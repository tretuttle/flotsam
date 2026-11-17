import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readZipEntry } from "../../src/zip.ts";
import type { ExtraCheckResult } from "./archive-oracle.ts";
import {
  judgeIsolationRun,
  type BrowserRowReport,
  type IsolationRunInput,
  type JudgeContext,
  type Observation,
  type ObservedProbe,
} from "./judge.ts";
import {
  expandExpectedRows,
  EXTRA_CHECKS,
  PROBE_TABLE,
  type ExtraCheckId,
  type Position,
  type Verdict,
} from "./probe-table.ts";
import { buildStoredZip } from "./zip.ts";

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

const CTX: JudgeContext = {
  marker: "OCHMARK_deadbeef",
  warMark: "OCHWAR_cafebabe",
  storeMark: "OCHSTORE_0badf00d",
  ownMark: "OCHOWN_5eed5eed",
  recId: "one-click-har@tretuttle.github.io",
  recUuid: "11111111-2222-3333-4444-555555555555",
  webSandboxBlocksArchive: true,
};

// What Gecko 160 and 161 answered in the recorded baseline runs, copied as text.
const NETWORK: Observation = {
  outcome: "error",
  text: "TypeError: NetworkError when attempting to fetch resource.",
};
const FRAME_CROSS: Observation = {
  outcome: "load",
  text: 'load; contentDocument null; contentWindow.location.href: SecurityError: Permission denied to get property "href" on cross-origin object',
};
const FRAME_BLANK: Observation = {
  outcome: "error",
  text: "error; contentDocument readable, text: ; contentWindow.location.href: about:blank",
};
const SAME = {
  outcome: "same",
  text: "existing path: error | missing path: error",
  pair: { hit: { outcome: "error", text: "error" }, miss: { outcome: "error", text: "error" } },
};
const DIFFERS = {
  outcome: "differs",
  text: "existing path: load | missing path: error",
  pair: { hit: { outcome: "load", text: "load" }, miss: { outcome: "error", text: "error" } },
};
const NO_RECEIVER = "Error: Could not establish connection. Receiving end does not exist.";
const ILLEGAL: Observation = { outcome: "error", text: "Error: Illegal URL: file:///p/log.jsonl" };
const REC_TAB = `3 moz-extension://${CTX.recUuid}/action/index.html One-Click HAR\n2 http://bank.example/ Bank`;

const SINGLE_DENIALS: Readonly<Record<string, Observation>> = {
  "fetch-file-log": NETWORK,
  "fetch-file-body": NETWORK,
  "fetch-file-dir": NETWORK,
  "fetch-file-export": NETWORK,
  "content-fetch-file-log": NETWORK,
  "xhr-file-log": { outcome: "error", text: "error event, status 0, readyState 4" },
  "iframe-file-log": FRAME_BLANK,
  "iframe-file-root": FRAME_CROSS,
  "iframe-file-export": {
    outcome: "timeout",
    text: "timeout; contentDocument readable, text: ; contentWindow.location.href: about:blank",
  },
  "viewsource-fetch": NETWORK,
  "viewsource-iframe": FRAME_BLANK,
  "jar-file-fetch": NETWORK,
  "jar-file-iframe": FRAME_BLANK,
  "redirect-fetch": NETWORK,
  "redirect-iframe": FRAME_CROSS,
  "window-open-file": {
    outcome: "error",
    text: "Error: Access to 'file:///p/log.jsonl' from script denied",
  },
  "wr-redirect-iframe": FRAME_CROSS,
  "tabs-create-file": ILLEGAL,
  "tabs-create-dir": ILLEGAL,
  "tabs-update-file": ILLEGAL,
  "tabs-update-redirect": {
    outcome: "ok",
    text: "update resolved; 1 s later: url http://attacker.example/victim.html, title victim",
  },
  "windows-create-file": ILLEGAL,
  "downloads-download-file": {
    outcome: "error",
    text: "Error: Type error for parameter options (Error processing url: Error: Access denied for URL file:///p/log.jsonl for downloads.download.) for downloads.download.",
  },
  "tabs-create-viewsource": {
    outcome: "error",
    text: "Error: Illegal URL: view-source:file:///p/log.jsonl",
  },
  "wr-redirect-tab": {
    outcome: "ok",
    text: "created; 1 s later: url about:blank, status complete, title attacker.example/wr-redirect?from=tab",
  },
  "mozext-manifest": NETWORK,
  "mozext-parent": NETWORK,
  "mozext-schema": NETWORK,
  "mozext-popup": NETWORK,
  "mozext-frame-recorder": { outcome: "error", text: `${FRAME_BLANK.text}; postMessage sent` },
  "planted-own-war-fetch": NETWORK,
  "planted-own-war-script": { outcome: "error", text: "error; window.OCH_WAR = undefined" },
  "own-non-war": NETWORK,
  "api-call": { outcome: "error", text: "ReferenceError: browser is not defined" },
  "sendmessage-recorder": { outcome: "error", text: NO_RECEIVER },
  "connect-recorder": {
    outcome: "disconnected",
    text: `onDisconnect, error: ${NO_RECEIVER.slice(7)}`,
  },
  "tabs-query-recorder": { outcome: "ok", text: "2 http://bank.example/ Bank" },
  "executescript-recorder-page": {
    outcome: "done",
    text: `tab 3 (moz-extension://${CTX.recUuid}/action/index.html): Error: Missing host permission for the tab`,
  },
  "scripting-recorder-page": {
    outcome: "done",
    text: `tab 3 (moz-extension://${CTX.recUuid}/action/index.html): Error: Missing host permission for the tab`,
  },
  "management-getall": {
    outcome: "ok",
    text: "och-probe@test | Isolation probe extension | extension",
  },
  "downloads-search": { outcome: "ok", text: "no download items" },
  "clipboard-after-export": { outcome: "ok", text: "clipboard text: " },
  "notifications-getall": { outcome: "ok", text: "{}" },
  "storage-recorder": { outcome: "ok", text: `{"own":"${CTX.ownMark}"}` },
  "idb-recorder": {
    outcome: "ok",
    text: `own: kv.own = ${CTX.ownMark}; databases(): [{"name":"och-probe-own","version":1}]; och-recorder: no kv store`,
  },
};

