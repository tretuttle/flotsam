import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { RunNames, Structured } from "./content.ts";
import {
  diffSnapshots,
  diskProblems,
  hardLinks,
  inProductArea,
  pruneStructured,
  readChangedStructured,
  snapshotTree,
  type DiskChange,
  type DiskEntry,
  type DiskEvidence,
  type RunDisk,
} from "./disk.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-disk-"));
  made.push(dir);
  return dir;
};

const KEY = "0123456789abcdef0123456789abcdef";
const AREA = { archiveKey: KEY, keyFileName: "one-click-har.archive-key" };

const file = (digest = "d0", more: Partial<DiskEntry> = {}): DiskEntry => ({
  kind: "file",
  size: 3,
  mode: 0o644,
  nlink: 1,
  link: null,
  digest,
  marked: null,
  ...more,
});
const dir: DiskEntry = {
  kind: "directory",
  size: 0,
  mode: 0o700,
  nlink: 2,
  link: null,
  digest: null,
  marked: null,
};
const link = (to: string): DiskEntry => ({
  kind: "symlink",
  size: 1,
  mode: 0o777,
  nlink: 1,
  link: to,
  digest: null,
  marked: null,
});
const added = (path: string, entry: DiskEntry = file()): DiskChange => ({
  path,
  change: "new",
  entry,
});

const run = (final: readonly DiskChange[], more: Partial<RunDisk> = {}): RunDisk => ({
  plan: [],
  probes: [],
  final,
  structured: {},
  names: [],
  harness: {},
  ...more,
});
const evidence = (
  product: RunDisk,
  controls: readonly [RunDisk, RunDisk],
  probed: readonly string[] = [],
): DiskEvidence => ({
  product,
  controls,
  area: AREA,
  probed,
});
const prefs = (...names: string[]): Structured => ({
  format: "prefs",
  entries: Object.fromEntries(
    names.map((n) => [`pref ${n}`, { fields: ["value"], rows: [["1"]] }]),
  ),
  unaccounted: 0,
});

