import type { ExtraCheckResult } from "./archive-oracle.ts";
import {
  denialAt,
  expandExpectedRows,
  EXTRA_CHECKS,
  type Denial,
  type ExpectedOutcome,
  type ExtraCheckId,
  type Outcome,
  OUTCOMES,
  type Position,
  type ProbeSpec,
  type Shape,
  type Verdict,
} from "./probe-table.ts";

/** One answer a probe got, about the exact target it acted on. Only a well-formed one is ever judged. */
export type Observation = {
  readonly outcome: Outcome;
  readonly text: string;
  readonly target: string;
};
export type ObservedPair = { readonly hit: Observation; readonly miss: Observation };

/**
 * What one probe acts on: a target, or an existing target and a missing one to tell apart. Every probe's units are
 * planned before it runs, and the witness checks each of them first.
 */
export type Unit = string | readonly [hit: string, miss: string];

/** What a privileged witness found for one target before the probes ran: present and answering, or not. */
export type Witness = { readonly present: boolean; readonly detail: string };

export type BrowserRowReport = {
  readonly kind: "row";
  readonly position: Position;
  readonly probe: string;
  /** As the browser sent it; parsed by the judge, so a missing or malformed field can only become NO-RESULT. */
  readonly observed: unknown;
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
  /** In the probe extension's own file that is not web accessible. */
  readonly secretMark: string;
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
  /** Planned units of every probe, keyed `<probe>@<position>` or `<probe>` for every position. */
  readonly targets: Readonly<Record<string, readonly Unit[]>>;
  /** The witness's finding for every planned target and every missing counterpart. */
  readonly witness: Readonly<Record<string, Witness>>;
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
/** A frame probe appends what came back after it posted a message into the frame; only silence is withheld. */
const FRAME_NO_REPLY = /; replies: none$/u;
/** A frame that answered postMessage, whatever its load event said. */
const FRAME_ANSWERED = /; replies: (?!none$|no window$).+$/su;
const FRAME_STATES = [FRAME_CROSS_ORIGIN, FRAME_BLANK].map(
  (state) => new RegExp(state.source.replace("(;|$)", ""), "gu"),
);

/**
 * A frame that read nothing shows one of two states: still an empty about:blank, or navigated to a cross-origin
 * document. Which one a timeout catches depends on load, so a pair compares the two as one state.
 */
const settled = (o: Observation): string =>
  `${o.outcome}|${FRAME_STATES.reduce((text, state) => text.replace(state, "; frame withheld"), o.text)}`;
/** Outcomes that mean the probe produced no answer to judge, or a refusal other than the declared one. */
const NO_ANSWER: ReadonlySet<Outcome> = new Set(["threw", "no-target", "timeout", "error"]);
const OUTCOME_SET: ReadonlySet<string> = new Set(OUTCOMES);

/** The most severe verdict: a leak first, then BLOCKED only when every verdict is BLOCKED. */
function worst(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("READ")) return "READ";
  if (verdicts.includes("LEAKS-EXISTENCE")) return "LEAKS-EXISTENCE";
  return verdicts.every((v) => v === "BLOCKED") ? "BLOCKED" : "NO-RESULT";
}

/** A browser report as an Observation, or null when any field is missing, of the wrong type, or not a known outcome. */
export function readObservation(value: unknown): Observation | null {
  const { outcome, text, target } = Object(value) as Record<string, unknown>;
  return OUTCOME_SET.has(outcome as string) &&
    typeof text === "string" &&
    typeof target === "string"
    ? { outcome: outcome as Outcome, text, target }
    : null;
}

function readPair(value: unknown): ObservedPair | null {
  const { pair } = Object(value) as { readonly pair?: unknown };
  const { hit, miss } = Object(pair) as Record<string, unknown>;
  const read = { hit: readObservation(hit), miss: readObservation(miss) };
  return read.hit === null || read.miss === null ? null : { hit: read.hit, miss: read.miss };
}

const shown = (value: unknown): string => (JSON.stringify(value) ?? String(value)).slice(0, 200);

