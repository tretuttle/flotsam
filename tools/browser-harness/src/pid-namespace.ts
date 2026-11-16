import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";

const PID_NAMESPACE_ENV = "ONE_CLICK_HAR_IN_PID_NS";

type PidNamespaceProbe = { readonly ok: true } | { readonly ok: false; readonly reason: string };

let cachedProbe: PidNamespaceProbe | null = null;

function probePidNamespace(): PidNamespaceProbe {
  if (cachedProbe !== null) return cachedProbe;
  if (process.platform !== "linux") {
    cachedProbe = { ok: false, reason: `unshare is Linux-only (platform=${process.platform})` };
    return cachedProbe;
  }
  const result = NodeChildProcess.spawnSync(
    "unshare",
    ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--", "true"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) {
    cachedProbe = { ok: false, reason: result.error.message };
  } else if (result.status !== 0) {
    const detail = `${result.stderr}${result.stdout}`.trim();
    cachedProbe = {
      ok: false,
      reason: detail || `unshare exited with code ${String(result.status ?? 1)}`,
    };
  } else {
    cachedProbe = { ok: true };
  }
  return cachedProbe;
}

export function registerPidNamespaceSuite(
  testFilePath: string,
  suiteName: string,
  defineTests: () => void,
): void {
  if (process.platform !== "linux" || process.env[PID_NAMESPACE_ENV] === "1") {
    describe(suiteName, defineTests);
    return;
  }
  describe(suiteName, () => {
    it("runs real-signal tests inside an isolated PID and user namespace", async (ctx) => {
      const probe = probePidNamespace();
      if (!probe.ok) {
        const message = `skipping "${suiteName}" outside isolated namespace: ${probe.reason}`;
        process.stderr.write(`${message}\n`);
        ctx.skip(message);
        return;
      }
      await runVitestSuiteInNamespace(testFilePath, suiteName);
    });
  });
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function findRepoRoot(startDir: string): string {
  let current = NodePath.resolve(startDir);
  while (true) {
    if (NodeFS.existsSync(NodePath.join(current, "vite.config.ts"))) return current;
    const parent = NodePath.dirname(current);
    if (parent === current) {
      throw new Error(`could not locate repo root from ${startDir}`);
    }
    current = parent;
  }
}

async function runVitestSuiteInNamespace(testFilePath: string, suiteName: string): Promise<void> {
  const repoRoot = findRepoRoot(NodePath.dirname(testFilePath));
  const vpBin = NodePath.join(repoRoot, "node_modules", ".bin", "vp");
  const viteConfig = NodePath.join(repoRoot, "vite.config.ts");
  const vitestArgs = [
    vpBin,
    "test",
    "run",
    "--config",
    viteConfig,
    "--no-cache",
    "--no-fsModuleCache",
    testFilePath,
    "-t",
    `^${escapeRegExp(suiteName)} >`,
  ];
  const runnerScript =
    'if command -v prlimit >/dev/null 2>&1; then prlimit --core=1:1 -- "$@"; else "$@"; fi';
  const unshareArgs = [
    "--user",
    "--map-root-user",
    "--pid",
    "--fork",
    "--mount-proc",
    "--",
    "sh",
    "-c",
    runnerScript,
    "_",
    ...vitestArgs,
  ];
  // Give each isolated namespace its own TMPDIR so concurrent namespaces never collide on lease files.
  const nsTmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "och-ns-tmp-"));

  try {
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn("unshare", unshareArgs, {
        cwd: repoRoot,
        env: { ...process.env, [PID_NAMESPACE_ENV]: "1", TMPDIR: nsTmpDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `isolated namespace test "${suiteName}" failed (${String(code ?? signal ?? 1)})\n${output.trim()}`,
          ),
        );
      });
    });
  } finally {
    await NodeFSP.rm(nsTmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
