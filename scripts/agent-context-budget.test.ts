import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const scriptPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "agent-context-budget.ts",
);

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

interface FixtureRepo {
  root: string;
  dir: string;
  baseShortSha: string;
  eventFilePath: (name: string) => string;
  runGit: (args: string[], cwd?: string) => string;
  commitFiles: (files: Record<string, string | null>, message: string) => string;
  writeWorktreeFile: (relPath: string, content: Buffer | string | null) => void;
}

function createCleanEnv(
  globalConfigFile: string,
  extraEnv: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("GIT_") ||
      key.startsWith("GITHUB_") ||
      key === "CI" ||
      key === "ALLOW_INCREASE"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = globalConfigFile;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (key.toUpperCase() === "PATH") {
      for (const existingKey of Object.keys(env)) {
        if (existingKey.toUpperCase() === "PATH") {
          delete env[existingKey];
        }
      }
    }
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function createFixtureRepo(options: { withOriginMain?: boolean } = {}): FixtureRepo {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "flotsam-budget-test-")),
  );
  tempRoots.push(root);

  const dir = NodePath.join(root, "repo");
  const globalConfigFile = NodePath.join(root, "gitconfig");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(globalConfigFile, "", "utf8");

  const runGit = (args: string[], cwd = dir): string => {
    const result = NodeChildProcess.spawnSync(
      "git",
      [
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd,
        env: createCleanEnv(globalConfigFile),
        encoding: "utf8",
      },
    );
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${String(result.status)}): ${result.stderr}`);
    }
    return result.stdout.trim();
  };

  runGit(["init", "-b", "main"]);

  const writeWorktreeFile = (relPath: string, content: Buffer | string | null): void => {
    const fullPath = NodePath.join(dir, relPath);
    if (content === null) {
      NodeFS.rmSync(fullPath, { force: true });
    } else {
      NodeFS.mkdirSync(NodePath.dirname(fullPath), { recursive: true });
      NodeFS.writeFileSync(fullPath, content);
    }
  };

  const commitFiles = (files: Record<string, string | null>, message: string): string => {
    for (const [relPath, content] of Object.entries(files)) {
      writeWorktreeFile(relPath, content);
    }
    runGit(["add", "-A"]);
    runGit(["commit", "--allow-empty", "-m", message]);
    return runGit(["rev-parse", "HEAD"]);
  };

  let baseSha: string;
  if (options.withOriginMain !== false) {
    baseSha = commitFiles({ "AGENTS.md": "base agents\n", "CLAUDE.md": "@AGENTS.md\n" }, "base");
    runGit(["update-ref", "refs/remotes/origin/main", baseSha]);
  } else {
    baseSha = commitFiles({ "README.md": "init\n" }, "init");
  }

  return {
    root,
    dir,
    baseShortSha: baseSha.slice(0, 7),
    eventFilePath: (name: string) => NodePath.join(root, name),
    runGit,
    commitFiles,
    writeWorktreeFile,
  };
}

function runBudgetCli(
  repo: FixtureRepo,
  extraEnv: Record<string, string | undefined> = {},
  cwd = repo.dir,
): { status: number | null; stdout: string; stderr: string } {
  const globalConfigFile = NodePath.join(repo.root, "gitconfig");
  const result = NodeChildProcess.spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: createCleanEnv(globalConfigFile, extraEnv),
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function writeEventFile(repo: FixtureRepo, name: string, payload: unknown): string {
  const eventFile = repo.eventFilePath(name);
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  NodeFS.writeFileSync(eventFile, content, "utf8");
  return eventFile;
}

describe("agent-context-budget CLI", () => {
  it.each<{
    name: string;
    setupCwd: (repo: FixtureRepo) => string;
  }>([
    {
      name: "from repository root when files are unchanged",
      setupCwd: (repo) => repo.dir,
    },
    {
      name: "from a subdirectory when files are unchanged",
      setupCwd: (repo) => {
        const docsDir = NodePath.join(repo.dir, "docs");
        NodeFS.mkdirSync(docsDir, { recursive: true });
        return docsDir;
      },
    },
  ])("passes with exit 0 ($name)", ({ setupCwd }) => {
    const repo = createFixtureRepo();
    const res = runBudgetCli(repo, {}, setupCwd(repo));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`origin/main (${repo.baseShortSha})`);
  });

  it.each<{
    name: string;
    withOriginMain?: boolean;
    setup: (repo: FixtureRepo) => void;
    expectedStderr: string[];
    notExpectedStderr?: string[];
  }>([
    {
      name: "AGENTS.md grows by 1 byte in working tree",
      setup: (repo) => {
        repo.writeWorktreeFile("AGENTS.md", "base agents\n+");
      },
      expectedStderr: [
        "AGENTS.md: 12 -> 13 bytes (+1)",
        "git fetch origin main",
        "agent-context-increase",
        "Check",
      ],
      notExpectedStderr: ["carriage return"],
    },
    {
      name: "CLAUDE.md grows in a commit",
      setup: (repo) => {
        repo.commitFiles({ "CLAUDE.md": "@AGENTS.md\nextra\n" }, "grow claude");
      },
      expectedStderr: ["CLAUDE.md: 11 -> 17 bytes (+6)"],
      notExpectedStderr: ["carriage return"],
    },
    {
      name: "one file shrinks by more than the other grows",
      setup: (repo) => {
        repo.writeWorktreeFile("AGENTS.md", "a\n");
        repo.writeWorktreeFile("CLAUDE.md", "@AGENTS.md\n+");
      },
      expectedStderr: ["CLAUDE.md: 11 -> 12 bytes (+1)"],
      notExpectedStderr: ["AGENTS.md:"],
    },
    {
      name: "UTF-8 multi-byte characters count bytes not UTF-16 units",
      setup: (repo) => {
        repo.writeWorktreeFile("AGENTS.md", "012345678\n😀");
      },
      expectedStderr: ["AGENTS.md: 12 -> 14 bytes (+2)"],
    },
    {
      name: ".gitattributes ident is ignored for working-tree byte count",
      setup: (repo) => {
        repo.writeWorktreeFile(".gitattributes", "AGENTS.md ident\n");
        repo.writeWorktreeFile("AGENTS.md", `$Id: ${"x".repeat(100)} $\n`);
      },
      expectedStderr: ["AGENTS.md: 12 -> 108 bytes (+96)"],
    },
    {
      name: "absent files on base commit count as 0 bytes",
      withOriginMain: false,
      setup: (repo) => {
        repo.runGit(["update-ref", "refs/remotes/origin/main", "HEAD"]);
        repo.writeWorktreeFile("AGENTS.md", "new\n");
        repo.writeWorktreeFile("CLAUDE.md", "@AGENTS.md\n");
      },
      expectedStderr: ["AGENTS.md: 0 -> 4 bytes (+4)", "CLAUDE.md: 0 -> 11 bytes (+11)"],
    },
    {
      name: "working tree CRLF reports carriage return hint",
      setup: (repo) => {
        repo.writeWorktreeFile("AGENTS.md", "base agents\r\n");
      },
      expectedStderr: ["AGENTS.md: 12 -> 13 bytes (+1)", "carriage return (\\r) bytes"],
    },
  ])(
    "fails with exit 1 on unapproved growth: $name",
    ({ withOriginMain, setup, expectedStderr, notExpectedStderr }) => {
      const repo = createFixtureRepo(withOriginMain === undefined ? undefined : { withOriginMain });
      setup(repo);
      const res = runBudgetCli(repo);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(repo.baseShortSha);
      for (const fragment of expectedStderr) {
        expect(res.stderr).toContain(fragment);
      }
      for (const fragment of notExpectedStderr ?? []) {
        expect(res.stderr).not.toContain(fragment);
      }
    },
  );

  it("allows growth in CI pull_request with agent-context-increase label", () => {
    const repo = createFixtureRepo();
    repo.writeWorktreeFile("AGENTS.md", "base agents\nmore text\n");
    const eventFile = writeEventFile(repo, "pr-labelled.json", {
      pull_request: {
        labels: [{ name: "bug" }, { name: "agent-context-increase" }],
      },
    });

    const res = runBudgetCli(repo, {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventFile,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Allowed by the agent-context-increase label.");
  });

  it.each<{
    name: string;
    labels: Array<{ name: string }>;
    env: Record<string, string | undefined>;
  }>([
    {
      name: "CI pull_request with other label",
      labels: [{ name: "enhancement" }],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
      },
    },
    {
      name: "CI pull_request with prefix-matching label",
      labels: [{ name: "agent-context-increase-requested" }],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
      },
    },
    {
      name: "CI pull_request_target with agent-context-increase label",
      labels: [{ name: "agent-context-increase" }],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request_target",
      },
    },
    {
      name: "CI push event with agent-context-increase label",
      labels: [{ name: "agent-context-increase" }],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
      },
    },
    {
      name: "GITHUB_EVENT_NAME=pull_request outside GitHub Actions",
      labels: [{ name: "agent-context-increase" }],
      env: {
        GITHUB_EVENT_NAME: "pull_request",
      },
    },
    {
      name: "ALLOW_INCREASE=true locally with labelled payload",
      labels: [{ name: "agent-context-increase" }],
      env: { ALLOW_INCREASE: "true" },
    },
    {
      name: "CI=true locally with labelled payload",
      labels: [{ name: "agent-context-increase" }],
      env: { CI: "true" },
    },
  ])("denies growth: $name", ({ labels, env }) => {
    const repo = createFixtureRepo();
    repo.writeWorktreeFile("AGENTS.md", "base agents\nmore text\n");
    const eventFile = writeEventFile(repo, "pr-event.json", {
      pull_request: { labels },
    });

    const res = runBudgetCli(repo, {
      GITHUB_EVENT_PATH: eventFile,
      ...env,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("agent-context-increase");
  });

  it.each<{
    name: string;
    withOriginMain?: boolean;
    setup: (repo: FixtureRepo) => { env?: Record<string, string | undefined>; cwd?: string };
    expectedStderr: string;
  }>([
    {
      name: "empty PATH fails to start git",
      setup: () => ({ env: { PATH: "" } }),
      expectedStderr: "Failed to run git",
    },
    {
      name: "cwd outside a git repo",
      setup: (repo) => {
        const outsideDir = NodePath.join(repo.root, "outside");
        NodeFS.mkdirSync(outsideDir, { recursive: true });
        return {
          env: { GIT_CEILING_DIRECTORIES: repo.root },
          cwd: outsideDir,
        };
      },
      expectedStderr: "git rev-parse failed",
    },
    {
      name: "missing refs/remotes/origin/main",
      withOriginMain: false,
      setup: () => ({}),
      expectedStderr: "git fetch origin main",
    },
    {
      name: "AGENTS.md on origin/main is a tree instead of a blob",
      withOriginMain: false,
      setup: (repo) => {
        const baseSha = repo.commitFiles(
          { "AGENTS.md/nested.md": "nested\n", "CLAUDE.md": "@AGENTS.md\n" },
          "tree agents",
        );
        repo.runGit(["update-ref", "refs/remotes/origin/main", baseSha]);
        NodeFS.rmSync(NodePath.join(repo.dir, "AGENTS.md"), { recursive: true, force: true });
        repo.writeWorktreeFile("AGENTS.md", "base agents\n");
        return {};
      },
      expectedStderr: "blob",
    },
    {
      name: "working-tree CLAUDE.md missing",
      setup: (repo) => {
        repo.writeWorktreeFile("CLAUDE.md", null);
        return {};
      },
      expectedStderr: "CLAUDE.md",
    },
    {
      name: "working-tree AGENTS.md replaced by a directory",
      setup: (repo) => {
        repo.writeWorktreeFile("AGENTS.md", null);
        NodeFS.mkdirSync(NodePath.join(repo.dir, "AGENTS.md"));
        return {};
      },
      expectedStderr: "regular file",
    },
    {
      name: "CI pull_request with GITHUB_EVENT_PATH unset",
      setup: () => ({
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
        },
      }),
      expectedStderr: "GITHUB_EVENT_PATH",
    },
    {
      name: "CI pull_request with GITHUB_EVENT_PATH pointing to missing file",
      setup: (repo) => ({
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: repo.eventFilePath("nonexistent.json"),
        },
      }),
      expectedStderr: "GITHUB_EVENT_PATH",
    },
    {
      name: "CI pull_request with GITHUB_EVENT_PATH malformed JSON",
      setup: (repo) => ({
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: writeEventFile(repo, "malformed.json", "{not json"),
        },
      }),
      expectedStderr: "GITHUB_EVENT_PATH",
    },
    {
      name: "CI pull_request with GITHUB_EVENT_PATH empty object",
      setup: (repo) => ({
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: writeEventFile(repo, "empty-obj.json", {}),
        },
      }),
      expectedStderr: "GITHUB_EVENT_PATH",
    },
    {
      name: "CI pull_request with GITHUB_EVENT_PATH non-array labels",
      setup: (repo) => ({
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: writeEventFile(repo, "bad-labels.json", {
            pull_request: { labels: "x" },
          }),
        },
      }),
      expectedStderr: "GITHUB_EVENT_PATH",
    },
  ])("fails closed with exit 2: $name", ({ withOriginMain, setup, expectedStderr }) => {
    const repo = createFixtureRepo(withOriginMain === undefined ? undefined : { withOriginMain });
    const { env, cwd } = setup(repo);
    const res = runBudgetCli(repo, env, cwd);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(expectedStderr);
  });

  it.skipIf(process.platform === "win32")(
    "fails closed with exit 2 when working-tree AGENTS.md is a symlink",
    () => {
      const repo = createFixtureRepo();
      repo.writeWorktreeFile("docs/big.md", "big\n".repeat(1000));
      repo.writeWorktreeFile("AGENTS.md", null);
      NodeFS.symlinkSync("docs/big.md", NodePath.join(repo.dir, "AGENTS.md"));
      const res = runBudgetCli(repo);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("regular file");
    },
  );
});
