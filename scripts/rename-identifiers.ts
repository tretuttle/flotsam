import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// The retired name is assembled from parts so this file never contains it and `--check` can scan it like any other file.
const HAR = "har";
const ANYTIME = "anytime";
const UPPER_HAR = HAR.toUpperCase();
const UPPER_ANYTIME = ANYTIME.toUpperCase();
const TITLE_HAR = "Har";
const TITLE_ANYTIME = "Anytime";

interface Replacement {
  readonly from: string;
  readonly to: string;
}

/** Ordered: the first matching row wins at each position, and no `to` contains any `from`. */
export const REPLACEMENTS: readonly Replacement[] = [
  { from: `${HAR}-${ANYTIME}`, to: "one-click-har" },
  { from: `${HAR}${TITLE_ANYTIME}`, to: "oneClickHar" },
  { from: `${TITLE_HAR}${TITLE_ANYTIME}`, to: "OneClickHar" },
  { from: `${UPPER_HAR}_${UPPER_ANYTIME}`, to: "ONE_CLICK_HAR" },
  { from: `${UPPER_HAR} ${TITLE_ANYTIME}`, to: "One-Click HAR" },
  { from: `${HAR}_${ANYTIME}`, to: "one_click_har" },
];

const REPLACEMENT_PATTERN = new RegExp(
  REPLACEMENTS.map((row) => row.from.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join("|"),
  "gu",
);
const REPLACEMENT_BY_FROM = new Map(REPLACEMENTS.map((row) => [row.from, row.to]));
const LEFTOVER_PATTERN = new RegExp(`${HAR}[-_ ]?${ANYTIME}`, "iu");

const SKIPPED_PREFIXES = [".audit/", ".git/"];
const SKIPPED_FILES = ["pnpm-lock.yaml"];
const SKIPPED_SEGMENT = "node_modules";

export function rewrite(text: string): string {
  return text.replaceAll(REPLACEMENT_PATTERN, (match) => REPLACEMENT_BY_FROM.get(match) ?? match);
}

function isSkipped(relPath: string): boolean {
  return (
    SKIPPED_FILES.includes(relPath) ||
    SKIPPED_PREFIXES.some((prefix) => relPath.startsWith(prefix)) ||
    relPath.split("/").includes(SKIPPED_SEGMENT)
  );
}

function runGit(root: string, args: readonly string[]): string {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) {
    throw new Error(`Failed to run git ${args[0] ?? ""}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function listFiles(root: string): string[] {
  const output = runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return [...new Set(output.split("\0").filter((entry) => entry !== ""))]
    .filter((relPath) => !isSkipped(relPath) && NodeFS.existsSync(NodePath.join(root, relPath)))
    .toSorted();
}

function readText(fullPath: string): string | undefined {
  const buffer = NodeFS.readFileSync(fullPath);
  return buffer.includes(0) ? undefined : buffer.toString("utf8");
}

export function findLeftovers(root: string): string[] {
  const leftovers: string[] = [];
  for (const relPath of listFiles(root)) {
    if (LEFTOVER_PATTERN.test(relPath)) {
      leftovers.push(`${relPath} (file name)`);
    }
    const text = readText(NodePath.join(root, relPath));
    if (text === undefined) {
      continue;
    }
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (LEFTOVER_PATTERN.test(line)) {
        leftovers.push(`${relPath}:${String(index + 1)}: ${line.trim()}`);
      }
    }
  }
  return leftovers;
}

function isTracked(root: string, relPath: string): boolean {
  return runGit(root, ["ls-files", "--", relPath]).trim() !== "";
}

function removeEmptyDirectories(root: string, relDir: string): void {
  let current = relDir;
  while (current !== "." && current !== "") {
    const fullPath = NodePath.join(root, current);
    if (!NodeFS.existsSync(fullPath) || NodeFS.readdirSync(fullPath).length > 0) {
      return;
    }
    NodeFS.rmdirSync(fullPath);
    current = NodePath.dirname(current);
  }
}

export function fix(root: string): string[] {
  const changes: string[] = [];
  const files = listFiles(root);
  for (const relPath of files) {
    const fullPath = NodePath.join(root, relPath);
    const text = readText(fullPath);
    if (text === undefined) {
      continue;
    }
    const next = rewrite(text);
    if (next !== text) {
      NodeFS.writeFileSync(fullPath, next);
      changes.push(`edited ${relPath}`);
    }
  }
  for (const relPath of files) {
    const target = rewrite(relPath);
    if (target === relPath) {
      continue;
    }
    if (NodeFS.existsSync(NodePath.join(root, target))) {
      throw new Error(`Cannot move ${relPath}: ${target} already exists.`);
    }
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, target)), { recursive: true });
    if (isTracked(root, relPath)) {
      runGit(root, ["mv", "--", relPath, target]);
    } else {
      NodeFS.renameSync(NodePath.join(root, relPath), NodePath.join(root, target));
    }
    removeEmptyDirectories(root, NodePath.dirname(relPath));
    changes.push(`moved ${relPath} -> ${target}`);
  }
  return changes;
}

function parseArgs(argv: readonly string[]): { check: boolean; root: string } {
  let check = false;
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--root") {
      const value = argv[(index += 1)];
      if (value === undefined) {
        throw new Error("--root needs a directory.");
      }
      root = NodePath.resolve(value);
    } else {
      throw new Error(`Unknown argument ${String(arg)}. Use --check or --root <dir>.`);
    }
  }
  return { check, root };
}

function main(): void {
  const { check, root } = parseArgs(process.argv.slice(2));
  if (check) {
    const leftovers = findLeftovers(root);
    if (leftovers.length > 0) {
      console.error(
        `Found ${String(leftovers.length)} use(s) of the retired product name. Run \`pnpm run rename:fix\`.`,
      );
      for (const leftover of leftovers) {
        console.error(leftover);
      }
      process.exitCode = 1;
    }
    return;
  }
  for (const change of fix(root)) {
    console.log(change);
  }
}

if (import.meta.main) {
  main();
}
