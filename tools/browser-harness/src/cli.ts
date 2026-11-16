import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { checkHarFile, expectedBodies, formatHarCheck } from "./har.ts";
import { captureBaseline, measurePage, type Summary } from "./measure.ts";
import { startFixtureServer } from "./server.ts";

const DEFAULT_ZEN_BINARY = "C:\\Program Files\\Zen Twilight\\zen.exe";

class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "har-check") {
    await runHarCheck(argv.slice(1));
    return;
  }
  const command = parseCommand(argv);
  if (command.kind === "serve") {
    const server = await startFixtureServer();
    process.stderr.write(`fixture server ${server.origin}\n`);
    return;
  }
  if (command.kind === "measure") {
    const result = await measurePage(command);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    writeReport(result);
    return;
  }
  const result = await captureBaseline(command);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  writeReport(result);
  process.stderr.write(`wrote ${command.outPath}\n`);
}

async function runHarCheck(args: readonly string[]): Promise<void> {
  const file = args[0];
  if (file === undefined || args.length !== 1) usage("usage: browser-harness har-check <file.har>");
  const result = await checkHarFile(file, expectedBodies());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`${formatHarCheck(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

function writeReport(result: { loadTimeMs: Summary; parentWorkingSetBytes: Summary }): void {
  process.stderr.write(
    `load time median ${result.loadTimeMs.median.toFixed(1)} ms, spread ${result.loadTimeMs.spread.toFixed(1)} ms, ${String(result.loadTimeMs.runCount)} runs\n`,
  );
  process.stderr.write(
    `parent working set median ${result.parentWorkingSetBytes.median.toFixed(0)} bytes, spread ${result.parentWorkingSetBytes.spread.toFixed(0)} bytes, ${String(result.parentWorkingSetBytes.runCount)} runs\n`,
  );
}

type Command =
  | { readonly kind: "serve" }
  | {
      readonly kind: "measure";
      readonly runs: number;
      readonly binaryPath: string;
      readonly extensionPath: string | null;
    }
  | {
      readonly kind: "baseline";
      readonly runs: number;
      readonly binaryPath: string;
      readonly outPath: string;
    };

function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  if (command === undefined) usage("usage: browser-harness <serve|measure|baseline|har-check>");
  const flags = readFlags(rest);
  if (command === "serve") {
    if (flags.size > 0) usage("serve takes no flags");
    return { kind: "serve" };
  }
  const runs = parseRuns(flags.get("--runs") ?? "10");
  const binaryPath = flags.get("--binary") ?? DEFAULT_ZEN_BINARY;
  flags.delete("--runs");
  flags.delete("--binary");
  if (command === "measure") {
    const extensionPath = flags.get("--extension") ?? null;
    flags.delete("--extension");
    if (flags.size > 0) usage(`unknown flag ${[...flags.keys()].join(", ")}`);
    return { kind: "measure", runs, binaryPath, extensionPath };
  }
  if (command === "baseline") {
    const outPath =
      flags.get("--out") ?? NodePath.join(packageRoot(), "baselines", "no-extension.json");
    flags.delete("--out");
    if (flags.size > 0) usage(`unknown flag ${[...flags.keys()].join(", ")}`);
    return { kind: "baseline", runs, binaryPath, outPath };
  }
  usage(`unknown command ${command}`);
}

function readFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--")) usage(`unexpected argument ${token ?? ""}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`missing value for ${token}`);
    flags.set(token, value);
    index += 1;
  }
  return flags;
}

function parseRuns(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) usage("--runs expects a positive integer");
  const runs = Number(value);
  if (runs > 100) usage("--runs cannot exceed 100");
  return runs;
}

function packageRoot(): string {
  return NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
}

function usage(message: string): never {
  throw new UsageError(message);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
