import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  beyondControl,
  diffSnapshots,
  diskProblems,
  hardLinks,
  inProductArea,
  productWriteProblems,
  snapshotTree,
  type DiskChange,
  type DiskEntry,
  type DiskEvidence,
  type RunChanges,
} from "./disk.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const KEY = "0123456789abcdef0123456789abcdef";
const AREA = { archiveKey: KEY, keyFileName: "one-click-har.archive-key" };

const file: DiskEntry = { kind: "file", size: 3, mtimeMs: 1, mode: 0o600, nlink: 1, link: null };
const dir: DiskEntry = {
  kind: "directory",
  size: 0,
  mtimeMs: 1,
  mode: 0o700,
  nlink: 2,
  link: null,
};
const link = (to: string): DiskEntry => ({
  kind: "symlink",
  size: 1,
  mtimeMs: 1,
  mode: 0o777,
  nlink: 1,
  link: to,
});
const added = (path: string, entry: DiskEntry = file): DiskChange => ({
  path,
  change: "new",
  entry,
});
const run = (
  final: readonly DiskChange[],
  names: RunChanges["names"] = [],
  plan: readonly DiskChange[] = [],
): RunChanges => ({
  plan,
  final,
  names,
});

describe("disk snapshot", () => {
  it("records a link as a link with its target text, and never follows it", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-disk-"));
    made.push(root);
    NodeFS.mkdirSync(NodePath.join(root, "archive"));
    NodeFS.writeFileSync(NodePath.join(root, "archive", "log.jsonl"), "secret", { mode: 0o600 });
    NodeFS.symlinkSync(NodePath.join(root, "archive"), NodePath.join(root, "link"));
    const snap = snapshotTree(root);
    expect(Object.keys(snap)).toEqual(["archive", "archive/log.jsonl", "link"]);
    expect(snap["link"]).toMatchObject({ kind: "symlink", link: NodePath.join(root, "archive") });
    expect(snap["archive/log.jsonl"]).toMatchObject({
      kind: "file",
      size: 6,
      mode: 0o600,
      nlink: 1,
    });
    expect(snap["archive"]).toMatchObject({ kind: "directory", size: 0 });
  });

  it("records the exact mode, time and link count, and calls a socket neither file nor folder", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-disk-"));
    made.push(root);
    const path = NodePath.join(root, "f");
    NodeFS.writeFileSync(path, "x");
    NodeFS.chmodSync(path, 0o751);
    NodeFS.linkSync(path, NodePath.join(root, "g"));
    const server = NodeNet.createServer();
    await new Promise<void>((resolve) => server.listen(NodePath.join(root, "s"), resolve));
    try {
      const snap = snapshotTree(root);
      expect(snap["f"]).toEqual({
        kind: "file",
        size: 1,
        mtimeMs: NodeFS.lstatSync(path).mtimeMs,
        mode: 0o751,
        nlink: 2,
        link: null,
      });
      expect(snap["s"]?.kind).toBe("other");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reports new paths and changed files, but not a directory whose children changed", () => {
    const before = { a: file, d: dir, l: link("x") };
    const after = {
      a: { ...file, size: 4 },
      d: { ...dir, mtimeMs: 2 },
      l: link("y"),
      n: file,
      m: { ...file },
    };
    expect(diffSnapshots(before, after).map((c) => `${c.change} ${c.path}`)).toEqual([
      "changed a",
      "changed l",
      "new n",
      "new m",
    ]);
    expect(diffSnapshots(before, { ...before, a: { ...file, mode: 0o644 } })).toHaveLength(1);
    expect(diffSnapshots(before, { ...before, a: { ...file, mtimeMs: 9 } })).toHaveLength(1);
    expect(diffSnapshots(before, { ...before, a: { ...file, nlink: 2 } })).toHaveLength(1);
    expect(diffSnapshots(before, { ...before, d: file })).toHaveLength(1);
    expect(diffSnapshots(before, before)).toEqual([]);
    expect(diffSnapshots(before, { ...before, a: dir })).toEqual([
      { path: "a", change: "changed", entry: dir },
    ]);
    const other: DiskEntry = { ...file, kind: "other" };
    expect(diffSnapshots(before, { ...before, a: other })).toEqual([
      { path: "a", change: "changed", entry: other },
    ]);
    expect(diffSnapshots({}, { n: file })).toEqual([{ path: "n", change: "new", entry: file }]);
  });
});

