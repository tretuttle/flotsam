import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readZipEntry } from "../../src/zip.ts";
import type { ExtraCheckResult } from "./archive-oracle.ts";
import {
  judgeIsolationRun,
  readObservation,
  type BrowserRowReport,
  type IsolationRunInput,
  type JudgeContext,
  type Observation,
  type Unit,
  type Witness,
} from "./judge.ts";
import {
  expandExpectedRows,
  EXTRA_CHECKS,
  PROBE_TABLE,
  type Denial,
  type ExtraCheckId,
  type Outcome,
  type Position,
  type ProbeSpec,
  type Verdict,
} from "./probe-table.ts";
import { planTargets, type PlanInput } from "./targets.ts";
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
  secretMark: "OCHSECRET_feedface",
  storeMark: "OCHSTORE_0badf00d",
  ownMark: "OCHOWN_5eed5eed",
  recId: "one-click-har@tretuttle.github.io",
  recUuid: "11111111-2222-3333-4444-555555555555",
  webSandboxBlocksArchive: true,
};

const LOG = "/d/one-click-har/k0/sites/bank.example/log/r-0.jsonl";
const PLAN_INPUT: PlanInput = {
  file: {
    appFolder: "/d/one-click-har",
    keyFolder: "/d/one-click-har/k0",
    log: LOG,
    body: "/d/one-click-har/k0/sites/bank.example/bodies/r1.7.body",
    export: "/dl/bank.example-2026-11-16.har",
    siteDir: "/d/one-click-har/k0/sites/bank.example",
  },
  inventory: [
    { path: "/d/one-click-har", directory: true },
    { path: "/d/one-click-har/k0/settings.json", directory: false },
  ],
  outsideKeyFolder: [],
  guessedKeyFolders: ["/d/one-click-har/g1", "/d/one-click-har/g2"],
  redirectToLog: "http://attacker.example/redir?to=file%3A%2F%2F%2Fd%2Flog",
  wrRedirect: "http://attacker.example/wr-redirect",
  rec: {
    id: CTX.recId,
    base: `moz-extension://${CTX.recUuid}/`,
    popupPath: "action/index.html",
    popupScriptPath: "action/index.js",
    files: ["manifest.json", "action/index.html"],
  },
  probe: {
    base: "moz-extension://99999999-0000-0000-0000-000000000000/",
    warMark: CTX.warMark,
    secretMark: CTX.secretMark,
  },
  randomUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  randomId: "not-installed-1@test",
  plantedResource: {
    hit: "resource://och-planted/sites/bank.example/log/r-0.jsonl",
    miss: "resource://och-planted/sites/bank.example/log/missing.jsonl",
  },
  resourceNames: ["gre", "app"],
  chromePackages: ["global"],
  mozSrc: "moz-src:///browser/a.sys.mjs",
  binDir: "/opt/zen",
};
const PLAN = planTargets(PLAN_INPUT);

const spec = (id: string): ProbeSpec => PROBE_TABLE.find((s) => s.id === id)!;
const unitsOf = (id: string): readonly Unit[] => PLAN.targets[id]!;
const only = (id: string): string => unitsOf(id)[0] as string;
const pairUnit = (id: string): readonly [string, string] =>
  unitsOf(id)[0] as readonly [string, string];

// The witness found every planned target, found every missing counterpart absent, and found no guessed key.
const MISSES = new Set(
  Object.values(PLAN.targets)
    .flat()
    .flatMap((u) => (typeof u === "string" ? [] : [u[1]])),
);
const GUESSES = new Set(
  PROBE_TABLE.filter((s) => s.guess === true).flatMap((s) =>
    unitsOf(s.id).map((u) => (typeof u === "string" ? u : u[0])),
  ),
);
const WITNESS: Readonly<Record<string, Witness>> = Object.fromEntries(
  Object.keys(PLAN.checks).map((t) => [
    t,
    { present: !MISSES.has(t) && !GUESSES.has(t), detail: "seen" },
  ]),
);

const at = (target: string, outcome: Outcome, text: string): Observation => ({
  outcome,
  text,
  target,
});
type Side = { readonly outcome: Outcome; readonly text: string };
const pairAt = (unit: readonly [string, string], hit: Side, miss: Side) => ({
  outcome: hit.outcome === miss.outcome && hit.text === miss.text ? "same" : "differs",
  text: `existing path: ${hit.outcome} | missing path: ${miss.outcome}`,
  target: unit[0],
  pair: { hit: at(unit[0], hit.outcome, hit.text), miss: at(unit[1], miss.outcome, miss.text) },
});
const each = (items: readonly unknown[]) => ({
  outcome: "each",
  text: "",
  target: "",
  each: items,
});

// What Gecko answered in the recorded baseline runs, copied as text.
const NETWORK = "TypeError: NetworkError when attempting to fetch resource.";
const BLANK =
  "error; contentDocument readable, text: ; contentWindow.location.href: about:blank; replies: none";
const CROSS =
  'load; contentDocument null; contentWindow.location.href: SecurityError: Permission denied to get property "href" on cross-origin object; replies: none';
const NO_RECEIVER = "Error: Could not establish connection. Receiving end does not exist.";
const REC_TAB = `3 moz-extension://${CTX.recUuid}/action/index.html One-Click HAR\n2 http://bank.example/ Bank`;
const ERROR_SIDE: Side = { outcome: "error", text: "error" };
const LOAD_SIDE: Side = { outcome: "load", text: "load" };

