import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const scriptPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "rename-identifiers.ts",
);

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

// Parts are joined so this test file never contains the retired name.
const spellings = [
  { old: ["har", "anytime"].join("-"), next: "one-click-har" },
  { old: ["har", "Anytime"].join(""), next: "oneClickHar" },
  { old: ["Har", "Anytime"].join(""), next: "OneClickHar" },
  { old: ["HAR", "ANYTIME"].join("_"), next: "ONE_CLICK_HAR" },
  { old: ["HAR", "Anytime"].join(" "), next: "One-Click HAR" },
  { old: ["har", "anytime"].join("_"), next: "one_click_har" },
];

function run(root: string, ...args: string[]): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync("node", [scriptPath, ...args, "--root", root], {
    encoding: "utf8",
  });
}

function git(root: string, ...args: string[]): void {
  NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function plantRepo(): string {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rename-identifiers-test-")),
  );
  tempRoots.push(root);
  git(root, "init", "-b", "main");
  for (const [index, { old }] of spellings.entries()) {
    const dir = NodePath.join(root, `pkg-${old}`);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, `file-${String(index)}.txt`), `before ${old} after\n`);
    NodeFS.writeFileSync(NodePath.join(root, `name-${old}.md`), "plain\n");
  }
  NodeFS.mkdirSync(NodePath.join(root, ".audit"));
  NodeFS.writeFileSync(NodePath.join(root, ".audit/decisions.tsv"), `${spellings[0]?.old}\n`);
  git(root, "add", "-A");
  return root;
}

function listTree(root: string): string[] {
  return NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => !entry.startsWith(".git"))
    .toSorted();
}

describe("rename-identifiers", () => {
  it("rewrites every spelling in file bodies and file names, then passes --check", () => {
    const root = plantRepo();

    expect(run(root, "--check").status).toBe(1);
    expect(run(root).status).toBe(0);

    for (const [index, { old, next }] of spellings.entries()) {
      const dir = NodePath.join(root, `pkg-${next}`);
      expect(NodeFS.readFileSync(NodePath.join(dir, `file-${String(index)}.txt`), "utf8")).toBe(
        `before ${next} after\n`,
      );
      expect(NodeFS.existsSync(NodePath.join(root, `name-${next}.md`))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(root, `pkg-${old}`))).toBe(false);
    }
    expect(NodeFS.readFileSync(NodePath.join(root, ".audit/decisions.tsv"), "utf8")).toBe(
      `${spellings[0]?.old}\n`,
    );
    expect(run(root, "--check").status).toBe(0);
  });

  it("changes nothing on a second run", () => {
    const root = plantRepo();
    run(root);
    const treeAfterFirst = listTree(root);
    const bodyAfterFirst = NodeFS.readFileSync(
      NodePath.join(root, "pkg-one-click-har", "file-0.txt"),
      "utf8",
    );

    const second = run(root);

    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
    expect(listTree(root)).toEqual(treeAfterFirst);
    expect(
      NodeFS.readFileSync(NodePath.join(root, "pkg-one-click-har", "file-0.txt"), "utf8"),
    ).toBe(bodyAfterFirst);
  });

  it("fails --check with the file and line of a new occurrence", () => {
    const root = plantRepo();
    run(root);
    const planted = spellings[0]?.old ?? "";
    NodeFS.writeFileSync(
      NodePath.join(root, "src.ts"),
      `const ok = 1;\nconst name = "${planted}";\n`,
    );
    git(root, "add", "-A");

    const result = run(root, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`src.ts:2: const name = "${planted}";`);
  });

  it("fails --check on a file name alone", () => {
    const root = plantRepo();
    run(root);
    NodeFS.writeFileSync(NodePath.join(root, `${spellings[1]?.old}.txt`), "plain\n");
    git(root, "add", "-A");

    const result = run(root, "--check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${spellings[1]?.old}.txt (file name)`);
  });
});
