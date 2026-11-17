import type { ExtraCheckResult } from "./archive-oracle.ts";
import {
  denialAt,
  expandExpectedRows,
  EXTRA_CHECKS,
  type Denial,
  type ExpectedOutcome,
  type ExtraCheckId,
  type Position,
  type ProbeSpec,
  type Verdict,
} from "./probe-table.ts";

export type Observation = { readonly outcome: string; readonly text: string };
export type ObservedPair = { readonly hit: Observation; readonly miss: Observation };
export type ObservedTarget = Observation & {
  readonly target: string;
  readonly pair?: ObservedPair;
};

/** What a probe reported: one answer, an existing/missing pair, or one answer per planned target. */
export type ObservedProbe = Observation & {
  readonly pair?: ObservedPair;
  readonly each?: readonly ObservedTarget[];
};

export type BrowserRowReport = {
  readonly kind: "row";
  readonly position: Position;
  readonly probe: string;
  readonly observed: ObservedProbe;
};

/** A planted or limit control: what each of its readers got back. Each read must carry a planted mark. */
export type SyntheticControlResult = {
  readonly id: string;
  readonly position: Position;
  readonly observed: string;
  readonly reads: readonly string[];
};

export type JudgeContext = {
  /** In the bank cookie, HTML and JSON body, so in the log, the body file and the export. */
  readonly marker: string;
  /** In the probe extension's own web-accessible files. */
  readonly warMark: string;
  /** Planted in the recorder's storage.local and its origin's IndexedDB. */
  readonly storeMark: string;
  /** Planted by the probe extension in its own storage; seeing it proves a store read worked. Not a leak. */
  readonly ownMark: string;
  readonly recId: string;
  readonly recUuid: string;
  /** On Linux, the webIsolated content sandbox blocks local paths, so planted-resource@web is BLOCKED there. */
  readonly webSandboxBlocksArchive?: boolean;
};

export type IsolationRunInput = {
  readonly context: JudgeContext;
  readonly browserRows: readonly BrowserRowReport[];
  /** Planned targets of each "each" probe, keyed `<probe>@<position>` or `<probe>` for every position. */
  readonly targets: Readonly<Record<string, readonly string[]>>;
  readonly syntheticControls: readonly SyntheticControlResult[];
  readonly csFileInjected: boolean;
  /** The probe extension's policy, asked from the system principal, can access neither the file page nor the log. */
  readonly canAccessFileObserved: boolean;
  readonly csArchiveInjectedDocs: readonly { readonly href: string; readonly text: string }[];
  readonly extraChecks: readonly ExtraCheckResult[];
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
  readonly checks: readonly ExtraCheckResult[];
  readonly mismatches: readonly string[];
};

const FETCH_NETWORK_ERROR = /^TypeError: NetworkError when attempting to fetch resource\.$/u;
const FRAME_CROSS_ORIGIN =
  /; contentDocument null; contentWindow\.location\.href: SecurityError: Permission denied to get property "href" on cross-origin object/u;
const FRAME_BLANK =
  /; contentDocument readable, text: ; contentWindow\.location\.href: about:blank(;|$)/u;
const FRAME_EVENTS = new Set(["load", "error", "timeout"]);
/** Outcomes that mean the probe produced no answer to judge, or a refusal other than the declared one. */
const NO_ANSWER = new Set(["", "threw", "no-target", "timeout", "error"]);

const SEVERITY: readonly Verdict[] = ["READ", "LEAKS-EXISTENCE", "NO-RESULT"];
const worst = (verdicts: readonly Verdict[]): Verdict =>
  SEVERITY.find((v) => verdicts.includes(v)) ?? "BLOCKED";

const isObservation = (value: unknown): value is Observation =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Observation).outcome === "string" &&
  typeof (value as Observation).text === "string";

function carriesMark(value: unknown, ctx: JudgeContext): boolean {
  const text = JSON.stringify(value) ?? "";
  return [ctx.marker, ctx.warMark, ctx.storeMark].some((mark) => text.includes(mark));
}

function denies(denial: Denial, o: Observation, ctx: JudgeContext): boolean {
  switch (denial.kind) {
    case "rejected":
      return o.outcome === "error" && denial.error.test(o.text);
    case "answered":
      return o.outcome === denial.outcome && denial.text.test(o.text);
    case "answered-without-recorder":
      return (
        o.outcome === "ok" &&
        o.text.length > 0 &&
        !o.text.includes(ctx.recId) &&
        !o.text.includes(ctx.recUuid)
      );
    case "own-value-only":
      return o.outcome === "ok" && o.text.includes(ctx.ownMark);
    case "frame-withheld":
      return (
        FRAME_EVENTS.has(o.outcome) && (FRAME_CROSS_ORIGIN.test(o.text) || FRAME_BLANK.test(o.text))
      );
    case "unreachable":
      return o.outcome === "fetch error, link error" && FETCH_NETWORK_ERROR.test(o.text);
    case "indistinguishable":
    case "never":
      return false;
  }
}

