import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readZipEntry } from "../../src/zip.ts";
import {
  isProfileDerivedKey,
  judgeIsolationRun,
  type BrowserRowReport,
  type JudgeContext,
  type SyntheticControlResult,
} from "./judge.ts";
import { expandExpectedRows, PROBE_TABLE, SYNTHETIC_ROWS } from "./probe-table.ts";
import { buildStoredZip } from "./zip.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

function makePassingContext(): JudgeContext {
  return {
    marker: "OCHMARK_deadbeef",
    warMark: "OCHWAR_cafebabe",
    secretMark: "OCHSECRET_12345678",
    site: "bank.example",
    archiveKey: "0123456789abcdef0123456789abcdef",
    appFolder: "/tmp/one-click-har-isolation/data/one-click-har",
    recId: "one-click-har@tretuttle.github.io",
    recUuid: "11111111-2222-3333-4444-555555555555",
    planUrls: [
      "file:///tmp/one-click-har-isolation/data/one-click-har/0123456789abcdef0123456789abcdef/sites/bank.example/log/r-0.jsonl",
    ],
  };
}

function makePassingInput(ctx: JudgeContext): {
  browserRows: BrowserRowReport[];
  syntheticControls: SyntheticControlResult[];
} {
  const browserRows: BrowserRowReport[] = [];
  for (const row of expandExpectedRows(false)) {
    if (row.detect === "synthetic") continue;
    let outcome = "error";
    let differs = false;
    let text = "blocked";

    if (row.id === "api-namespace") {
      outcome = "ok";
      text = "typeof browser: undefined; typeof browser.oneClickHar: n/a";
    } else if (
      row.id === "resource-all" ||
      row.id === "resource-traversal" ||
      row.id === "chrome-all" ||
      row.id === "chrome-traversal" ||
      row.id === "moz-src-root"
    ) {
      outcome = "0 of 5 reachable";
    } else if (row.id === "storage-recorder" || row.id === "notifications-getall") {
      outcome = "ok";
      text = "{}";
    } else if (row.id === "idb-recorder") {
      outcome = "ok";
      text =
        'databases(): []; open("och-recorder"): database opened in this origin, no kv store (empty)';
    } else if (row.id === "downloads-search") {
      outcome = "ok";
      text = "no download items";
    } else if (row.expected.kind === "READ") {
      outcome = "ok";
      text = row.id.startsWith("planted-own-war") ? ctx.warMark : ctx.marker;
    } else if (
      row.expected.kind === "LEAKS-EXISTENCE" ||
      row.expected.kind === "LEAKS-EXISTENCE-OR-READ"
    ) {
      if (row.detect === "oracle") {
        outcome = "differs";
        differs = true;
        text = "existing path: load | missing path: error";
      } else if (row.detect === "addon") {
        outcome = "ok";
        text = `${ctx.recId} moz-extension://${ctx.recUuid}/action/index.html`;
      } else if (row.detect === "names") {
        outcome = "ok";
        text = `201: ${ctx.archiveKey}`;
      }
    }

    browserRows.push({
      kind: "row",
      position: row.position,
      probe: row.id,
      observed: { outcome, differs, text },
    });
  }

  const syntheticControls: SyntheticControlResult[] = SYNTHETIC_ROWS.filter(
    (r) => r.expected.kind === "READ",
  ).map((r) => ({
    id: r.id,
    position: r.position,
    observed: `read ${ctx.marker}`,
    verdict: "READ",
  }));

  return { browserRows, syntheticControls };
}

