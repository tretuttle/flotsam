import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  expectedResourceCount,
  FIXTURE_SEED,
  smallResourcePaths,
  SMALL_KINDS,
  SMALL_PER_KIND,
} from "./fixtures.ts";
import { readProcessorTimeMs, readWorkingSetBytes } from "./owned-process.ts";
import { type RemoteProtocol } from "./remote.ts";
import { startFixtureServer } from "./server.ts";
import { launchBrowser } from "./browser.ts";

export type Summary = {
  readonly median: number;
  readonly spread: number;
  readonly min: number;
  readonly max: number;
  readonly runCount: number;
};

export type MeasureSample = {
  readonly loadTimeMs: number;
  readonly parentWorkingSetBytes: number;
  readonly resourceCount: number;
  readonly requestCount: number;
};

export type MachineInfo = {
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
};

export type MeasureResult = {
  readonly samples: readonly MeasureSample[];
  readonly loadTimeMs: Summary;
  readonly parentWorkingSetBytes: Summary;
  readonly errors: number;
  readonly expectedResourceCount: number;
  readonly wallTimeMs: number;
  readonly browserCpuMs: number;
  readonly limiter: string;
  readonly extensionPath: string | null;
  readonly browser: {
    readonly binaryPath: string;
    readonly version: string;
    readonly buildId: string;
    readonly userAgent: string;
    readonly remoteProtocol: RemoteProtocol;
  };
  readonly machine: MachineInfo;
};

export type BaselineFile = {
  readonly capturedAt: string;
  readonly extension: null;
  readonly browser: MeasureResult["browser"];
  readonly machine: MachineInfo;
  readonly page: {
    readonly resourceCount: number;
    readonly cache: "no-store";
    readonly seed: string;
    readonly smallPerKind: number;
    readonly kinds: readonly string[];
  };
  readonly loadTimeMs: Summary;
  readonly parentWorkingSetBytes: Summary;
  readonly samples: readonly MeasureSample[];
  readonly errors: number;
  readonly wallTimeMs: number;
  readonly browserCpuMs: number;
  readonly limiter: string;
};

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) throw new Error("no runs");
  const sorted = [...values].sort((left, right) => left - right);
  const min = at(sorted, 0);
  const max = at(sorted, sorted.length - 1);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? at(sorted, mid) : (at(sorted, mid - 1) + at(sorted, mid)) / 2;
  return { median, spread: max - min, min, max, runCount: values.length };
}