const DENIED: Readonly<Record<string, readonly [Outcome, string]>> = {
  "fetch-file-log": ["error", NETWORK],
  "fetch-file-body": ["error", NETWORK],
  "fetch-file-dir": ["error", NETWORK],
  "fetch-file-export": ["error", NETWORK],
  "content-fetch-file-log": ["error", NETWORK],
  "xhr-file-log": ["error", "error event, status 0, readyState 4"],
  "iframe-file-log": ["error", BLANK],
  "iframe-file-root": ["load", CROSS],
  "iframe-file-export": ["timeout", BLANK.replace(/^error/u, "timeout")],
  "viewsource-fetch": ["error", NETWORK],
  "viewsource-iframe": ["error", BLANK],
  "jar-file-fetch": ["error", NETWORK],
  "jar-file-iframe": ["error", BLANK],
  "redirect-fetch": ["error", NETWORK],
  "redirect-iframe": ["timeout", CROSS.replace(/^load/u, "timeout")],
  "window-open-file": ["error", "Error: Access to 'file:///d/log' from script denied"],
  "wr-redirect-iframe": ["load", CROSS],
  "tabs-create-file": ["error", "Error: Illegal URL: file:///d/log"],
  "tabs-create-dir": ["error", "Error: Illegal URL: file:///d/"],
  "tabs-update-file": ["error", "Error: Illegal URL: file:///d/log"],
  "tabs-update-redirect": [
    "ok",
    "update resolved; 1 s later: url http://attacker.example/victim.html, title victim",
  ],
  "windows-create-file": ["error", "Error: Illegal URL: file:///d/log"],
  "downloads-download-file": [
    "error",
    "Error: Type error (Error processing url: Error: Access denied for URL file:///d/log for downloads.download.)",
  ],
  "tabs-create-viewsource": ["error", "Error: Illegal URL: view-source:file:///d/log"],
  "wr-redirect-tab": [
    "ok",
    "created; 1 s later: url about:blank, status complete, title attacker.example/wr-redirect?from=tab",
  ],
  "mozext-manifest": ["error", NETWORK],
  "mozext-parent": ["error", NETWORK],
  "mozext-schema": ["error", NETWORK],
  "mozext-popup": ["error", NETWORK],
  "mozext-frame-recorder": ["error", BLANK],
  "own-non-war": ["error", NETWORK],
  "api-call": ["error", "ReferenceError: browser is not defined"],
  "sendmessage-recorder": ["error", NO_RECEIVER],
  "connect-recorder": ["disconnected", `onDisconnect, error: ${NO_RECEIVER.slice(7)}`],
  "executescript-recorder-page": [
    "done",
    `tab 3 (moz-extension://${CTX.recUuid}/action/index.html): Error: Missing host permission for the tab`,
  ],
  "scripting-recorder-page": [
    "done",
    `tab 3 (moz-extension://${CTX.recUuid}/action/index.html): Error: Missing host permission for the tab`,
  ],
  "downloads-search": ["ok", "no download items"],
  "clipboard-after-export": ["ok", "clipboard text: "],
  "notifications-getall": ["ok", "{}"],
  "storage-recorder": ["ok", `{"own":"${CTX.ownMark}"}`],
  "idb-recorder": [
    "ok",
    `own: kv.own = ${CTX.ownMark}; databases(): [{"name":"och-probe-own","version":1}]; och-recorder: no kv store`,
  ],
};

const apiNamespace = (position: Position): string =>
  ["ext-bg", "ext-page", "ext-devtools"].includes(position)
    ? "typeof browser.oneClickHar: undefined; typeof page oneClickHar: undefined; page globals not in a fresh frame: n/a"
    : "typeof browser.oneClickHar: n/a; typeof page oneClickHar: undefined; page globals not in a fresh frame: []";

/** The answer a probe gets when its declared denial holds, at one unit. */
function deniedUnit(id: string, unit: Unit, position: Position): unknown {
  if (typeof unit !== "string") return pairAt(unit, ERROR_SIDE, ERROR_SIDE);
  if (spec(id).deny.kind === "unreachable") return at(unit, "fetch error, link error", NETWORK);
  if (id === "api-namespace") return at(unit, "ok", apiNamespace(position));
  if (id === "window-open-file" && position === "file")
    return at(unit, "error", "window.open returned null");
  const [outcome, text] = DENIED[id] ?? ["error", NETWORK];
  return at(unit, outcome, text);
}

/** The answer a control or decided exception must show. */
function seenUnit(id: string, unit: Unit): unknown {
  if (typeof unit !== "string") return pairAt(unit, LOAD_SIDE, ERROR_SIDE);
  if (id === "planted-own-war-fetch") return at(unit, "ok", `status 200, 20 chars: ${CTX.warMark}`);
  if (id === "planted-own-war-script")
    return at(unit, "load", `load; window.OCH_WAR = ${CTX.warMark}`);
  if (id === "tabs-query-recorder" || id === "management-getall") return at(unit, "ok", REC_TAB);
  return at(unit, "ok", `cookie ${CTX.marker}`);
}

function rowFor(id: string, position: Position, seen: boolean): unknown {
  const units = unitsOf(id);
  const one = (u: Unit): unknown => (seen ? seenUnit(id, u) : deniedUnit(id, u, position));
  return spec(id).shape === "each" ? each(units.map(one)) : one(units[0]!);
}

function passingRows(): BrowserRowReport[] {
  return expandExpectedRows(false).flatMap((row) =>
    row.spec === null
      ? []
      : [
          {
            kind: "row" as const,
            position: row.position,
            probe: row.id,
            observed: rowFor(
              row.id,
              row.position,
              row.expected.kind !== "BLOCKED" &&
                !(row.id === "planted-resource" && row.position === "web"),
            ),
          },
        ],
  );
}

const passingChecks = (): ExtraCheckResult[] =>
  (Object.keys(EXTRA_CHECKS) as ExtraCheckId[]).map((id) => ({ id, ok: true, detail: "held" }));

