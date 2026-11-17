import { WriteRefused } from "@one-click-har/export/run";
import { describe, expect, it } from "vite-plus/test";
import {
  carriesHead,
  createPartSink,
  ExportCancelled,
  exportFiles,
  journalLine,
  SINK_BATCH_UNITS,
  unfinishedExports,
  type ExportLimits,
  type ExportPlatform,
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

  realPath = (path: string, depth = 0): string => {
    if (depth > 20)
      throw Object.assign(new Error("loop"), { name: "NS_ERROR_FILE_UNRESOLVABLE_SYMLINK" });
    const resolved = this.resolveParent(path);
    const node = this.nodes.get(resolved);
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
            node.bytes.push(...Buffer.from(text));
          },
          flush: () => undefined,
          size: () => node.bytes.length,
          readHead: (bytes) => Uint8Array.from(node.bytes.slice(0, bytes)),
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
      },
      remove: async (path) => {
        this.check("remove");
        this.nodes.delete(this.resolveParent(path));
      },
      freeBytes: () => 1 << 30,
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

const setup = () => {
  const fs = new MemoryFs();
  for (const folder of ["/home", "/home/u", PROFILE, DOWNLOADS]) fs.folder(folder);
  fs.file(`${PROFILE}/prefs.js`, "user_pref(1);");
  const limits = new Limits();
  const files = exportFiles(fs.platform(), (real) => !real.startsWith(PROFILE), limits);
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

/**
 * What happens between the pre-rename check and the rename, and how the export must end. The kind is written here.
 * `left` is every name under the export folder afterwards: a replacement is put back where it was found.
 */
const BEFORE_RENAME: readonly {
  readonly cause: string;
  readonly act: (fs: MemoryFs, path: string) => void;
  readonly kind: string;
  readonly left: readonly string[];
}[] = [
  {
    cause: "the folder is deleted",
    act: (fs) => fs.removeTree(DOWNLOADS),
    kind: "folder-missing",
    left: [],
  },
  {
    cause: "the folder is replaced by a link to the profile",
    act: (fs) => {
      fs.nodes.set("/home/u/moved", fs.nodes.get(DOWNLOADS)!);
      for (const key of [...fs.nodes.keys()].filter((k) => k.startsWith(`${DOWNLOADS}/`))) {
        fs.nodes.set(key.replace(DOWNLOADS, "/home/u/moved"), fs.nodes.get(key)!);
        fs.nodes.delete(key);
      }
      fs.nodes.delete(DOWNLOADS);
      fs.link(DOWNLOADS, PROFILE);
    },
    kind: "folder-refused",
    left: [],
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
    async ({ act, kind, left }) => {
      const at = setup();
      const { part, path } = await exportOnce(at);
      const held = at.fs.hold("rename");
      const finished = failureOf(part.finish("site.har"));
      await held.reached;
      act(at.fs, path);
      const replacement = at.fs.nodes.get(path);
      held.release();
      expect(await finished).toEqual({ kind });
      await part.discard();
      expect(inDownloads(at.fs)).toEqual(left);
      if (left.length > 0) expect(at.fs.nodes.get(path)).toBe(replacement);
      expect(at.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
      expect([...at.fs.nodes.keys()].filter((p) => p.startsWith(`${PROFILE}/`))).toEqual([
        `${PROFILE}/prefs.js`,
      ]);
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

  it("a regular file of the written length that takes the part's name during the rename itself is renamed in, and nothing outside changes", async () => {
    const at = setup();
    at.fs.file("/home/u/notes.txt", DOCUMENT);
    const outside = at.fs.nodes.get("/home/u/notes.txt");
    const { part, path } = await exportOnce(at);
    const held = at.fs.hold("rename");
    const finished = part.finish("site.har");
    await held.reached;
    at.fs.nodes.set(path, outside!);
    held.release();
    expect(await finished).toBe("site.har");
    expect(at.fs.nodes.get(`${DOWNLOADS}/site.har`)).toBe(outside);
    expect(at.fs.text("/home/u/notes.txt")).toBe(DOCUMENT);
    expect(at.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
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