export async function measurePage(options: {
  runs: number;
  binaryPath: string;
  extensionPath: string | null;
}): Promise<MeasureResult> {
  const server = await startFixtureServer();
  const browser = await launchBrowser({
    binaryPath: options.binaryPath,
    extensionPath: options.extensionPath,
  });
  const samples: MeasureSample[] = [];
  const started = process.hrtime.bigint();
  const cpuStarted = readProcessorTimeMs(browser.browserPid);
  try {
    for (let index = 0; index < options.runs; index += 1) {
      server.resetRequestCount();
      const context = await browser.openTab(`${server.origin}/`);
      try {
        const timing = parsePageTiming(await browser.evaluate(context, "window.__harnessReady"));
        const parentWorkingSetBytes = readWorkingSetBytes(browser.browserPid);
        const requestCount = server.requestCount();
        const served = new Set(server.requestPaths());
        const missingOnServer = smallResourcePaths().filter((path) => !served.has(path));
        const expected = expectedResourceCount();
        if (
          timing.resourceCount !== expected ||
          timing.missing.length > 0 ||
          missingOnServer.length > 0
        ) {
          throw new Error(
            `run ${String(index + 1)} loaded ${String(timing.resourceCount)} resources, expected ${String(expected)}; page missing ${timing.missing.join(" ") || "none"}; server missing ${missingOnServer.join(" ") || "none"}`,
          );
        }
        if (!(timing.loadTimeMs > 0)) {
          throw new Error(
            `run ${String(index + 1)} navigation timing was ${String(timing.loadTimeMs)}`,
          );
        }
        if (requestCount < expected + 1) {
          throw new Error(
            `run ${String(index + 1)} served ${String(requestCount)} responses, expected at least ${String(expected + 1)}`,
          );
        }
        samples.push({
          loadTimeMs: timing.loadTimeMs,
          parentWorkingSetBytes,
          resourceCount: timing.resourceCount,
          requestCount,
        });
      } finally {
        await browser.closeTab(context).catch(() => undefined);
      }
    }
    const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const browserCpuMs = readProcessorTimeMs(browser.browserPid) - cpuStarted;
    return {
      samples,
      loadTimeMs: summarize(samples.map((sample) => sample.loadTimeMs)),
      parentWorkingSetBytes: summarize(samples.map((sample) => sample.parentWorkingSetBytes)),
      errors: 0,
      expectedResourceCount: expectedResourceCount(),
      wallTimeMs,
      browserCpuMs,
      limiter: limiterNote(wallTimeMs, browserCpuMs),
      extensionPath: options.extensionPath,
      browser: {
        binaryPath: options.binaryPath,
        version: browser.version,
        buildId: browser.buildId,
        userAgent: browser.userAgent,
        remoteProtocol: browser.remoteProtocol,
      },
      machine: machineInfo(),
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

export async function captureBaseline(options: {
  runs: number;
  binaryPath: string;
  outPath: string;
}): Promise<BaselineFile> {
  const measured = await measurePage({
    runs: options.runs,
    binaryPath: options.binaryPath,
    extensionPath: null,
  });
  const file: BaselineFile = {
    capturedAt: new Date().toISOString(),
    extension: null,
    browser: measured.browser,
    machine: measured.machine,
    page: {
      resourceCount: measured.expectedResourceCount,
      cache: "no-store",
      seed: FIXTURE_SEED,
      smallPerKind: SMALL_PER_KIND,
      kinds: SMALL_KINDS,
    },
    loadTimeMs: measured.loadTimeMs,
    parentWorkingSetBytes: measured.parentWorkingSetBytes,
    samples: measured.samples,
    errors: measured.errors,
    wallTimeMs: measured.wallTimeMs,
    browserCpuMs: measured.browserCpuMs,
    limiter: measured.limiter,
  };
  await NodeFSP.mkdir(NodePath.dirname(options.outPath), { recursive: true });
  await NodeFSP.writeFile(options.outPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return file;
}

function machineInfo(): MachineInfo {
  const cpu = NodeOS.cpus()[0];
  return {
    platform: NodeOS.platform(),
    release: NodeOS.release(),
    arch: NodeOS.arch(),
    cpuModel: cpu?.model.trim() || "unknown",
    cpuCount: NodeOS.cpus().length,
    totalMemoryBytes: NodeOS.totalmem(),
  };
}

function parsePageTiming(text: string): {
  loadTimeMs: number;
  resourceCount: number;
  missing: readonly string[];
} {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.loadTimeMs !== "number" ||
    typeof value.resourceCount !== "number" ||
    !Array.isArray(value.missing)
  ) {
    throw new Error(`page timing was ${text}`);
  }
  const missing: string[] = [];
  for (const item of value.missing) {
    if (typeof item !== "string") throw new Error(`page timing was ${text}`);
    missing.push(item);
  }
  return {
    loadTimeMs: value.loadTimeMs,
    resourceCount: value.resourceCount,
    missing,
  };
}

function limiterNote(wallTimeMs: number, browserCpuMs: number): string {
  if (!(wallTimeMs > 0)) return "The runs recorded no wall time.";
  const percent = Math.round((browserCpuMs / wallTimeMs) * 100);
  const timing =
    "Load time is navigation timing, loadEventEnd minus startTime. Wall time also includes the working-set query after each load. Each run loaded 200 uncached localhost resources.";
  if (browserCpuMs / wallTimeMs >= 0.4) {
    return `The browser parent used ${String(percent)} percent of one core across the runs, so parent CPU is on the critical path. ${timing}`;
  }
  return `The browser parent used ${String(percent)} percent of one core across the runs, so parent CPU does not fill the load time. ${timing}`;
}

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`missing sample ${String(index)}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
