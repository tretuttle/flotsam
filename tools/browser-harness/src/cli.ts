import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import type { BrowserDisplay } from "./browser.ts";
import { checkHarFile, formatHarCheck } from "./har.ts";
import { captureBaseline, measurePage, type MeasureResult } from "./measure.ts";
import { currentPlatformName } from "./owned-process.ts";
import { parseScenarioName, SCENARIO_NAMES, SCENARIOS } from "./scenarios.ts";
import { startFixtureServer } from "./server.ts";

export const BINARY_ENV = "BROWSER_HARNESS_BINARY";

const USAGE = [
  "usage:",
  "  browser-harness serve",
  `  browser-harness measure --binary <path> [--runs <n>] [--extension <path>] [--show-window]`,
  `  browser-harness baseline --binary <path> [--runs <n>] [--out-dir <dir>] [--show-window]`,
  `  browser-harness har-check --scenario <${SCENARIO_NAMES.join("|")}> <file.har>`,
  `The binary may come from ${BINARY_ENV} instead of --binary. Browsers run headless unless --show-window is passed.`,
].join("\n");

class UsageError extends Error {}

type Command =
  | { readonly kind: "serve" }
  | { readonly kind: "har-check"; readonly scenario: string; readonly file: string }
  | {
      readonly kind: "measure";
      readonly runs: number;
      readonly binaryPath: string;
      readonly display: BrowserDisplay;
      readonly extensionPath: string | null;
    }
  | {
      readonly kind: "baseline";
      readonly runs: number;
      readonly binaryPath: string;
      readonly display: BrowserDisplay;
      readonly outDir: string;
    };

export function parseCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Command {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  const allowed = (names: readonly string[], positionalCount: number): void => {
    const extra = Object.keys(values).filter((name) => !names.includes(name));
    if (extra.length > 0) usage(`${command ?? ""} does not take --${extra.join(", --")}`);
    if (rest.length !== positionalCount) usage(`${command ?? ""} got unexpected arguments`);
  };
  if (command === "serve") {
    allowed([], 0);
    return { kind: "serve" };
  }
  if (command === "har-check") {
    allowed(["scenario"], 1);
    if (values.scenario === undefined) usage("har-check needs --scenario");
    return { kind: "har-check", scenario: values.scenario, file: rest[0] ?? "" };
  }
  if (command === "measure" || command === "baseline") {
    const common = ["binary", "runs", "show-window"];
    const runs = parseRuns(values.runs ?? "10");
    const binaryPath = requireBinary(values.binary ?? env[BINARY_ENV]);
    const display: BrowserDisplay = values["show-window"] === true ? "window" : "headless";
    if (command === "measure") {
      allowed([...common, "extension"], 0);
      return {
        kind: "measure",
        runs,
        binaryPath,
        display,
        extensionPath: values.extension ?? null,
      };
    }
    allowed([...common, "out-dir"], 0);
    const outDir = values["out-dir"] ?? NodePath.join(packageRoot(), "baselines");
    return { kind: "baseline", runs, binaryPath, display, outDir };
  }
  usage(command === undefined ? "missing command" : `unknown command ${command}`);
}

function parse(args: readonly string[]) {
  return NodeUtil.parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      binary: { type: "string" },
      runs: { type: "string" },
      extension: { type: "string" },
      "out-dir": { type: "string" },
      scenario: { type: "string" },
      "show-window": { type: "boolean" },
    },
  });
}

function requireBinary(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    usage(`a browser binary is required: pass --binary <path> or set ${BINARY_ENV}`);
  }
  const path = NodePath.resolve(value);
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
  } catch {
    usage(`browser binary not found or not executable: ${path}`);
  }
  if (!NodeFS.statSync(path).isFile()) usage(`browser binary is not a file: ${path}`);
  return path;
}

function parseRuns(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) usage("--runs expects a positive integer");
  const runs = Number(value);
  if (runs > 100) usage("--runs cannot exceed 100");
  return runs;
}

function usage(message: string): never {
  throw new UsageError(`${message}\n${USAGE}`);
}

function packageRoot(): string {
  return NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
}

async function main(argv: readonly string[]): Promise<void> {
  currentPlatformName();
  const command = parseCommand(argv, process.env);
  if (command.kind === "serve") {
    const server = await startFixtureServer();
    process.stdout.write(`${server.origin}\n`);
    return;
  }
  if (command.kind === "har-check") {
    const result = await checkHarFile(command.file, SCENARIOS[parseScenarioName(command.scenario)]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${formatHarCheck(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const interrupt = (signal: NodeJS.Signals): void => {
    process.stderr.write(`${signal}: stopping the browser and removing its profile\n`);
    controller.abort(new Error(`interrupted by ${signal}`));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  if (command.kind === "measure") {
    const result = await measurePage({ ...command, signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    report(result);
    return;
  }
  const { file, path } = await captureBaseline({ ...command, signal: controller.signal });
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
  report(file);
  process.stderr.write(`wrote ${path}\n`);
}

function report(result: Omit<MeasureResult, "extensionPath">): void {
  const { lastResourceFinishedMs: time, parentWorkingSetBytes: memory } = result;
  process.stderr.write(
    `${result.browser.name} ${result.browser.version} (${result.browser.buildId}), ${result.browser.headless ? "headless" : "window"}, ${String(result.runCount)} runs, ${String(result.errors)} failed\n`,
  );
  if (time !== null && memory !== null) {
    process.stderr.write(
      `last resource finished: median ${time.median.toFixed(1)} ms, spread ${time.spread.toFixed(1)} ms over ${String(time.runCount)} samples\n`,
    );
    process.stderr.write(
      `parent working set: median ${memory.median.toFixed(0)} bytes, spread ${memory.spread.toFixed(0)} bytes\n`,
    );
  }
  for (const failure of result.failures) {
    process.stderr.write(`run ${String(failure.run)} failed: ${failure.reason}\n`);
  }
  if (result.errors > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