function carriesMark(value: unknown, ctx: JudgeContext): boolean {
  const text = JSON.stringify(value) ?? "";
  return [ctx.marker, ctx.warMark, ctx.secretMark, ctx.storeMark].some((mark) =>
    text.includes(mark),
  );
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
        FRAME_EVENTS.has(o.outcome) &&
        (FRAME_CROSS_ORIGIN.test(o.text) || FRAME_BLANK.test(o.text)) &&
        FRAME_NO_REPLY.test(o.text)
      );
    case "unreachable":
      return o.outcome === "fetch error, link error" && FETCH_NETWORK_ERROR.test(o.text);
    case "indistinguishable":
    case "never":
      return false;
  }
}

/** The probe's declared leak kind; a probe that declares none (a store read) proves nothing either way. */
const leakKind = (spec: ProbeSpec): Verdict => ("leak" in spec ? spec.leak : "NO-RESULT");

/** A well-formed answer that is not the denial: what it leaked, by the probe's declared leak kind. */
function leakOf(spec: ProbeSpec, denial: Denial, o: Observation): Verdict {
  if (denial.kind === "unreachable")
    return o.outcome.startsWith("fetch ok") ? "READ" : "LEAKS-EXISTENCE";
  return leakKind(spec);
}

type Judged = { readonly verdict: Verdict; readonly line: string };

/** Why a target cannot carry a verdict: the witness did not find it as planned. Null when it did. */
function witnessProblem(
  input: IsolationRunInput,
  target: string,
  want: "present" | "absent" | "either",
): string | null {
  const found = input.witness[target];
  if (found === undefined) return `no witness ran for ${target}`;
  if (want === "present" && !found.present)
    return `witness did not find ${target} (${found.detail})`;
  if (want === "absent" && found.present)
    return `witness found ${target}, planned as missing (${found.detail})`;
  return null;
}

function judgeSingle(
  spec: ProbeSpec,
  denial: Denial,
  unit: string,
  raw: unknown,
  input: IsolationRunInput,
): Judged {
  const o = readObservation(raw);
  const line = `${unit} -> ${o === null ? `malformed ${shown(raw)}` : `${o.outcome}: ${o.text}`}`;
  if (carriesMark(raw, input.context)) return { verdict: "READ", line };
  if (o === null) return { verdict: "NO-RESULT", line };
  if (o.target !== unit) return { verdict: "NO-RESULT", line: `${line}; acted on ${o.target}` };
  const problem = witnessProblem(input, unit, "present");
  if (problem !== null) return { verdict: "NO-RESULT", line: `${line}; ${problem}` };
  if (denies(denial, o, input.context)) return { verdict: "BLOCKED", line };
  if (FRAME_ANSWERED.test(o.text)) return { verdict: leakOf(spec, denial, o), line };
  if (NO_ANSWER.has(o.outcome) || o.text.length === 0) return { verdict: "NO-RESULT", line };
  return { verdict: leakOf(spec, denial, o), line };
}

function judgePair(
  spec: ProbeSpec,
  unit: readonly [string, string],
  raw: unknown,
  input: IsolationRunInput,
): Judged {
  const pair = readPair(raw);
  const line = `${unit[0]} -> ${pair === null ? `malformed ${shown(raw)}` : `${pair.hit.outcome}: ${pair.hit.text} | ${pair.miss.outcome}: ${pair.miss.text}`}`;
  if (carriesMark(raw, input.context)) return { verdict: "READ", line };
  if (pair === null) return { verdict: "NO-RESULT", line };
  if (pair.hit.target !== unit[0] || pair.miss.target !== unit[1]) {
    return {
      verdict: "NO-RESULT",
      line: `${line}; acted on ${pair.hit.target} and ${pair.miss.target}`,
    };
  }
  const problem =
    witnessProblem(input, unit[0], spec.guess === true ? "either" : "present") ??
    witnessProblem(input, unit[1], "absent");
  if (problem !== null) return { verdict: "NO-RESULT", line: `${line}; ${problem}` };
  if (pair.hit.outcome === "threw" || pair.miss.outcome === "threw") {
    return { verdict: "NO-RESULT", line };
  }
  if (settled(pair.hit) === settled(pair.miss)) return { verdict: "BLOCKED", line };
  return { verdict: leakKind(spec), line };
}

