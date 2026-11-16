import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const AGENT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
type AgentFile = (typeof AGENT_FILES)[number];

const BASE_REF = "origin/main";
const BASE_COMMIT_REF = "refs/remotes/origin/main^{commit}";
const INCREASE_LABEL = "agent-context-increase";

function runGit(cwd: string, args: readonly string[], input?: string): string {
  const command = args[0] ?? "";
  const result = NodeChildProcess.spawnSync(
    "git",
    args,
    input !== undefined ? { cwd, input, encoding: "utf8" } : { cwd, encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(`Failed to run git ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${String(result.status)}`;
    throw new Error(`git ${command} failed: ${detail}`);
  }
  return result.stdout;
}

function readBase(repoRoot: string): { shortSha: string; sizes: Record<AgentFile, number> } {
  const query = [BASE_COMMIT_REF, ...AGENT_FILES.map((file) => `${BASE_COMMIT_REF}:${file}`)];
  const output = runGit(
    repoRoot,
    ["cat-file", "--batch-check=%(objecttype) %(objectsize) %(objectname)"],
    `${query.join("\n")}\n`,
  );
  const lines = output.trimEnd().split(/\r?\n/u);
  const commitMatch = /^commit \d+ ([0-9a-f]+)$/u.exec(lines[0] ?? "");
  if (!commitMatch?.[1]) {
    throw new Error(`Cannot read base ref ${BASE_REF}. Run \`git fetch origin main\` and retry.`);
  }
  const shortSha = commitMatch[1].slice(0, 7);
  const sizes: Record<AgentFile, number> = { "AGENTS.md": 0, "CLAUDE.md": 0 };

  for (const [index, file] of AGENT_FILES.entries()) {
    const line = lines[index + 1] ?? "";
    if (line.endsWith(" missing")) {
      continue;
    }
    const blobMatch = /^blob (\d+) [0-9a-f]+$/u.exec(line);
    if (!blobMatch?.[1]) {
      throw new Error(`Expected ${file} on ${BASE_REF} (${shortSha}) to be a blob, got "${line}".`);
    }
    sizes[file] = Number(blobMatch[1]);
  }

  return { shortSha, sizes };
}

function readWorkingFile(
  repoRoot: string,
  file: AgentFile,
): { bytes: number; hasCarriageReturn: boolean } {
  const fullPath = NodePath.join(repoRoot, file);
  if (!NodeFS.lstatSync(fullPath).isFile()) {
    throw new Error(`Expected ${file} to be a regular file.`);
  }
  const content = NodeFS.readFileSync(fullPath);
  return {
    bytes: content.byteLength,
    hasCarriageReturn: content.includes(0x0d),
  };
}

function hasIncreaseLabel(env: NodeJS.ProcessEnv): boolean {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "pull_request") {
    return false;
  }
  const eventPath = env.GITHUB_EVENT_PATH ?? "";
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(eventPath, "utf8"));
    const labels =
      typeof parsed === "object" &&
      parsed !== null &&
      "pull_request" in parsed &&
      typeof parsed.pull_request === "object" &&
      parsed.pull_request !== null &&
      "labels" in parsed.pull_request
        ? parsed.pull_request.labels
        : undefined;
    if (!Array.isArray(labels)) {
      throw new Error("missing pull_request.labels array");
    }
    return labels.some(
      (label) =>
        typeof label === "object" &&
        label !== null &&
        "name" in label &&
        label.name === INCREASE_LABEL,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read GITHUB_EVENT_PATH (${eventPath}): ${message}`, { cause: error });
  }
}

function runCli(): number {
  try {
    const repoRoot = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const base = readBase(repoRoot);
    const allowed = hasIncreaseLabel(process.env);
    const deltas: Array<{
      file: AgentFile;
      before: number;
      after: number;
      hasCarriageReturn: boolean;
    }> = [];

    for (const file of AGENT_FILES) {
      const before = base.sizes[file];
      const working = readWorkingFile(repoRoot, file);
      if (working.bytes > before) {
        deltas.push({
          file,
          before,
          after: working.bytes,
          hasCarriageReturn: working.hasCarriageReturn,
        });
      }
    }

    if (deltas.length === 0) {
      process.stdout.write(
        `Agent instructions are not larger than on ${BASE_REF} (${base.shortSha}).\n`,
      );
      return 0;
    }

    const summaryLines = [
      `Agent instructions grew compared with ${BASE_REF} (${base.shortSha}):`,
      ...deltas.map(
        (delta) =>
          `  ${delta.file}: ${String(delta.before)} -> ${String(delta.after)} bytes (+${String(delta.after - delta.before)})`,
      ),
    ];

    if (allowed) {
      process.stdout.write(
        [...summaryLines, `Allowed by the ${INCREASE_LABEL} label.`].join("\n") + "\n",
      );
      return 0;
    }

    const crlfLines = deltas
      .filter((delta) => delta.hasCarriageReturn)
      .map(
        (delta) =>
          `${delta.file} contains carriage return (\\r) bytes. Convert its line endings to LF and rerun.`,
      );

    process.stderr.write(
      [
        ...summaryLines,
        ...crlfLines,
        "If main has moved, run `git fetch origin main` (and update your branch if behind) and rerun.",
        "Rewrite or remove existing text instead of adding to it.",
        `If a maintainer asked for this growth, add the \`${INCREASE_LABEL}\` label (\`gh pr create --label ${INCREASE_LABEL}\` or \`gh pr edit <pr> --add-label ${INCREASE_LABEL}\`). CI \`Check\` then passes, while \`pnpm run check\` keeps failing on a machine by design, so push once earlier checks pass.`,
      ].join("\n") + "\n",
    );
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

process.exitCode = runCli();
