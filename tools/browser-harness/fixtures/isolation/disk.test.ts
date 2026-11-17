import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  diffSnapshots,
  diskRules,
  productWrites,
  snapshotTree,
  unallowedWrites,
  type DiskChange,
  type DiskEntry,
} from "./disk.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const KEY = "0123456789abcdef0123456789abcdef";
const RULES = diskRules({
  archiveKey: KEY,
  keyFileName: "one-click-har.archive-key",
  harnessFiles: ["downloads/saved-page.html"],
});

const file: DiskEntry = { kind: "file", size: 3, mtimeMs: 1, mode: 0o600, link: null };
const dir: DiskEntry = { kind: "directory", size: 0, mtimeMs: 1, mode: 0o700, link: null };
const link = (to: string): DiskEntry => ({
  kind: "symlink",
  size: 1,
  mtimeMs: 1,
  mode: 0o777,
  link: to,
});
const added = (path: string, entry: DiskEntry = file): DiskChange => ({
  path,
  change: "new",
  entry,
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
    expect(snap["archive/log.jsonl"]).toMatchObject({ kind: "file", size: 6, mode: 0o600 });
    expect(snap["archive"]).toMatchObject({ kind: "directory", size: 0 });
  });

  it("records the exact mode and time, and calls a socket neither file nor folder", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-disk-"));
    made.push(root);
    const path = NodePath.join(root, "f");
    NodeFS.writeFileSync(path, "x");
    NodeFS.chmodSync(path, 0o751);
    const server = NodeNet.createServer();
    await new Promise<void>((resolve) => server.listen(NodePath.join(root, "s"), resolve));
    try {
      const snap = snapshotTree(root);
      expect(snap["f"]).toEqual({
        kind: "file",
        size: 1,
        mtimeMs: NodeFS.lstatSync(path).mtimeMs,
        mode: 0o751,
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

describe("disk rules", () => {
  it("allows the browser's profile, the key file, the key folder, an export and the harness's files", () => {
    const allowed = [
      added("profile/prefs.js"),
      added("profile/26faf9e7.sqlite-wal"),
      added("profile/zen-sessions.jsonlz4"),
      added("profile/storage/default/x/idb/1.sqlite"),
      added("profile/extensions/one-click-har@tretuttle.github.io.xpi"),
      added("profile/MarionetteActivePort"),
      added("profile/one-click-har.archive-key"),
      added("data/one-click-har", dir),
      added(`data/one-click-har/${KEY}`, dir),
      added(`data/one-click-har/${KEY}/sites/bank.example/log/r-0.jsonl`),
      added("downloads/bank.example-2026-11-16.har"),
      added("downloads/saved-page.html"),
      added("home/.cache", dir),
      added("home/.config/mozilla/firefox/Crash Reports/events", dir),
      added("home/.config/mozilla/firefox/Crash Reports/glean/db/data.safe.bin"),
      added("profile/breach-alerts.db"),
      added("home/.cache/fontconfig/0a1bf7d8b1ba794ae01cd62177a1cfec-le64.cache-9", link("x")),
    ];
    expect(unallowedWrites(allowed, RULES)).toEqual([]);
  });

  it("fails what the product writes anywhere else, links included", () => {
    const writes = [
      added("profile/one-click-har-sites.txt"),
      added("downloads/one-click-har-archive", link(`/w/data/one-click-har/${KEY}`)),
      added("downloads/notes.txt"),
      added("downloads/export.har", link("/elsewhere")),
      added("data/one-click-har/sites", dir),
      added("data/one-click-har/recent-sites.txt"),
      added(`data/one-click-har/${KEY}/link`, link("/")),
      added("home/.config/zen/sites.txt"),
      added("home/.config/mozilla/one-click-har.txt"),
      added("home/.one-click-har", dir),
      added("profile/storage/x", link("/")),
      added("profile/lock", link("127.0.0.1:+42")),
      added(`profile/${KEY}`),
      added(`data/one-click-har/${KEY}-other`, dir),
      added("profile/one-click-harXarchive-key"),
      added("downloads/one-click-har.archive-key"),
      added("profile/one-click-har.archive-key.bak"),
      added("downloads/saved-pageXhtml"),
      added("x/downloads/saved-page.html"),
      added("downloads/saved-page.html.bak"),
      added("profile/prefs.js", dir),
      added("home/.cache/zen/x"),
      added("stray.txt"),
    ];
    expect(unallowedWrites(writes, RULES)).toEqual([
      "new file profile/one-click-har-sites.txt",
      `new symlink downloads/one-click-har-archive -> /w/data/one-click-har/${KEY}`,
      "new file downloads/notes.txt",
      "new symlink downloads/export.har -> /elsewhere",
      "new directory data/one-click-har/sites",
      "new file data/one-click-har/recent-sites.txt",
      `new symlink data/one-click-har/${KEY}/link -> /`,
      "new file home/.config/zen/sites.txt",
      "new file home/.config/mozilla/one-click-har.txt",
      "new directory home/.one-click-har",
      "new symlink profile/storage/x -> /",
      "new symlink profile/lock -> 127.0.0.1:+42",
      `new file profile/${KEY}`,
      `new directory data/one-click-har/${KEY}-other`,
      "new file profile/one-click-harXarchive-key",
      "new file downloads/one-click-har.archive-key",
      "new file profile/one-click-har.archive-key.bak",
      "new file downloads/saved-pageXhtml",
      "new file x/downloads/saved-page.html",
      "new file downloads/saved-page.html.bak",
      "new directory profile/prefs.js",
      "new file home/.cache/zen/x",
      "new file stray.txt",
    ]);
  });

  it("keeps another run's key folder out", () => {
    expect(unallowedWrites([added(`data/one-click-har/${"f".repeat(32)}/x`)], RULES)).toEqual([
      `new file data/one-click-har/${"f".repeat(32)}/x`,
    ]);
  });

  it("names as product writes what the product owns and anything no rule allows", () => {
    const changes = [
      added("profile/prefs.js"),
      added("profile/user.js"),
      added("profile/one-click-har.archive-key"),
      added(`data/one-click-har/${KEY}/settings.json`),
      added("profile/one-click-har-sites.txt"),
      added("downloads/saved-page.html"),
      added("data/one-click-har", dir),
      added("downloads/x.har"),
    ];
    expect(productWrites(changes, RULES).map((c) => c.path)).toEqual([
      "profile/one-click-har.archive-key",
      `data/one-click-har/${KEY}/settings.json`,
      "profile/one-click-har-sites.txt",
      "data/one-click-har",
      "downloads/x.har",
    ]);
  });
});
