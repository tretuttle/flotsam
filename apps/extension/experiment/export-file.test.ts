import * as NodeCrypto from "node:crypto";
import { WriteRefused } from "@one-click-har/export/run";
import { describe, expect, it } from "vite-plus/test";
import {
  carriesHead,
  createPartSink,
  ERRNO_KINDS,
  ExportCancelled,
  exportFiles,
  journalLine,
  LINK_FALLBACK,
  SINK_BATCH_UNITS,
  unfinishedExports,
  type ExportLimits,
  type ExportPause,
  type ExportPlatform,
  type HeldFolder,
  type JournaledPart,
  type JournalEntry,
  type Part,
  type PartJournal,
  type PathState,
} from "./export-file.ts";

/**
 * An inode. A handle and every hard link hold the same object, so a write through a handle follows the inode. A folder
 * or FIFO may report any size through lstat, or the size of another inode, as a user-space file system can, so a check
 * can be shown to hold without the size agreeing by luck. Opened both ways, a FIFO reports 0 bytes.
 */
type FileNode = { readonly kind: "file"; bytes: number[] };
type Node =
  | { readonly kind: "folder"; readonly size?: number }
  | { readonly kind: "fifo"; readonly size: number | FileNode }
  | FileNode
  | { readonly kind: "link"; readonly target: string };

/** A call that waits at its start until the test lets it go. */
interface Hold {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

/** A small POSIX file system: paths name inodes, links resolve, an open handle keeps writing its own inode. */
class MemoryFs {
  readonly nodes = new Map<string, Node>([["/", { kind: "folder" }]]);
  /** Errors to throw from one platform call, as the browser threw them for one cause. */
  readonly fail = new Map<keyof ExportPlatform, unknown>();
  readonly holds = new Map<keyof ExportPlatform, { gate: Promise<void>; reached: () => void }>();
  /** Every rename that moved something, as `from -> to`. */
  readonly moves: string[] = [];
  /** Set when anything reads a FIFO by its path. */
  fifoRead = false;

  parent = (path: string): string | null =>
    path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  filename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
  join = (folder: string, name: string): string => `${folder === "/" ? "" : folder}/${name}`;

  /** Resolves links in every component but the last. */
  private resolveParent(path: string): string {
    const up = this.parent(path);
    return up === null ? path : this.join(this.realPath(up), this.filename(path));
  }

  /** Throws for a path that does not exist, as Gecko's `normalize` does. */
  realPath = (path: string, depth = 0): string => {
    if (depth > 20)
      throw Object.assign(new Error("loop"), { name: "NS_ERROR_FILE_UNRESOLVABLE_SYMLINK" });
    const resolved = this.resolveParent(path);
    const node = this.nodes.get(resolved);
    if (node === undefined && depth === 0 && path !== "/")
      throw Object.assign(new Error("missing"), { name: "NS_ERROR_FILE_NOT_FOUND" });
    return node?.kind === "link" ? this.realPath(node.target, depth + 1) : resolved;
  };

  folder(path: string, size?: number): void {
    this.nodes.set(path, size === undefined ? { kind: "folder" } : { kind: "folder", size });
  }
  file(path: string, text: string): FileNode {
    const node: FileNode = { kind: "file", bytes: [...Buffer.from(text)] };
    this.nodes.set(path, node);
    return node;
  }
  link(path: string, target: string): void {
    this.nodes.set(path, { kind: "link", target });
  }
  fifo(path: string, size: number | FileNode = 0): void {
    this.nodes.set(path, { kind: "fifo", size });
  }
  /** Every inode's number, given the first time it is asked for. */
  private readonly inodes = new WeakMap<object, number>();
  private lastInode = 0;
  ino(node: object): string {
    if (!this.inodes.has(node)) {
      this.lastInode += 1;
      this.inodes.set(node, this.lastInode);
    }
    return String(this.inodes.get(node));
  }
  /** Where `node` is named now, or null when nothing names it. */
  pathOf(node: Node): string | null {
    for (const [path, at] of this.nodes) if (at === node) return path;
    return null;
  }
  /** Every unlink or rename of a name the platform was asked for. An unnamed export makes none. */
  readonly removes: string[] = [];
  /** Answers `link` and `createUnnamed` refuse with, as the kernel gave them. */
  readonly failUnnamed = new Map<"createUnnamed" | "link", unknown>();
  /** Set to make every folder's file system unable to hold an unnamed file. */
  noUnnamedFiles = false;
  /** Set to hide /proc/self/fd, so no unnamed file can be linked. */
  noFdLink = false;
  /** The last unnamed file made, as another process reaches it through /proc/<pid>/fd. */
  lastUnnamed: FileNode | null = null;
  /**
   * Bytes the disk still takes; null for room enough. A write past them stores what fits, a short write, and then
   * throws what the next write meets: the worker's ENOSPC, or the name Gecko gave the part's handle.
   */
  room: number | null = null;
  /** Set to make readText hand back its last byte changed, as a copy that is not byte-exact would. */
  copyCorrupts = false;

  /** Appends `text` to `node` as far as the room allows, then throws `full` if not all of it fit. */
  private store(node: FileNode, text: string, full: unknown): void {
    const bytes = [...Buffer.from(text)];
    const taken = this.room === null ? bytes : bytes.slice(0, this.room);
    node.bytes.push(...taken);
    if (this.room === null) return;
    this.room -= taken.length;
    if (taken.length < bytes.length) throw full;
  }

  /** Holds the folder at `path` open, as file-worker.ts does with a directory descriptor. */
  holdFolder = async (path: string): Promise<HeldFolder> => {
    const folder = this.nodes.get(path);
    if (folder?.kind !== "folder") throw new DOMException("x", "NotFoundError");
    const where = (): string | null => this.pathOf(folder);
    return {
      where: async () => where(),
      identityOf: async (name) => {
        const at = where();
        const node = at === null ? undefined : this.nodes.get(this.join(at, name));
        return node === undefined ? null : { dev: "m", ino: this.ino(node) };
      },
      createUnnamed: async () => {
        if (this.failUnnamed.has("createUnnamed")) throw this.failUnnamed.get("createUnnamed");
        if (this.noUnnamedFiles) return { refused: "unnamed-refused", errno: "EOPNOTSUPP" };
        if (this.noFdLink) return { refused: "fd-link-unavailable", errno: "fd-link-unavailable" };
        const node: FileNode = { kind: "file", bytes: [] };
        this.lastUnnamed = node;
        return {
          file: {
            identity: { dev: "m", ino: this.ino(node) },
            write: async (text) => this.store(node, text, { name: "ENOSPC" }),
            size: async () => node.bytes.length,
            read: async (offset, bytes) =>
              Uint8Array.from(node.bytes.slice(offset, offset + bytes)),
            readText: async (offset, bytes) => {
              const taken = node.bytes.slice(offset, offset + bytes);
              if (this.copyCorrupts && taken.length > 0) taken[taken.length - 1] = 0x20;
              return { text: Buffer.from(taken).toString(), bytes: taken.length };
            },
            link: async (name) => {
              if (this.failUnnamed.has("link")) throw this.failUnnamed.get("link");
              const at = where();
              if (at === null) throw { name: "ENOENT" };
              if (this.nodes.has(this.join(at, name))) return false;
              this.nodes.set(this.join(at, name), node);
              return true;
            },
            close: () => undefined,
          },
        };
      },
      close: () => undefined,
    };
  };

