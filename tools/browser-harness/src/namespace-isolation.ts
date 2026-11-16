import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { readHostProcessTable, readProcessIdentity } from "./process-table.ts";
import type { ProcessTable } from "./signal-policy.ts";

// Real-signal suites live in `*.namespace.test.ts` files. The root Vite config runs them only when
// this variable is set, and each of those files proves its isolation before defining a test.
const NAMESPACE_RUN_ENV = "ONE_CLICK_HAR_NAMESPACE_RUN";
const HOST_SENTINEL_ENV = "ONE_CLICK_HAR_HOST_SENTINEL";
export const LAUNCHER_MARKER = "one-click-har-pid-namespace-launcher";
const LAUNCHER_REFUSED_EXIT = 97;

export type IsolationVerdict =
  | { readonly isolated: true }
  | { readonly isolated: false; readonly reason: string };

type IsolationCase = {
  readonly table: ProcessTable;
  readonly sentinel: { readonly pid: number; readonly startTime: string } | null;
};

const ISOLATION_RULES: readonly ((c: IsolationCase) => string | null)[] = [
  (c) => (c.sentinel === null ? `no host process was named in ${HOST_SENTINEL_ENV}` : null),
  (c) => {
    const init = c.table.get(1);
    return init?.args.includes(LAUNCHER_MARKER) === true
      ? null
      : `PID 1 is not the namespace launcher (${init?.commandLine ?? "absent"})`;
  },
  (c) =>
    c.sentinel !== null && c.table.get(c.sentinel.pid)?.startTime === c.sentinel.startTime
      ? `host process ${String(c.sentinel.pid)} is visible, so this /proc is the host's`
      : null,
  (c) => {
    for (const identity of c.table.values()) {
      if (!descendsFromInit(identity.pid, c.table)) {
        return `process ${String(identity.pid)} (${identity.commandLine}) does not descend from the launcher`;
      }
    }
    return null;
  },
];

// Isolated means: PID 1 is our launcher, a host process we named is invisible, and every visible
// process descends from the launcher.
export function judgeIsolation(input: {
  readonly table: ProcessTable;
  readonly sentinel: string | undefined;
}): IsolationVerdict {
  const isolationCase: IsolationCase = {
    table: input.table,
    sentinel: parseSentinel(input.sentinel),
  };
  for (const rule of ISOLATION_RULES) {
    const reason = rule(isolationCase);
    if (reason !== null) return { isolated: false, reason };
  }
  return { isolated: true };
}

function parseSentinel(
  text: string | undefined,
): { readonly pid: number; readonly startTime: string } | null {
  const match = /^(\d+):(\d+)$/u.exec(text ?? "");
  if (match === null) return null;
  return { pid: Number(match[1]), startTime: match[2] ?? "" };
}

function descendsFromInit(pid: number, table: ProcessTable): boolean {
  let current = pid;
  for (let hops = 0; hops <= table.size; hops += 1) {
    if (current === 1) return true;
    const parent = table.get(current)?.parentPid;
    if (parent === null || parent === undefined) return false;
    current = parent;
  }
  return false;
}

export function requireIsolatedPidNamespace(): void {
  const verdict =
    process.platform === "linux"
      ? judgeIsolation({
          table: readHostProcessTable(),
          sentinel: process.env[HOST_SENTINEL_ENV],
        })
      : { isolated: false as const, reason: `PID namespaces are Linux-only (${process.platform})` };
  if (!verdict.isolated) {
    throw new Error(
      `refusing to run real-signal tests outside an isolated PID namespace: ${verdict.reason}`,
    );
  }
}

export type NamespaceRun =
  | { readonly outcome: "passed"; readonly summary: string }
  | { readonly outcome: "unavailable"; readonly reason: string }
  | { readonly outcome: "failed"; readonly detail: string };

const LAUNCHER_SCRIPT = `[ "$$" = 1 ] || { echo "namespace launcher is PID $$, not 1" >&2; exit ${String(LAUNCHER_REFUSED_EXIT)}; }
"$@"
exit $?`;

function namespaceArgs(command: readonly string[]): string[] {
  return [
    "--user",
    "--map-current-user",
    "--pid",
    "--fork",
    "--mount-proc",
    "--",
    "sh",
    "-c",
    LAUNCHER_SCRIPT,
    LAUNCHER_MARKER,
    ...command,
  ];
}

function namespaceUnavailableReason(): string | null {
  if (process.platform !== "linux") return `PID namespaces are Linux-only (${process.platform})`;
  const probe = NodeChildProcess.spawnSync("unshare", namespaceArgs(["true"]), {
    encoding: "utf8",
  });
  if (probe.error !== undefined) return probe.error.message;
  // The launcher refusing to run means a namespace exists but is not isolated: a failure, not a skip.
  if (probe.status === 0 || probe.status === LAUNCHER_REFUSED_EXIT) return null;
  return `${probe.stderr}${probe.stdout}`.trim() || `unshare exited ${String(probe.status)}`;
}

// Runs every `*.namespace.test.ts` file of one package inside a fresh PID and user namespace,
// under a 1-byte core limit and a private TMPDIR so lease files never meet the host's.
export async function runNamespacedSuites(packageDir: string): Promise<NamespaceRun> {
  const unavailable = namespaceUnavailableReason();
  if (unavailable !== null) return { outcome: "unavailable", reason: unavailable };
  const repoRoot = findRepoRoot(packageDir);
  const sentinel = readProcessIdentity(process.pid);
  if (sentinel === undefined) throw new Error("could not read this process's start time");
  const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "och-ns-tmp-"));
  try {
    const command = [
      "prlimit",
      "--core=1:1",
      "--",
      NodePath.join(repoRoot, "node_modules", ".bin", "vp"),
      "test",
      "run",
      "--config",
      NodePath.join(repoRoot, "vite.config.ts"),
      "--dir",
      packageDir,
    ];
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn("unshare", namespaceArgs(command), {
        cwd: packageDir,
        env: {
          ...process.env,
          [NAMESPACE_RUN_ENV]: "1",
          [HOST_SENTINEL_ENV]: `${String(process.pid)}:${sentinel.startTime}`,
          TMPDIR: tmpdir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.on("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    return result.code === 0
      ? {
          outcome: "passed",
          summary: result.output
            .replaceAll(/\u001b\[[0-9;]*m/gu, "")
            .split("\n")
            .filter((line) => /^\s*(Test Files|Tests)\s/u.test(line))
            .join("\n"),
        }
      : { outcome: "failed", detail: `exit ${String(result.code)}\n${result.output.trim()}` };
  } finally {
    await NodeFSP.rm(tmpdir, { recursive: true, force: true });
  }
}

function findRepoRoot(startDir: string): string {
  let current = NodePath.resolve(startDir);
  while (!NodeFS.existsSync(NodePath.join(current, "pnpm-workspace.yaml"))) {
    const parent = NodePath.dirname(current);
    if (parent === current) throw new Error(`could not locate repo root from ${startDir}`);
    current = parent;
  }
  return current;
}