describe("disk snapshot", () => {
  it("records a link as a link with its target text, and never follows it", () => {
    const root = scratch();
    NodeFS.mkdirSync(NodePath.join(root, "archive"));
    NodeFS.writeFileSync(NodePath.join(root, "archive", "log.jsonl"), "secret", { mode: 0o600 });
    NodeFS.symlinkSync(NodePath.join(root, "archive"), NodePath.join(root, "link"));
    const snap = snapshotTree(root, { names: [], marker: "SECRET" });
    expect(Object.keys(snap)).toEqual(["archive", "archive/log.jsonl", "link"]);
    expect(snap["link"]).toMatchObject({
      kind: "symlink",
      link: NodePath.join(root, "archive"),
      digest: null,
    });
    expect(snap["archive/log.jsonl"]).toMatchObject({
      kind: "file",
      size: 6,
      mode: 0o600,
      nlink: 1,
      marked: false,
    });
    NodeFS.writeFileSync(NodePath.join(root, "archive", "log.jsonl"), "a SECRET line");
    expect(snapshotTree(root, { marker: "SECRET" })["archive/log.jsonl"]).toMatchObject({
      marked: true,
      digest: null,
    });
    expect(snapshotTree(root)["archive/log.jsonl"]).toMatchObject({ marked: null, digest: null });
    expect(snap["archive"]).toMatchObject({ kind: "directory", size: 0, digest: null });
  });

  it("digests a file's bytes with the run's names replaced, and only when given names", async () => {
    const root = scratch();
    const path = NodePath.join(root, "f");
    NodeFS.writeFileSync(path, `${root}/x`);
    NodeFS.chmodSync(path, 0o751);
    NodeFS.linkSync(path, NodePath.join(root, "g"));
    const server = NodeNet.createServer();
    await new Promise<void>((resolve) => server.listen(NodePath.join(root, "s"), resolve));
    try {
      const names: RunNames = [[root, "{workspace}"]];
      const snap = snapshotTree(root, { names });
      expect(snap["f"]).toMatchObject({ kind: "file", mode: 0o751, nlink: 2, link: null });
      expect(snap["f"]?.digest).toBe(
        snapshotTree(root, { names: [[root, "{workspace}"]] })["g"]?.digest,
      );
      const other = scratch();
      NodeFS.writeFileSync(NodePath.join(other, "f"), `${other}/x`);
      expect(snapshotTree(other, { names: [[other, "{workspace}"]] })["f"]?.digest).toBe(
        snap["f"]?.digest,
      );
      expect(snapshotTree(root)["f"]?.digest).toBeNull();
      expect(snap["s"]?.kind).toBe("other");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reports new paths and changed files, but not a directory whose children changed", () => {
    const before = { a: file(), d: dir, l: link("x") };
    const after = { a: file("d1"), d: { ...dir, size: 9 }, l: link("y"), n: file(), m: file() };
    expect(diffSnapshots(before, after).map((c) => `${c.change} ${c.path}`)).toEqual([
      "changed a",
      "changed l",
      "new n",
      "new m",
    ]);
    for (const changed of [{ size: 4 }, { mode: 0o600 }, { nlink: 2 }, { kind: "other" as const }])
      expect(diffSnapshots(before, { ...before, a: file("d0", changed) })).toHaveLength(1);
    expect(diffSnapshots(before, { ...before, d: file() })).toHaveLength(1);
    expect(diffSnapshots(before, before)).toEqual([]);
    expect(diffSnapshots({}, { n: file() })).toEqual([{ path: "n", change: "new", entry: file() }]);
  });

  it("reads the entries of every changed file whose format it knows, and only those", () => {
    const root = scratch();
    NodeFS.writeFileSync(NodePath.join(root, "prefs.js"), 'user_pref("a", 1);\n');
    NodeFS.writeFileSync(NodePath.join(root, "blob.bin"), "\u0000\u0001");
    const read = readChangedStructured(
      root,
      [added("prefs.js"), added("blob.bin"), added("d", dir)],
      [],
    );
    expect(Object.keys(read)).toEqual(["prefs.js"]);
    expect(read["prefs.js"]?.format).toBe("prefs");
  });
});

describe("the product run against two control runs", () => {
  const same = run([added("profile/prefs.js", file("p")), added("profile/storage/x", file("s"))]);

  it("holds when every path, kind, mode and set of bytes matches either control run", () => {
    expect(diskProblems(evidence(same, [same, same]))).toEqual([]);
    const other = run([
      added("profile/prefs.js", file("q")),
      added("profile/storage/x", file("s")),
    ]);
    expect(diskProblems(evidence(other, [same, other]))).toEqual([]);
  });

  it("fails a path neither control run wrote, or one unlike both in kind, mode or link", () => {
    const product = run([
      ...same.final,
      added("profile/leaked.jsonl"),
      added("profile/storage/x2", dir),
    ]);
    expect(diskProblems(evidence(product, [same, same]))).toEqual([
      "new file profile/leaked.jsonl: outside the product's places, and neither control run wrote it",
      "new directory profile/storage/x2: outside the product's places, and neither control run wrote it",
    ]);
    for (const unlike of [file("p", { mode: 0o600 }), dir, link("/w/data")]) {
      expect(
        diskProblems(evidence(run([added("profile/prefs.js", unlike)]), [same, same])),
      ).toEqual([
        `new ${unlike.kind} profile/prefs.js${unlike.link === null ? "" : ` -> ${unlike.link}`}: unlike what either control run left there in kind, mode or link`,
      ]);
    }
  });

  it("fails bytes the two control runs agree on and the product run changed, and leaves noise alone", () => {
    const appended = run([
      added("profile/prefs.js", file("p+leak")),
      added("profile/storage/x", file("s")),
    ]);
    expect(diskProblems(evidence(appended, [same, same]))).toEqual([
      "new file profile/prefs.js: bytes differ from both control runs, which agree",
    ]);
    const noisy = run([
      added("profile/prefs.js", file("p2")),
      added("profile/storage/x", file("s")),
    ]);
    expect(diskProblems(evidence(appended, [same, noisy]))).toEqual([]);
    const onlyOne = run([added("profile/storage/x", file("s"))]);
    expect(diskProblems(evidence(appended, [same, onlyOne]))).toEqual([]);
  });

  it("compares a readable file entry by entry even where both control runs differ", () => {
    const control = (digest: string, structured: Structured): RunDisk =>
      run([added("profile/prefs.js", file(digest))], {
        structured: { "profile/prefs.js": structured },
      });
    const product = control("p3", prefs("a", "leaked"));
    expect(
      diskProblems(evidence(product, [control("p1", prefs("a")), control("p2", prefs("a"))])),
    ).toEqual(["profile/prefs.js: pref leaked: in neither control run"]);
    expect(
      diskProblems(
        evidence(control("p3", prefs("a")), [control("p1", prefs("a")), control("p2", prefs("a"))]),
      ),
    ).toEqual([]);
    const padded: Structured = { ...prefs("a"), format: "sqlite", unaccounted: 16 };
    expect(
      diskProblems(
        evidence(control("p3", padded), [control("p1", prefs("a")), control("p2", prefs("a"))]),
      ),
    ).toEqual(["profile/prefs.js: 16 bytes past its last page"]);
  });

  it("judges a database's journal and write-ahead log through the database", () => {
    const db: Structured = { format: "sqlite", entries: {}, unaccounted: 0 };
    const product = run(
      [added("profile/places.sqlite-wal", file("w9")), added("profile/places.sqlite", file("x"))],
      {
        structured: { "profile/places.sqlite": db },
      },
    );
    const control = run([added("profile/places.sqlite", file("x"))], {
      structured: { "profile/places.sqlite": db },
    });
    expect(diskProblems(evidence(product, [control, control]))).toEqual([]);
    const loose = run([added("profile/places.sqlite-wal", file("w9"))]);
    expect(diskProblems(evidence(loose, [control, control]))).toHaveLength(1);
  });

  it("matches a path and a link by the run's roles, never by the run's own names", () => {
    const names: RunNames = [
      ["U1", "{recorder-uuid}"],
      ["/w1", "{workspace}"],
    ];
    const theirs: RunNames = [
      ["C1", "{recorder-uuid}"],
      ["/w2", "{workspace}"],
    ];
    const product = run(
      [added("profile/storage/moz-extension+++U1", dir), added("home/l", link("/w1/x"))],
      { names },
    );
    const control = run(
      [added("profile/storage/moz-extension+++C1", dir), added("home/l", link("/w2/x"))],
      { names: theirs },
    );
    expect(diskProblems(evidence(product, [control, control]))).toEqual([]);
    expect(diskProblems(evidence(run(product.final), [control, control]))).toHaveLength(2);
  });
});

describe("pruning the recorded entries", () => {
  it("keeps entries only for files whose bytes differ from both control runs, in every run", () => {
    const s = prefs("a");
    const names: RunNames = [["/w1", "{workspace}"]];
    const product = run([added("/w1/p", file("p9")), added("q", file("q1"))], {
      names,
      structured: { "/w1/p": s, q: s },
    });
    const control = run([added("/w2/p", file("p1")), added("q", file("q1"))], {
      names: [["/w2", "{workspace}"]],
      structured: { "/w2/p": s, q: s },
    });
    const kept = pruneStructured(product, [control, control]);
    expect(kept.map((r) => Object.keys(r.structured))).toEqual([["/w1/p"], ["/w2/p"], ["/w2/p"]]);
    expect(kept[0].final).toBe(product.final);
  });
});

describe("the product's places", () => {
  const nobody = run([]);
  const check = (
    writes: readonly DiskChange[],
    probed: readonly string[] = [],
  ): readonly string[] => diskProblems(evidence(run(writes), [nobody, nobody], probed));

  it("allows the app folder, the key folder, the key file and a probed export, private, with one link", () => {
    const writes = [
      added("data/one-click-har", dir),
      added(`data/one-click-har/${KEY}`, dir),
      added(`data/one-click-har/${KEY}/sites`, dir),
      added(
        `data/one-click-har/${KEY}/sites/bank.example/log/r-0.jsonl`,
        file("l", { mode: 0o600 }),
      ),
      added("profile/one-click-har.archive-key", file("k", { mode: 0o600 })),
      added("downloads/bank.example-2026-11-16.har", file("e", { mode: 0o600 })),
    ];
    expect(
      check(writes, ["profile/one-click-har.archive-key", "downloads/bank.example-2026-11-16.har"]),
    ).toEqual([]);
    expect(writes.every((w) => inProductArea(w, AREA))).toBe(true);
  });

  it("fails another mode, a second link, or a key file or export the plan never probed", () => {
    expect(
      check([
        added(`data/one-click-har/${KEY}/x.jsonl`, file("x", { mode: 0o640 })),
        added(`data/one-click-har/${KEY}/d`, { ...dir, mode: 0o755 }),
        added("data/one-click-har", { ...dir, mode: 0o750 }),
        added(`data/one-click-har/${KEY}/h.jsonl`, file("h", { mode: 0o600, nlink: 2 })),
        added("downloads/late.har", file("e", { mode: 0o600 })),
      ]),
    ).toEqual([
      `new file data/one-click-har/${KEY}/x.jsonl: mode 640, not 600`,
      `new directory data/one-click-har/${KEY}/d: mode 755, not 700`,
      "new directory data/one-click-har: mode 750, not 700",
      `new file data/one-click-har/${KEY}/h.jsonl: 2 links`,
      "new file downloads/late.har: written after the plan, so never probed",
      `data/one-click-har/${KEY}/h.jsonl has 2 links`,
    ]);
  });

  it("keeps everything else out of the product's places, anchored at both ends", () => {
    const outside = [
      added("downloads/notes.txt"),
      added("downloads/x/y.har"),
      added("downloads/export.har", link("/elsewhere")),
      added("data/one-click-har/sites", dir),
      added(`data/one-click-har/${KEY}-other`, dir),
      added(`data/one-click-har/${"f".repeat(32)}/x`),
      added(`data/one-click-har/${KEY}/link`, link("/")),
      added("profile/one-click-harXarchive-key"),
      added("profile/one-click-har.archive-key.bak"),
      added(`data/one-click-har/${KEY}`),
      added("data/one-click-harX", dir),
      added("Xdata/one-click-har", dir),
      added("downloads/.har"),
      added("downloads/a.harX"),
      added(`Xdata/one-click-har/${KEY}/x`),
      added(`x/data/one-click-har/${KEY}`, dir),
      added("home/one-click-har.archive-key"),
    ];
    expect(outside.filter((w) => inProductArea(w, AREA))).toEqual([]);
  });
});

describe("the harness's files, hard links, and files that came and went", () => {
  it("holds a harness file to the harness's own bytes", () => {
    const harness = { "profile/extensions/rec.xpi": "x1" };
    const nobody = run([]);
    expect(
      diskProblems(
        evidence(run([added("profile/extensions/rec.xpi", file("x1"))], { harness }), [
          nobody,
          nobody,
        ]),
      ),
    ).toEqual([]);
    expect(
      diskProblems(
        evidence(run([added("profile/extensions/rec.xpi", file("x2"))], { harness }), [
          nobody,
          nobody,
        ]),
      ),
    ).toEqual(["new file profile/extensions/rec.xpi: the harness wrote it, and its bytes changed"]);
  });

  it("names every hard link once, in any snapshot, and never a folder", () => {
    expect(
      hardLinks([
        added("profile/storage/x", file("x", { nlink: 2 })),
        added("profile/storage/x", file("x", { nlink: 2 })),
        added("profile/l", { ...link("y"), nlink: 3 }),
        added("profile/d", { ...dir, nlink: 5 }),
        added("profile/one", file()),
      ]),
    ).toEqual(["profile/storage/x has 2 links", "profile/l has 3 links"]);
    const linked = added("profile/storage/x", file("x", { nlink: 2 }));
    const control = run([added("profile/storage/x", file("x"))]);
    expect(diskProblems(evidence(run([], { plan: [linked] }), [control, control]))).toEqual([
      "profile/storage/x has 2 links",
    ]);
  });

  it("fails a file that held recorded data and came and went, unless a control run made it too", () => {
    const transient = added("profile/leaked-ephemeral.jsonl", file("t", { marked: true }));
    const control = run([added("profile/places.sqlite")], {
      probes: [added("profile/prefs-1.js")],
    });
    expect(
      diskProblems(
        evidence(run([], { plan: [transient], probes: [transient] }), [control, control]),
      ),
    ).toEqual([
      "new file profile/leaked-ephemeral.jsonl: held recorded data and came and went during the run, more such files in its folder than either control run made",
    ]);
    const part = (name: string): DiskChange =>
      added(`downloads/${name}.part`, file(name, { marked: true }));
    const downloading = run([], { probes: [part("AAAA")] });
    expect(
      diskProblems(evidence(run([], { probes: [part("BBBB")] }), [downloading, control])),
    ).toEqual([]);
    expect(
      diskProblems(
        evidence(run([], { plan: [part("BBBB")], probes: [part("CCCC")] }), [downloading, control]),
      ),
    ).toEqual([
      "new file downloads/BBBB.part: held recorded data and came and went during the run, more such files in its folder than either control run made",
      "new file downloads/CCCC.part: held recorded data and came and went during the run, more such files in its folder than either control run made",
    ]);
    const kept = run([part("AAAA")], { probes: [part("AAAA")] });
    expect(
      diskProblems(evidence(run([], { probes: [part("BBBB")] }), [kept, control])),
    ).toHaveLength(1);
    const unmarked = added("downloads/UTqe--NX.part", file("u", { marked: false }));
    expect(diskProblems(evidence(run([], { probes: [unmarked] }), [control, control]))).toEqual([]);
    const marked = file("m", { marked: true });
    const known = run([], {
      probes: [added("profile/prefs-1.js", marked), added("profile/places.sqlite-journal", marked)],
    });
    expect(diskProblems(evidence(known, [control, control]))).toEqual([]);
    const own = run([], {
      plan: [
        added(`data/one-click-har/${KEY}/tmp.jsonl`, file("t", { mode: 0o600, marked: true })),
      ],
    });
    expect(diskProblems(evidence(own, [control, control]))).toEqual([]);
    const stays = run([transient], { plan: [transient] });
    expect(diskProblems(evidence(stays, [control, control]))).toHaveLength(1);
  });
});