  text(path: string): string {
    const node = this.nodes.get(this.realPath(path));
    return node?.kind === "file" ? Buffer.from(node.bytes).toString() : "";
  }
  /** Removes a folder and everything in it. */
  removeTree(path: string): void {
    for (const key of this.nodes.keys())
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
  }
  /** The next `call` waits at its start until released. */
  hold(call: keyof ExportPlatform): Hold {
    let reached = (): void => undefined;
    let release = (): void => undefined;
    const atStart = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.set(call, { gate, reached });
    return { reached: atStart, release };
  }

  private async wait(call: keyof ExportPlatform): Promise<void> {
    const held = this.holds.get(call);
    if (held === undefined) return;
    this.holds.delete(call);
    held.reached();
    await held.gate;
  }
  private check(call: keyof ExportPlatform): void {
    if (this.fail.has(call)) throw this.fail.get(call);
  }

  platform(): ExportPlatform {
    return {
      state: (path): PathState => {
        const node = this.nodes.get(this.resolveParent(path));
        if (node === undefined) return { kind: "missing" };
        if (node.kind === "file") return { kind: "file", size: node.bytes.length };
        if (node.kind === "link") return { kind: "link", size: node.target.length };
        if (node.kind === "fifo")
          return {
            kind: "other",
            size: typeof node.size === "number" ? node.size : node.size.bytes.length,
          };
        return { kind: "folder", size: node.size ?? 4096 };
      },
      realPath: (path) => this.realPath(path),
      parent: this.parent,
      join: this.join,
      filename: this.filename,
      makeFolder: async (folder) => {
        this.check("makeFolder");
        const real = this.realPath(folder);
        const node = this.nodes.get(real);
        if (node !== undefined && node.kind !== "folder")
          throw new DOMException("x", "InvalidAccessError");
        const up = this.parent(real);
        if (up !== null && !this.nodes.has(up)) await this.platform().makeFolder(up);
        if (node === undefined) this.folder(real);
      },
      createExclusive: (path) => {
        this.check("createExclusive");
        const at = this.resolveParent(path);
        if (this.nodes.has(at)) throw { name: "NS_ERROR_FILE_ALREADY_EXISTS" };
        const node = this.file(at, "");
        return {
          write: (text) => {
            this.check("createExclusive");
            this.store(node, text, { name: "NS_ERROR_FILE_NO_DEVICE_SPACE" });
          },
          flush: () => undefined,
          size: () => node.bytes.length,
          read: (offset, bytes) => Uint8Array.from(node.bytes.slice(offset, offset + bytes)),
          resize: (bytes) => {
            node.bytes.length = Math.min(node.bytes.length, bytes);
            while (node.bytes.length < bytes) node.bytes.push(0);
          },
          close: () => undefined,
        };
      },
      readHead: async (path, bytes) => {
        const node = this.nodes.get(this.realPath(path));
        if (node?.kind === "fifo") {
          this.fifoRead = true;
          return new Uint8Array(0);
        }
        if (node?.kind !== "file") throw new DOMException("x", "NotReadableError");
        return node.bytes.length < bytes
          ? new Uint8Array(0)
          : Uint8Array.from(node.bytes.slice(0, bytes));
      },
      rename: async (from, to) => {
        await this.wait("rename");
        this.check("rename");
        const target = this.resolveParent(to);
        if (this.nodes.has(target)) throw new DOMException("x", "NoModificationAllowedError");
        const source = this.resolveParent(from);
        const node = this.nodes.get(source);
        if (node === undefined) throw new DOMException("x", "NotFoundError");
        this.nodes.delete(source);
        this.nodes.set(target, node);
        this.moves.push(`${source} -> ${target}`);
        this.removes.push(`rename ${source}`);
      },
      remove: async (path) => {
        this.check("remove");
        this.removes.push(`remove ${path}`);
        this.nodes.delete(this.resolveParent(path));
      },
      freeBytes: () => this.room ?? 1 << 30,
      sha256: () => {
        const hash = NodeCrypto.createHash("sha256");
        return { update: (bytes) => void hash.update(bytes), hex: () => hash.digest("hex") };
      },
    };
  }
}

/** Step timers the test fires by hand, and the job's cancel. */
class Limits implements ExportLimits {
  readonly stepMs = 15_000;
  readonly signal = { aborted: false };
  private readonly armed = new Set<() => void>();
  timer = (): { readonly elapsed: Promise<void>; readonly cancel: () => void } => {
    let fire = (): void => undefined;
    const elapsed = new Promise<void>((resolve) => {
      fire = resolve;
    });
    this.armed.add(fire);
    return { elapsed, cancel: () => this.armed.delete(fire) };
  };
  /** Every step timer still armed runs out. */
  elapse(): void {
    for (const fire of this.armed) fire();
    this.armed.clear();
  }
  private readonly held = new Map<ExportPause, { reached: () => void; gate: Promise<void> }>();
  pause = async (point: ExportPause): Promise<void> => {
    const held = this.held.get(point);
    if (held === undefined) return;
    this.held.delete(point);
    held.reached();
    await held.gate;
  };
  /** The export waits at `point` until released, as the harness topic holds it. */
  hold(point: ExportPause): Hold {
    let reached = (): void => undefined;
    let release = (): void => undefined;
    const atPoint = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.set(point, { reached, gate });
    return { reached: atPoint, release };
  }
}

const PROFILE = "/home/u/profile";
const DOWNLOADS = "/home/u/Downloads";
/** The first write of an export, as runExport writes it: the document's opening with a random file id. */
const OPENING = '{"log":{"_harExportId":"9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e","entries":[';
const REST = "]}}";
const DOCUMENT = `${OPENING}${REST}`;

/** Every line the export journaled, parsed. */
class MemoryJournal implements PartJournal {
  readonly lines: JournalEntry[] = [];
  started = async (path: string, head: string): Promise<void> => {
    this.lines.push({ started: path, head });
  };
  ended = async (path: string): Promise<void> => {
    this.lines.push({ ended: path });
  };
  /** What the next start would act on. */
  unended(): readonly JournaledPart[] {
    return unfinishedExports(this.lines.map(journalLine).join(""));
  }
}

const setup = (wrap: (platform: ExportPlatform, fs: MemoryFs) => ExportPlatform = (p) => p) => {
  const fs = new MemoryFs();
  for (const folder of ["/home", "/home/u", PROFILE, DOWNLOADS]) fs.folder(folder);
  fs.file(`${PROFILE}/prefs.js`, "user_pref(1);");
  const limits = new Limits();
  const files = exportFiles(wrap(fs.platform(), fs), (real) => !real.startsWith(PROFILE), limits);
  return { fs, files, limits, journal: new MemoryJournal() };
};
type Setup = ReturnType<typeof setup>;

const failureOf = async (call: Promise<unknown>): Promise<unknown> => {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WriteRefused);
  return (error as WriteRefused).failure;
};