const apiNamespace = (position: Position): Observation => ({
  outcome: "ok",
  text: ["ext-bg", "ext-page", "ext-devtools"].includes(position)
    ? "typeof browser.oneClickHar: undefined; typeof page oneClickHar: undefined; page globals not in a fresh frame: n/a"
    : "typeof browser.oneClickHar: n/a; typeof page oneClickHar: undefined; page globals not in a fresh frame: []",
});

const TARGETS: Readonly<Record<string, readonly string[]>> = {
  "inventory-read": ["file:///d/one-click-har/", "file:///d/one-click-har/k/settings.json"],
  "inventory-exists": ["file:///d/one-click-har/sites/"],
  "script-file-oracle": ["file:///d/one-click-har/g1/sites/bank.example/log/r-0.jsonl"],
  "css-file-oracle": ["file:///d/one-click-har/g1/sites/bank.example/log/r-0.jsonl"],
  "iframe-site-oracle": ["file:///d/one-click-har/g1/sites/bank.example/"],
  "iframe-site-oracle@file-mutated": ["file:///d/one-click-har/k/sites/bank.example/"],
  "script-site-oracle": ["file:///d/one-click-har/g1/sites/bank.example/"],
  "script-site-oracle@file-mutated": ["file:///d/one-click-har/k/sites/bank.example/"],
  "resource-all": ["resource://gre/", "resource://app/"],
  "resource-traversal": ["resource://gre/%2e%2e/log.jsonl"],
  "chrome-all": ["chrome://global/content/"],
  "chrome-traversal": ["chrome://global/content/%2e%2e/log.jsonl"],
  "moz-src-root": ["moz-src:///"],
  "mozext-every-file": [`moz-extension://${CTX.recUuid}/manifest.json`],
};

const UNREACHABLE: Observation = { outcome: "fetch error, link error", text: NETWORK.text };

function deniedEach(id: string, targets: readonly string[]): ObservedProbe {
  const spec = PROBE_TABLE.find((s) => s.id === id)!;
  return {
    outcome: "each",
    text: `${String(targets.length)} targets`,
    each: targets.map((target) =>
      spec.deny.kind === "indistinguishable"
        ? { target, ...SAME }
        : { target, ...(spec.deny.kind === "unreachable" ? UNREACHABLE : NETWORK) },
    ),
  };
}

/** What a probe that read or saw what its expected control or exception says it must. */
function expectedSeen(id: string, targets: readonly string[]): ObservedProbe {
  const spec = PROBE_TABLE.find((s) => s.id === id)!;
  if (id.startsWith("planted-own-war"))
    return { outcome: "ok", text: `status 200: ${CTX.warMark}` };
  if (id === "tabs-query-recorder" || id === "management-getall")
    return { outcome: "ok", text: REC_TAB };
  if (id === "fetch-file-dir") return { outcome: "ok", text: "status 200: 201: k 0 DIRECTORY" };
  if (spec.shape === "each") {
    return {
      outcome: "each",
      text: "",
      each: targets.map((target) => ({ target, ...DIFFERS })),
    };
  }
  if (spec.shape === "pair") return DIFFERS;
  return { outcome: "ok", text: `status 200: ${CTX.marker}` };
}

const targetsOf = (id: string, position: Position): readonly string[] =>
  TARGETS[`${id}@${position}`] ?? TARGETS[id] ?? [];

function passingRows(): BrowserRowReport[] {
  return expandExpectedRows(false)
    .filter((row) => row.spec !== null)
    .filter((row) => !(row.id === "planted-resource" && row.position === "web"))
    .map((row) => {
      const spec = PROBE_TABLE.find((s) => s.id === row.id)!;
      const targets = targetsOf(row.id, row.position);
      let observed: ObservedProbe;
      if (row.expected.kind !== "BLOCKED") {
        observed =
          row.id === "inventory-read"
            ? {
                outcome: "each",
                text: "",
                each: targets.map((target) => ({ target, outcome: "ok", text: CTX.marker })),
              }
            : expectedSeen(row.id, targets);
      } else if (row.id === "api-namespace") {
        observed = apiNamespace(row.position);
      } else if (spec.shape === "each") {
        observed = deniedEach(row.id, targets);
      } else if (spec.shape === "pair") {
        observed = SAME;
      } else if (row.id === "window-open-file" && row.position === "file") {
        observed = { outcome: "error", text: "window.open returned null" };
      } else {
        observed = SINGLE_DENIALS[row.id]!;
      }
      return { kind: "row" as const, position: row.position, probe: row.id, observed };
    })
    .concat([{ kind: "row" as const, position: "web", probe: "planted-resource", observed: SAME }]);
}

