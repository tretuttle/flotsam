import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export type ProcessSnapshot = {
  readonly parentPid: number;
  readonly workingSetBytes: number;
  readonly cpuTimeMs: number;
};

export type ProcessPlatformName = "win32" | "linux" | "darwin";

type ProcessPlatform = {
  // POSIX children become process group leaders, so one signal to the group reaches every
  // descendant that did not leave the group, even after the leader died.
  readonly groupLeader: boolean;
  readonly killTree: (rootPid: number) => void;
  readonly treeAlive: (rootPid: number) => boolean;
  readonly snapshot: (pid: number) => ProcessSnapshot;
  readonly parseSnapshot: (text: string, pid: number) => ProcessSnapshot;
};

export const PROCESS_PLATFORMS: Readonly<Record<ProcessPlatformName, ProcessPlatform>> = {
  win32: {
    groupLeader: false,
    killTree: (rootPid) => {
      const result = NodeChildProcess.spawnSync(
        "taskkill.exe",
        ["/PID", String(rootPid), "/T", "/F"],
        { encoding: "utf8", windowsHide: true },
      );
      if (result.status === 0) return;
      const detail = `${result.stdout}${result.stderr}`;
      if (result.status === 128 || /not found/iu.test(detail)) return;
      throw new Error(`taskkill ${String(rootPid)} failed: ${detail.trim()}`);
    },
    treeAlive: (rootPid) => pidAlive(rootPid),
    snapshot: (pid) =>
      PROCESS_PLATFORMS.win32.parseSnapshot(
        run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"; if ($null -eq $p) { exit 3 }; "$($p.ParentProcessId) $($p.WorkingSetSize) $($p.UserModeTime + $p.KernelModeTime)"`,
        ]),
        pid,
      ),
    parseSnapshot: (text, pid) => {
      const [parent, workingSet, hundredNanoseconds] = threeNumbers(text, pid);
      return {
        parentPid: parent,
        workingSetBytes: workingSet,
        cpuTimeMs: hundredNanoseconds / 1e4,
      };
    },
  },
  linux: {
    groupLeader: true,
    killTree: killGroup,
    treeAlive: groupAlive,
    snapshot: (pid) =>
      PROCESS_PLATFORMS.linux.parseSnapshot(
        NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8"),
        pid,
      ),
    parseSnapshot: (text, pid) => {
      // The command name is wrapped in parentheses and may itself hold spaces and ")".
      const close = text.lastIndexOf(")");
      if (close === -1) throw new Error(`/proc/${String(pid)}/stat has no command name`);
      const fields = text
        .slice(close + 2)
        .trim()
        .split(" ");
      const field = (number: number): number => {
        const value = Number(fields[number - 3]);
        if (!Number.isFinite(value))
          throw new Error(`/proc/${String(pid)}/stat field ${String(number)}`);
        return value;
      };
      const { pageBytes, ticksPerSecond } = linuxUnits();
      return {
        parentPid: field(4),
        workingSetBytes: field(24) * pageBytes,
        cpuTimeMs: ((field(14) + field(15)) * 1000) / ticksPerSecond,
      };
    },
  },
  darwin: {
    groupLeader: true,
    killTree: killGroup,
    treeAlive: groupAlive,
    snapshot: (pid) =>
      PROCESS_PLATFORMS.darwin.parseSnapshot(
        run("ps", ["-o", "ppid=,rss=,time=", "-p", String(pid)]),
        pid,
      ),
    parseSnapshot: (text, pid) => {
      const [parent, rssKilobytes, time] = text.trim().split(/\s+/u);
      return {
        parentPid: positive(Number(parent), "parent", pid),
        workingSetBytes: positive(Number(rssKilobytes), "rss", pid) * 1024,
        cpuTimeMs: cpuTimeText(time ?? "", pid),
      };
    },
  },
};

export function currentPlatformName(platform: string = process.platform): ProcessPlatformName {
  if (platform === "win32" || platform === "linux" || platform === "darwin") return platform;
  throw new Error(`unsupported platform ${platform}; supported: win32, linux, darwin`);
}

function processPlatform(): ProcessPlatform {
  return PROCESS_PLATFORMS[currentPlatformName()];
}

export type OwnedChild = {
  readonly child: NodeChildProcess.ChildProcess;
  readonly pid: number;
};