/** Writes the opening and then the rest through a new part, with `between` run after the opening. */
const exportOnce = async (
  { files, journal }: Pick<Setup, "files" | "journal">,
  between: (path: string) => void = () => undefined,
  rest = REST,
) => {
  const folder = await files.openFolder(DOWNLOADS);
  const { part, path } = await folder.createPart("site.har", journal);
  await part.append(OPENING, OPENING.length);
  between(path);
  await part.append(rest, rest.length);
  return { part, path };
};

/** As the host does: finish, or discard on any failure, and hand back the failure. */
const finishOrDiscard = async (part: Part): Promise<unknown> => {
  const failure = await failureOf(part.finish("site.har"));
  await part.discard();
  return failure;
};

/** What the part at `path` holds now. */
const partText = (fs: MemoryFs, path: string): string =>
  Buffer.from((fs.nodes.get(path) as FileNode).bytes).toString();

/** Names under the export folder, links and FIFOs included. */
const inDownloads = (fs: MemoryFs): readonly string[] =>
  [...fs.nodes.keys()].filter((p) => p.startsWith(`${DOWNLOADS}/`)).sort();

/**
 * What each cause must report, from the contract's kinds. The error is the one the browser gave for that cause, as
 * observed on Zen 1.24.2b and Zen Twilight 1.25t; the kind is written here, not read from FS_ERROR_KINDS.
 */
const CAUSES: readonly {
  readonly cause: string;
  readonly call: keyof ExportPlatform;
  readonly error: unknown;
  readonly kind: string;
}[] = [
  {
    cause: "read-only mount, folder creation",
    call: "makeFolder",
    error: new DOMException("x", "ReadOnlyError"),
    kind: "read-only",
  },
  {
    cause: "read-only mount, part creation",
    call: "createExclusive",
    error: { name: "NS_ERROR_FILE_READ_ONLY" },
    kind: "read-only",
  },
  {
    cause: "folder is a file, folder creation",
    call: "makeFolder",
    error: new DOMException("x", "InvalidAccessError"),
    kind: "not-a-folder",
  },
  {
    cause: "no permission, folder creation",
    call: "makeFolder",
    error: new DOMException("x", "NotAllowedError"),
    kind: "access-denied",
  },
  {
    cause: "no permission, part creation",
    call: "createExclusive",
    error: { name: "NS_ERROR_FILE_ACCESS_DENIED" },
    kind: "access-denied",
  },
  {
    cause: "name too long",
    call: "createExclusive",
    error: { name: "NS_ERROR_FILE_NAME_TOO_LONG" },
    kind: "name-too-long",
  },
  {
    cause: "the rename finds no part, in a folder that is still there",
    call: "rename",
    error: new DOMException("x", "NotFoundError"),
    kind: "file-replaced",
  },
  {
    cause: "an I/O error the table does not name, on purpose",
    call: "rename",
    error: { name: "NS_ERROR_FILE_DEVICE_FAILURE" },
    kind: "other",
  },
];

/** Moves the export folder to /home/u/moved, with everything in it, and puts a link to the profile in its place. */
const folderToProfileLink = (fs: MemoryFs): void => {
  for (const key of [...fs.nodes.keys()].filter(
    (k) => k === DOWNLOADS || k.startsWith(`${DOWNLOADS}/`),
  )) {
    fs.nodes.set(key.replace(DOWNLOADS, "/home/u/moved"), fs.nodes.get(key)!);
    fs.nodes.delete(key);
  }
  fs.link(DOWNLOADS, PROFILE);
};

/**
 * What happens between the pre-rename check and the rename, and how the export must end. The kind is written here.
 * `left` is every name under the export folder afterwards: a replacement is put back where it was found. `profile` is
 * every name in the profile afterwards, each holding what it held when the row acted.
 */
const BEFORE_RENAME: readonly {
  readonly cause: string;
  readonly act: (fs: MemoryFs, path: string) => void;
  readonly kind: string;
  readonly left: readonly string[];
  readonly profile?: readonly string[];
}[] = [
  {
    cause: "the folder is deleted",
    act: (fs) => fs.removeTree(DOWNLOADS),
    kind: "folder-missing",
    left: [],
  },
  {
    cause: "the folder is replaced by a link to the profile",
    act: folderToProfileLink,
    kind: "folder-refused",
    left: [],
  },
  {
    cause:
      "the folder is replaced by a link to the profile, the part hard-linked there under its name",
    act: (fs, path) => {
      folderToProfileLink(fs);
      fs.nodes.set(
        `${PROFILE}/site.har.part`,
        fs.nodes.get(path.replace(DOWNLOADS, "/home/u/moved"))!,
      );
    },
    kind: "folder-refused",
    left: [],
    profile: [`${PROFILE}/prefs.js`, `${PROFILE}/site.har.part`],
  },
  {
    cause: "the part is deleted",
    act: (fs, path) => fs.nodes.delete(path),
    kind: "file-replaced",
    left: [],
  },
  {
    cause: "a FIFO takes the part's name",
    act: (fs, path) => fs.fifo(path),
    kind: "file-replaced",
    left: [`${DOWNLOADS}/site.har.part`],
  },
  {
    cause: "a link to prefs.js takes the part's name",
    act: (fs, path) => fs.link(path, `${PROFILE}/prefs.js`),
    kind: "file-replaced",
    left: [`${DOWNLOADS}/site.har.part`],
  },
  {
    cause: "a hard link to prefs.js takes the part's name",
    act: (fs, path) => fs.nodes.set(path, fs.nodes.get(`${PROFILE}/prefs.js`)!),
    kind: "file-replaced",
    left: [`${DOWNLOADS}/site.har.part`],
  },
  {
    cause:
      "a regular file of the written length and first bytes, at another inode, takes the part's name",
    act: (fs, path) => fs.file(path, partText(fs, path)),
    kind: "file-replaced",
    left: [`${DOWNLOADS}/site.har.part`],
  },
];