/** A well-formed answer that is not the denial: what it leaked, by the probe's declared leak kind. */
function leakOf(spec: ProbeSpec, denial: Denial, o: Observation): Verdict {
  if (denial.kind === "unreachable")
    return o.outcome.startsWith("fetch ok") ? "READ" : "LEAKS-EXISTENCE";
  if (denial.kind === "own-value-only") return "NO-RESULT";
  return spec.leak;
}

function singleVerdict(spec: ProbeSpec, denial: Denial, o: unknown, ctx: JudgeContext): Verdict {
  if (carriesMark(o, ctx)) return "READ";
  if (!isObservation(o)) return "NO-RESULT";
  if (denies(denial, o, ctx)) return "BLOCKED";
  if (NO_ANSWER.has(o.outcome) || o.text.length === 0) return "NO-RESULT";
  return leakOf(spec, denial, o);
}

function pairVerdict(spec: ProbeSpec, pair: unknown, ctx: JudgeContext): Verdict {
  if (carriesMark(pair, ctx)) return "READ";
  if (typeof pair !== "object" || pair === null) return "NO-RESULT";
  const { hit, miss } = pair as Partial<ObservedPair>;
  if (!isObservation(hit) || !isObservation(miss)) return "NO-RESULT";
  if ([hit.outcome, miss.outcome].some((outcome) => outcome === "" || outcome === "threw")) {
    return "NO-RESULT";
  }
  return hit.outcome === miss.outcome && hit.text === miss.text ? "BLOCKED" : spec.leak;
}

function eachVerdict(
  spec: ProbeSpec,
  denial: Denial,
  observed: ObservedProbe,
  planned: readonly string[] | undefined,
  ctx: JudgeContext,
): { readonly verdict: Verdict; readonly summary: string } {
  if (planned === undefined) return { verdict: "NO-RESULT", summary: "no planned targets" };
  if (!Array.isArray(observed.each))
    return { verdict: "NO-RESULT", summary: "no per-target results" };
  const judged = observed.each.map((t) => ({
    target: t.target,
    verdict:
      denial.kind === "indistinguishable"
        ? pairVerdict(spec, t.pair, ctx)
        : singleVerdict(spec, denial, t, ctx),
    line: `${t.target} -> ${t.pair === undefined ? `${t.outcome}: ${t.text}` : `${t.pair.hit.outcome} | ${t.pair.miss.outcome}`}`,
  }));
  const reported = new Set(judged.map((t) => t.target));
  const missing = planned.filter((t) => !reported.has(t));
  const unplanned = judged.filter((t) => !planned.includes(t.target)).map((t) => t.target);
  const verdict = worst([
    ...judged.map((t) => t.verdict),
    ...(missing.length > 0 || unplanned.length > 0 ? (["NO-RESULT"] as const) : []),
  ]);
  const notBlocked = judged
    .filter((t) => t.verdict !== "BLOCKED")
    .map((t) => `${t.verdict} ${t.line}`);
  return {
    verdict,
    summary: [
      `${String(judged.length)} of ${String(planned.length)} planned targets reported`,
      ...missing.map((t) => `missing ${t}`),
      ...unplanned.map((t) => `unplanned ${t}`),
      ...notBlocked,
    ].join("; "),
  };
}

function judgeBrowserRow(
  spec: ProbeSpec,
  position: Position,
  observed: ObservedProbe,
  input: IsolationRunInput,
): { readonly verdict: Verdict; readonly summary: string } {
  // Rows arrive as JSON from the browser, so a row may carry no observation at all.
  if (typeof observed !== "object" || observed === null) {
    return { verdict: "NO-RESULT", summary: "no observation" };
  }
  const denial = denialAt(spec, position);
  const head = `${observed.outcome}: ${observed.text}`;
  switch (spec.shape) {
    case "single":
      return { verdict: singleVerdict(spec, denial, observed, input.context), summary: head };
    case "pair":
      return {
        verdict:
          denial.kind === "indistinguishable"
            ? pairVerdict(spec, observed.pair, input.context)
            : "NO-RESULT",
        summary: head,
      };
    case "each":
      return eachVerdict(
        spec,
        denial,
        observed,
        input.targets[`${spec.id}@${position}`] ?? input.targets[spec.id],
        input.context,
      );
  }
}