export function spawnOwned(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdio?: NodeChildProcess.StdioOptions;
  } = {},
): OwnedChild {
  const child = NodeChildProcess.spawn(command, args, {
    detached: processPlatform().groupLeader,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  if (child.pid === undefined) throw new Error(`could not start ${command}`);
  return { child, pid: child.pid };
}

function killProcessTree(rootPid: number): void {
  assertPid(rootPid);
  processPlatform().killTree(rootPid);
}

export function readProcessSnapshot(pid: number): ProcessSnapshot {
  assertPid(pid);
  return processPlatform().snapshot(pid);
}

const REAP_MS = 5_000;

export async function killOwnedTree(rootPid: number, memberPids: readonly number[]): Promise<void> {
  const platform = processPlatform();
  const alive = (): number[] =>
    [rootPid, ...memberPids].filter((pid) =>
      pid === rootPid ? platform.treeAlive(pid) : pidAlive(pid),
    );
  killProcessTree(rootPid);
  const deadline = Date.now() + REAP_MS;
  while (alive().length > 0 && Date.now() < deadline) await delay(50);
  if (alive().length > 0) {
    killProcessTree(rootPid);
    await delay(50);
  }
  const left = alive();
  if (left.length > 0) throw new Error(`owned process still running: ${left.join(", ")}`);
}

const PROFILE_REMOVAL_MS = 15_000;
const REMOVAL_SCRIPT =
  'require("node:fs").rmSync(process.env.PROFILE_DIR,{recursive:true,force:true,maxRetries:50,retryDelay:100})';

export async function removeDirectoryBounded(directory: string): Promise<void> {
  const worker = spawnOwned(process.execPath, ["-e", REMOVAL_SCRIPT], {
    env: { ...process.env, PROFILE_DIR: directory },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  worker.child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000);
  });
  const exit = await waitForExit(worker.child, PROFILE_REMOVAL_MS);
  if (exit === "timeout") {
    await killOwnedTree(worker.pid, []);
    throw new Error(
      `profile removal timed out after ${String(PROFILE_REMOVAL_MS)} ms at ${directory}`,
    );
  }
  if (exit !== 0) {
    throw new Error(`profile removal exited ${String(exit)} at ${directory}\n${stderr.trim()}`);
  }
  if (NodeFS.existsSync(directory)) throw new Error(`profile still present at ${directory}`);
}

export function pidAlive(pid: number): boolean {
  assertPid(pid);
  return signalReaches(pid);
}

function groupAlive(rootPid: number): boolean {
  return signalReaches(-rootPid);
}

function killGroup(rootPid: number): void {
  try {
    process.kill(-rootPid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

function signalReaches(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

let cachedLinuxUnits: { pageBytes: number; ticksPerSecond: number } | null = null;

function linuxUnits(): { pageBytes: number; ticksPerSecond: number } {
  cachedLinuxUnits ??= {
    pageBytes: positive(Number(run("getconf", ["PAGESIZE"]).trim()), "PAGESIZE", process.pid),
    ticksPerSecond: positive(Number(run("getconf", ["CLK_TCK"]).trim()), "CLK_TCK", process.pid),
  };
  return cachedLinuxUnits;
}

function cpuTimeText(text: string, pid: number): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(text);
  if (match === null) throw new Error(`cpu time for ${String(pid)} was ${text}`);
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total * 1000;
}

function threeNumbers(text: string, pid: number): readonly [number, number, number] {
  const [first, second, third, ...rest] = text.trim().split(/\s+/u).map(Number);
  const values = [first, second, third].filter(
    (value): value is number => value !== undefined && Number.isFinite(value) && value >= 0,
  );
  const [a, b, c] = values;
  if (a === undefined || b === undefined || c === undefined || rest.length > 0) {
    throw new Error(`process snapshot for ${String(pid)} was ${text.trim()}`);
  }
  return [a, b, c];
}

function positive(value: number, label: string, pid: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} for ${String(pid)} was ${String(value)}`);
  }
  return value;
}

function run(command: string, args: readonly string[]): string {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim();
    throw new Error(`${command} exited ${String(result.status)}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${String(pid)}`);
}

function waitForExit(
  child: NodeChildProcess.ChildProcess,
  timeoutMs: number,
): Promise<number | "timeout"> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return null;
}