describe("the export file boundary", () => {
  it.each(CAUSES)(
    "reports $cause as $kind, with no text, and leaves no journal line open",
    async ({ call, error, kind }) => {
      const at = setup();
      at.fs.fail.set(call, error);
      let part: Part | null = null;
      const failure = await failureOf(
        exportOnce(at).then((written) => {
          part = written.part;
          return written.part.finish("site.har");
        }),
      );
      await (part as Part | null)?.discard();
      expect(failure).toEqual({ kind });
      expect(at.journal.unended()).toEqual([]);
      if (call !== "rename") expect(at.journal.lines).toEqual([]);
      expect(inDownloads(at.fs)).toEqual([]);
    },
  );

  it.each(BEFORE_RENAME)(
    "when $cause between the check and the rename, reports $kind and changes nothing else",
    async ({ act, kind, left, profile = [`${PROFILE}/prefs.js`] }) => {
      const at = setup();
      const { part, path } = await exportOnce(at);
      const held = at.fs.hold("rename");
      const finished = failureOf(part.finish("site.har"));
      await held.reached;
      act(at.fs, path);
      const replacement = at.fs.nodes.get(path);
      const inProfile = profile.map((p) => at.fs.nodes.get(p));
      held.release();
      expect(await finished).toEqual({ kind });
      await part.discard();
      expect(inDownloads(at.fs)).toEqual(left);
      if (left.length > 0) expect(at.fs.nodes.get(path)).toBe(replacement);
      expect(at.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
      expect([...at.fs.nodes.keys()].filter((p) => p.startsWith(`${PROFILE}/`)).sort()).toEqual(
        profile,
      );
      profile.forEach((p, i) => expect(at.fs.nodes.get(p), p).toBe(inProfile[i]));
      expect(at.journal.unended()).toEqual([]);
    },
  );

  it("reports a full disk with the bytes a write needed and the free bytes", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    const platform = { ...fs.platform(), freeBytes: () => 4096 };
    const files = exportFiles(platform, () => true, new Limits());
    const folder = await files.openFolder("/d");
    const { part } = await folder.createPart("a.har", new MemoryJournal());
    fs.fail.set("createExclusive", { name: "NS_ERROR_FILE_NO_DEVICE_SPACE" });
    expect(await failureOf(part.append("x".repeat(10_000), 10_000))).toEqual({
      kind: "disk-full",
      needBytes: 10_000,
      freeBytes: 4096,
    });
  });

  it("journals a part only once it holds its opening, and ends the line at the rename", async () => {
    const at = setup();
    const folder = await at.files.openFolder(DOWNLOADS);
    const { part, path } = await folder.createPart("site.har", at.journal);
    expect(at.journal.lines).toEqual([]);
    await part.append(OPENING, OPENING.length);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }]);
    await part.append(REST, REST.length);
    expect(await part.finish("site.har")).toBe("site.har");
    expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe(DOCUMENT);
    expect(at.fs.nodes.has(path)).toBe(false);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("writes nothing through a part replaced by a link, a regular file or a hard link, reports file-replaced, and leaves the replacement", async () => {
    const attacks: readonly ((fs: MemoryFs, path: string) => void)[] = [
      (fs, path) => fs.link(path, `${PROFILE}/prefs.js`),
      (fs, path) => fs.file(path, "attacker's own file"),
      (fs, path) => fs.nodes.set(path, fs.nodes.get(`${PROFILE}/prefs.js`)!),
    ];
    for (const attack of attacks) {
      const at = setup();
      const { part, path } = await exportOnce(at, (p) => attack(at.fs, p));
      const replacement = at.fs.nodes.get(path);
      expect(await finishOrDiscard(part)).toEqual({ kind: "file-replaced" });
      expect(at.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
      expect(at.fs.nodes.has(`${DOWNLOADS}/site.har`)).toBe(false);
      expect(at.fs.nodes.get(path)).toBe(replacement);
      expect(at.journal.unended()).toEqual([]);
    }
  });

  /**
   * The pre-rename check: the path is a regular file (kind) of the handle's length (size) whose length follows the
   * handle (follows), and the handle's file has the written length and first bytes. Each case is seen by one conjunct
   * only. The rename's own check would still catch kind and size after a move, so nothing may have moved.
   */
  const ONE_CONJUNCT: readonly {
    readonly seenBy: "kind" | "size" | "follows" | "written length" | "first bytes";
    readonly change: string;
    readonly make: (fs: MemoryFs, path: string) => void;
    /** The export's own file, changed in place: still the export's, so discarded. */
    readonly inPlace: boolean;
  }[] = [
    {
      seenBy: "kind",
      change: "a FIFO whose reported size follows the part's",
      make: (fs, p) => fs.fifo(p, fs.nodes.get(p) as FileNode),
      inPlace: false,
    },
    {
      seenBy: "size",
      change: "a regular file one byte longer than the part",
      make: (fs, p) => fs.file(p, `${partText(fs, p)}x`),
      inPlace: false,
    },
    {
      seenBy: "follows",
      change: "a regular file with the part's size and first bytes, at another inode",
      make: (fs, p) => fs.file(p, partText(fs, p)),
      inPlace: false,
    },
    {
      seenBy: "written length",
      change: "the part's own file, appended to by another writer",
      make: (fs, p) => (fs.nodes.get(p) as FileNode).bytes.push(...Buffer.from(" ")),
      inPlace: true,
    },
    {
      seenBy: "first bytes",
      change: "the part's own first bytes, overwritten in place",
      make: (fs, p) => (fs.nodes.get(p) as FileNode).bytes.fill(0x20, 0, 16),
      inPlace: true,
    },
  ];
  it.each(ONE_CONJUNCT)(
    "only the $seenBy test sees $change; nothing is renamed and nothing but the export's own file is deleted",
    async ({ make, inPlace }) => {
      const at = setup();
      const { part, path } = await exportOnce(at, () => undefined, "");
      make(at.fs, path);
      const replacement = at.fs.nodes.get(path);
      expect(await finishOrDiscard(part)).toEqual({ kind: "file-replaced" });
      expect(at.fs.moves).toEqual([]);
      expect(at.fs.fifoRead).toBe(false);
      expect(at.fs.nodes.get(path)).toBe(inPlace ? undefined : replacement);
      expect(at.journal.unended()).toEqual([]);
    },
  );

  it("the rename's own check moves back anything but a regular file of the written length", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at, () => undefined, "");
    const held = at.fs.hold("rename");
    const finished = failureOf(part.finish("site.har"));
    await held.reached;
    at.fs.file(path, `${DOCUMENT}x`);
    const replacement = at.fs.nodes.get(path);
    held.release();
    expect(await finished).toEqual({ kind: "file-replaced" });
    await part.discard();
    expect(at.fs.moves).toEqual([
      `${path} -> ${DOWNLOADS}/site.har`,
      `${DOWNLOADS}/site.har -> ${path}`,
    ]);
    expect(at.fs.nodes.get(path)).toBe(replacement);
    expect(inDownloads(at.fs)).toEqual([path]);
  });

  it("a file the export renamed into a folder that became a link is moved back out, never deleted, and the export is folder-refused", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    const held = at.fs.hold("rename");
    const finished = failureOf(part.finish("site.har"));
    await held.reached;
    folderToProfileLink(at.fs);
    const ours = at.fs.nodes.get(path.replace(DOWNLOADS, "/home/u/moved"));
    at.fs.nodes.set(`${PROFILE}/site.har.part`, ours!);
    held.release();
    expect(await finished).toEqual({ kind: "folder-refused" });
    await part.discard();
    expect(at.fs.moves).toEqual([
      `${PROFILE}/site.har.part -> ${PROFILE}/site.har`,
      `${PROFILE}/site.har -> ${PROFILE}/site.har.part`,
    ]);
    expect(at.fs.nodes.get(`${PROFILE}/site.har.part`)).toBe(ours);
    expect(at.fs.nodes.get("/home/u/moved/site.har.part")).toBe(ours);
    expect(at.fs.nodes.has(`${PROFILE}/site.har`)).toBe(false);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("a folder swapped for a link between the folder's check and the entry's, the file hard-linked behind it, is refused", async () => {
    let swapAt: string | null = null;
    const at = setup((platform, fs) => ({
      ...platform,
      state: (p) => {
        if (p === swapAt) {
          swapAt = null;
          folderToProfileLink(fs);
          fs.nodes.set(`${PROFILE}/site.har`, fs.nodes.get("/home/u/moved/site.har")!);
        }
        return platform.state(p);
      },
    }));
    const { part, path } = await exportOnce(at);
    swapAt = `${DOWNLOADS}/site.har`;
    expect(await failureOf(part.finish("site.har"))).toEqual({ kind: "folder-refused" });
    await part.discard();
    const ours = at.fs.nodes.get("/home/u/moved/site.har");
    expect(at.fs.nodes.get(`${PROFILE}/site.har.part`)).toBe(ours);
    expect([...at.fs.nodes.keys()].filter((p) => p.startsWith(`${PROFILE}/`)).sort()).toEqual([
      `${PROFILE}/prefs.js`,
      `${PROFILE}/site.har.part`,
    ]);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("a file not the export's, renamed in a folder that became a link, is put back under the name it had", async () => {
    const at = setup();
    const { part } = await exportOnce(at);
    const held = at.fs.hold("rename");
    const finished = failureOf(part.finish("site.har"));
    await held.reached;
    folderToProfileLink(at.fs);
    const theirs = at.fs.file(`${PROFILE}/site.har.part`, "theirs");
    held.release();
    expect(await finished).toEqual({ kind: "folder-refused" });
    await part.discard();
    expect(at.fs.nodes.get(`${PROFILE}/site.har.part`)).toBe(theirs);
    expect(at.fs.nodes.has(`${PROFILE}/site.har`)).toBe(false);
    expect(at.fs.moves).toEqual([
      `${PROFILE}/site.har.part -> ${PROFILE}/site.har`,
      `${PROFILE}/site.har -> ${PROFILE}/site.har.part`,
    ]);
    expect(at.fs.nodes.get("/home/u/moved/site.har.part")).toBeDefined();
  });

  it("a finished name removed right after the rename is file-replaced, not a folder problem", async () => {
    const at = setup((platform, fs) => ({
      ...platform,
      rename: async (from, to) => {
        await platform.rename(from, to);
        if (to.endsWith(".har")) fs.nodes.delete(to);
      },
    }));
    const { part } = await exportOnce(at);
    expect(await finishOrDiscard(part)).toEqual({ kind: "file-replaced" });
    expect(inDownloads(at.fs)).toEqual([]);
  });

  it("a rename still running after the step limit ends the export timed-out, and the file is deleted once it lands", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    const held = at.fs.hold("rename");
    const finished = failureOf(part.finish("site.har"));
    await held.reached;
    at.limits.elapse();
    expect(await finished).toEqual({ kind: "timed-out" });
    await part.discard();
    expect(at.journal.unended()).toEqual([{ path, head: OPENING }]);
    held.release();
    await expect.poll(() => at.journal.unended()).toEqual([]);
    expect(at.fs.moves).toEqual([`${path} -> ${DOWNLOADS}/site.har`]);
    expect(inDownloads(at.fs)).toEqual([]);
  });

  it("a late rename that moved a FIFO puts it back, and deletes nothing", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    const held = at.fs.hold("rename");
    const finished = failureOf(part.finish("site.har"));
    await held.reached;
    at.fs.fifo(path);
    const fifo = at.fs.nodes.get(path);
    at.limits.elapse();
    expect(await finished).toEqual({ kind: "timed-out" });
    await part.discard();
    held.release();
    await expect.poll(() => at.journal.unended()).toEqual([]);
    expect(at.fs.nodes.get(path)).toBe(fifo);
    expect(inDownloads(at.fs)).toEqual([path]);
    expect(at.fs.fifoRead).toBe(false);
  });

  it("cancel during the rename ends the export cancelled once the rename lands, and deletes the finished file", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    const held = at.fs.hold("rename");
    const finished = part.finish("site.har").then(
      () => null,
      (e: unknown) => e,
    );
    await held.reached;
    at.limits.signal.aborted = true;
    held.release();
    expect(await finished).toBeInstanceOf(ExportCancelled);
    await part.discard();
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("cancel before the rename renames nothing", async () => {
    const at = setup();
    const { part, path } = await exportOnce(at);
    at.limits.signal.aborted = true;
    expect(await part.finish("site.har").catch((e: unknown) => e)).toBeInstanceOf(ExportCancelled);
    await part.discard();
    expect(at.fs.moves).toEqual([]);
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("refuses a folder that is a link, resolves into the profile, or becomes a link", async () => {
    const linked = setup();
    linked.fs.nodes.delete(DOWNLOADS);
    linked.fs.link(DOWNLOADS, PROFILE);
    expect(await failureOf(linked.files.openFolder(DOWNLOADS))).toEqual({ kind: "folder-refused" });

    const through = setup();
    through.fs.link("/home/u/in", PROFILE);
    expect(await failureOf(through.files.openFolder("/home/u/in/new"))).toEqual({
      kind: "folder-refused",
    });
    expect(through.fs.nodes.has(`${PROFILE}/new`)).toBe(false);

    const later = setup();
    const { part } = await exportOnce(later, () => {
      later.fs.nodes.delete(DOWNLOADS);
      later.fs.link(DOWNLOADS, PROFILE);
    });
    expect(await finishOrDiscard(part)).toEqual({ kind: "folder-refused" });
    expect([...later.fs.nodes.keys()].filter((p) => p.startsWith(PROFILE))).toEqual([
      PROFILE,
      `${PROFILE}/prefs.js`,
    ]);
    expect(later.journal.unended()).toEqual([]);
  });

  it("never overwrites, and journals only the part it created: taken names, even a dangling link, move on", async () => {
    const at = setup();
    at.fs.file(`${DOWNLOADS}/site.har`, "theirs");
    at.fs.file(`${DOWNLOADS}/site.har.part`, "a stale part");
    at.fs.link(`${DOWNLOADS}/site (2).har.part`, "/nowhere");
    const { part, path } = await exportOnce(at, () =>
      at.fs.file(`${DOWNLOADS}/site (2).har`, "also theirs"),
    );
    expect(path).toBe(`${DOWNLOADS}/site (3).har.part`);
    expect(await part.finish("site.har")).toBe("site (3).har");
    expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe("theirs");
    expect(at.fs.text(`${DOWNLOADS}/site.har.part`)).toBe("a stale part");
    expect(at.fs.text(`${DOWNLOADS}/site (2).har`)).toBe("also theirs");
    expect(at.fs.text(`${DOWNLOADS}/site (3).har`)).toBe(DOCUMENT);
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
  });

  it("discards only its own part, never through a folder that became a link, and keeps the line of a part it could not delete", async () => {
    const own = setup();
    const { part, path } = await exportOnce(own);
    await part.discard();
    expect(own.fs.nodes.has(path)).toBe(false);
    expect(own.journal.unended()).toEqual([]);

    const later = setup();
    later.fs.file(`${PROFILE}/site.har.part`, DOCUMENT);
    const second = await exportOnce(later, () => {
      later.fs.nodes.delete(DOWNLOADS);
      later.fs.link(DOWNLOADS, PROFILE);
    });
    await second.part.discard();
    expect(later.fs.text(`${PROFILE}/site.har.part`)).toBe(DOCUMENT);

    const stuck = setup();
    const third = await exportOnce(stuck);
    stuck.fs.fail.set("remove", new DOMException("x", "NotAllowedError"));
    await third.part.discard();
    expect(stuck.fs.text(third.path)).toBe(DOCUMENT);
    expect(stuck.journal.unended()).toEqual([{ path: third.path, head: OPENING }]);
  });

  it("before its opening is journaled, a part is discarded as the handle's own file", async () => {
    const at = setup();
    const folder = await at.files.openFolder(DOWNLOADS);
    const { part, path } = await folder.createPart("site.har", at.journal);
    await part.discard();
    expect(at.fs.nodes.has(path)).toBe(false);
    expect(at.journal.lines).toEqual([]);
  });
});

/** An export folder the platform holds open, as on Linux. */
const held = () => setup((platform, fs) => ({ ...platform, holdFolder: fs.holdFolder }));

/** Names under a folder, links and FIFOs included. */
const under = (fs: MemoryFs, folder: string): readonly string[] =>
  [...fs.nodes.keys()].filter((p) => p.startsWith(`${folder}/`)).sort();

/**
 * The review's racing rows, made at the moment named, each with what the export must report and every name under the
 * export folder, the folder it was moved to, and the profile afterwards. Nothing the row put anywhere may change, and
 * the export renames and deletes nothing.
 */
const RACES: readonly {
  readonly cause: string;
  readonly at: ExportPause;
  readonly act: (fs: MemoryFs) => void;
  readonly ends: { readonly done: string } | { readonly kind: string; readonly unconfirmed?: true };
  readonly left: { readonly [folder: string]: readonly string[] };
}[] = [
  {
    cause: "a foreign file is written at the finished name",
    at: "before-link",
    act: (fs) => fs.file(`${DOWNLOADS}/site.har`, "theirs"),
    ends: { done: "site (2).har" },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site (2).har`, `${DOWNLOADS}/site.har`] },
  },
  {
    cause: "a link to prefs.js is put at the finished name",
    at: "before-link",
    act: (fs) => fs.link(`${DOWNLOADS}/site.har`, `${PROFILE}/prefs.js`),
    ends: { done: "site (2).har" },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site (2).har`, `${DOWNLOADS}/site.har`] },
  },
  {
    cause: "a file is put at the part's name",
    at: "before-link",
    act: (fs) => fs.file(`${DOWNLOADS}/site.har.part`, "theirs"),
    ends: { done: "site.har" },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site.har`, `${DOWNLOADS}/site.har.part`] },
  },
  {
    cause: "the folder is replaced by a link to the profile",
    at: "before-link",
    act: folderToProfileLink,
    ends: { kind: "folder-refused", unconfirmed: true },
    left: { "/home/u/moved": ["/home/u/moved/site.har"], [PROFILE]: [`${PROFILE}/prefs.js`] },
  },
  {
    cause:
      "the folder is replaced by a link to the profile, with a file planted there at the part's name",
    at: "before-link",
    act: (fs) => {
      folderToProfileLink(fs);
      fs.file(`${PROFILE}/site.har.part`, "planted");
    },
    ends: { kind: "folder-refused", unconfirmed: true },
    left: {
      "/home/u/moved": ["/home/u/moved/site.har"],
      [PROFILE]: [`${PROFILE}/prefs.js`, `${PROFILE}/site.har.part`],
    },
  },
  {
    cause: "the folder is replaced by a link to the profile and put back",
    at: "before-link",
    act: (fs) => {
      folderToProfileLink(fs);
      fs.nodes.delete(DOWNLOADS);
      fs.nodes.set(DOWNLOADS, fs.nodes.get("/home/u/moved")!);
      fs.nodes.delete("/home/u/moved");
    },
    ends: { done: "site.har" },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site.har`], [PROFILE]: [`${PROFILE}/prefs.js`] },
  },
  {
    cause: "the folder is deleted",
    at: "before-link",
    act: (fs) => fs.removeTree(DOWNLOADS),
    ends: { kind: "folder-missing" },
    left: { [PROFILE]: [`${PROFILE}/prefs.js`] },
  },
  {
    cause: "the finished name is removed",
    at: "after-link",
    act: (fs) => fs.nodes.delete(`${DOWNLOADS}/site.har`),
    ends: { kind: "file-replaced", unconfirmed: true },
    left: { [DOWNLOADS]: [] },
  },
  {
    cause: "a foreign file takes the finished name",
    at: "after-link",
    act: (fs) => fs.file(`${DOWNLOADS}/site.har`, "theirs"),
    ends: { kind: "file-replaced", unconfirmed: true },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site.har`] },
  },
  {
    cause: "the finished file's first bytes are overwritten",
    at: "after-link",
    act: (fs) => (fs.nodes.get(`${DOWNLOADS}/site.har`) as FileNode).bytes.fill(0x20, 0, 16),
    ends: { kind: "file-replaced", unconfirmed: true },
    left: { [DOWNLOADS]: [`${DOWNLOADS}/site.har`] },
  },
  {
    cause:
      "the folder is replaced by a link to the profile with a file planted at the finished name",
    at: "after-link",
    act: (fs) => {
      folderToProfileLink(fs);
      fs.file(`${PROFILE}/site.har`, "planted");
    },
    ends: { kind: "folder-refused", unconfirmed: true },
    left: {
      "/home/u/moved": ["/home/u/moved/site.har"],
      [PROFILE]: [`${PROFILE}/prefs.js`, `${PROFILE}/site.har`],
    },
  },
];

describe("an export folder held open, its file unnamed until one link", () => {
  it("names only its own file, in the held folder, and renames or deletes nothing", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    expect(inDownloads(at.fs)).toEqual([]);
    expect(await part.finish("site.har")).toBe("site.har");
    expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe(DOCUMENT);
    expect(inDownloads(at.fs)).toEqual([`${DOWNLOADS}/site.har`]);
    expect(at.fs.removes).toEqual([]);
    expect(at.journal.lines).toEqual([]);
  });

  it.each(RACES)(
    "when $cause ($at), ends as written and touches nothing it did not create",
    async ({ at: point, act, ends, left }) => {
      const at = held();
      const { part } = await exportOnce(at);
      const before = new Map(at.fs.nodes);
      const hold = at.limits.hold(point);
      const finished = part.finish("site.har").then(
        (name) => ({ done: name }),
        (error: unknown) => error,
      );
      await hold.reached;
      act(at.fs);
      const acted = new Map(at.fs.nodes);
      hold.release();
      const outcome = await finished;
      await part.discard();
      if ("done" in ends) expect(outcome).toEqual(ends);
      else {
        expect(outcome).toBeInstanceOf(WriteRefused);
        expect((outcome as WriteRefused).failure).toEqual({ kind: ends.kind });
        expect(part.unconfirmed()).toBe(ends.unconfirmed === true);
      }
      for (const [folder, names] of Object.entries(left))
        expect(under(at.fs, folder)).toEqual(names);
      // Everything there before the export, and everything the row put down, is the same node at the same name.
      for (const [path, node] of acted)
        if (before.get(path) === node || !before.has(path))
          expect(at.fs.nodes.get(path), path).toBe(node);
      expect(at.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
      expect(at.fs.removes).toEqual([]);
    },
  );

  it("an unnamed file overwritten through its descriptor is never named", async () => {
    const at = held();
    const { part } = await exportOnce(at, () => at.fs.lastUnnamed?.bytes.fill(0x20, 0, 16));
    expect(await finishOrDiscard(part)).toEqual({ kind: "file-replaced" });
    expect(part.unconfirmed()).toBe(false);
    expect(inDownloads(at.fs)).toEqual([]);
  });

  it("a folder replaced before the finish is refused without naming anything", async () => {
    const at = held();
    const { part } = await exportOnce(at, () => folderToProfileLink(at.fs));
    expect(await finishOrDiscard(part)).toEqual({ kind: "folder-refused" });
    expect(part.unconfirmed()).toBe(false);
    expect(under(at.fs, "/home/u/moved")).toEqual([]);
    expect(under(at.fs, PROFILE)).toEqual([`${PROFILE}/prefs.js`]);
  });

  it("cancel while the link waits names nothing, and nothing is left", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    const hold = at.limits.hold("before-link");
    const finished = part.finish("site.har").catch((e: unknown) => e);
    await hold.reached;
    at.limits.signal.aborted = true;
    hold.release();
    expect(await finished).toBeInstanceOf(ExportCancelled);
    await part.discard();
    expect(inDownloads(at.fs)).toEqual([]);
    expect(part.unconfirmed()).toBe(false);
  });

  it("a link still waiting at the step limit ends timed-out, and names nothing once let go", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    const hold = at.limits.hold("before-link");
    const finished = failureOf(part.finish("site.har"));
    await hold.reached;
    at.limits.elapse();
    expect(await finished).toEqual({ kind: "timed-out" });
    await part.discard();
    hold.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inDownloads(at.fs)).toEqual([]);
  });

  it("finishes on the link route and says so", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    expect(await part.finish("site.har")).toBe("site.har");
    expect(part.route()).toEqual({ route: "link" });
  });

  /** Every errno the table names, from the call that makes the file and from the link, with what it must end as. */
  const ERRNO_ROWS = Object.entries(ERRNO_KINDS).flatMap(([errno, kind]) =>
    (["createUnnamed", "link"] as const)
      .filter((call) => call !== "link" || !Object.hasOwn(LINK_FALLBACK, errno))
      .map((call) => ({ errno, call, kind })),
  );
  it.each(ERRNO_ROWS)(
    "reports $errno from $call as $kind, with nothing left",
    async ({ errno, call, kind }) => {
      const at = held();
      at.fs.failUnnamed.set(call, { name: errno });
      const failure = await failureOf(
        exportOnce(at).then(async ({ part }) => {
          try {
            return await part.finish("site.har");
          } finally {
            await part.discard();
          }
        }),
      );
      expect(failure).toEqual(
        kind === "disk-full" ? { kind, needBytes: 1, freeBytes: 0 } : { kind },
      );
      expect(inDownloads(at.fs)).toEqual([]);
    },
  );

  it("leaves an errno the table does not name as other: a fault in the call itself", async () => {
    for (const errno of ["EBADF", "EFAULT", "EINVAL", "ENOMEM"]) {
      expect(Object.hasOwn(ERRNO_KINDS, errno), errno).toBe(false);
      const at = held();
      at.fs.failUnnamed.set("link", { name: errno });
      const { part } = await exportOnce(at);
      expect(await finishOrDiscard(part), errno).toEqual({ kind: "other" });
    }
  });

  it.each(Object.entries(LINK_FALLBACK).map(([errno, because]) => ({ errno, because })))(
    "a link refused with $errno moves the whole file to a named part and finishes there ($because)",
    async ({ errno, because }) => {
      const at = held();
      at.fs.failUnnamed.set("link", { name: errno });
      const { part } = await exportOnce(at);
      expect(await part.finish("site.har")).toBe("site.har");
      expect(at.fs.text(`${DOWNLOADS}/site.har`)).toBe(DOCUMENT);
      expect(inDownloads(at.fs)).toEqual([`${DOWNLOADS}/site.har`]);
      expect(part.route()).toEqual({ route: "named", because, errno });
      // The copy's first piece is up to a MiB, so the head is the file's first 128 ASCII bytes, not the opening alone.
      const path = `${DOWNLOADS}/site.har.part`;
      const head = DOCUMENT.slice(0, 128);
      expect(at.journal.lines).toEqual([{ started: path, head }, { ended: path }]);
      expect(part.unconfirmed()).toBe(false);
    },
  );

  it("a copy to a named part that fails is discarded, and the export names nothing", async () => {
    const at = held();
    at.fs.failUnnamed.set("link", { name: "EXDEV" });
    const { part } = await exportOnce(at);
    at.fs.fail.set("rename", new DOMException("x", "NotReadableError"));
    expect(await finishOrDiscard(part)).toEqual({ kind: "other" });
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.unended()).toEqual([]);
  });

  it("a short write and then a full disk on the unnamed file end disk-full, with nothing left", async () => {
    const at = held();
    at.fs.room = OPENING.length + 10;
    const rest = "x".repeat(100);
    const failure = await failureOf(
      exportOnce(at, () => undefined, rest).then(async ({ part }) => part.finish("site.har")),
    );
    expect(failure).toEqual({ kind: "disk-full", needBytes: 100, freeBytes: 0 });
    // The unnamed file took the 10 bytes that fit; closed unnamed, it is gone.
    expect(at.fs.lastUnnamed?.bytes.length).toBe(OPENING.length + 10);
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.lines).toEqual([]);
  });

  it("the copy's first write meeting a short write and then a full disk ends disk-full, with no part left", async () => {
    const at = held();
    at.fs.failUnnamed.set("link", { name: "EXDEV" });
    const { part } = await exportOnce(at);
    // About 8 KiB free when the copy starts, as in review: here 10 bytes of a document that needs more.
    at.fs.room = 10;
    expect(await finishOrDiscard(part)).toEqual({
      kind: "disk-full",
      needBytes: DOCUMENT.length,
      freeBytes: 0,
    });
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.unended()).toEqual([]);
  });

  it("a copy whose bytes are not the unnamed file's fails as copy-mismatch, with nothing left", async () => {
    const at = held();
    at.fs.failUnnamed.set("link", { name: "EXDEV" });
    at.fs.copyCorrupts = true;
    const { part } = await exportOnce(at);
    expect(await finishOrDiscard(part)).toEqual({ kind: "copy-mismatch" });
    expect(inDownloads(at.fs)).toEqual([]);
    expect(at.journal.unended()).toEqual([]);
  });

  it("cancel while the bytes move to a named part ends cancelled, with nothing left", async () => {
    const at = held();
    const { part } = await exportOnce(at);
    // The cancel comes as the link's refusal is read, so it lands while the bytes are being moved.
    at.fs.failUnnamed.set("link", {
      get name() {
        at.limits.signal.aborted = true;
        return "EXDEV";
      },
    });
    expect(await part.finish("site.har").catch((e: unknown) => e)).toBeInstanceOf(ExportCancelled);
    await part.discard();
    expect(inDownloads(at.fs)).toEqual([]);
    // Not one piece was copied after the cancel: the named part never got its first bytes, so never a journal line.
    expect(at.journal.lines).toEqual([]);
  });

  it.each([
    {
      cause: "the folder's file system makes no unnamed file",
      set: "noUnnamedFiles",
      because: "unnamed-refused",
      errno: "EOPNOTSUPP",
    },
    {
      cause: "/proc/self/fd cannot lead to the unnamed file",
      set: "noFdLink",
      because: "fd-link-unavailable",
      errno: "fd-link-unavailable",
    },
  ] as const)("names a part from the start where $cause", async ({ set, because, errno }) => {
    const at = held();
    at.fs[set] = true;
    const { part, path } = await exportOnce(at);
    expect(path).toBe(`${DOWNLOADS}/site.har.part`);
    expect(await part.finish("site.har")).toBe("site.har");
    expect(at.journal.lines).toEqual([{ started: path, head: OPENING }, { ended: path }]);
    expect(part.route()).toEqual({ route: "named", because, errno });
  });
});

describe("the proof, without a handle, that a file is an export's", () => {
  const io = (fs: MemoryFs) => fs.platform();
  it("is a regular file, not a link, that starts with the journaled head, and never reads a FIFO", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    fs.file("/d/ours.har.part", `${OPENING}{"entry"`);
    fs.file("/d/theirs.har.part", "x".repeat(OPENING.length + 10));
    fs.file("/d/short.har.part", OPENING.slice(0, 10));
    fs.link("/d/link.har.part", "/d/ours.har.part");
    fs.fifo("/d/fifo.har.part", 4096);
    fs.folder("/d/folder.har.part", 4096);
    expect(await carriesHead(io(fs), "/d/ours.har.part", OPENING)).toBe(true);
    expect(await carriesHead(io(fs), "/d/ours.har.part", OPENING, OPENING.length + 8)).toBe(true);
    expect(await carriesHead(io(fs), "/d/ours.har.part", OPENING, OPENING.length)).toBe(false);
    for (const path of [
      "/d/theirs.har.part",
      "/d/short.har.part",
      "/d/link.har.part",
      "/d/fifo.har.part",
      "/d/folder.har.part",
      "/d/missing.har.part",
    ])
      expect(await carriesHead(io(fs), path, OPENING), path).toBe(false);
    expect(await carriesHead(io(fs), "/d/ours.har.part", "")).toBe(false);
    expect(fs.fifoRead).toBe(false);
  });

  it("is refused when the file stops being a regular file during the read", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    fs.file("/d/ours.har.part", OPENING);
    const platform = fs.platform();
    const swapping = {
      state: platform.state,
      readHead: async (path: string, bytes: number) => {
        const read = await platform.readHead(path, bytes);
        fs.fifo(path, OPENING.length);
        return read;
      },
    };
    expect(await carriesHead(swapping, "/d/ours.har.part", OPENING)).toBe(false);
  });
});

describe("the export's part sink", () => {
  it("writes every piece in order, the first alone and at once, and counts UTF-8 bytes as Node encodes them", async () => {
    const appended: string[] = [];
    const reported: number[] = [];
    const sink = createPartSink(
      async (text) => void appended.push(text),
      (bytes) => reported.push(bytes),
    );
    await sink.write(OPENING);
    expect(appended).toEqual([OPENING]);
    const pieces = ['{"a":"', "x".repeat(SINK_BATCH_UNITS), "é中😀", "\ud800", '"}'];
    for (const piece of pieces) await sink.write(piece);
    await sink.close();
    const text = OPENING + pieces.join("");
    expect(appended.join("")).toBe(text);
    expect(appended.length).toBeGreaterThan(2);
    expect(sink.bytesWritten()).toBe(Buffer.byteLength(text, "utf8"));
    expect(reported.at(-1)).toBe(Buffer.byteLength(text, "utf8"));
  });
});

describe("the export journal", () => {
  it("names the parts that started and never ended, with their heads, and nothing else", () => {
    const journal = [
      journalLine({ started: "/d/a.har.part", head: OPENING }),
      journalLine({ started: "/d/b.har.part", head: OPENING }),
      journalLine({ ended: "/d/a.har.part" }),
      journalLine({ started: "/home/user/.bashrc", head: OPENING }),
      '{"started":"/d/no-head.har.part"}\n',
      journalLine({ started: "/d/empty-head.har.part", head: "" }),
      '{"started":"/d/torn.har.pa',
    ].join("");
    expect(unfinishedExports(journal)).toEqual([{ path: "/d/b.har.part", head: OPENING }]);
    expect(unfinishedExports("")).toEqual([]);
  });
});
