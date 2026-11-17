import * as NodeCrypto from "node:crypto";
import {
  expandExpectedRows,
  PROBE_TABLE,
  type ExpectedOutcome,
  type Position,
  type ProbeSpec,
  type Verdict,
} from "./probe-table.ts";

export type ObservedProbe = {
  readonly outcome: string;
  readonly differs: boolean;
  readonly text: string;
};

export type BrowserRowReport = {
  readonly kind: "row";
  readonly position: Position;
  readonly probe: string;
  readonly observed: ObservedProbe;
};

export type SyntheticControlResult = {
  readonly id: string;
  readonly position: Position;
  readonly observed: string;
  readonly verdict: Verdict;
};

export type JudgeContext = {
  readonly marker: string;
  readonly warMark: string;
  readonly secretMark: string;
  readonly site: string;
  readonly archiveKey: string;
  readonly appFolder: string;
  readonly recId: string;
  readonly recUuid: string;
  readonly planUrls: readonly string[];
  /** On Linux, the webIsolated content sandbox blocks local paths, so planted-resource@web is BLOCKED there. */
  readonly webSandboxBlocksArchive?: boolean;
};

export type JudgedRow = {
  readonly id: string;
  readonly position: Position;
  readonly what: string;
  readonly expected: ExpectedOutcome;
  readonly observed: string;
  readonly verdict: Verdict;
  readonly ok: boolean;
};

export type IsolationJudgment = {
  readonly ok: boolean;
  readonly counts: Readonly<Record<Verdict, number>>;
  readonly rows: readonly JudgedRow[];
  readonly mismatches: readonly string[];
};

export function isProfileDerivedKey(key: string, profileDir: string): boolean {
  if (!/^[0-9a-f]{32}$/u.test(key)) return true;
  const profileHash = NodeCrypto.createHash("sha256").update(profileDir).digest("hex");
  return profileHash.startsWith(key.slice(0, 16));
}

function expectedLabel(expected: ExpectedOutcome): string {
  switch (expected.kind) {
    case "BLOCKED":
      return "BLOCKED";
    case "READ":
      return `READ (${expected.control})`;
    case "LEAKS-EXISTENCE-OR-READ":
      return `LEAKS-EXISTENCE or READ (${expected.control})`;
    case "LEAKS-EXISTENCE":
      return "exception" in expected
        ? `LEAKS-EXISTENCE (exception: ${expected.exception})`
        : `LEAKS-EXISTENCE (${expected.control})`;
  }
}

function matchesExpectation(expected: ExpectedOutcome, verdict: Verdict): boolean {
  if (verdict === "NO-RESULT") return false;
  switch (expected.kind) {
    case "BLOCKED":
      return verdict === "BLOCKED";
    case "READ":
      return verdict === "READ";
    case "LEAKS-EXISTENCE":
      return verdict === "LEAKS-EXISTENCE";
    case "LEAKS-EXISTENCE-OR-READ":
      return verdict === "LEAKS-EXISTENCE" || verdict === "READ";
  }
}

function scrubPlanUrls(text: string, planUrls: readonly string[]): string {
  let out = text;
  const ordered = [...planUrls].toSorted((a, b) => b.length - a.length);
  for (const url of ordered) {
    if (url.length > 0) out = out.split(url).join("<plan-url>");
  }
  return out;
}

function verdictOf(spec: ProbeSpec, observed: ObservedProbe, ctx: JudgeContext): Verdict {
  const text = observed.text;
  const has = (needle: string): boolean => needle.length > 0 && text.includes(needle);

  if (spec.detect === "planted") return has(ctx.warMark) ? "READ" : "BLOCKED";
  if (spec.detect === "planted-absent") return has(ctx.secretMark) ? "READ" : "BLOCKED";
  if (has(ctx.marker)) return "READ";

  if (spec.detect === "api") {
    return /typeof browser\.oneClickHar: (object|function)/u.test(text) ? "READ" : "BLOCKED";
  }
  if (spec.detect === "oracle") return observed.differs ? "LEAKS-EXISTENCE" : "BLOCKED";
  if (spec.detect === "frame") return observed.outcome === "load" ? "LEAKS-EXISTENCE" : "BLOCKED";
  if (spec.detect === "fetch-ok") return observed.outcome === "ok" ? "READ" : "BLOCKED";
  if (spec.detect === "reach") {
    if (/^0 of /u.test(observed.outcome)) return "BLOCKED";
    return text.includes("-> fetch status ") ? "READ" : "LEAKS-EXISTENCE";
  }
  if (spec.detect === "execute-script") {
    return text.includes(": returned ") ? "READ" : "BLOCKED";
  }
  if (spec.detect === "downloads") {
    return text.includes(".har") || has(ctx.site) || has(ctx.appFolder)
      ? "LEAKS-EXISTENCE"
      : "BLOCKED";
  }
  if (spec.detect === "store") {
    if (text.includes("kv.secret =")) return "READ";
    if (text === "{}" || text.includes("no kv store (empty)")) return "BLOCKED";
    return "READ";
  }

  const scrubbed = scrubPlanUrls(text, ctx.planUrls);
  if (spec.detect === "names") {
    if (scrubbed.includes(ctx.site) || scrubbed.includes(ctx.archiveKey)) {
      return "LEAKS-EXISTENCE";
    }
    if (
      spec.id === "tabs-create-dir" &&
      observed.outcome === "ok" &&
      text.includes("url file://")
    ) {
      return "LEAKS-EXISTENCE";
    }
    return "BLOCKED";
  }
  if (spec.detect === "addon") {
    return scrubbed.includes(ctx.recId) || text.includes(ctx.recUuid)
      ? "LEAKS-EXISTENCE"
      : "BLOCKED";
  }

  if (
    (spec.id === "tabs-create-file" ||
      spec.id === "windows-create-file" ||
      spec.id === "tabs-create-viewsource" ||
      spec.id === "tabs-update-file") &&
    observed.outcome === "ok"
  ) {
    return "LEAKS-EXISTENCE";
  }
  if (
    (spec.id === "tabs-update-redirect" || spec.id === "wr-redirect-tab") &&
    observed.outcome === "ok" &&
    text.includes("url file://")
  ) {
    return "LEAKS-EXISTENCE";
  }
  return "BLOCKED";
}

