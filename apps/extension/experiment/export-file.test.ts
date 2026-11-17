import { WriteRefused } from "@one-click-har/export/run";
import { describe, expect, it } from "vite-plus/test";
import {
  createPartSink,
  exportFiles,
  journalLine,
  SINK_BATCH_UNITS,
  unfinishedExports,
  type ExportPlatform,
  type PathState,
} from "./export-file.ts";

/** An inode. A handle and every hard link hold the same object, so a write through a handle follows the inode. */
type Node =
  | { readonly kind: "folder" }
  | { readonly kind: "file"; bytes: number[] }
  | { readonly kind: "link"; readonly target: string };

/** A small POSIX file system: paths name inodes, links resolve, an open handle keeps writing its own inode. */
class MemoryFs {
  readonly nodes = new Map<string, Node>([["/", { kind: "folder" }]]);
  /** Errors to throw from one platform call, as the browser threw them for one cause. */
  readonly fail = new Map<keyof ExportPlatform, unknown>();

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

  folder(path: string): void {
    this.nodes.set(path, { kind: "folder" });
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
        return { kind: node.kind };
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
          close: () => undefined,
        };
      },
      readHead: async (path, bytes) => {
        const node = this.nodes.get(this.realPath(path));
        return Uint8Array.from(node?.kind === "file" ? node.bytes.slice(0, bytes) : []);
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
        this.nodes.delete(this.resolveParent(path));
      },
      freeBytes: () => 1 << 30,
    };
  }
}

const PROFILE = "/home/u/profile";
const DOWNLOADS = "/home/u/Downloads";

const setup = () => {
  const fs = new MemoryFs();
  for (const folder of ["/home", "/home/u", PROFILE, DOWNLOADS]) fs.folder(folder);
  fs.file(`${PROFILE}/prefs.js`, "user_pref(1);");
  const files = exportFiles(fs.platform(), (real) => !real.startsWith(PROFILE));
  return { fs, files };
};

const failureOf = async (call: Promise<unknown>): Promise<unknown> => {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WriteRefused);
  return (error as WriteRefused).failure;
};