describe("the control run", () => {
  const browser = [
    added("profile/prefs.js", { ...file, mode: 0o644 }),
    added("profile/storage/default/moz-extension+++U1^userContextId=4294967295", dir),
    added("profile/lock", link("127.0.0.1:+42")),
    added("home/.cache/fontconfig/x.cache-9", link("/w1/home/.cache/fontconfig/y")),
  ];
  const control = run(
    [
      added("profile/prefs.js", { ...file, mode: 0o644, size: 99 }),
      added("profile/storage/default/moz-extension+++C1^userContextId=4294967295", dir),
      added("profile/lock", link("127.0.0.1:+42")),
      added("home/.cache/fontconfig/x.cache-9", link("/w2/home/.cache/fontconfig/y")),
    ],
    [
      ["/w2", "{workspace}"],
      ["C1", "{recorder-uuid}"],
    ],
  );
  const names: RunChanges["names"] = [
    ["/w1", "{workspace}"],
    ["U1", "{recorder-uuid}"],
  ];

  it("leaves to the browser what the control run wrote at the same place, kind, mode and link", () => {
    expect(beyondControl(run(browser, names), control)).toEqual([]);
  });

  it("gives the product every write the control run did not make the same way", () => {
    const product = run(
      [
        ...browser,
        added("profile/storage/leaked-log.jsonl"),
        added("profile/prefs.js.bak", { ...file, mode: 0o644 }),
        added("downloads/bank.example-2026-11-16.har", { ...file, mode: 0o644 }),
      ],
      names,
    );
    const theirs = run([added("downloads/bank.example-2026-11-16.har")], [], []);
    expect(
      beyondControl(product, { ...control, final: [...control.final, ...theirs.final] }).map(
        (c) => c.path,
      ),
    ).toEqual([
      "profile/storage/leaked-log.jsonl",
      "profile/prefs.js.bak",
      "downloads/bank.example-2026-11-16.har",
    ]);
    expect(beyondControl(run([added("profile/lock", link("/w1/data"))], names), control)).toEqual([
      added("profile/lock", link("/w1/data")),
    ]);
  });

  it("counts what the product wrote by plan time, once, though it was gone by the end", () => {
    const transient = added("home/.config/zen/sites.txt");
    expect(beyondControl(run([], names, [transient, transient]), control)).toEqual([transient]);
    expect(beyondControl(run([], names, [browser[0]!]), control)).toEqual([]);
    expect(
      beyondControl(run([], names, [browser[0]!]), run([], control.names, [control.final[0]!])),
    ).toEqual([]);
  });

  it("matches on the uuid's role, never on the uuid", () => {
    const sameUuid = run(
      [added("profile/storage/default/moz-extension+++C1^userContextId=4294967295", dir)],
      [],
    );
    expect(beyondControl(sameUuid, control)).toHaveLength(1);
    expect(beyondControl(run([browser[1]!], [["U1", "{probe-uuid}"]]), control)).toHaveLength(1);
  });
});