function syntheticVerdict(
  id: string,
  position: Position,
  input: IsolationRunInput,
): { verdict: Verdict; observed: string } {
  const { context, canAccessFileObserved } = input;
  if (id === "cs-file-injection") {
    return canAccessFileObserved
      ? {
          verdict: "BLOCKED",
          observed: "no content script ran in any file:// document; policy denies file access",
        }
      : {
          verdict: "NO-RESULT",
          observed: "no file:// injection seen, and the policy was not observed to deny it",
        };
  }
  if (id === "cs-in-archive-document") {
    const docs = input.csArchiveInjectedDocs;
    const observed = docs.map((d) => `${d.href}: ${d.text.slice(0, 200)}`).join("; ");
    if (docs.some((d) => carriesMark(d.text, context))) return { verdict: "READ", observed };
    if (docs.length > 0) return { verdict: "LEAKS-EXISTENCE", observed };
    return canAccessFileObserved
      ? { verdict: "BLOCKED", observed: "no content script ran in any archive or export document" }
      : {
          verdict: "NO-RESULT",
          observed: "no injection seen, and the policy was not observed to deny it",
        };
  }
  const control = input.syntheticControls.find((c) => c.id === id && c.position === position);
  if (control === undefined) return { verdict: "NO-RESULT", observed: "no result reported" };
  const read =
    control.reads.length > 0 && control.reads.every((text) => carriesMark(text, context));
  return { verdict: read ? "READ" : "BLOCKED", observed: control.observed };
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

/** Every declared extra check must report exactly once; a missing, repeated or unknown one fails the run. */
function judgeExtraChecks(results: readonly ExtraCheckResult[]): readonly string[] {
  const declared = Object.keys(EXTRA_CHECKS) as ExtraCheckId[];
  return [
    ...declared.flatMap((id) => {
      const runs = results.filter((r) => r.id === id);
      if (runs.length === 0) return [`extra check ${id} did not run`];
      if (runs.length > 1) return [`extra check ${id} ran ${String(runs.length)} times`];
      return runs.filter((r) => !r.ok).map((r) => `${id}: ${r.detail}`);
    }),
    ...results
      .filter((r) => !declared.includes(r.id))
      .map((r) => `extra check ${String(r.id)} is not declared`),
  ];
}

export function judgeIsolationRun(input: IsolationRunInput): IsolationJudgment {
  const rowMap = new Map(input.browserRows.map((row) => [`${row.probe}|${row.position}`, row]));

  const rows: JudgedRow[] = expandExpectedRows(input.csFileInjected).map((expectedRow) => {
    const expected: ExpectedOutcome =
      expectedRow.id === "planted-resource" &&
      expectedRow.position === "web" &&
      input.context.webSandboxBlocksArchive === true
        ? { kind: "BLOCKED" }
        : expectedRow.expected;
    const base = {
      id: expectedRow.id,
      position: expectedRow.position,
      what: expectedRow.what,
      expected,
    };
    const { spec } = expectedRow;
    if (spec === null) {
      const { verdict, observed } = syntheticVerdict(expectedRow.id, expectedRow.position, input);
      return { ...base, observed, verdict, ok: matchesExpectation(expected, verdict) };
    }
    const reported = rowMap.get(`${expectedRow.id}|${expectedRow.position}`);
    if (reported === undefined) {
      return { ...base, observed: "no row reported", verdict: "NO-RESULT", ok: false };
    }
    const { verdict, summary } = judgeBrowserRow(
      spec,
      expectedRow.position,
      reported.observed,
      input,
    );
    // A control passes only on its planted mark, so an answer that merely succeeded cannot stand in for it.
    const marked = expected.kind !== "READ" || carriesMark(reported.observed, input.context);
    return {
      ...base,
      observed: summary,
      verdict,
      ok: marked && matchesExpectation(expected, verdict),
    };
  });

  const counts: Record<Verdict, number> = {
    BLOCKED: 0,
    READ: 0,
    "LEAKS-EXISTENCE": 0,
    "NO-RESULT": 0,
  };
  for (const row of rows) counts[row.verdict] += 1;

  const mismatches = [
    ...judgeExtraChecks(input.extraChecks),
    ...rows
      .filter((row) => !row.ok)
      .map(
        (row) =>
          `${row.id}@${row.position}: expected ${expectedLabel(row.expected)}, got ${row.verdict} (${row.observed.slice(0, 240)})`,
      ),
  ];

  return { ok: mismatches.length === 0, counts, rows, checks: input.extraChecks, mismatches };
}