describe("isolation probe table and judge", () => {
  it("expands to all 287 probe rows with explicit expectations", () => {
    const rows = expandExpectedRows(false);
    expect(rows).toHaveLength(287);
    expect(PROBE_TABLE.length).toBe(65);
    const exceptions = rows.flatMap((r) =>
      r.expected.kind === "LEAKS-EXISTENCE" && "exception" in r.expected
        ? [r.expected.exception]
        : [],
    );
    expect(new Set(exceptions)).toEqual(
      new Set([
        "top-level-app-folder-existence",
        "addon-tabs-visibility",
        "addon-management-visibility",
      ]),
    );
    expect(exceptions).toHaveLength(6);
  });

  it("passes when every probe matches its row and every planted control sees", () => {
    const ctx = makePassingContext();
    const { browserRows, syntheticControls } = makePassingInput(ctx);
    const result = judgeIsolationRun({
      context: ctx,
      browserRows,
      syntheticControls,
      csFileInjected: false,
      canAccessFileObserved: true,
      csArchiveInjectedDocs: [],
    });
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.counts).toEqual({
      BLOCKED: 262,
      READ: 13,
      "LEAKS-EXISTENCE": 12,
      "NO-RESULT": 0,
    });
  });

  it("fails on missing probe rows, leaked bytes, guessed profile keys, Downloads leaks, and failed controls", () => {
    const ctx = makePassingContext();

    // Missing row -> NO-RESULT fails
    const missing = makePassingInput(ctx);
    missing.browserRows.pop();
    const missingRes = judgeIsolationRun({
      context: ctx,
      ...missing,
      csFileInjected: false,
      canAccessFileObserved: true,
      csArchiveInjectedDocs: [],
    });
    expect(missingRes.ok).toBe(false);
    expect(missingRes.counts["NO-RESULT"]).toBe(1);

    // Byte leak -> BLOCKED row returns READ
    const byteLeak = makePassingInput(ctx);
    const fetchRow = byteLeak.browserRows.find(
      (r) => r.probe === "fetch-file-log" && r.position === "web",
    )!;
    Object.assign(fetchRow, {
      observed: { outcome: "ok", differs: false, text: `leaked ${ctx.marker}` },
    });
    const byteRes = judgeIsolationRun({
      context: ctx,
      ...byteLeak,
      csFileInjected: false,
      canAccessFileObserved: true,
      csArchiveInjectedDocs: [],
    });
    expect(byteRes.ok).toBe(false);
    expect(byteRes.mismatches[0]).toContain("fetch-file-log@web");

    // Guessed profile-derived key -> script-site-oracle@file leaks existence
    const keyLeak = makePassingInput(ctx);
    const oracleRow = keyLeak.browserRows.find(
      (r) => r.probe === "script-site-oracle" && r.position === "file",
    )!;
    Object.assign(oracleRow, {
      observed: {
        outcome: "differs",
        differs: true,
        text: "existing path: load | missing path: error",
      },
    });
    const keyRes = judgeIsolationRun({
      context: ctx,
      ...keyLeak,
      csFileInjected: false,
      canAccessFileObserved: true,
      csArchiveInjectedDocs: [],
    });
    expect(keyRes.ok).toBe(false);
    expect(keyRes.mismatches[0]).toContain("script-site-oracle@file");

    // Export added to Downloads list -> downloads-search@ext-bg catches it
    const dlLeak = makePassingInput(ctx);
    const dlRow = dlLeak.browserRows.find(
      (r) => r.probe === "downloads-search" && r.position === "ext-bg",
    )!;
    Object.assign(dlRow, {
      observed: { outcome: "ok", differs: false, text: "/home/u/Downloads/bank.example-2026.har" },
    });
    const dlRes = judgeIsolationRun({
      context: ctx,
      ...dlLeak,
      csFileInjected: false,
      canAccessFileObserved: true,
      csArchiveInjectedDocs: [],
    });
    expect(dlRes.ok).toBe(false);
    expect(dlRes.mismatches[0]).toContain("downloads-search@ext-bg");

    // Planted control fails to read -> fails check (proving probe can see)
    const blindControl = makePassingInput(ctx);
    const controlRow = blindControl.browserRows.find(
      (r) => r.probe === "planted-own-war-fetch" && r.position === "web",
    )!;
    Object.assign(controlRow, {
      observed: { outcome: "error", differs: false, text: "NetworkError" },
    });
    const blindRes = judgeIsolationRun({
      context: ctx,
      ...blindControl,
      csFileInjected: false,
      canAccessFileObserved: true,
      csArchiveInjectedDocs: [],
    });
    expect(blindRes.ok).toBe(false);
    expect(blindRes.mismatches[0]).toContain("planted-own-war-fetch@web");
  });

  it("requires planted-resource@file to leak even when Linux webIsolated sandbox blocks planted-resource@web", () => {
    const ctx = { ...makePassingContext(), webSandboxBlocksArchive: true };
    const passing = makePassingInput(ctx);
    const webResource = passing.browserRows.find(
      (r) => r.probe === "planted-resource" && r.position === "web",
    )!;
    Object.assign(webResource, {
      observed: {
        outcome: "same",
        differs: false,
        text: "existing path: error | missing path: error",
      },
    });
    const okRes = judgeIsolationRun({
      context: ctx,
      ...passing,
      csFileInjected: false,
      canAccessFileObserved: true,
      csArchiveInjectedDocs: [],
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.counts).toEqual({
      BLOCKED: 263,
      READ: 13,
      "LEAKS-EXISTENCE": 11,
      "NO-RESULT": 0,
    });

    const fileResource = passing.browserRows.find(
      (r) => r.probe === "planted-resource" && r.position === "file",
    )!;
    Object.assign(fileResource, {
      observed: {
        outcome: "same",
        differs: false,
        text: "existing path: error | missing path: error",
      },
    });
    const badRes = judgeIsolationRun({
      context: ctx,
      ...passing,
      csFileInjected: false,
      canAccessFileObserved: true,
      csArchiveInjectedDocs: [],
    });
    expect(badRes.ok).toBe(false);
    expect(badRes.mismatches[0]).toContain("planted-resource@file");
  });

  it("detects profile-derived archive keys", () => {
    const profileDir = "/tmp/profile-abc";
    const derived = NodeCrypto.createHash("sha256").update(profileDir).digest("hex").slice(0, 16);
    expect(isProfileDerivedKey(`${derived}0000000000000000`, profileDir)).toBe(true);
    expect(isProfileDerivedKey(derived, profileDir)).toBe(true);
    expect(isProfileDerivedKey("f".repeat(32), profileDir)).toBe(false);
  });

  it("builds multi-entry stored XPI archives readable by readZipEntry", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-iso-zip-"));
    cleanupDirs.push(dir);
    const xpiPath = NodePath.join(dir, "probe.xpi");
    const zip = buildStoredZip([
      { name: "manifest.json", data: Buffer.from('{"id":"probe@test"}', "utf8") },
      { name: "sub/script.js", data: Buffer.from("console.log(1);\n", "utf8") },
    ]);
    await NodeFSP.writeFile(xpiPath, zip);
    expect((await readZipEntry(xpiPath, "manifest.json")).toString("utf8")).toBe(
      '{"id":"probe@test"}',
    );
    expect((await readZipEntry(xpiPath, "sub/script.js")).toString("utf8")).toBe(
      "console.log(1);\n",
    );
  });
});