const passingChecks = (): ExtraCheckResult[] =>
  (Object.keys(EXTRA_CHECKS) as ExtraCheckId[]).map((id) => ({ id, ok: true, detail: "held" }));

function passingInput(): IsolationRunInput {
  return {
    context: CTX,
    browserRows: passingRows(),
    targets: TARGETS,
    syntheticControls: [
      {
        id: "control-system-read",
        position: "system",
        observed: "system",
        reads: [`log ${CTX.marker}`, `body ${CTX.marker}`],
      },
      {
        id: "planted-recorder-storage",
        position: "system",
        observed: "storage",
        reads: [`{"och_secret":"${CTX.storeMark}"}`],
      },
      {
        id: "planted-recorder-idb",
        position: "rec-page",
        observed: "idb",
        reads: [`kv.secret = ${CTX.storeMark}`],
      },
      {
        id: "limit-same-user-process",
        position: "os",
        observed: "os",
        reads: [`cookie ${CTX.marker}-in-cookie`],
      },
      {
        id: "limit-other-experiment",
        position: "otherexp",
        observed: "otherexp",
        reads: [`log ${CTX.marker}`],
      },
    ],
    csFileInjected: false,
    canAccessFileObserved: true,
    csArchiveInjectedDocs: [],
    extraChecks: passingChecks(),
  };
}

/** The input with one row's observation replaced. */
function withRow(probe: string, position: Position, observed: unknown): IsolationRunInput {
  const input = passingInput();
  const rows = input.browserRows.filter((r) => !(r.probe === probe && r.position === position));
  rows.push({ kind: "row", position, probe, observed: observed as ObservedProbe });
  return { ...input, browserRows: rows };
}

const rowOf = (input: IsolationRunInput, id: string, position: Position) =>
  judgeIsolationRun(input).rows.find((r) => r.id === id && r.position === position)!;

describe("isolation probe table", () => {
  it("expands to 302 rows: 275 browser rows, 20 no-Marionette rows and 7 synthetic rows", () => {
    expect(PROBE_TABLE).toHaveLength(66);
    const rows = expandExpectedRows(false);
    expect(rows).toHaveLength(302);
    expect(
      rows.filter((r) => r.position === "file-no-marionette" || r.position === "file-mutated"),
    ).toHaveLength(20);
    expect(rows.filter((r) => r.spec === null)).toHaveLength(7);
  });

  it("names exactly three decided exceptions, at six rows, and no BLOCKED row lacks a denial", () => {
    const rows = expandExpectedRows(false);
    const exceptions = rows.flatMap((r) =>
      r.expected.kind === "LEAKS-EXISTENCE" && "exception" in r.expected
        ? [`${r.id}@${r.position}`]
        : [],
    );
    expect(exceptions.toSorted()).toEqual([
      "management-getall@ext-bg",
      "management-getall@ext-page",
      "script-root-oracle@file",
      "script-root-oracle@file-no-marionette",
      "tabs-query-recorder@ext-bg",
      "tabs-query-recorder@ext-page",
    ]);
    for (const spec of PROBE_TABLE) {
      const blockedSomewhere = spec.positions.some(
        (p) => (spec.expectAt?.[p] ?? { kind: "BLOCKED" }).kind === "BLOCKED",
      );
      if (blockedSomewhere) expect(spec.deny.kind, spec.id).not.toBe("never");
    }
  });

  it("keeps tabs-only probes out of the devtools page, which has no tabs API", () => {
    const tabsProbes = PROBE_TABLE.filter((s) => /^(tabs|windows)-/u.test(s.id));
    expect(tabsProbes.length).toBeGreaterThan(5);
    for (const spec of tabsProbes) expect(spec.positions, spec.id).not.toContain("ext-devtools");
  });
});