function passingInput(): IsolationRunInput {
  return {
    context: CTX,
    browserRows: passingRows(),
    targets: PLAN.targets,
    witness: WITNESS,
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
  rows.push({ kind: "row", position, probe, observed });
  return { ...input, browserRows: rows };
}

/** Verdict, ok, observed text and the run's mismatches for one row: everything a person or CI reads. */
function judged(input: IsolationRunInput, id: string, position: Position) {
  const judgment = judgeIsolationRun(input);
  const row = judgment.rows.find((r) => r.id === id && r.position === position)!;
  return {
    verdict: row.verdict,
    ok: row.ok,
    observed: row.observed,
    mismatches: judgment.mismatches,
  };
}

describe("isolation probe table", () => {
  it("expands to 292 rows: 275 browser rows, 10 no-Marionette rows and 7 synthetic rows", () => {
    expect(PROBE_TABLE).toHaveLength(66);
    const rows = expandExpectedRows(false);
    expect(rows).toHaveLength(292);
    expect(rows.filter((r) => r.position === "file-no-marionette")).toHaveLength(10);
    expect(rows.filter((r) => r.spec === null)).toHaveLength(7);
  });

  it("names exactly three decided exceptions, at six rows", () => {
    const exceptions = expandExpectedRows(false).flatMap((r) =>
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
  });

  it("keeps tabs-only probes out of the devtools page, which has no tabs API", () => {
    for (const id of ["tabs-query-recorder", "management-getall", "downloads-search"]) {
      expect(spec(id).positions).not.toContain("ext-devtools");
    }
  });

  it("plans units for exactly the probes in the table", () => {
    expect(Object.keys(PLAN.targets).toSorted()).toEqual(PROBE_TABLE.map((s) => s.id).toSorted());
  });
});

/** The verdict a well-formed answer other than the denial gets, written out apart from the table. */
const LEAK: Readonly<Record<string, Verdict>> = {
  ...Object.fromEntries(
    [
      "fetch-file-log",
      "fetch-file-body",
      "fetch-file-export",
      "inventory-read",
      "content-fetch-file-log",
      "xhr-file-log",
      "iframe-file-log",
      "iframe-file-export",
      "viewsource-fetch",
      "viewsource-iframe",
      "jar-file-fetch",
      "jar-file-iframe",
      "redirect-fetch",
      "redirect-iframe",
      "window-open-file",
      "wr-redirect-iframe",
      "downloads-download-file",
      "resource-all",
      "resource-traversal",
      "chrome-all",
      "chrome-traversal",
      "moz-src-root",
      "mozext-every-file",
      "mozext-manifest",
      "mozext-parent",
      "mozext-schema",
      "mozext-popup",
      "own-non-war",
      "api-namespace",
      "api-call",
      "sendmessage-recorder",
      "connect-recorder",
      "executescript-recorder-page",
      "scripting-recorder-page",
      "clipboard-after-export",
    ].map((id) => [id, "READ"]),
  ),
  ...Object.fromEntries(
    [
      "fetch-file-dir",
      "iframe-file-root",
      "img-file-oracle",
      "script-file-oracle",
      "css-file-oracle",
      "iframe-site-oracle",
      "script-root-oracle",
      "script-site-oracle",
      "tabs-create-file",
      "tabs-create-dir",
      "tabs-update-file",
      "tabs-update-redirect",
      "windows-create-file",
      "tabs-create-viewsource",
      "wr-redirect-tab",
      "planted-resource",
      "mozext-script-oracle",
      "mozext-timing",
      "mozext-frame-recorder",
      "sendmessage-oracle",
      "tabs-query-recorder",
      "management-getall",
      "downloads-search",
      "notifications-getall",
    ].map((id) => [id, "LEAKS-EXISTENCE"]),
  ),
  // A store read that did not show the prober's own value proves nothing either way.
  "storage-recorder": "NO-RESULT",
  "idb-recorder": "NO-RESULT",
};

/** A well-formed answer that is not the denial and carries no planted mark. */
function leakingUnit(denial: Denial, unit: Unit): unknown {
  if (typeof unit !== "string") return pairAt(unit, LOAD_SIDE, ERROR_SIDE);
  switch (denial.kind) {
    case "unreachable":
      return at(unit, "fetch ok, link load", "status 200, 9 chars: <listing>");
    case "frame-withheld":
      return at(unit, "load", "load; contentDocument readable, text: {}; replies: none");
    case "answered":
      return at(unit, denial.outcome === "error" ? "load" : (denial.outcome as Outcome), "x=1");
    case "answered-without-recorder":
      return at(unit, "ok", REC_TAB);
    default:
      return at(unit, "ok", "status 200, 1 chars: x");
  }
}

const denialOf = (s: ProbeSpec, position: Position): Denial =>
  ("denyAt" in s ? s.denyAt?.[position] : undefined) ?? s.deny;

describe("isolation judge", () => {
  it("passes a run where every probe saw its declared denial on a witnessed target", () => {
    const result = judgeIsolationRun(passingInput());
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({
      BLOCKED: 274,
      READ: 11,
      "LEAKS-EXISTENCE": 7,
      "NO-RESULT": 0,
    });
    expect(result.rows.filter((r) => !r.ok)).toEqual([]);
  });

  const blockedRows = expandExpectedRows(false).filter(
    (r) =>
      r.spec !== null &&
      r.expected.kind === "BLOCKED" &&
      !(r.id === "planted-resource" && r.position === "web") &&
      unitsOf(r.id).length > 0,
  );
  it.each(blockedRows.map((r) => [r.id, r.position] as const))(
    "judges a leak at %s@%s as its kind, fails the row, and names it in the report",
    (id, position) => {
      const s = spec(id);
      const denial = denialOf(s, position);
      const units = unitsOf(id);
      const observed =
        s.shape === "each"
          ? each(
              units.map((u, i) => (i === 0 ? leakingUnit(denial, u) : deniedUnit(id, u, position))),
            )
          : leakingUnit(denial, units[0]!);
      const result = judged(withRow(id, position, observed), id, position);
      expect(result.verdict).toBe(LEAK[id]);
      expect(result.ok).toBe(false);
      expect(result.mismatches).toHaveLength(1);
      expect(
        result.mismatches[0]!.startsWith(`${id}@${position}: expected BLOCKED, got ${LEAK[id]!} (`),
      ).toBe(true);
    },
  );

  it("reads a probe that came back empty as NO-RESULT, even on a decided-exception row", () => {
    const xhr = only("xhr-file-log");
    expect(judged(withRow("xhr-file-log", "web", {}), "xhr-file-log", "web")).toEqual({
      verdict: "NO-RESULT",
      ok: false,
      observed: `${xhr} -> malformed {}`,
      mismatches: [`xhr-file-log@web: expected BLOCKED, got NO-RESULT (${xhr} -> malformed {})`],
    });
    const tabs = only("tabs-query-recorder");
    expect(
      judged(withRow("tabs-query-recorder", "ext-bg", {}), "tabs-query-recorder", "ext-bg"),
    ).toEqual({
      verdict: "NO-RESULT",
      ok: false,
      observed: `${tabs} -> malformed {}`,
      mismatches: [
        `tabs-query-recorder@ext-bg: expected LEAKS-EXISTENCE (exception: addon-tabs-visibility), got NO-RESULT (${tabs} -> malformed {})`,
      ],
    });
  });

  const malformed: readonly (readonly [string, unknown])[] = [
    ["an outcome no runner reports", { outcome: "undefined", text: "undefined", target: "x" }],
    ["no text", { outcome: "error", target: "x" }],
    ["a text that is not a string", { outcome: "error", text: 7, target: "x" }],
    ["no target", { outcome: "error", text: "error event, status 0, readyState 4" }],
    ["null", null],
    ["a string", "error"],
  ];
  it.each(malformed)("reads a row with %s as NO-RESULT", (_label, observed) => {
    expect(judged(withRow("xhr-file-log", "web", observed), "xhr-file-log", "web")).toMatchObject({
      verdict: "NO-RESULT",
      ok: false,
    });
  });

  it("accepts exactly the closed outcome set", () => {
    expect(readObservation({ outcome: "fetch ok, link load", text: "", target: "t" })).toEqual({
      outcome: "fetch ok, link load",
      text: "",
      target: "t",
    });
    expect(readObservation({ outcome: "load,error", text: "x", target: "t" })).not.toBeNull();
    expect(readObservation({ outcome: "fetch maybe, link load", text: "x", target: "t" })).toBe(
      null,
    );
  });

  it("refuses a denial against a target the probe did not plan: a typo'd path, file or add-on id", () => {
    const xhr = only("xhr-file-log");
    expect(
      judged(
        withRow("xhr-file-log", "file", at(`${xhr}-typo`, ...DENIED["xhr-file-log"]!)),
        "xhr-file-log",
        "file",
      ),
    ).toEqual({
      verdict: "NO-RESULT",
      ok: false,
      observed: `${xhr} -> error: error event, status 0, readyState 4; acted on ${xhr}-typo`,
      mismatches: [
        `xhr-file-log@file: expected BLOCKED, got NO-RESULT (${`${xhr} -> error: error event, status 0, readyState 4; acted on ${xhr}-typo`.slice(0, 240)})`,
      ],
    });
    const typoParent = `moz-extension://${CTX.recUuid}/experiment/parent-typo.js`;
    expect(
      judged(
        withRow("mozext-parent", "web", at(typoParent, "error", NETWORK)),
        "mozext-parent",
        "web",
      ),
    ).toMatchObject({ verdict: "NO-RESULT", ok: false });
    expect(
      judged(
        withRow(
          "connect-recorder",
          "ext-bg",
          at(`addon:${CTX.recId}-typo`, ...DENIED["connect-recorder"]!),
        ),
        "connect-recorder",
        "ext-bg",
      ),
    ).toEqual({
      verdict: "NO-RESULT",
      ok: false,
      observed: `addon:${CTX.recId} -> disconnected: ${DENIED["connect-recorder"]![1]}; acted on addon:${CTX.recId}-typo`,
      mismatches: [
        `connect-recorder@ext-bg: expected BLOCKED, got NO-RESULT (addon:${CTX.recId} -> disconnected: ${DENIED["connect-recorder"]![1]}; acted on addon:${CTX.recId}-typo)`,
      ],
    });
  });

  it("refuses a denial against a target the witness did not find, or never checked", () => {
    const log = only("fetch-file-log");
    const absent = {
      ...passingInput(),
      witness: { ...WITNESS, [log]: { present: false, detail: "NotFoundError" } },
    };
    expect(judged(absent, "fetch-file-log", "web")).toMatchObject({
      verdict: "NO-RESULT",
      ok: false,
      observed: `${log} -> error: ${NETWORK}; witness did not find ${log} (NotFoundError)`,
    });
    const rest = Object.fromEntries(Object.entries(WITNESS).filter(([t]) => t !== log));
    const unchecked = { ...passingInput(), witness: rest };
    expect(judged(unchecked, "xhr-file-log", "web").observed).toBe(
      `${log} -> error: error event, status 0, readyState 4; no witness ran for ${log}`,
    );
    const onLog = expandExpectedRows(false).filter(
      (r) => r.spec !== null && unitsOf(r.id).includes(log),
    );
    expect(judgeIsolationRun(unchecked).counts["NO-RESULT"]).toBe(onLog.length);
  });

  it("refuses a pair whose missing side the witness found present", () => {
    const unit = pairUnit("img-file-oracle");
    const input = {
      ...passingInput(),
      witness: { ...WITNESS, [unit[1]]: { present: true, detail: "file, 3 bytes" } },
    };
    expect(judged(input, "img-file-oracle", "web")).toMatchObject({
      verdict: "NO-RESULT",
      ok: false,
      observed: `${unit[0]} -> error: error | error: error; witness found ${unit[1]}, planned as missing (file, 3 bytes)`,
    });
    const hitAbsent = {
      ...passingInput(),
      witness: { ...WITNESS, [unit[0]]: { present: false, detail: "NotFoundError" } },
    };
    expect(judged(hitAbsent, "img-file-oracle", "web").verdict).toBe("NO-RESULT");
  });

  it("judges a guessed key that exists and tells apart as LEAKS-EXISTENCE, in both log oracles", () => {
    for (const id of ["script-file-oracle", "css-file-oracle"]) {
      const [first, second] = unitsOf(id) as readonly (readonly [string, string])[];
      const input = {
        ...withRow(
          id,
          "file",
          each([pairAt(first!, LOAD_SIDE, ERROR_SIDE), pairAt(second!, ERROR_SIDE, ERROR_SIDE)]),
        ),
        witness: { ...WITNESS, [first![0]]: { present: true, detail: "file, 900 bytes" } },
      };
      expect(judged(input, id, "file")).toEqual({
        verdict: "LEAKS-EXISTENCE",
        ok: false,
        observed: `2 results for 2 planned targets; LEAKS-EXISTENCE ${first![0]} -> load: load | error: error`,
        mismatches: [
          `${id}@file: expected BLOCKED, got LEAKS-EXISTENCE (${`2 results for 2 planned targets; LEAKS-EXISTENCE ${first![0]} -> load: load | error: error`.slice(0, 240)})`,
        ],
      });
    }
  });

  it("judges per-target rows: a missing, repeated or unplanned target is NO-RESULT", () => {
    const [gre, app] = unitsOf("resource-all") as readonly string[];
    const deny = (u: string) => at(u, "fetch error, link error", NETWORK);
    const cases: readonly (readonly [unknown, string])[] = [
      [
        each([deny(gre!)]),
        `1 results for 2 planned targets; NO-RESULT ${app!} -> 0 results, expected one`,
      ],
      [
        each([deny(gre!), deny(gre!), deny(app!)]),
        `3 results for 2 planned targets; NO-RESULT ${gre!} -> 2 results, expected one`,
      ],
      [
        each([deny(gre!), deny(app!), deny("resource://other/")]),
        "3 results for 2 planned targets; unplanned resource://other/",
      ],
      [{ outcome: "each", text: "0 targets", target: "" }, "no per-target results"],
    ];
    for (const [observed, summary] of cases) {
      expect(judged(withRow("resource-all", "web", observed), "resource-all", "web")).toMatchObject(
        { verdict: "NO-RESULT", ok: false, observed: summary },
      );
    }
  });

  it("judges an each-probe with nothing planned as BLOCKED only when it reports nothing", () => {
    expect(judged(passingInput(), "inventory-exists", "file")).toMatchObject({
      verdict: "BLOCKED",
      ok: true,
      observed: "0 results for 0 planned targets",
    });
    const extra = withRow(
      "inventory-exists",
      "file",
      each([pairAt(["file:///d/x", "file:///d/x-och-missing"], ERROR_SIDE, ERROR_SIDE)]),
    );
    expect(judged(extra, "inventory-exists", "file").verdict).toBe("NO-RESULT");
    const emptyPlan = { ...passingInput(), targets: { ...PLAN.targets, "fetch-file-log": [] } };
    expect(judged(emptyPlan, "fetch-file-log", "web")).toMatchObject({
      verdict: "NO-RESULT",
      ok: false,
      observed: "planned [], expected one single unit",
    });
    const noXhr = Object.fromEntries(
      Object.entries(PLAN.targets).filter(([id]) => id !== "xhr-file-log"),
    );
    expect(judged({ ...passingInput(), targets: noXhr }, "xhr-file-log", "web").observed).toBe(
      "no planned targets",
    );
  });

  it("probes paths written outside the key folder, and fails one whose existence a page can tell", () => {
    const outside = planTargets({
      ...PLAN_INPUT,
      outsideKeyFolder: [{ path: "/p/one-click-har-sites.txt", directory: false }],
    }).targets["inventory-exists"]!;
    expect(outside).toEqual([
      ["file:///p/one-click-har-sites.txt", "file:///p/one-click-har-sites.txt-och-missing"],
    ]);
    const unit = outside[0] as readonly [string, string];
    const input = {
      ...withRow("inventory-exists", "file", each([pairAt(unit, LOAD_SIDE, ERROR_SIDE)])),
      targets: { ...PLAN.targets, "inventory-exists": outside },
      witness: {
        ...WITNESS,
        [unit[0]]: { present: true, detail: "file" },
        [unit[1]]: { present: false, detail: "NotFoundError" },
      },
    };
    expect(judged(input, "inventory-exists", "file")).toMatchObject({
      verdict: "LEAKS-EXISTENCE",
      ok: false,
    });
  });

  it("calls a recorder frame that loaded, or any frame that answered postMessage, a leak", () => {
    const popup = only("mozext-frame-recorder");
    expect(
      judged(
        withRow("mozext-frame-recorder", "web", at(popup, "load", CROSS)),
        "mozext-frame-recorder",
        "web",
      ),
    ).toMatchObject({ verdict: "LEAKS-EXISTENCE", ok: false });
    const answered = BLANK.replace("replies: none", 'replies: {"oneClickHar":{"recording":true}}');
    expect(
      judged(
        withRow("mozext-frame-recorder", "web", at(popup, "error", answered)),
        "mozext-frame-recorder",
        "web",
      ).verdict,
    ).toBe("LEAKS-EXISTENCE");
    const log = only("iframe-file-log");
    expect(
      judged(
        withRow("iframe-file-log", "web", at(log, "error", answered)),
        "iframe-file-log",
        "web",
      ).verdict,
    ).toBe("READ");
    expect(
      judged(withRow("iframe-file-log", "web", at(log, "load", CROSS)), "iframe-file-log", "web"),
    ).toMatchObject({ verdict: "BLOCKED", ok: true });
  });

  it("takes a cross-origin frame and a blank one as one withheld state in a pair, but not a frame that read", () => {
    const unit = pairUnit("script-root-oracle");
    const cross: Side = { outcome: "timeout", text: CROSS.replace(/^load/u, "timeout") };
    const blank: Side = { outcome: "timeout", text: BLANK.replace(/^error/u, "timeout") };
    const verdictOf = (observed: unknown): Verdict =>
      judged(withRow("script-root-oracle", "web", observed), "script-root-oracle", "web").verdict;
    expect(verdictOf(pairAt(unit, cross, blank))).toBe("BLOCKED");
    expect(
      verdictOf(
        pairAt(unit, { ...blank, text: blank.text.replace("text: ;", "text: {};") }, blank),
      ),
    ).toBe("LEAKS-EXISTENCE");
    expect(
      verdictOf(
        pairAt(
          unit,
          { outcome: "error", text: "error" },
          { outcome: "error", text: "error, but longer" },
        ),
      ),
    ).toBe("LEAKS-EXISTENCE");
    expect(verdictOf(pairAt(unit, { ...blank, outcome: "threw" }, blank))).toBe("NO-RESULT");
    expect(verdictOf(pairAt(unit, blank, { ...blank, outcome: "threw" }))).toBe("NO-RESULT");
    expect(verdictOf({ outcome: "same", text: "", target: unit[0] })).toBe("NO-RESULT");
    expect(verdictOf(pairAt([unit[1], unit[0]], ERROR_SIDE, ERROR_SIDE))).toBe("NO-RESULT");
  });

  it("reads a listing that names no add-on as a denial, an empty one as no answer", () => {
    const tabs = only("tabs-query-recorder");
    expect(
      judged(
        withRow("tabs-query-recorder", "ext-bg", at(tabs, "ok", "x")),
        "tabs-query-recorder",
        "ext-bg",
      ),
    ).toMatchObject({ verdict: "BLOCKED", ok: false });
    expect(
      judged(
        withRow("tabs-query-recorder", "ext-bg", at(tabs, "ok", "")),
        "tabs-query-recorder",
        "ext-bg",
      ).verdict,
    ).toBe("NO-RESULT");
    const byUuid = `3 moz-extension://${CTX.recUuid}/x.html x`;
    expect(
      judged(
        withRow("management-getall", "ext-page", at(only("management-getall"), "ok", byUuid)),
        "management-getall",
        "ext-page",
      ),
    ).toMatchObject({ verdict: "LEAKS-EXISTENCE", ok: true });
  });

  it("reads any planted mark as READ, whatever else the row says", () => {
    for (const mark of [CTX.marker, CTX.warMark, CTX.secretMark, CTX.storeMark]) {
      expect(
        judged(
          withRow("own-non-war", "web", at(only("own-non-war"), "ok", `status 200: ${mark}`)),
          "own-non-war",
          "web",
        ),
      ).toMatchObject({ verdict: "READ", ok: false });
    }
    expect(
      judged(withRow("xhr-file-log", "web", { text: CTX.marker }), "xhr-file-log", "web").verdict,
    ).toBe("READ");
  });

  it("calls a timeout, a throw, a missing tab or a refusal other than the declared one NO-RESULT", () => {
    const cases: readonly (readonly [string, Position, unknown])[] = [
      [
        "fetch-file-log",
        "ext-bg",
        at(only("fetch-file-log"), "timeout", "no fetch result within 3000 ms"),
      ],
      [
        "tabs-create-file",
        "ext-bg",
        { outcome: "threw", text: "TypeError: b.tabs is undefined", target: "" },
      ],
      [
        "executescript-recorder-page",
        "ext-bg",
        at(only("executescript-recorder-page"), "no-target", "no tab"),
      ],
      [
        "window-open-file",
        "file",
        at(only("window-open-file"), "error", DENIED["window-open-file"]![1]),
      ],
      ["storage-recorder", "ext-bg", at(only("storage-recorder"), "ok", "{}")],
      ["fetch-file-log", "web", at(only("fetch-file-log"), "error", "TypeError: other")],
    ];
    for (const [id, position, observed] of cases) {
      expect(judged(withRow(id, position, observed), id, position)).toMatchObject({
        verdict: "NO-RESULT",
        ok: false,
      });
    }
  });

  it("turns a missing or repeated row into NO-RESULT and fails it", () => {
    const input = passingInput();
    const isRow = (r: BrowserRowReport) => r.probe === "fetch-file-log" && r.position === "web";
    const missing = { ...input, browserRows: input.browserRows.filter((r) => !isRow(r)) };
    expect(judged(missing, "fetch-file-log", "web")).toEqual({
      verdict: "NO-RESULT",
      ok: false,
      observed: "0 rows reported, expected one",
      mismatches: [
        "fetch-file-log@web: expected BLOCKED, got NO-RESULT (0 rows reported, expected one)",
      ],
    });
    const twice = { ...input, browserRows: [...input.browserRows, input.browserRows.find(isRow)!] };
    expect(judged(twice, "fetch-file-log", "web")).toMatchObject({
      verdict: "NO-RESULT",
      ok: false,
      observed: "2 rows reported, expected one",
    });
  });

  it("fails a control that could not read its planted value, and a decided exception that showed nothing", () => {
    const war = only("planted-own-war-fetch");
    expect(
      judged(
        withRow("planted-own-war-fetch", "web", at(war, "error", NETWORK)),
        "planted-own-war-fetch",
        "web",
      ),
    ).toEqual({
      verdict: "BLOCKED",
      ok: false,
      observed: `${war} -> error: ${NETWORK}`,
      mismatches: [
        `planted-own-war-fetch@web: expected READ (planted-own-war), got BLOCKED (${war} -> error: ${NETWORK})`,
      ],
    });
    expect(
      judged(
        withRow("planted-own-war-fetch", "web", at(war, "ok", "status 200, 5 chars: wrong")),
        "planted-own-war-fetch",
        "web",
      ),
    ).toMatchObject({ verdict: "READ", ok: false });
    expect(
      judged(
        withRow(
          "tabs-query-recorder",
          "ext-page",
          at(only("tabs-query-recorder"), "ok", "2 http://bank.example/ Bank"),
        ),
        "tabs-query-recorder",
        "ext-page",
      ),
    ).toMatchObject({ verdict: "BLOCKED", ok: false });
  });

  it("requires planted-resource@file to leak when the Linux sandbox blocks planted-resource@web", () => {
    const unit = pairUnit("planted-resource");
    const input = withRow("planted-resource", "file", pairAt(unit, ERROR_SIDE, ERROR_SIDE));
    expect(judged(input, "planted-resource", "web")).toMatchObject({
      verdict: "BLOCKED",
      ok: true,
    });
    expect(judgeIsolationRun(input).mismatches).toEqual([
      `planted-resource@file: expected LEAKS-EXISTENCE or READ (planted-resource-substitution), got BLOCKED (${unit[0]} -> error: error | error: error)`,
    ]);
    const elsewhere = { ...passingInput(), context: { ...CTX, webSandboxBlocksArchive: false } };
    expect(judgeIsolationRun(elsewhere).mismatches).toEqual([
      `planted-resource@web: expected LEAKS-EXISTENCE or READ (planted-resource-substitution), got BLOCKED (${unit[0]} -> error: error | error: error)`,
    ]);
  });

  it("judges synthetic controls from their reads: a missing control is NO-RESULT, a blind one fails", () => {
    const base = passingInput();
    const replace = (id: string, change: object) => ({
      ...base,
      syntheticControls: base.syntheticControls.map((c) => (c.id === id ? { ...c, ...change } : c)),
    });
    const missing = {
      ...base,
      syntheticControls: base.syntheticControls.filter((c) => c.id !== "limit-other-experiment"),
    };
    expect(judged(missing, "limit-other-experiment", "otherexp")).toMatchObject({
      verdict: "NO-RESULT",
      ok: false,
      observed: "no result reported",
    });
    expect(
      judged(
        replace("control-system-read", { reads: [`log ${CTX.marker}`, "error NotFoundError"] }),
        "control-system-read",
        "system",
      ),
    ).toMatchObject({ verdict: "BLOCKED", ok: false, observed: "system" });
    expect(
      judged(replace("control-system-read", { reads: [] }), "control-system-read", "system")
        .verdict,
    ).toBe("BLOCKED");
    expect(
      judged(
        replace("planted-recorder-idb", { position: "system" }),
        "planted-recorder-idb",
        "rec-page",
      ).verdict,
    ).toBe("NO-RESULT");
  });

  it("fails a content script that ran in an archive document, and needs the policy's denial to pass without one", () => {
    const base = passingInput();
    const injected = {
      ...base,
      csArchiveInjectedDocs: [{ href: "file:///d/one-click-har/k/x.jsonl", text: "{}" }],
    };
    expect(judged(injected, "cs-in-archive-document", "cs-archive")).toMatchObject({
      verdict: "LEAKS-EXISTENCE",
      ok: false,
      observed: "file:///d/one-click-har/k/x.jsonl: {}",
    });
    const read = {
      ...base,
      csArchiveInjectedDocs: [{ href: "file:///d/x.jsonl", text: CTX.marker }],
    };
    expect(judged(read, "cs-in-archive-document", "cs-archive").verdict).toBe("READ");
    expect(judged(base, "cs-in-archive-document", "cs-archive").observed).toBe(
      "no content script ran in any archive or export document",
    );
    expect(judged(base, "cs-file-injection", "cs-file").observed).toBe(
      "no content script ran in any file:// document; policy denies file access",
    );
    const unproven = { ...base, canAccessFileObserved: false };
    expect(judged(unproven, "cs-in-archive-document", "cs-archive")).toMatchObject({
      verdict: "NO-RESULT",
      ok: false,
      observed: "no injection seen, and the policy was not observed to deny it",
    });
    expect(judged(unproven, "cs-file-injection", "cs-file")).toMatchObject({
      verdict: "NO-RESULT",
      ok: false,
      observed: "no file:// injection seen, and the policy was not observed to deny it",
    });
  });

  it("fails when a declared extra check fails, did not run, ran twice, or is unknown", () => {
    const base = passingInput();
    const mismatches = (extraChecks: readonly ExtraCheckResult[]) =>
      judgeIsolationRun({ ...base, extraChecks }).mismatches;
    expect(
      mismatches(
        base.extraChecks.map((c) =>
          c.id === "archive-modes" ? { ...c, ok: false, detail: "x is file mode 644" } : c,
        ),
      ),
    ).toEqual(["archive-modes: x is file mode 644"]);
    expect(
      mismatches(base.extraChecks.filter((c) => c.id !== "key-differs-across-profiles")),
    ).toEqual(["extra check key-differs-across-profiles did not run"]);
    expect(
      mismatches([...base.extraChecks, { id: "downloads-list", ok: true, detail: "again" }]),
    ).toEqual(["extra check downloads-list ran 2 times"]);
    expect(
      mismatches([...base.extraChecks, { id: "made-up" as ExtraCheckId, ok: true, detail: "" }]),
    ).toEqual(["extra check made-up is not declared"]);
    expect(mismatches([])).toHaveLength(Object.keys(EXTRA_CHECKS).length);
  });

  it("runs the content-script rows in the file:// page, and drops the injection row, once a content script ran there", () => {
    const rows = expandExpectedRows(true);
    expect(rows.some((r) => r.id === "cs-file-injection")).toBe(false);
    expect(rows.filter((r) => r.position === "cs-file")).toHaveLength(40);
    const judgment = judgeIsolationRun({ ...passingInput(), csFileInjected: true });
    expect(
      judgment.rows.filter((r) => r.position === "cs-file").every((r) => r.verdict === "NO-RESULT"),
    ).toBe(true);
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

describe("isolation judge details", () => {
  const xhr = () => only("xhr-file-log");

  it("reads a probe that threw at its planned target as NO-RESULT", () => {
    expect(
      judged(
        withRow("xhr-file-log", "web", at(xhr(), "threw", "TypeError: x")),
        "xhr-file-log",
        "web",
      ),
    ).toMatchObject({
      verdict: "NO-RESULT",
      observed: `${xhr()} -> threw: TypeError: x`,
    });
    expect(
      judged(
        withRow(
          "executescript-recorder-page",
          "ext-bg",
          at(only("executescript-recorder-page"), "no-target", "no tab"),
        ),
        "executescript-recorder-page",
        "ext-bg",
      ),
    ).toMatchObject({
      verdict: "NO-RESULT",
      observed: `${only("executescript-recorder-page")} -> no-target: no tab`,
    });
  });

  it("shows the first 200 characters of a malformed row, and calls a text or target of the wrong type malformed", () => {
    const long = { outcome: "ok", text: "a".repeat(300) };
    expect(judged(withRow("xhr-file-log", "web", long), "xhr-file-log", "web").observed).toBe(
      `${xhr()} -> malformed ${JSON.stringify(long).slice(0, 200)}`,
    );
    const textNumber = { outcome: "ok", text: 7, target: xhr() };
    expect(judged(withRow("xhr-file-log", "web", textNumber), "xhr-file-log", "web")).toMatchObject(
      {
        verdict: "NO-RESULT",
        observed: `${xhr()} -> malformed ${JSON.stringify(textNumber)}`,
      },
    );
    const targetNumber = {
      outcome: "error",
      text: "error event, status 0, readyState 4",
      target: 5,
    };
    expect(
      judged(withRow("xhr-file-log", "web", targetNumber), "xhr-file-log", "web").observed,
    ).toBe(`${xhr()} -> malformed ${JSON.stringify(targetNumber)}`);
  });

  it("accepts every load and reply combination, and not a pair's or a per-target row's own outcome", () => {
    for (const outcome of [
      "load,timeout",
      "timeout,timeout",
      "fetch timeout, link timeout",
      "fetch ok, link timeout",
      "no-target",
    ]) {
      expect(readObservation({ outcome, text: "", target: "t" })?.outcome).toBe(outcome);
    }
    for (const outcome of ["same", "differs", "each", "undefined"]) {
      expect(readObservation({ outcome, text: "", target: "t" })).toBe(null);
    }
  });

  it("calls a pair NO-RESULT when either side is malformed or acted on another target, and READ when it carries a mark", () => {
    const unit = pairUnit("img-file-oracle");
    const verdictAndLine = (observed: unknown) => {
      const r = judged(withRow("img-file-oracle", "web", observed), "img-file-oracle", "web");
      return [r.verdict, r.observed];
    };
    const good = pairAt(unit, ERROR_SIDE, ERROR_SIDE);
    const noHitTarget = {
      ...good,
      pair: { hit: { outcome: "error", text: "error" }, miss: good.pair.miss },
    };
    expect(verdictAndLine(noHitTarget)).toEqual([
      "NO-RESULT",
      `${unit[0]} -> malformed ${JSON.stringify(noHitTarget).slice(0, 200)}`,
    ]);
    const noMissTarget = {
      ...good,
      pair: { hit: good.pair.hit, miss: { outcome: "error", text: "error" } },
    };
    expect(verdictAndLine(noMissTarget)[0]).toBe("NO-RESULT");
    expect(verdictAndLine({ outcome: "same" })).toEqual([
      "NO-RESULT",
      `${unit[0]} -> malformed {"outcome":"same"}`,
    ]);
    const otherMiss = {
      ...good,
      pair: { ...good.pair, miss: { ...good.pair.miss, target: "file:///x" } },
    };
    expect(verdictAndLine(otherMiss)).toEqual([
      "NO-RESULT",
      `${unit[0]} -> error: error | error: error; acted on ${unit[0]} and file:///x`,
    ]);
    const otherHit = {
      ...good,
      pair: { ...good.pair, hit: { ...good.pair.hit, target: "file:///x" } },
    };
    expect(verdictAndLine(otherHit)).toEqual([
      "NO-RESULT",
      `${unit[0]} -> error: error | error: error; acted on file:///x and ${unit[1]}`,
    ]);
    const marked = pairAt(unit, { outcome: "load", text: CTX.marker }, ERROR_SIDE);
    expect(verdictAndLine(marked)).toEqual([
      "READ",
      `${unit[0]} -> load: ${CTX.marker} | error: error`,
    ]);
  });

  it("refuses a plan of the wrong shape for its probe", () => {
    const shapes: readonly (readonly [string, readonly Unit[], string])[] = [
      [
        "fetch-file-log",
        ["file:///a", "file:///b"],
        'planned ["file:///a","file:///b"], expected one single unit',
      ],
      [
        "fetch-file-log",
        [["file:///a", "file:///b"]],
        'planned [["file:///a","file:///b"]], expected one single unit',
      ],
      ["img-file-oracle", ["file:///a"], 'planned ["file:///a"], expected one pair unit'],
    ];
    for (const [id, units, summary] of shapes) {
      const input = {
        ...passingInput(),
        targets: { ...PLAN.targets, [id]: units } as Readonly<Record<string, readonly Unit[]>>,
      };
      expect(judged(input, id, "web")).toMatchObject({
        verdict: "NO-RESULT",
        ok: false,
        observed: summary,
      });
    }
    const pairForFetch = {
      ...withRow("inventory-read", "web", each([{ target: "file:///a" }])),
      targets: { ...PLAN.targets, "inventory-read": [["file:///a", "file:///b"] as const] },
    };
    expect(judged(pairForFetch, "inventory-read", "web")).toMatchObject({
      verdict: "NO-RESULT",
      observed:
        "1 results for 1 planned targets; NO-RESULT file:///a -> a pair planned for a rejected probe",
    });
  });

  it("names per-target results that are not a list, not a string, or missing a pair", () => {
    expect(
      judged(withRow("resource-all", "web", { each: {} }), "resource-all", "web").observed,
    ).toBe("no per-target results");
    const [gre, app] = unitsOf("resource-all") as readonly string[];
    const deny = (u: unknown) => ({ outcome: "fetch error, link error", text: NETWORK, target: u });
    expect(
      judged(
        withRow("resource-all", "web", each([deny(gre), deny(app), deny(5)])),
        "resource-all",
        "web",
      ).observed,
    ).toBe("3 results for 2 planned targets; unplanned null");
    const [first] = unitsOf("script-file-oracle") as readonly (readonly [string, string])[];
    expect(
      judged(withRow("script-file-oracle", "web", each([])), "script-file-oracle", "web").observed,
    ).toBe(
      `0 results for 2 planned targets; NO-RESULT ${first![0]} -> 0 results, expected one; NO-RESULT ${(unitsOf("script-file-oracle")[1] as readonly string[])[0]!} -> 0 results, expected one`,
    );
  });

  it("shows the first 200 characters of each injected archive document", () => {
    const text = "b".repeat(300);
    const input = { ...passingInput(), csArchiveInjectedDocs: [{ href: "file:///d/x", text }] };
    expect(judged(input, "cs-in-archive-document", "cs-archive").observed).toBe(
      `file:///d/x: ${"b".repeat(200)}`,
    );
  });

  it("passes planted-resource@file when it reads the log, not only when it tells existence", () => {
    const unit = pairUnit("planted-resource");
    const read = withRow(
      "planted-resource",
      "file",
      pairAt(unit, { outcome: "load", text: CTX.marker }, ERROR_SIDE),
    );
    expect(judged(read, "planted-resource", "file")).toMatchObject({ verdict: "READ", ok: true });
  });

  it("holds each denial to its outcome as well as its text", () => {
    const cases: readonly (readonly [string, Position, unknown, Verdict, boolean])[] = [
      ["fetch-file-log", "web", at(only("fetch-file-log"), "ok", NETWORK), "READ", false],
      [
        "downloads-search",
        "ext-bg",
        at(only("downloads-search"), "done", "no download items"),
        "LEAKS-EXISTENCE",
        false,
      ],
      [
        "management-getall",
        "ext-bg",
        at(only("management-getall"), "ok", `${CTX.recId} | One-Click HAR`),
        "LEAKS-EXISTENCE",
        true,
      ],
      [
        "management-getall",
        "ext-bg",
        at(only("management-getall"), "done", "och-probe@test"),
        "LEAKS-EXISTENCE",
        true,
      ],
      [
        "management-getall",
        "ext-page",
        at(only("management-getall"), "ok", "och-probe@test"),
        "BLOCKED",
        false,
      ],
      [
        "storage-recorder",
        "ext-bg",
        at(only("storage-recorder"), "error", `own ${CTX.ownMark}`),
        "NO-RESULT",
        false,
      ],
      ["iframe-file-log", "web", at(only("iframe-file-log"), "ok", BLANK), "READ", false],
      [
        "resource-all",
        "web",
        each(
          (unitsOf("resource-all") as readonly string[]).map((u) =>
            at(u, "fetch error, link error", "TypeError: other"),
          ),
        ),
        "LEAKS-EXISTENCE",
        false,
      ],
      [
        "planted-own-war-script",
        "web",
        at(only("planted-own-war-script"), "error", "error; window.OCH_WAR = undefined"),
        "BLOCKED",
        false,
      ],
      [
        "planted-own-war-script",
        "file",
        at(only("planted-own-war-script"), "load", "load; window.OCH_WAR = other"),
        "READ",
        false,
      ],
      [
        "planted-own-war-fetch",
        "file",
        at(only("planted-own-war-fetch"), "ok", "status 200, 3 chars: abc"),
        "READ",
        false,
      ],
      [
        "devtools-gethar",
        "ext-devtools",
        at(only("devtools-gethar"), "ok", "0 entries: []"),
        "READ",
        false,
      ],
      ["baseline-webrequest", "ext-bg", at(only("baseline-webrequest"), "ok", "{}"), "READ", false],
      [
        "fetch-file-dir",
        "web",
        at(only("fetch-file-dir"), "ok", `status 200: ${CTX.secretMark}`),
        "READ",
        false,
      ],
    ];
    for (const [id, position, observed, verdict, ok] of cases) {
      expect([id, position, judged(withRow(id, position, observed), id, position)]).toMatchObject([
        id,
        position,
        { verdict, ok },
      ]);
    }
  });
});
