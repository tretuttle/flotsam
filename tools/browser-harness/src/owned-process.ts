import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export function killProcessTree(pid: number): void {
  assertPid(pid);
  if (process.platform === "win32") {
    const result = NodeChildProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) return;
    const detail = `${result.stdout}${result.stderr}`;
    if (result.status === 128 || /not found/iu.test(detail)) return;
    throw new Error(`taskkill ${String(pid)} failed: ${detail.trim()}`);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

export function readWorkingSetBytes(pid: number): number {
  assertPid(pid);
  if (process.platform === "win32") {
    const text = powershell(`(Get-Process -Id ${String(pid)} -ErrorAction Stop).WorkingSet64`);
    const bytes = Number(text.trim());
    if (!Number.isFinite(bytes) || bytes <= 0) {
      throw new Error(`working set for ${String(pid)} was ${text.trim()}`);
    }
    return bytes;
  }
  const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(
    NodeFS.readFileSync(`/proc/${String(pid)}/status`, "utf8"),
  );
  const kilobytes = match === null ? undefined : Number(match[1]);
  if (kilobytes === undefined || !Number.isFinite(kilobytes) || kilobytes <= 0) {
    throw new Error(`working set for ${String(pid)} was missing`);
  }
  return kilobytes * 1024;
}

export function readProcessorTimeMs(pid: number): number {
  assertPid(pid);
  if (process.platform === "win32") {
    const text = powershell(
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"; if ($null -eq $p) { exit 1 }; $p.UserModeTime + $p.KernelModeTime`,
    );
    const hundredNanoseconds = Number(text.trim());
    if (!Number.isFinite(hundredNanoseconds) || hundredNanoseconds < 0) {
      throw new Error(`processor time for ${String(pid)} was ${text.trim()}`);
    }
    return hundredNanoseconds / 10_000;
  }
  const fields = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8").split(" ");
  const utime = Number(fields[13]);
  const stime = Number(fields[14]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
    throw new Error(`processor time for ${String(pid)} was missing`);
  }
  return ((utime + stime) * 1000) / clockTicksPerSecond();
}

export function parentPidOf(pid: number): number {
  assertPid(pid);
  if (process.platform === "win32") {
    const text = powershell(
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").ParentProcessId`,
    );
    const parent = Number(text.trim());
    if (!Number.isInteger(parent) || parent <= 0) {
      throw new Error(`parent of ${String(pid)} was ${text.trim()}`);
    }
    return parent;
  }
  const match = /^PPid:\s+(\d+)$/mu.exec(
    NodeFS.readFileSync(`/proc/${String(pid)}/status`, "utf8"),
  );
  const parent = match === null ? undefined : Number(match[1]);
  if (parent === undefined || !Number.isInteger(parent) || parent <= 0) {
    throw new Error(`parent of ${String(pid)} was missing`);
  }
  return parent;
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${String(pid)}`);
}

function powershell(command: string): string {
  const result = NodeChildProcess.spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim();
    throw new Error(detail || "powershell failed");
  }
  return result.stdout;
}

function clockTicksPerSecond(): number {
  const result = NodeChildProcess.spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const ticks = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(ticks) || ticks <= 0) return 100;
  return ticks;
}

const REAP_MS = 5_000;
const PROFILE_REMOVAL_MS = 15_000;
const REMOVAL_SCRIPT =
  'require("node:fs").rmSync(process.env.PROFILE_DIR,{recursive:true,force:true,maxRetries:50,retryDelay:100})';

function isProcessAlive(pid: number): boolean {
  assertPid(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

async function killOwnedPids(pids: readonly number[]): Promise<void> {
  const unique = [...new Set(pids)];
  for (const pid of unique) killProcessTree(pid);
  let alive = unique.filter((pid) => isProcessAlive(pid));
  const deadline = Date.now() + REAP_MS;
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(50);
    alive = unique.filter((pid) => isProcessAlive(pid));
  }
  if (alive.length === 0) return;
  for (const pid of alive) killProcessTree(pid);
  await delay(50);
  alive = unique.filter((pid) => isProcessAlive(pid));
  if (alive.length > 0) {
    throw new Error(`owned process still running: ${alive.join(", ")}`);
  }
}

export async function releaseOwnedProfile(
  pids: readonly number[],
  directory: string,
): Promise<void> {
  await killOwnedPids(pids);
  await removeDirectoryBounded(directory);
}

async function removeDirectoryBounded(directory: string): Promise<void> {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", REMOVAL_SCRIPT], {
    env: { ...process.env, PROFILE_DIR: directory },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000);
  });
  const exitCode = await waitForChild(child, PROFILE_REMOVAL_MS);
  if (exitCode === "timeout") {
    if (child.pid !== undefined) killProcessTree(child.pid);
    process.stderr.write(`profile cleanup timed out at ${directory}\n`);
    return;
  }
  if (exitCode !== 0) {
    const detail = stderr.trim();
    process.stderr.write(
      `profile cleanup exited ${String(exitCode)} at ${directory}${detail.length === 0 ? "" : `\n${detail}`}\n`,
    );
  }
}

function waitForChild(
  child: NodeChildProcess.ChildProcess,
  timeoutMs: number,
): Promise<number | "timeout"> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function isMissingProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}
