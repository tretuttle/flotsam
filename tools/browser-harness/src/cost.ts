import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  launchBrowser,
  type BrowserDisplay,
  type BrowserIdentity,
  type BrowserSession,
} from "./browser.ts";
import {
  baselineFileName,
  summarize,
  type FailedRun,
  type MachineInfo,
  type MachineLoad,
  type Summary,
} from "./measure.ts";
import { readProcessSnapshot, type ProcessSnapshot } from "./owned-process.ts";
import { getCostScenario, type CostScenarioName, type MeasuredScenario } from "./scenarios.ts";
import { startFixtureServer, type ServedRequest } from "./server.ts";

export const COST_ARMS = ["off", "extension", "panel"] as const;
export type CostArm = (typeof COST_ARMS)[number];

export type CostSample = {
  readonly round: number;
  readonly arm: CostArm;
  readonly lastResourceFinishedMs: number;
  readonly parentWorkingSetBytes: number;
  readonly parentCpuMs: number;
  readonly wallMs: number;
  readonly requestCount: number;
};

export type ArmSummary = {
  readonly arm: CostArm;
  readonly scoredRunCount: number;
  readonly lastResourceFinishedMs: Summary | null;
  readonly parentCpuMs: Summary | null;
  readonly parentWorkingSetBytes: Summary | null;
  readonly wallMs: Summary | null;
};

export type CostScenarioResult = {
  readonly scenario: CostScenarioName;
  readonly rounds: number;
  readonly warmupDropped: 1;
  readonly errors: number;
  readonly failures: readonly FailedRun[];
  readonly warmupSamples: readonly CostSample[];
  readonly scoredSamples: readonly CostSample[];
  readonly arms: Readonly<Record<CostArm, ArmSummary>>;
  readonly budget: {
    readonly parentCpuMs: number | null;
    readonly lastResourceFinishedMs: number | null;
  };
  readonly browser: BrowserIdentity;
  readonly machine: MachineInfo;
  readonly load: { readonly before: MachineLoad; readonly after: MachineLoad };
};

export type CostBaselineFile = {
  readonly capturedAt: string;
  readonly scenario: CostScenarioName;
  readonly arm: "off" | "panel";
  readonly rounds: number;
  readonly warmupDropped: 1;
  readonly runCount: number;
  readonly errors: number;
  readonly failures: readonly FailedRun[];
  readonly samples: readonly CostSample[];
  readonly lastResourceFinishedMs: Summary | null;
  readonly parentCpuMs: Summary | null;
  readonly parentWorkingSetBytes: Summary | null;
  readonly wallMs: Summary | null;
  readonly browser: BrowserIdentity;
  readonly machine: MachineInfo;
  readonly load: { readonly before: MachineLoad; readonly after: MachineLoad };
};

export function rotateArms(round: number): readonly CostArm[] {
  return COST_ARMS.map((_, index) => COST_ARMS[(index + round) % COST_ARMS.length] ?? "off");
}

export function computeBudget(offMedian: number, panelMedian: number): number {
  return offMedian + 0.5 * (panelMedian - offMedian);
}

export function detectSlowArm(options: {
  readonly arm: CostArm;
  readonly observedMedianMs: number;
  readonly offMedianMs: number;
  readonly panelMedianMs: number;
  readonly slackMs?: number;
}): { readonly ok: boolean; readonly budgetMs: number; readonly reason: string | null } {
  const budgetMs = computeBudget(options.offMedianMs, options.panelMedianMs);
  const ceiling = budgetMs + (options.slackMs ?? 0);
  if (options.panelMedianMs > options.offMedianMs && options.observedMedianMs > ceiling) {
    return {
      ok: false,
      budgetMs,
      reason: `${options.arm} median ${options.observedMedianMs.toFixed(1)} ms exceeded budget ${budgetMs.toFixed(1)} ms (off ${options.offMedianMs.toFixed(1)} ms, panel ${options.panelMedianMs.toFixed(1)} ms)`,
    };
  }
  return { ok: true, budgetMs, reason: null };
}

