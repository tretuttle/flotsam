import { WriteRefused } from "@one-click-har/export/run";
import { describe, expect, it } from "vite-plus/test";
import {
  carriesHead,
  createPartSink,
  exportFiles,
  journalLine,
  SINK_BATCH_UNITS,
  unfinishedExports,
  type ExportPlatform,
  type JournaledPart,
  type JournalEntry,
  type Part,
  type PartJournal,
  type PathState,
} from "./export-file.ts";

/**
 * An inode. A handle and every hard link hold the same object, so a write through a handle follows the inode. A folder
 * or FIFO may report any size, so a check can be shown to hold without the size agreeing by luck.
 */
type Node =
  | { readonly kind: "folder"; readonly size?: number }
  | { readonly kind: "fifo"; readonly size: number }
  | { readonly kind: "file"; bytes: number[] }
  | { readonly kind: "link"; readonly target: string };

/** A small POSIX file system: paths name inodes, links resolve, an open handle keeps writing its own inode. */
class MemoryFs {
  readonly nodes = new Map<string, Node>([["/", { kind: "folder" }]]);
  /** Errors to throw from one platform call, as the browser threw them for one cause. */
  readonly fail = new Map<keyof ExportPlatform, unknown>();
  /** Set when a FIFO is opened to be read, which on a real system blocks until something writes to it. */
  fifoOpened = false;

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
  file(path: string, text: string): Node {
    const node: Node = { kind: "file", bytes: [...Buffer.from(text)] };
    this.nodes.set(path, node);
    return node;
  }
  link(path: string, target: string): void {
    this.nodes.set(path, { kind: "link", target });
  }
  text(path: string): string {
    const node = this.nodes.get(this.realPath(path));
    return node?.kind === "file" ? Buffer.from(node.bytes).toString() : "";
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
        return { kind: node.kind === "fifo" ? "other" : "folder", size: node.size ?? 4096 };
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
        const node = this.file(at, "") as Extract<Node, { kind: "file" }>;
        return {
          write: (text) => {
            this.check("createExclusive");
            node.bytes.push(...Buffer.from(text));
          },
          flush: () => undefined,
          close: () => undefined,
        };
      },
      readHead: async (path, bytes) => {
        const node = this.nodes.get(this.realPath(path));
        if (node?.kind === "fifo") {
          this.fifoOpened = true;
          throw new Error("a FIFO was opened: this read blocks forever");
        }
        if (node?.kind !== "file") throw new DOMException("x", "NotReadableError");
        return Uint8Array.from(node.bytes.slice(0, bytes));
      },
      rename: async (from, to) => {
        this.check("rename");
        const target = this.resolveParent(to);
        if (this.nodes.has(target)) throw new DOMException("x", "NoModificationAllowedError");
        const source = this.resolveParent(from);
        const node = this.nodes.get(source);
        if (node === undefined) throw new DOMException("x", "NotFoundError");
        this.nodes.delete(source);
        this.nodes.set(target, node);
      },
      remove: async (path) => {
        this.check("remove");
        this.nodes.delete(this.resolveParent(path));
      },
      freeBytes: () => 1 << 30,
    };
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
  const files = exportFiles(fs.platform(), (real) => !real.startsWith(PROFILE));
  return { fs, files, journal: new MemoryJournal() };
};

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
  { files, journal }: { files: ReturnType<typeof exportFiles>; journal: MemoryJournal },
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
    cause: "an I/O error the table does not name, on purpose",
    call: "rename",
    error: { name: "NS_ERROR_FILE_DEVICE_FAILURE" },
    kind: "other",
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
      expect([...at.fs.nodes.keys()].filter((p) => p.startsWith(`${DOWNLOADS}/`))).toEqual([]);
    },
  );

  it("reports a full disk with the bytes a write needed and the free bytes", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    const platform = { ...fs.platform(), freeBytes: () => 4096 };
    const files = exportFiles(platform, () => true);
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
   * Each replacement agrees with the export's part in all but one of kind, size and first bytes. One that is a regular
   * file starting with the export's first bytes carries its random id, so the discard takes it for the part.
   */
  const ONE_DIFFERENCE: readonly {
    readonly seenBy: "kind" | "size" | "first bytes";
    readonly replacement: string;
    readonly make: (fs: MemoryFs, path: string) => void;
    readonly discarded: boolean;
  }[] = [
    {
      seenBy: "first bytes",
      replacement: "a regular file of the part's size",
      make: (fs, p) => fs.file(p, "x".repeat(DOCUMENT.length)),
      discarded: false,
    },
    {
      seenBy: "size",
      replacement: "a regular file with the part's first bytes",
      make: (fs, p) => fs.file(p, `${OPENING}tail`),
      discarded: true,
    },
    {
      seenBy: "kind",
      replacement: "a folder reporting the part's size",
      make: (fs, p) => fs.folder(p, DOCUMENT.length),
      discarded: false,
    },
    {
      seenBy: "kind",
      replacement: "a FIFO reporting the part's size",
      make: (fs, p) => fs.nodes.set(p, { kind: "fifo", size: DOCUMENT.length }),
      discarded: false,
    },
  ];
  it.each(ONE_DIFFERENCE)(
    "only the $seenBy check sees $replacement; discarded as the part: $discarded",
    async ({ make, discarded }) => {
      const at = setup();
      const { part, path } = await exportOnce(at, (p) => make(at.fs, p));
      const replacement = at.fs.nodes.get(path);
      expect(await finishOrDiscard(part)).toEqual({ kind: "file-replaced" });
      expect(at.fs.fifoOpened).toBe(false);
      expect(at.fs.nodes.has(`${DOWNLOADS}/site.har`)).toBe(false);
      expect(at.fs.nodes.get(path)).toBe(discarded ? undefined : replacement);
      expect(at.journal.unended()).toEqual([]);
    },
  );

  it("a replacement of the same kind, size and first bytes is renamed into the folder as it is, and nothing outside changes", async () => {
    const copy = setup();
    const a = await exportOnce(copy, (p) => copy.fs.file(p, `${OPENING}]}]`));
    expect(await a.part.finish("site.har")).toBe("site.har");
    expect(copy.fs.text(`${DOWNLOADS}/site.har`)).toBe(`${OPENING}]}]`);

    const linked = setup();
    linked.fs.file("/home/u/notes.txt", `${OPENING}]}]`);
    const outside = linked.fs.nodes.get("/home/u/notes.txt");
    const b = await exportOnce(linked, (p) => linked.fs.nodes.set(p, outside!));
    expect(await b.part.finish("site.har")).toBe("site.har");
    expect(linked.fs.text("/home/u/notes.txt")).toBe(`${OPENING}]}]`);
    expect(linked.fs.nodes.get(`${DOWNLOADS}/site.har`)).toBe(outside);
    expect(linked.fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
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
    later.fs.file(`${PROFILE}/site.har.part`, OPENING);
    const second = await exportOnce(later, () => {
      later.fs.nodes.delete(DOWNLOADS);
      later.fs.link(DOWNLOADS, PROFILE);
    });
    await second.part.discard();
    expect(later.fs.text(`${PROFILE}/site.har.part`)).toBe(OPENING);

    const stuck = setup();
    const third = await exportOnce(stuck);
    stuck.fs.fail.set("remove", new DOMException("x", "NotAllowedError"));
    await third.part.discard();
    expect(stuck.fs.text(third.path)).toBe(DOCUMENT);
    expect(stuck.journal.unended()).toEqual([{ path: third.path, head: OPENING }]);
  });

  it("before its opening is journaled, a part is discarded while it holds no more than that opening", async () => {
    const at = setup();
    const folder = await at.files.openFolder(DOWNLOADS);
    const { part, path } = await folder.createPart("site.har", at.journal);
    await part.discard();
    expect(at.fs.nodes.has(path)).toBe(false);
    expect(at.journal.lines).toEqual([]);
  });
});

describe("the proof recovery asks for before it deletes a part", () => {
  const io = (fs: MemoryFs) => fs.platform();
  it("is a regular file, not a link, that starts with the journaled head", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    fs.file("/d/ours.har.part", `${OPENING}{"entry"`);
    fs.file("/d/theirs.har.part", "x".repeat(OPENING.length + 10));
    fs.file("/d/short.har.part", OPENING.slice(0, 10));
    fs.link("/d/link.har.part", "/d/ours.har.part");
    fs.nodes.set("/d/fifo.har.part", { kind: "fifo", size: 4096 });
    fs.folder("/d/folder.har.part", 4096);
    expect(await carriesHead(io(fs), "/d/ours.har.part", OPENING)).toBe(true);
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
    expect(fs.fifoOpened).toBe(false);
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