/** Writes `text` through a new part and finishes it, with `between` run while the part is open. */
const exportOnce = async (
  files: ReturnType<typeof exportFiles>,
  text: string,
  between: (path: string) => void = () => undefined,
) => {
  const folder = await files.openFolder(DOWNLOADS);
  const { part, path } = await folder.createPart("site.har", async () => undefined);
  await part.append(text.slice(0, 5), 5);
  between(path);
  await part.append(text.slice(5), text.length - 5);
  return { part, path };
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
  it.each(CAUSES)("reports $cause as $kind, with no text", async ({ call, error, kind }) => {
    const { fs, files } = setup();
    fs.fail.set(call, error);
    const failure = await failureOf(
      exportOnce(files, '{"log":{}}').then(({ part }) => part.finish("site.har")),
    );
    expect(failure).toEqual({ kind });
  });

  it("reports a full disk with the bytes a write needed and the free bytes", async () => {
    const fs = new MemoryFs();
    fs.folder("/d");
    const platform = { ...fs.platform(), freeBytes: () => 4096 };
    const files = exportFiles(platform, () => true);
    const folder = await files.openFolder("/d");
    const { part } = await folder.createPart("a.har", async () => undefined);
    fs.fail.set("createExclusive", { name: "NS_ERROR_FILE_NO_DEVICE_SPACE" });
    expect(await failureOf(part.append("x".repeat(10_000), 10_000))).toEqual({
      kind: "disk-full",
      needBytes: 10_000,
      freeBytes: 4096,
    });
  });

  it("finishes a part written through its handle, under the planned name", async () => {
    const { fs, files } = setup();
    const { part } = await exportOnce(files, '{"log":{"entries":[]}}');
    expect(await part.finish("site.har")).toBe("site.har");
    expect(fs.text(`${DOWNLOADS}/site.har`)).toBe('{"log":{"entries":[]}}');
    expect(fs.nodes.has(`${DOWNLOADS}/site.har.part`)).toBe(false);
  });

  it("writes nothing through a part replaced by a link, a regular file or a hard link, and reports file-replaced", async () => {
    const attacks: readonly ((fs: MemoryFs, path: string) => void)[] = [
      (fs, path) => fs.link(path, `${PROFILE}/prefs.js`),
      (fs, path) => fs.file(path, "attacker's own file"),
      (fs, path) => fs.file(path, "x".repeat('{"log":{"entries":[]}}'.length)),
      (fs, path) => fs.nodes.set(path, fs.nodes.get(`${PROFILE}/prefs.js`)!),
    ];
    for (const attack of attacks) {
      const { fs, files } = setup();
      const { part } = await exportOnce(files, '{"log":{"entries":[]}}', (path) =>
        attack(fs, path),
      );
      expect(await failureOf(part.finish("site.har"))).toEqual({ kind: "file-replaced" });
      expect(fs.text(`${PROFILE}/prefs.js`)).toBe("user_pref(1);");
      expect(fs.nodes.has(`${DOWNLOADS}/site.har`)).toBe(false);
    }
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
    const { part } = await exportOnce(later.files, "{}", () => {
      later.fs.nodes.delete(DOWNLOADS);
      later.fs.link(DOWNLOADS, PROFILE);
    });
    expect(await failureOf(part.finish("site.har"))).toEqual({ kind: "folder-refused" });
    expect([...later.fs.nodes.keys()].filter((p) => p.startsWith(PROFILE))).toEqual([
      PROFILE,
      `${PROFILE}/prefs.js`,
    ]);
  });

  it("never overwrites: a part or final name already taken, even by a dangling link, moves on to the next number", async () => {
    const { fs, files } = setup();
    fs.file(`${DOWNLOADS}/site.har`, "theirs");
    fs.file(`${DOWNLOADS}/site.har.part`, "a stale part");
    fs.link(`${DOWNLOADS}/site (2).har.part`, "/nowhere");
    const { part, path } = await exportOnce(files, "{}0123", () =>
      fs.file(`${DOWNLOADS}/site (2).har`, "also theirs"),
    );
    expect(path).toBe(`${DOWNLOADS}/site (3).har.part`);
    expect(await part.finish("site.har")).toBe("site (3).har");
    expect(fs.text(`${DOWNLOADS}/site.har`)).toBe("theirs");
    expect(fs.text(`${DOWNLOADS}/site.har.part`)).toBe("a stale part");
    expect(fs.text(`${DOWNLOADS}/site (2).har`)).toBe("also theirs");
    expect(fs.text(`${DOWNLOADS}/site (3).har`)).toBe("{}0123");
  });

  it("discards only its own folder's part, and nothing through a folder that became a link", async () => {
    const { fs, files } = setup();
    const { part, path } = await exportOnce(files, "{}0123");
    await part.discard();
    expect(fs.nodes.has(path)).toBe(false);
    const later = setup();
    later.fs.file(`${PROFILE}/site.har.part`, "profile file");
    const second = await exportOnce(later.files, "{}0123", () => {
      later.fs.nodes.delete(DOWNLOADS);
      later.fs.link(DOWNLOADS, PROFILE);
    });
    await second.part.discard();
    expect(later.fs.text(`${PROFILE}/site.har.part`)).toBe("profile file");
  });
});

describe("the export's part sink", () => {
  it("writes every piece in order and counts UTF-8 bytes as Node encodes them", async () => {
    const appended: string[] = [];
    const reported: number[] = [];
    const sink = createPartSink(
      async (text) => void appended.push(text),
      (bytes) => reported.push(bytes),
    );
    const pieces = ['{"a":"', "x".repeat(SINK_BATCH_UNITS), "é中😀", "\ud800", '"}'];
    for (const piece of pieces) await sink.write(piece);
    await sink.close();
    const text = pieces.join("");
    expect(appended.join("")).toBe(text);
    expect(appended.length).toBeGreaterThan(1);
    expect(sink.bytesWritten()).toBe(Buffer.byteLength(text, "utf8"));
    expect(reported.at(-1)).toBe(Buffer.byteLength(text, "utf8"));
  });
});

describe("the export journal", () => {
  it("names the parts that started and never ended, and nothing else", () => {
    const journal = [
      journalLine("started", "/d/a.har.part"),
      journalLine("started", "/d/b.har.part"),
      journalLine("ended", "/d/a.har.part"),
      journalLine("started", "/home/user/.bashrc"),
      '{"started":"/d/torn.har.pa',
    ].join("");
    expect(unfinishedExports(journal)).toEqual(["/d/b.har.part"]);
    expect(unfinishedExports("")).toEqual([]);
  });
});