describe("the product's places", () => {
  it("allows the app folder, the key folder, the key file and an export, private, with one link", () => {
    const writes = [
      added("data/one-click-har", dir),
      added(`data/one-click-har/${KEY}`, dir),
      added(`data/one-click-har/${KEY}/sites`, dir),
      added(`data/one-click-har/${KEY}/sites/bank.example/log/r-0.jsonl`),
      added("profile/one-click-har.archive-key"),
      added("downloads/bank.example-2026-11-16.har"),
    ];
    expect(productWriteProblems(writes, AREA)).toEqual([]);
    expect(writes.every((w) => inProductArea(w, AREA))).toBe(true);
  });

  it("fails a write anywhere else, a link, another mode or a second link", () => {
    const writes = [
      added("profile/storage/leaked-log.jsonl"),
      added("downloads/one-click-har-archive", link(`/w/data/one-click-har/${KEY}`)),
      added("downloads/export.har", link("/elsewhere")),
      added("downloads/notes.txt"),
      added("downloads/x/y.har"),
      added("downloads/bank.example-export.har", { ...file, mode: 0o644 }),
      added("data/one-click-har/sites", dir),
      added(`data/one-click-har/${KEY}-other`, dir),
      added(`data/one-click-har/${"f".repeat(32)}/x`),
      added(`data/one-click-har/${KEY}/link`, link("/")),
      added(`data/one-click-har/${KEY}/x.jsonl`, { ...file, mode: 0o640 }),
      added(`data/one-click-har/${KEY}/d`, { ...dir, mode: 0o755 }),
      added("data/one-click-har", { ...dir, mode: 0o750 }),
      added(`data/one-click-har/${KEY}/h.jsonl`, { ...file, nlink: 2 }),
      added("profile/one-click-har.archive-key", { ...file, mode: 0o644 }),
      added("profile/one-click-harXarchive-key"),
      added("profile/one-click-har.archive-key.bak"),
      added(`profile/${KEY}`),
      added(`data/one-click-har/${KEY}`),
      added("data/one-click-harX", dir),
      added("Xdata/one-click-har", dir),
      added("downloads/.har"),
      added("downloads/a.harX"),
    ];
    expect(productWriteProblems(writes, AREA)).toEqual([
      "new file profile/storage/leaked-log.jsonl: outside the key folder, the key file and the export folder",
      `new symlink downloads/one-click-har-archive -> /w/data/one-click-har/${KEY}: outside the key folder, the key file and the export folder`,
      "new symlink downloads/export.har -> /elsewhere: outside the key folder, the key file and the export folder",
      "new file downloads/notes.txt: outside the key folder, the key file and the export folder",
      "new file downloads/x/y.har: outside the key folder, the key file and the export folder",
      "new file downloads/bank.example-export.har: mode 644, not 600",
      "new directory data/one-click-har/sites: outside the key folder, the key file and the export folder",
      `new directory data/one-click-har/${KEY}-other: outside the key folder, the key file and the export folder`,
      `new file data/one-click-har/${"f".repeat(32)}/x: outside the key folder, the key file and the export folder`,
      `new symlink data/one-click-har/${KEY}/link -> /: outside the key folder, the key file and the export folder`,
      `new file data/one-click-har/${KEY}/x.jsonl: mode 640, not 600`,
      `new directory data/one-click-har/${KEY}/d: mode 755, not 700`,
      "new directory data/one-click-har: mode 750, not 700",
      `new file data/one-click-har/${KEY}/h.jsonl: 2 links`,
      "new file profile/one-click-har.archive-key: mode 644, not 600",
      "new file profile/one-click-harXarchive-key: outside the key folder, the key file and the export folder",
      "new file profile/one-click-har.archive-key.bak: outside the key folder, the key file and the export folder",
      `new file profile/${KEY}: outside the key folder, the key file and the export folder`,
      `new file data/one-click-har/${KEY}: outside the key folder, the key file and the export folder`,
      "new directory data/one-click-harX: outside the key folder, the key file and the export folder",
      "new directory Xdata/one-click-har: outside the key folder, the key file and the export folder",
      "new file downloads/.har: outside the key folder, the key file and the export folder",
      "new file downloads/a.harX: outside the key folder, the key file and the export folder",
    ]);
  });

  it("names every file with a second link, and never a folder", () => {
    expect(
      hardLinks([
        added("profile/storage/x", { ...file, nlink: 2 }),
        added("profile/l", { ...link("y"), nlink: 3 }),
        added("profile/d", { ...dir, nlink: 5 }),
        added("profile/one", file),
      ]),
    ).toEqual(["profile/storage/x has 2 links", "profile/l has 3 links"]);
  });
});

describe("disk problems", () => {
  const evidence = (
    product: readonly DiskChange[],
    plan: readonly DiskChange[] = [],
  ): DiskEvidence => ({
    product: run(product, [], plan),
    control: run([added("profile/prefs.js", { ...file, mode: 0o644 })]),
    area: AREA,
    probed: ["profile/one-click-har.archive-key", "downloads/planned.har"],
  });

  it("holds when the product wrote only its places, probed or in the key folder", () => {
    expect(
      diskProblems(
        evidence([
          added("profile/prefs.js", { ...file, mode: 0o644 }),
          added("profile/one-click-har.archive-key"),
          added("downloads/planned.har"),
          added(`data/one-click-har/${KEY}/late.jsonl`),
        ]),
      ),
    ).toEqual([]);
  });

  it("fails a write outside, a hard link even where the control wrote, and an export the plan never saw", () => {
    expect(
      diskProblems(
        evidence(
          [
            added("profile/prefs.js", { ...file, mode: 0o644, nlink: 2 }),
            added("downloads/late.har"),
          ],
          [added("home/.config/zen/sites.txt")],
        ),
      ),
    ).toEqual([
      "new file home/.config/zen/sites.txt: outside the key folder, the key file and the export folder",
      "profile/prefs.js has 2 links",
      "new file downloads/late.har: written after the plan, so never probed",
    ]);
  });
});