export function summarizeCostSamples(samples: readonly CostSample[], arm: CostArm): ArmSummary {
  const matching = samples.filter((sample) => sample.arm === arm && sample.round > 0);
  return {
    arm,
    scoredRunCount: matching.length,
    lastResourceFinishedMs: summarize(matching.map((sample) => sample.lastResourceFinishedMs)),
    parentCpuMs: summarize(matching.map((sample) => sample.parentCpuMs)),
    parentWorkingSetBytes: summarize(matching.map((sample) => sample.parentWorkingSetBytes)),
    wallMs: summarize(matching.map((sample) => sample.wallMs)),
  };
}

export async function measureCostScenario(options: {
  readonly scenarioName: CostScenarioName;
  readonly rounds: number;
  readonly binaryPath: string;
  readonly extensionPath: string;
  readonly display: BrowserDisplay;
  readonly signal: AbortSignal;
}): Promise<CostScenarioResult> {
  if (options.rounds < 2) {
    throw new Error("cost measurement requires at least 2 rounds (round 0 warmup is dropped)");
  }
  const scenario = getCostScenario(options.scenarioName);
  await using server = await startFixtureServer();
  const loadBefore = await readMachineLoad();
  const allSamples: CostSample[] = [];
  const failures: FailedRun[] = [];
  let browserIdentity: BrowserIdentity | null = null;
  let runIndex = 0;

  for (let round = 0; round < options.rounds; round += 1) {
    for (const arm of rotateArms(round)) {
      options.signal.throwIfAborted();
      runIndex += 1;
      try {
        await using session = await launchBrowser({
          binaryPath: options.binaryPath,
          extensionPath: arm === "extension" ? options.extensionPath : null,
          display: options.display,
          protocol: "marionette",
          allowSystemAccess: arm === "panel",
          signal: options.signal,
        });
        browserIdentity ??= session.identity;
        const sample = await runCostArm({
          session,
          server,
          scenario,
          round,
          arm,
          inspect: readProcessSnapshot,
          signal: options.signal,
        });
        allSamples.push(sample);
      } catch (error) {
        if (options.signal.aborted) throw error;
        failures.push({
          run: runIndex,
          reason: `round ${String(round)} ${arm}: ${errorMessage(error)}`,
        });
      }
    }
  }

  const loadAfter = await readMachineLoad();
  if (browserIdentity === null) {
    throw new Error(
      `all cost runs failed for ${options.scenarioName}: ${failures.map((f) => f.reason).join("; ")}`,
    );
  }
  const warmupSamples = allSamples.filter((sample) => sample.round === 0);
  const scoredSamples = allSamples.filter((sample) => sample.round > 0);
  const arms: Record<CostArm, ArmSummary> = {
    off: summarizeCostSamples(allSamples, "off"),
    extension: summarizeCostSamples(allSamples, "extension"),
    panel: summarizeCostSamples(allSamples, "panel"),
  };
  const offCpu = arms.off.parentCpuMs?.median ?? null;
  const panelCpu = arms.panel.parentCpuMs?.median ?? null;
  const offLast = arms.off.lastResourceFinishedMs?.median ?? null;
  const panelLast = arms.panel.lastResourceFinishedMs?.median ?? null;

  return {
    scenario: options.scenarioName,
    rounds: options.rounds,
    warmupDropped: 1,
    errors: failures.length,
    failures,
    warmupSamples,
    scoredSamples,
    arms,
    budget: {
      parentCpuMs: offCpu !== null && panelCpu !== null ? computeBudget(offCpu, panelCpu) : null,
      lastResourceFinishedMs:
        offLast !== null && panelLast !== null ? computeBudget(offLast, panelLast) : null,
    },
    browser: browserIdentity,
    machine: readMachineInfo(),
    load: { before: loadBefore, after: loadAfter },
  };
}