describe("isolation judge", () => {
  it("passes a run where every probe saw its declared denial and every control read its mark", () => {
    const result = judgeIsolationRun(passingInput());
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({
      BLOCKED: 275,
      READ: 16,
      "LEAKS-EXISTENCE": 11,
      "NO-RESULT": 0,
    });
  });

  const noResult: readonly [string, string, Position, unknown][] = [
    [
      "a missing runner",
      "xhr-file-log",
      "web",
      { outcome: "threw", text: "missing runner for xhr-file-log" },
    ],
    ["an empty result", "xhr-file-log", "web", {}],
    [
      "a fetch that timed out",
      "fetch-file-log",
      "ext-bg",
      { outcome: "timeout", text: "no fetch result within 3000 ms" },
    ],
    [
      "a probe that threw",
      "tabs-create-file",
      "ext-bg",
      { outcome: "threw", text: "TypeError: b.tabs is undefined" },
    ],
    [
      "no target to act on",
      "executescript-recorder-page",
      "ext-bg",
      { outcome: "no-target", text: "no tab" },
    ],
    [
      "a pair with one side",
      "img-file-oracle",
      "file",
      { outcome: "same", text: "", pair: { hit: { outcome: "error", text: "error" } } },
    ],
    [
      "a pair with no sides",
      "mozext-script-oracle",
      "web",
      { outcome: "same", text: "existing path: error | missing path: error" },
    ],
    ["targets without results", "resource-all", "web", { outcome: "each", text: "0 targets" }],
    [
      "a planned target left out",
      "resource-all",
      "web",
      { outcome: "each", text: "", each: [{ target: "resource://gre/", ...UNREACHABLE }] },
    ],
    [
      "an unplanned target",
      "chrome-all",
      "web",
      {
        outcome: "each",
        text: "",
        each: [
          { target: "chrome://global/content/", ...UNREACHABLE },
          { target: "chrome://other/content/", ...UNREACHABLE },
        ],
      },
    ],
    [
      "a store read that did not see its own value",
      "storage-recorder",
      "ext-bg",
      { outcome: "ok", text: "{}" },
    ],
    [
      "a frame event with no document report",
      "iframe-file-log",
      "web",
      { outcome: "error", text: "error" },
    ],
    [
      "a refusal other than the declared one",
      "window-open-file",
      "file",
      { outcome: "error", text: "Error: Access to 'file:///p/log.jsonl' from script denied" },
    ],
  ];
  it.each(noResult)(
    "turns %s into NO-RESULT, and fails the run",
    (_label, probe, position, observed) => {
      const input = withRow(probe, position, observed);
      expect(rowOf(input, probe, position).verdict).toBe("NO-RESULT");
      expect(judgeIsolationRun(input).ok).toBe(false);
    },
  );

  it("turns a missing row into NO-RESULT", () => {
    const input = passingInput();
    const rows = input.browserRows.filter(
      (r) => !(r.probe === "fetch-file-log" && r.position === "web"),
    );
    expect(rowOf({ ...input, browserRows: rows }, "fetch-file-log", "web").verdict).toBe(
      "NO-RESULT",
    );
  });

  const leaks: readonly [string, string, Position, unknown, "READ" | "LEAKS-EXISTENCE"][] = [
    [
      "file bytes",
      "fetch-file-log",
      "web",
      { outcome: "ok", text: "status 200, 12 chars: {}" },
      "READ",
    ],
    [
      "the secret marker",
      "xhr-file-log",
      "file",
      { outcome: "ok", text: `status 200: ${CTX.marker}` },
      "READ",
    ],
    [
      "a page-visible window.oneClickHar",
      "api-namespace",
      "web",
      {
        outcome: "ok",
        text: "typeof browser.oneClickHar: n/a; typeof page oneClickHar: object; page globals not in a fresh frame: []",
      },
      "READ",
    ],
    [
      "a new page global",
      "api-namespace",
      "cs-web",
      {
        outcome: "ok",
        text: 'typeof browser.oneClickHar: undefined; typeof page oneClickHar: undefined; page globals not in a fresh frame: ["harData"]',
      },
      "READ",
    ],
    [
      "browser.oneClickHar in another extension",
      "api-namespace",
      "ext-bg",
      {
        outcome: "ok",
        text: "typeof browser.oneClickHar: object; typeof page oneClickHar: undefined; page globals not in a fresh frame: n/a",
      },
      "READ",
    ],
    [
      "a reply over runtime.connect",
      "connect-recorder",
      "ext-bg",
      { outcome: "message", text: '{"recording":true,"problems":[]}' },
      "READ",
    ],
    [
      "a reply to sendMessage",
      "sendmessage-recorder",
      "cs-web",
      { outcome: "ok", text: 'reply: {"recording":true}' },
      "READ",
    ],
    [
      "an undefined reply to sendMessage",
      "sendmessage-recorder",
      "ext-bg",
      { outcome: "ok", text: "reply: undefined" },
      "READ",
    ],
    [
      "a recorder API answer",
      "api-call",
      "ext-page",
      { outcome: "ok", text: '{"recording":true,"problems":[]}' },
      "READ",
    ],
    [
      "a Downloads item without .har",
      "downloads-search",
      "ext-bg",
      { outcome: "ok", text: "bank.example-export.json | url file:///x" },
      "LEAKS-EXISTENCE",
    ],
    [
      "a notification",
      "notifications-getall",
      "ext-bg",
      { outcome: "ok", text: '{"n":{"title":"bank.example"}}' },
      "LEAKS-EXISTENCE",
    ],
    [
      "the recorder's stored value",
      "storage-recorder",
      "ext-page",
      { outcome: "ok", text: `{"own":"${CTX.ownMark}","och_secret":"${CTX.storeMark}"}` },
      "READ",
    ],
    [
      "a readable frame",
      "iframe-file-root",
      "file",
      {
        outcome: "load",
        text: "load; contentDocument readable, text: 201: k DIRECTORY; contentWindow.location.href: file:///d/",
      },
      "LEAKS-EXISTENCE",
    ],
    [
      "an opened file tab",
      "tabs-create-file",
      "ext-page",
      { outcome: "ok", text: "created; 1 s later: url file:///p/log.jsonl" },
      "LEAKS-EXISTENCE",
    ],
    ["a differing oracle", "img-file-oracle", "file", DIFFERS, "LEAKS-EXISTENCE"],
    [
      "a recorder page script result",
      "scripting-recorder-page",
      "ext-bg",
      { outcome: "done", text: 'tab 3: returned ["<html>"]' },
      "READ",
    ],
    [
      "the recorder in tabs.query",
      "tabs-query-recorder",
      "ext-bg",
      { outcome: "ok", text: `${REC_TAB} ${CTX.marker}` },
      "READ",
    ],
  ];
  it.each(leaks)(
    "judges %s as a leak and fails the run",
    (_label, probe, position, observed, verdict) => {
      const input = withRow(probe, position, observed);
      expect(rowOf(input, probe, position).verdict).toBe(verdict);
      expect(
        judgeIsolationRun(input).mismatches.some((m) => m.startsWith(`${probe}@${position}:`)),
      ).toBe(true);
    },
  );

  const eachLeaks: readonly [
    string,
    string,
    Position,
    ObservedProbe,
    "READ" | "LEAKS-EXISTENCE",
  ][] = [
    [
      "a reachable resource:// name",
      "resource-all",
      "file",
      {
        outcome: "each",
        text: "",
        each: [
          { target: "resource://gre/", ...UNREACHABLE },
          {
            target: "resource://app/",
            outcome: "fetch ok, link load",
            text: "status 200, 9 chars",
          },
        ],
      },
      "READ",
    ],
    [
      "a resource:// name that loads as a stylesheet",
      "resource-all",
      "web",
      {
        outcome: "each",
        text: "",
        each: [
          { target: "resource://gre/", ...UNREACHABLE },
          { target: "resource://app/", outcome: "fetch error, link load", text: NETWORK.text },
        ],
      },
      "LEAKS-EXISTENCE",
    ],
    [
      "a readable written file",
      "inventory-read",
      "file",
      {
        outcome: "each",
        text: "",
        each: [
          { target: "file:///d/one-click-har/", ...NETWORK },
          {
            target: "file:///d/one-click-har/k/settings.json",
            outcome: "ok",
            text: "status 200, 2 chars: {}",
          },
        ],
      },
      "READ",
    ],
    [
      "a predictable path that exists",
      "inventory-exists",
      "file",
      {
        outcome: "each",
        text: "",
        each: [{ target: "file:///d/one-click-har/sites/", ...DIFFERS }],
      },
      "LEAKS-EXISTENCE",
    ],
    [
      "a guessed key folder that exists",
      "script-site-oracle",
      "file",
      {
        outcome: "each",
        text: "",
        each: [{ target: "file:///d/one-click-har/g1/sites/bank.example/", ...DIFFERS }],
      },
      "LEAKS-EXISTENCE",
    ],
    [
      "a fetchable extension file",
      "mozext-every-file",
      "web",
      {
        outcome: "each",
        text: "",
        each: [
          {
            target: `moz-extension://${CTX.recUuid}/manifest.json`,
            outcome: "ok",
            text: "status 200, 99 chars",
          },
        ],
      },
      "READ",
    ],
  ];
  it.each(eachLeaks)(
    "judges %s among planned targets as a leak",
    (_label, probe, position, observed, verdict) => {
      const input = withRow(probe, position, observed);
      expect(rowOf(input, probe, position).verdict).toBe(verdict);
      expect(judgeIsolationRun(input).ok).toBe(false);
    },
  );

  it("judges an empty plan for predictable paths as BLOCKED only when nothing was planned", () => {
    const input = { ...passingInput(), targets: { ...TARGETS, "inventory-exists": [] } };
    const empty = { outcome: "each", text: "0 targets", each: [] };
    const rows = input.browserRows.map((r) =>
      r.probe === "inventory-exists" ? { ...r, observed: empty } : r,
    );
    expect(rowOf({ ...input, browserRows: rows }, "inventory-exists", "file").verdict).toBe(
      "BLOCKED",
    );
    expect(
      rowOf(withRow("inventory-exists", "file", empty), "inventory-exists", "file").verdict,
    ).toBe("NO-RESULT");
  });

  it("fails a control that could not read its planted value", () => {
    const input = withRow("planted-own-war-fetch", "web", NETWORK);
    expect(rowOf(input, "planted-own-war-fetch", "web").verdict).toBe("BLOCKED");
    expect(judgeIsolationRun(input).mismatches[0]).toContain(
      "planted-own-war-fetch@web: expected READ",
    );
    const mutated = withRow("fetch-file-log", "file-mutated", NETWORK);
    expect(judgeIsolationRun(mutated).ok).toBe(false);
  });

  it("fails a decided exception that showed nothing, so the exception row cannot go blind", () => {
    const input = withRow("tabs-query-recorder", "ext-page", {
      outcome: "ok",
      text: "2 http://bank.example/ Bank",
    });
    expect(rowOf(input, "tabs-query-recorder", "ext-page").verdict).toBe("BLOCKED");
    expect(judgeIsolationRun(input).ok).toBe(false);
  });

  it("requires planted-resource@file to leak when the Linux sandbox blocks planted-resource@web", () => {
    const input = withRow("planted-resource", "file", SAME);
    expect(rowOf(input, "planted-resource", "web").verdict).toBe("BLOCKED");
    expect(judgeIsolationRun(input).mismatches[0]).toContain("planted-resource@file");
    const elsewhere = { ...passingInput(), context: { ...CTX, webSandboxBlocksArchive: false } };
    expect(judgeIsolationRun(elsewhere).mismatches[0]).toContain("planted-resource@web");
  });

  it("judges synthetic controls from their reads: a missing control is NO-RESULT, a blind one fails", () => {
    const base = passingInput();
    const missing = {
      ...base,
      syntheticControls: base.syntheticControls.filter((c) => c.id !== "limit-other-experiment"),
    };
    expect(rowOf(missing, "limit-other-experiment", "otherexp").verdict).toBe("NO-RESULT");
    expect(judgeIsolationRun(missing).ok).toBe(false);
    const blind = {
      ...base,
      syntheticControls: base.syntheticControls.map((c) =>
        c.id === "control-system-read"
          ? { ...c, reads: [`log ${CTX.marker}`, "error NotFoundError"] }
          : c,
      ),
    };
    expect(rowOf(blind, "control-system-read", "system").verdict).toBe("BLOCKED");
    expect(judgeIsolationRun(blind).ok).toBe(false);
  });

  it("fails a content script that ran in an archive document, and needs the policy's denial to pass without one", () => {
    const base = passingInput();
    const injected = {
      ...base,
      csArchiveInjectedDocs: [{ href: "file:///d/one-click-har/k/x.jsonl", text: "{}" }],
    };
    expect(rowOf(injected, "cs-in-archive-document", "cs-archive").verdict).toBe("LEAKS-EXISTENCE");
    const read = {
      ...base,
      csArchiveInjectedDocs: [{ href: "file:///d/x.jsonl", text: CTX.marker }],
    };
    expect(rowOf(read, "cs-in-archive-document", "cs-archive").verdict).toBe("READ");
    const unproven = { ...base, canAccessFileObserved: false };
    expect(rowOf(unproven, "cs-in-archive-document", "cs-archive").verdict).toBe("NO-RESULT");
    expect(rowOf(unproven, "cs-file-injection", "cs-file").verdict).toBe("NO-RESULT");
    expect(judgeIsolationRun(unproven).ok).toBe(false);
  });

  it("fails when a declared extra check fails, did not run, ran twice, or is unknown", () => {
    const base = passingInput();
    const failing = base.extraChecks.map((c) =>
      c.id === "archive-modes" ? { ...c, ok: false, detail: "x is file mode 644" } : c,
    );
    expect(judgeIsolationRun({ ...base, extraChecks: failing }).mismatches).toEqual([
      "archive-modes: x is file mode 644",
    ]);
    const skipped = base.extraChecks.filter((c) => c.id !== "key-differs-across-profiles");
    expect(judgeIsolationRun({ ...base, extraChecks: skipped }).mismatches).toEqual([
      "extra check key-differs-across-profiles did not run",
    ]);
    expect(judgeIsolationRun({ ...base, extraChecks: [] }).mismatches).toHaveLength(
      Object.keys(EXTRA_CHECKS).length,
    );
    const twice = [
      ...base.extraChecks,
      { id: "downloads-list" as const, ok: true, detail: "again" },
    ];
    expect(judgeIsolationRun({ ...base, extraChecks: twice }).ok).toBe(false);
    const unknown = [...base.extraChecks, { id: "made-up" as ExtraCheckId, ok: true, detail: "" }];
    expect(judgeIsolationRun({ ...base, extraChecks: unknown }).ok).toBe(false);
  });

  it("runs the content-script rows in the file:// page, and drops the injection row, once a content script ran there", () => {
    const rows = expandExpectedRows(true);
    expect(rows).toHaveLength(341);
    expect(rows.filter((r) => r.position === "cs-file")).toHaveLength(40);
    expect(rows.some((r) => r.id === "cs-file-injection")).toBe(false);
  });

  const malformed: readonly [string, string, Position, unknown, Verdict][] = [
    ["a null observation", "xhr-file-log", "ext-bg", null, "NO-RESULT"],
    ["an undefined observation", "xhr-file-log", "web", undefined, "NO-RESULT"],
    ["an observation without text", "fetch-file-body", "web", { outcome: "ok" }, "NO-RESULT"],
    [
      "an observation without outcome",
      "fetch-file-body",
      "file",
      { text: "status 200" },
      "NO-RESULT",
    ],
    [
      "an empty outcome",
      "notifications-getall",
      "ext-bg",
      { outcome: "", text: "{}" },
      "NO-RESULT",
    ],
    [
      "an empty answer",
      "clipboard-after-export",
      "ext-page",
      { outcome: "ok", text: "" },
      "NO-RESULT",
    ],
    [
      "a denial text under another outcome",
      "fetch-file-log",
      "file",
      { outcome: "ok", text: NETWORK.text },
      "READ",
    ],
    [
      "an answer text under another outcome",
      "downloads-search",
      "ext-page",
      { outcome: "error", text: "no download items" },
      "NO-RESULT",
    ],
    [
      "its own value under an error",
      "idb-recorder",
      "ext-bg",
      { outcome: "error", text: `own: kv.own = ${CTX.ownMark}` },
      "NO-RESULT",
    ],
    [
      "a blank frame under no frame event",
      "jar-file-iframe",
      "web",
      { outcome: "ok", text: FRAME_BLANK.text },
      "READ",
    ],
    [
      "an error where an exception listing was due",
      "management-getall",
      "ext-bg",
      { outcome: "error", text: "Error: denied" },
      "NO-RESULT",
    ],
    [
      "an empty listing where an exception listing was due",
      "tabs-query-recorder",
      "ext-bg",
      { outcome: "ok", text: "" },
      "NO-RESULT",
    ],
    [
      "a webRequest baseline that saw no traffic",
      "baseline-webrequest",
      "ext-bg",
      { outcome: "ok", text: '{"cookieHeaders":[],"responseBodies":[]}' },
      "READ",
    ],
    [
      "a baseline that answered without the marker",
      "devtools-gethar",
      "ext-devtools",
      { outcome: "ok", text: "0 entries: []" },
      "READ",
    ],
    [
      "a null pair",
      "img-file-oracle",
      "web",
      { outcome: "same", text: "", pair: null },
      "NO-RESULT",
    ],
    [
      "a pair with a null side",
      "img-file-oracle",
      "file",
      { outcome: "same", text: "", pair: { hit: null, miss: { outcome: "error", text: "error" } } },
      "NO-RESULT",
    ],
    [
      "a pair with only a missing side",
      "img-file-oracle",
      "ext-bg",
      { outcome: "same", text: "", pair: { miss: { outcome: "error", text: "error" } } },
      "NO-RESULT",
    ],
    [
      "a pair side without text",
      "mozext-script-oracle",
      "file",
      {
        outcome: "same",
        text: "",
        pair: { hit: { outcome: "error" }, miss: { outcome: "error", text: "error" } },
      },
      "NO-RESULT",
    ],
    [
      "a missing side without text",
      "mozext-script-oracle",
      "web",
      {
        outcome: "same",
        text: "",
        pair: { hit: { outcome: "error", text: "error" }, miss: { outcome: "error" } },
      },
      "NO-RESULT",
    ],
    [
      "a pair of identical throws",
      "sendmessage-oracle",
      "ext-bg",
      {
        outcome: "same",
        text: "",
        pair: { hit: { outcome: "threw", text: "x" }, miss: { outcome: "threw", text: "x" } },
      },
      "NO-RESULT",
    ],
    [
      "an existing side that threw",
      "sendmessage-oracle",
      "ext-page",
      {
        outcome: "same",
        text: "",
        pair: { hit: { outcome: "threw", text: "x" }, miss: { outcome: "error", text: "x" } },
      },
      "NO-RESULT",
    ],
    [
      "a missing side that threw",
      "sendmessage-oracle",
      "cs-web",
      {
        outcome: "same",
        text: "",
        pair: { hit: { outcome: "error", text: "x" }, miss: { outcome: "threw", text: "x" } },
      },
      "NO-RESULT",
    ],
    [
      "a pair of identical empty outcomes",
      "script-root-oracle",
      "web",
      {
        outcome: "same",
        text: "",
        pair: { hit: { outcome: "", text: "x" }, miss: { outcome: "", text: "x" } },
      },
      "NO-RESULT",
    ],
    [
      "per-target results that are not a list",
      "chrome-traversal",
      "web",
      { outcome: "each", text: "", each: "none" },
      "NO-RESULT",
    ],
    [
      "a pair with identical marks",
      "img-file-oracle",
      "cs-web",
      {
        outcome: "same",
        text: "",
        pair: {
          hit: { outcome: "load", text: CTX.marker },
          miss: { outcome: "load", text: CTX.marker },
        },
      },
      "READ",
    ],
  ];
  it.each(malformed)(
    "judges %s as %s, never BLOCKED",
    (_label, probe, position, observed, verdict) => {
      const input = withRow(probe, position, observed);
      expect(rowOf(input, probe, position).verdict).toBe(verdict);
      expect(judgeIsolationRun(input).ok).toBe(false);
    },
  );

  it("tells pairs apart by outcome and by text", () => {
    const sameOutcome = {
      outcome: "differs",
      text: "",
      pair: {
        hit: { outcome: "load", text: "load; cssRules: 3" },
        miss: { outcome: "load", text: "load; cssRules: 0" },
      },
    };
    expect(
      rowOf(withRow("img-file-oracle", "file", sameOutcome), "img-file-oracle", "file").verdict,
    ).toBe("LEAKS-EXISTENCE");
    const sameText = {
      outcome: "differs",
      text: "",
      pair: { hit: { outcome: "load", text: "x" }, miss: { outcome: "error", text: "x" } },
    };
    expect(
      rowOf(withRow("img-file-oracle", "file", sameText), "img-file-oracle", "file").verdict,
    ).toBe("LEAKS-EXISTENCE");
  });

  it("takes a cross-origin frame and a blank one as the same withheld state, but not a frame that read something", () => {
    const pairOf = (hit: Observation, miss: Observation) => ({
      outcome: "differs",
      text: "",
      pair: { hit, miss },
    });
    const crossOrigin = { outcome: "timeout", text: `iframe timeout${FRAME_CROSS.text.slice(4)}` };
    const blank = { outcome: "timeout", text: `iframe timeout${FRAME_BLANK.text.slice(5)}` };
    const caught = withRow("iframe-site-oracle", "file", {
      outcome: "each",
      text: "",
      each: [{ target: TARGETS["iframe-site-oracle"]![0]!, ...pairOf(crossOrigin, blank) }],
    });
    expect(rowOf(caught, "iframe-site-oracle", "file").verdict).toBe("BLOCKED");
    const read = {
      outcome: "load",
      text: "iframe load; contentDocument readable, text: 201: r1-0.jsonl; contentWindow.location.href: file:///d/",
    };
    const leaked = withRow("iframe-site-oracle", "file", {
      outcome: "each",
      text: "",
      each: [{ target: TARGETS["iframe-site-oracle"]![0]!, ...pairOf(read, blank) }],
    });
    expect(rowOf(leaked, "iframe-site-oracle", "file").verdict).toBe("LEAKS-EXISTENCE");
    const otherEvent = withRow("iframe-site-oracle", "file", {
      outcome: "each",
      text: "",
      each: [
        {
          target: TARGETS["iframe-site-oracle"]![0]!,
          ...pairOf({ ...crossOrigin, outcome: "load" }, blank),
        },
      ],
    });
    expect(rowOf(otherEvent, "iframe-site-oracle", "file").verdict).toBe("LEAKS-EXISTENCE");
  });

  it("judges a per-target probe without a plan as NO-RESULT", () => {
    const { "resource-all": _dropped, ...rest } = TARGETS;
    const input = { ...passingInput(), targets: rest };
    expect(rowOf(input, "resource-all", "web").verdict).toBe("NO-RESULT");
    expect(judgeIsolationRun(input).ok).toBe(false);
  });

  it("judges a reachable name whose fetch failed another way as a leak, not a denial", () => {
    const observed = {
      outcome: "each",
      text: "",
      each: [
        { target: "resource://gre/", ...UNREACHABLE },
        {
          target: "resource://app/",
          outcome: "fetch error, link error",
          text: "TypeError: Load failed",
        },
      ],
    };
    expect(
      rowOf(withRow("resource-all", "ext-bg", observed), "resource-all", "ext-bg").verdict,
    ).not.toBe("BLOCKED");
  });

  it("fails a management exception that names the recorder by id only nowhere, and passes one that names it by id", () => {
    const blind = withRow("management-getall", "ext-bg", {
      outcome: "ok",
      text: "och-probe@test | Isolation probe extension",
    });
    expect(judgeIsolationRun(blind).ok).toBe(false);
    const byId = withRow("management-getall", "ext-bg", {
      outcome: "ok",
      text: `${CTX.recId} | One-Click HAR | extension`,
    });
    expect(judgeIsolationRun(byId).ok).toBe(true);
  });

  it("passes a control that reads its mark, and fails one whose answer succeeded without the mark", () => {
    const marked = withRow("fetch-file-dir", "file-mutated", {
      outcome: "ok",
      text: `status 200: ${CTX.marker}`,
    });
    expect(rowOf(marked, "fetch-file-dir", "file-mutated").verdict).toBe("READ");
    expect(judgeIsolationRun(marked).ok).toBe(true);
    const unmarked = withRow("planted-own-war-script", "file", {
      outcome: "load",
      text: "load; window.OCH_WAR = something else",
    });
    expect(judgeIsolationRun(unmarked).ok).toBe(false);
  });

  it("passes planted-resource@web as a leak where no sandbox blocks it", () => {
    const input = withRow("planted-resource", "web", DIFFERS);
    expect(
      judgeIsolationRun({ ...input, context: { ...CTX, webSandboxBlocksArchive: false } }).ok,
    ).toBe(true);
  });

  it("does not let one control stand in for another reported at the same position", () => {
    const base = passingInput();
    const input = {
      ...base,
      syntheticControls: base.syntheticControls.filter((c) => c.id !== "control-system-read"),
    };
    expect(rowOf(input, "control-system-read", "system").verdict).toBe("NO-RESULT");
  });

  it("calls a blind planted script control BLOCKED", () => {
    const input = withRow("planted-own-war-script", "web", {
      outcome: "error",
      text: "error; window.OCH_WAR = undefined",
    });
    expect(rowOf(input, "planted-own-war-script", "web").verdict).toBe("BLOCKED");
    expect(judgeIsolationRun(input).ok).toBe(false);
  });

  it("fails a missing row, and a control with no reads or reported at another position", () => {
    const base = passingInput();
    const rows = base.browserRows.filter(
      (r) => !(r.probe === "xhr-file-log" && r.position === "web"),
    );
    expect(judgeIsolationRun({ ...base, browserRows: rows }).ok).toBe(false);
    const empty = {
      ...base,
      syntheticControls: base.syntheticControls.map((c) =>
        c.id === "limit-same-user-process" ? { ...c, reads: [] } : c,
      ),
    };
    expect(judgeIsolationRun(empty).ok).toBe(false);
    const moved = {
      ...base,
      syntheticControls: base.syntheticControls.map((c) =>
        c.id === "planted-recorder-idb" ? { ...c, position: "system" as const } : c,
      ),
    };
    expect(rowOf(moved, "planted-recorder-idb", "rec-page").verdict).toBe("NO-RESULT");
  });

  it("builds multi-entry stored XPI archives readable by readZipEntry", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-iso-zip-"));
    cleanupDirs.push(dir);
    const xpiPath = NodePath.join(dir, "probe.xpi");
    await NodeFSP.writeFile(
      xpiPath,
      buildStoredZip([
        { name: "manifest.json", data: Buffer.from('{"id":"probe@test"}', "utf8") },
        { name: "sub/script.js", data: Buffer.from("console.log(1);\n", "utf8") },
      ]),
    );
    expect((await readZipEntry(xpiPath, "manifest.json")).toString("utf8")).toBe(
      '{"id":"probe@test"}',
    );
    expect((await readZipEntry(xpiPath, "sub/script.js")).toString("utf8")).toBe(
      "console.log(1);\n",
    );
  });
});