export function judgeIsolationRun(input: {
  readonly context: JudgeContext;
  readonly browserRows: readonly BrowserRowReport[];
  readonly syntheticControls: readonly SyntheticControlResult[];
  readonly csFileInjected: boolean;
  readonly canAccessFileObserved: boolean;
  readonly csArchiveInjectedDocs: readonly { readonly href: string; readonly text: string }[];
  readonly extraChecks?: readonly string[];
}): IsolationJudgment {
  const specMap = new Map(PROBE_TABLE.map((spec) => [spec.id, spec]));
  const rowMap = new Map<string, BrowserRowReport>();
  for (const row of input.browserRows) {
    rowMap.set(`${row.probe}|${row.position}`, row);
  }
  const controlMap = new Map(input.syntheticControls.map((c) => [`${c.id}|${c.position}`, c]));

  const rows: JudgedRow[] = [];
  for (const expectedRow of expandExpectedRows(input.csFileInjected)) {
    const key = `${expectedRow.id}|${expectedRow.position}`;
    if (expectedRow.id === "cs-file-injection") {
      const verdict: Verdict = input.csFileInjected
        ? "LEAKS-EXISTENCE"
        : input.canAccessFileObserved
          ? "BLOCKED"
          : "NO-RESULT";
      const ok = matchesExpectation(expectedRow.expected, verdict);
      rows.push({
        id: expectedRow.id,
        position: expectedRow.position,
        what: expectedRow.what,
        expected: expectedRow.expected,
        observed: input.csFileInjected
          ? "content script injected into file:// page"
          : "no content script ran in any file:// document",
        verdict,
        ok,
      });
      continue;
    }

    if (expectedRow.id === "cs-in-archive-document") {
      const injected = input.csArchiveInjectedDocs;
      const verdict: Verdict = injected.some((doc) => doc.text.includes(input.context.marker))
        ? "READ"
        : injected.length > 0
          ? "LEAKS-EXISTENCE"
          : "BLOCKED";
      rows.push({
        id: expectedRow.id,
        position: expectedRow.position,
        what: expectedRow.what,
        expected: expectedRow.expected,
        observed:
          injected.length > 0
            ? injected.map((d) => `${d.href}: ${d.text.slice(0, 200)}`).join("; ")
            : "no content script ran in any archive or export document",
        verdict,
        ok: matchesExpectation(expectedRow.expected, verdict),
      });
      continue;
    }

    if (expectedRow.detect === "synthetic") {
      const control = controlMap.get(key);
      const verdict: Verdict = control?.verdict ?? "NO-RESULT";
      rows.push({
        id: expectedRow.id,
        position: expectedRow.position,
        what: expectedRow.what,
        expected: expectedRow.expected,
        observed: control?.observed ?? "no result reported",
        verdict,
        ok: matchesExpectation(expectedRow.expected, verdict),
      });
      continue;
    }

    const reported = rowMap.get(key);
    const spec = specMap.get(expectedRow.id);
    if (reported === undefined || spec === undefined) {
      rows.push({
        id: expectedRow.id,
        position: expectedRow.position,
        what: expectedRow.what,
        expected: expectedRow.expected,
        observed: "no row reported",
        verdict: "NO-RESULT",
        ok: false,
      });
      continue;
    }

    const verdict = verdictOf(spec, reported.observed, input.context);
    const effectiveExpected: ExpectedOutcome =
      expectedRow.id === "planted-resource" &&
      expectedRow.position === "web" &&
      input.context.webSandboxBlocksArchive === true
        ? { kind: "BLOCKED" }
        : expectedRow.expected;
    rows.push({
      id: expectedRow.id,
      position: expectedRow.position,
      what: expectedRow.what,
      expected: effectiveExpected,
      observed: `${reported.observed.outcome}: ${reported.observed.text}`,
      verdict,
      ok: matchesExpectation(effectiveExpected, verdict),
    });
  }

  const counts: Record<Verdict, number> = {
    BLOCKED: 0,
    READ: 0,
    "LEAKS-EXISTENCE": 0,
    "NO-RESULT": 0,
  };
  for (const row of rows) counts[row.verdict] += 1;

  const mismatches = [
    ...(input.extraChecks ?? []),
    ...rows
      .filter((row) => !row.ok)
      .map(
        (row) =>
          `${row.id}@${row.position}: expected ${expectedLabel(row.expected)}, got ${row.verdict} (${row.observed.slice(0, 160)})`,
      ),
  ];

  return {
    ok: mismatches.length === 0,
    counts,
    rows,
    mismatches,
  };
}