export async function runCostArm(options: {
  readonly session: Pick<
    BrowserSession,
    "browserPid" | "openTab" | "navigateTab" | "evaluate" | "evaluateChrome" | "closeTab"
  >;
  readonly server: {
    readonly origin: string;
    readonly takeRequests: () => readonly ServedRequest[];
  };
  readonly scenario: MeasuredScenario;
  readonly round: number;
  readonly arm: CostArm;
  readonly inspect: (pid: number) => ProcessSnapshot;
  readonly signal: AbortSignal;
}): Promise<CostSample> {
  const { session, server, scenario, round, arm, signal } = options;
  const context = await abortable(session.openTab("about:blank"), signal);
  let toolboxOpened = false;
  try {
    if (arm === "panel") {
      await abortable(
        session.evaluateChrome(
          `const done = arguments[arguments.length - 1];
           const { DevToolsShim } = ChromeUtils.importESModule("chrome://devtools-startup/content/DevToolsShim.sys.mjs");
           const tab = window.gBrowser.selectedTab;
           DevToolsShim.showToolboxForTab(tab, { toolId: "netmonitor" })
             .then((tb) => tb.selectTool("netmonitor").then(() => done(true)))
             .catch((err) => done({ error: String(err) }));`,
        ),
        signal,
      );
      toolboxOpened = true;
    }
    server.takeRequests();
    const before = options.inspect(session.browserPid);
    const started = process.hrtime.bigint();
    await abortable(session.navigateTab(context, `${server.origin}${scenario.pagePath}`), signal);
    const rawReport = await abortable(session.evaluate(context, "window.__harnessReady"), signal);
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    const after = options.inspect(session.browserPid);
    const served = server.takeRequests();
    const report = parseReport(rawReport);
    const problem = verifyCostRequests(report, served, scenario);
    if (problem !== null) throw new Error(problem);
    return {
      round,
      arm,
      lastResourceFinishedMs: report.lastResourceFinishedMs,
      parentWorkingSetBytes: after.workingSetBytes,
      parentCpuMs: after.cpuTimeMs - before.cpuTimeMs,
      wallMs,
      requestCount: served.length,
    };
  } finally {
    if (toolboxOpened) {
      await session
        .evaluateChrome(
          `const done = arguments[arguments.length - 1];
           const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
           const { gDevTools } = require("resource://devtools/client/framework/devtools.js");
           gDevTools.closeToolboxForTab(window.gBrowser.selectedTab).then(() => done(true), () => done(false));`,
        )
        .catch(() => undefined);
    }
    await session.closeTab(context).catch(() => undefined);
  }
}

export function costBaselineFileName(result: CostScenarioResult, arm: "off" | "panel"): string {
  const base = baselineFileName(result).replace(/\.json$/u, "");
  return `${base}-${result.scenario}-${arm}.json`;
}

export async function writeCostBaselines(
  result: CostScenarioResult,
  outDir: string,
): Promise<readonly string[]> {
  if (result.errors > 0) {
    throw new Error(`refusing to write cost baselines with ${String(result.errors)} failed runs`);
  }
  await NodeFSP.mkdir(outDir, { recursive: true });
  const paths: string[] = [];
  for (const arm of ["off", "panel"] as const) {
    const summary = result.arms[arm];
    const samples = result.scoredSamples.filter((sample) => sample.arm === arm);
    const file: CostBaselineFile = {
      capturedAt: new Date().toISOString(),
      scenario: result.scenario,
      arm,
      rounds: result.rounds,
      warmupDropped: 1,
      runCount: summary.scoredRunCount,
      errors: result.errors,
      failures: result.failures,
      samples,
      lastResourceFinishedMs: summary.lastResourceFinishedMs,
      parentCpuMs: summary.parentCpuMs,
      parentWorkingSetBytes: summary.parentWorkingSetBytes,
      wallMs: summary.wallMs,
      browser: result.browser,
      machine: result.machine,
      load: result.load,
    };
    const path = NodePath.join(outDir, costBaselineFileName(result, arm));
    await NodeFSP.writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    paths.push(path);
  }
  return paths;
}

export function formatCostSummary(result: CostScenarioResult): string {
  const lines = [
    `${result.scenario}: ${result.browser.name} ${result.browser.version} (${result.browser.buildId}), ${String(result.rounds)} rounds (round 0 dropped, ${String(result.rounds - 1)} scored), ${String(result.errors)} errors`,
    `load before: cpu ${result.load.before.cpuBusyPercent.toFixed(1)}%, loadavg ${formatLoadAvg(result.load.before.loadAverage)}; after: cpu ${result.load.after.cpuBusyPercent.toFixed(1)}%, loadavg ${formatLoadAvg(result.load.after.loadAverage)}`,
  ];
  for (const arm of COST_ARMS) {
    const s = result.arms[arm];
    const cpu = s.parentCpuMs;
    const last = s.lastResourceFinishedMs;
    lines.push(
      `  ${arm.padEnd(10)} n=${String(s.scoredRunCount)} cpu=${cpu ? `${cpu.median.toFixed(1)}ms (spread ${cpu.spread.toFixed(1)}ms)` : "n/a"} last=${last ? `${last.median.toFixed(1)}ms (spread ${last.spread.toFixed(1)}ms)` : "n/a"}`,
    );
  }
  if (result.budget.parentCpuMs !== null) {
    lines.push(`  budget cpu=${result.budget.parentCpuMs.toFixed(1)}ms`);
  }
  return lines.join("\n");
}