function judgeUnit(
  spec: ProbeSpec,
  denial: Denial,
  unit: Unit,
  raw: unknown,
  input: IsolationRunInput,
): Judged {
  if (typeof unit === "string") return judgeSingle(spec, denial, unit, raw, input);
  if (denial.kind !== "indistinguishable") {
    return {
      verdict: "NO-RESULT",
      line: `${unit[0]} -> a pair planned for a ${denial.kind} probe`,
    };
  }
  return judgePair(spec, unit, raw, input);
}

const unitKey = (unit: Unit): string => (typeof unit === "string" ? unit : unit[0]);

function eachVerdict(
  spec: ProbeSpec,
  denial: Denial,
  raw: unknown,
  planned: readonly Unit[],
  input: IsolationRunInput,
): { readonly verdict: Verdict; readonly summary: string } {
  const each = (raw as { readonly each?: unknown } | null)?.each;
  if (!Array.isArray(each)) return { verdict: "NO-RESULT", summary: "no per-target results" };
  const targetOf = (e: unknown): string | null => {
    const target = (e as { readonly target?: unknown } | null)?.target;
    return typeof target === "string" ? target : null;
  };
  const byTarget = Map.groupBy(each, targetOf);
  const judged = planned.map((unit) => {
    const reports = byTarget.get(unitKey(unit)) ?? [];
    return reports.length === 1
      ? judgeUnit(spec, denial, unit, reports[0], input)
      : {
          verdict: "NO-RESULT" as const,
          line: `${unitKey(unit)} -> ${String(reports.length)} results, expected one`,
        };
  });
  const keys = new Set<string | null>(planned.map(unitKey));
  const unplanned = each.map(targetOf).filter((t) => !keys.has(t));
  const verdict = worst([
    ...judged.map((t) => t.verdict),
    ...(unplanned.length > 0 ? (["NO-RESULT"] as const) : []),
  ]);
  return {
    verdict,
    summary: [
      `${String(each.length)} results for ${String(planned.length)} planned targets`,
      ...unplanned.map((t) => `unplanned ${String(t)}`),
      ...judged.filter((t) => t.verdict !== "BLOCKED").map((t) => `${t.verdict} ${t.line}`),
    ].join("; "),
  };
}

/** Whether a planned unit has the probe's shape. A shape not named here, or none at all, fits nothing. */
function fitsShape(shape: Shape | undefined, unit: Unit | undefined): unit is Unit {
  const fits: Readonly<Record<string, (u: unknown) => boolean>> = {
    single: (u) => typeof u === "string",
    pair: (u) => Array.isArray(u),
  };
  return fits[String(shape)]?.(unit) === true;
}

function judgeBrowserRow(
  spec: ProbeSpec,
  position: Position,
  raw: unknown,
  input: IsolationRunInput,
): { readonly verdict: Verdict; readonly summary: string } {
  const planned = input.targets[`${spec.id}@${position}`] ?? input.targets[spec.id];
  if (planned === undefined) return { verdict: "NO-RESULT", summary: "no planned targets" };
  const denial = denialAt(spec, position);
  if (spec.shape === "each") return eachVerdict(spec, denial, raw, planned, input);
  const unit = planned.length === 1 ? planned[0] : undefined;
  if (!fitsShape(spec.shape, unit)) {
    return {
      verdict: "NO-RESULT",
      summary: `planned ${shown(planned)}, expected one ${spec.shape} unit`,
    };
  }
  const judged = judgeUnit(spec, denial, unit, raw, input);
  return { verdict: judged.verdict, summary: judged.line };
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
      return `LEAKS-EXISTENCE (exception: ${expected.exception})`;
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
  const rowsAt = Map.groupBy(input.browserRows, (row) => `${row.probe}|${row.position}`);

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
    const reports = rowsAt.get(`${expectedRow.id}|${expectedRow.position}`) ?? [];
    const [reported] = reports;
    if (reported === undefined || reports.length > 1) {
      const observed = `${String(reports.length)} rows reported, expected one`;
      return { ...base, observed, verdict: "NO-RESULT", ok: false };
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