function formatLoadAvg(load: readonly number[] | null): string {
  if (load === null) return "n/a";
  return load.map((n) => n.toFixed(2)).join(" ");
}

function verifyCostRequests(
  report: {
    lastResourceFinishedMs: number;
    finished: readonly string[];
    failed: readonly string[];
  },
  served: readonly { readonly method: string; readonly path: string }[],
  scenario: MeasuredScenario,
): string | null {
  const problems: string[] = [];
  if (report.failed.length > 0) problems.push(`page failed ${report.failed.slice(0, 5).join(" ")}`);
  const resources = scenario.responses.filter((response) => response.path !== scenario.pagePath);
  const finished = new Set(report.finished);
  const unfinished = resources.filter((response) => !finished.has(response.path));
  if (unfinished.length > 0) {
    problems.push(`page did not finish ${String(unfinished.length)} resources`);
  }
  if (!(report.lastResourceFinishedMs > 0)) {
    problems.push(`last resource finished at ${String(report.lastResourceFinishedMs)} ms`);
  }
  const expected = scenario.responses.map((response) => `${response.method} ${response.path}`);
  const observed = served.map((request) => `${request.method} ${request.path}`);
  const missing = subtractMultiset(expected, observed);
  const extra = subtractMultiset(observed, expected);
  if (missing.length > 0) problems.push(`server never served ${String(missing.length)} expected`);
  if (extra.length > 0) problems.push(`server also served ${String(extra.length)} unexpected`);
  return problems.length === 0 ? null : problems.join("; ");
}

function subtractMultiset(values: readonly string[], remove: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of remove) counts.set(item, (counts.get(item) ?? 0) + 1);
  const left: string[] = [];
  for (const item of values) {
    const count = counts.get(item) ?? 0;
    if (count > 0) counts.set(item, count - 1);
    else left.push(item);
  }
  return left;
}

function parseReport(text: string): {
  lastResourceFinishedMs: number;
  finished: string[];
  failed: string[];
} {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("lastResourceFinishedMs" in parsed) ||
    typeof parsed.lastResourceFinishedMs !== "number" ||
    !("finished" in parsed) ||
    !Array.isArray(parsed.finished) ||
    !("failed" in parsed) ||
    !Array.isArray(parsed.failed)
  ) {
    throw new Error(`unexpected cost page report: ${text}`);
  }
  return {
    lastResourceFinishedMs: parsed.lastResourceFinishedMs,
    finished: parsed.finished.filter((item): item is string => typeof item === "string"),
    failed: parsed.failed.filter((item): item is string => typeof item === "string"),
  };
}

function readMachineInfo(): MachineInfo {
  const cpus = NodeOS.cpus();
  return {
    platform: NodeOS.platform(),
    release: NodeOS.release(),
    arch: NodeOS.arch(),
    cpuModel: cpus[0]?.model.trim() || "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: NodeOS.totalmem(),
  };
}

async function readMachineLoad(): Promise<MachineLoad> {
  const snap = (): { busy: number; total: number } => {
    let busy = 0;
    let total = 0;
    for (const cpu of NodeOS.cpus()) {
      const { idle, ...rest } = cpu.times;
      const used = rest.user + rest.nice + rest.sys + rest.irq;
      busy += used;
      total += used + idle;
    }
    return { busy, total };
  };
  const first = snap();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = snap();
  const total = second.total - first.total;
  return {
    cpuBusyPercent: total > 0 ? Math.round(((second.busy - first.busy) / total) * 1000) / 10 : 0,
    loadAverage: NodeOS.platform() === "win32" ? null : NodeOS.loadavg(),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
