import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export type ProcessSnapshot = {
  readonly parentPid: number;
  readonly workingSetBytes: number;
  readonly cpuTimeMs: number;
};

export type ProcessIdentity = {
  readonly pid: number;
  readonly pgrp: number | null;
  readonly startTime: string;
  readonly args: readonly string[];
  readonly commandLine: string;
};

export type GuardedSignal = "SIGTERM" | "SIGKILL" | 0;
export type GuardedTargetKind = "process" | "group";

export type AuthorizedTarget = {
  readonly pid: number;
  readonly startTime: string;
  readonly profileDir: string | null;
  readonly groupLeader: boolean;
};

const authorizedTargets = new Map<number, AuthorizedTarget>();

export type ProcessPlatformName = "win32" | "linux" | "darwin";

export const STDERR_DRAIN_GRACE_MS = 100;
const SIGTERM_WAIT_MS = 1_500;

type ProcessPlatform = {
  // POSIX children become process group leaders, so one signal to the group reaches every
  // descendant that did not leave the group, even after the leader died.
  readonly groupLeader: boolean;
  readonly terminateTree: (rootPid: number) => void;
  readonly killTree: (rootPid: number) => void;
  readonly treeAlive: (rootPid: number) => boolean;
  readonly snapshot: (pid: number) => ProcessSnapshot;
  readonly parseSnapshot: (text: string, pid: number) => ProcessSnapshot;
  readonly identity: (pid: number) => ProcessIdentity | null;
};

export const PROCESS_PLATFORMS: Readonly<Record<ProcessPlatformName, ProcessPlatform>> = {
  win32: {
    groupLeader: false,
    // Graceful close attempt on Windows (/T without /F); not observed on Linux.
    terminateTree: (rootPid) => {
      sendVerifiedSignal({
        id: rootPid,
        targetKind: "process",
        signal: "SIGTERM",
        platform: "win32",
        send: (rawPid) => {
          runTaskkill(["/PID", String(rawPid), "/T"], rawPid);
          return true;
        },
      });
    },
    killTree: (rootPid) => {
      sendVerifiedSignal({
        id: rootPid,
        targetKind: "process",
        signal: "SIGKILL",
        platform: "win32",
        send: (rawPid) => {
          runTaskkill(["/PID", String(rawPid), "/T", "/F"], rawPid);
          return true;
        },
      });
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
    // Windows equivalent: Win32_Process.CreationDate ticks + CommandLine (not observed on Linux).
    identity: (pid) => {
      const result = NodeChildProcess.spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"; if ($null -eq $p) { exit 3 }; "$($p.CreationDate.ToUniversalTime().Ticks)\t$($p.CommandLine)"`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      if (result.status !== 0 || result.error !== undefined) return null;
      const line = result.stdout.trim();
      const tab = line.indexOf("\t");
      if (tab <= 0) return null;
      const startTime = line.slice(0, tab).trim();
      const commandLine = line.slice(tab + 1);
      return startTime.length === 0
        ? null
        : {
            pid,
            pgrp: null,
            startTime,
            args: commandLine.split(/\s+/u).filter(Boolean),
            commandLine,
          };
    },
  },
  linux: {
    groupLeader: true,
    terminateTree: (rootPid) => signalGroup(rootPid, "SIGTERM"),
    killTree: (rootPid) => signalGroup(rootPid, "SIGKILL"),
    treeAlive: groupAlive,
    snapshot: (pid) =>
      PROCESS_PLATFORMS.linux.parseSnapshot(
        NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8"),
        pid,
      ),
    parseSnapshot: (text, pid) => {
      const fields = parseLinuxStatFields(text, pid);
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
    identity: (pid) => readLinuxProcessIdentity(pid),
  },
  darwin: {
    groupLeader: true,
    terminateTree: (rootPid) => signalGroup(rootPid, "SIGTERM"),
    killTree: (rootPid) => signalGroup(rootPid, "SIGKILL"),
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
    // macOS equivalents: `ps -o lstart=` start time, `ps -o args=` command line, `ps -o pgid=` pgrp (not observed on Linux).
    identity: (pid) => {
      const start = NodeChildProcess.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
      });
      const argsOut = NodeChildProcess.spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
        encoding: "utf8",
      });
      const pgidOut = NodeChildProcess.spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
      });
      if (start.status !== 0 || argsOut.status !== 0) return null;
      const startTime = start.stdout.trim();
      const commandLine = argsOut.stdout.trim();
      if (startTime.length === 0) return null;
      const pgidText = pgidOut.status === 0 ? pgidOut.stdout.trim() : "";
      const pgrp = /^\d+$/u.test(pgidText) ? Number(pgidText) : null;
      return {
        pid,
        pgrp,
        startTime,
        args: commandLine.split(/\s+/u).filter(Boolean),
        commandLine,
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
  readonly startTime: string | null;
};

export function spawnOwned(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdio?: NodeChildProcess.StdioOptions;
    readonly profileDir?: string | undefined;
  } = {},
): OwnedChild {
  const platform = processPlatform();
  const child = NodeChildProcess.spawn(command, args, {
    detached: platform.groupLeader,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  if (child.pid === undefined) throw new Error(`could not start ${command}`);
  const startTime =
    platform.identity(child.pid)?.startTime ??
    (currentPlatformName() === "linux" ? readLinuxStartTime(child.pid) : null);
  if (startTime !== null) {
    authorizedTargets.set(child.pid, {
      pid: child.pid,
      startTime,
      profileDir: options.profileDir ?? null,
      groupLeader: platform.groupLeader,
    });
  }
  return { child, pid: child.pid, startTime };
}

export function authorizeLeaseTarget(
  pid: number,
  expected: { readonly startTime: string; readonly profileDir: string },
): void {
  assertPid(pid);
  if (expected.startTime.length === 0 || expected.profileDir.length === 0) {
    throw new Error(
      `refusing to authorize lease for pid ${String(pid)}: incomplete lease identity`,
    );
  }
  const live = processPlatform().identity(pid);
  if (live === null) return;
  if (live.startTime !== expected.startTime || !commandLineHasPath(live, expected.profileDir)) {
    throw new Error(
      `refusing to authorize lease for pid ${String(pid)}: process identity does not match lease`,
    );
  }
  authorizedTargets.set(pid, {
    pid,
    startTime: expected.startTime,
    profileDir: expected.profileDir,
    groupLeader: live.pgrp === pid,
  });
}

function terminateProcessTree(rootPid: number): void {
  processPlatform().terminateTree(rootPid);
}

function killProcessTree(rootPid: number): void {
  processPlatform().killTree(rootPid);
}

export function readProcessSnapshot(pid: number): ProcessSnapshot {
  assertReadablePid(pid);
  return processPlatform().snapshot(pid);
}

export function readProcessIdentity(pid: number): ProcessIdentity | null {
  assertReadablePid(pid);
  return processPlatform().identity(pid);
}

function formatExitStatus(code: number | null, signal: NodeJS.Signals | string | null): string {
  if (code !== null) return `code ${String(code)}`;
  if (signal !== null) return `signal ${signal}`;
  return "code 0";
}

export function commandLineHasPath(identity: ProcessIdentity, targetPath: string): boolean {
  if (identity.args.includes(targetPath)) return true;
  const escaped = targetPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const boundary = new RegExp(`(?:^|[\\s\\0=])${escaped}(?:$|[\\s\\0])`, "u");
  return identity.args.some((arg) => boundary.test(arg)) || boundary.test(identity.commandLine);
}

const REAP_MS = 5_000;

export type KillTreeOptions = {
  readonly lease?: { readonly profileDir: string; readonly spawnedStartTime: string } | undefined;
};

export async function killOwnedTree(
  rootPid: number,
  memberPids: readonly number[],
  options: KillTreeOptions = {},
): Promise<void> {
  const platform = processPlatform();
  const trackedMembers = captureAuthorizedMembers(rootPid, memberPids, options.lease);
  const rootAuth = options.lease
    ? {
        pid: rootPid,
        startTime: options.lease.spawnedStartTime,
        profileDir: options.lease.profileDir,
        groupLeader: true,
      }
    : authorizedTargets.get(rootPid);
  if (rootAuth === undefined) {
    // Delegate directly so `sendVerifiedSignal` rejects invalid or unowned targets with a clear reason.
    terminateProcessTree(rootPid);
    return;
  }

  const rootRunning = (): boolean => platform.identity(rootPid) !== null;
  const alive = (): number[] => {
    const running: number[] = [];
    if (rootRunning() && platform.treeAlive(rootPid)) running.push(rootPid);
    for (const memberPid of trackedMembers) {
      if (memberPid !== rootPid && pidAlive(memberPid) && !running.includes(memberPid)) {
        running.push(memberPid);
      }
    }
    return running;
  };
  if (alive().length === 0) return;

  // Stop cleanly with SIGTERM first, then escalate to SIGKILL after a bounded wait; never send a core-dump signal.
  if (rootRunning()) {
    if (options.lease !== undefined) {
      sendVerifiedSignal({
        id: rootPid,
        targetKind: platform.groupLeader ? "group" : "process",
        signal: "SIGTERM",
        lease: options.lease,
      });
    } else {
      terminateProcessTree(rootPid);
    }
  } else {
    for (const memberPid of trackedMembers) {
      if (pidAlive(memberPid)) {
        sendVerifiedSignal({
          id: memberPid,
          targetKind: "process",
          signal: "SIGTERM",
          lease: options.lease,
        });
      }
    }
  }

  const termDeadline = Date.now() + SIGTERM_WAIT_MS;
  while (alive().length > 0 && Date.now() < termDeadline) await delay(50);
  if (alive().length > 0) {
    if (rootRunning()) {
      if (options.lease !== undefined) {
        sendVerifiedSignal({
          id: rootPid,
          targetKind: platform.groupLeader ? "group" : "process",
          signal: "SIGKILL",
          lease: options.lease,
        });
      } else {
        killProcessTree(rootPid);
      }
    }
    for (const memberPid of trackedMembers) {
      if (memberPid !== rootPid && pidAlive(memberPid)) {
        sendVerifiedSignal({
          id: memberPid,
          targetKind: "process",
          signal: "SIGKILL",
          lease: options.lease,
        });
      }
    }
    const killDeadline = Date.now() + REAP_MS - SIGTERM_WAIT_MS;
    while (alive().length > 0 && Date.now() < killDeadline) await delay(50);
  }
  const left = alive();
  if (left.length > 0) throw new Error(`owned process still running: ${left.join(", ")}`);
}

function captureAuthorizedMembers(
  rootPid: number,
  memberPids: readonly number[],
  lease: KillTreeOptions["lease"],
): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return [];
  const platform = processPlatform();
  const rootAuth = lease
    ? {
        pid: rootPid,
        startTime: lease.spawnedStartTime,
        profileDir: lease.profileDir,
        groupLeader: true,
      }
    : authorizedTargets.get(rootPid);
  if (rootAuth === undefined) return [];

  const candidates = new Set<number>(
    memberPids.filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== rootPid),
  );
  if (currentPlatformName() === "linux" && rootAuth.groupLeader) {
    try {
      for (const entry of NodeFS.readdirSync("/proc")) {
        if (!/^\d+$/u.test(entry)) continue;
        const pid = Number(entry);
        if (pid > 1 && pid !== rootPid) candidates.add(pid);
      }
    } catch {
      // Fall back to explicit memberPids if /proc cannot be listed.
    }
  }

  const verified: number[] = [];
  for (const pid of candidates) {
    const id = platform.identity(pid);
    if (id === null) continue;
    const sameGroup = id.pgrp === rootPid;
    const sameProfile = rootAuth.profileDir !== null && commandLineHasPath(id, rootAuth.profileDir);
    if (!sameGroup && !sameProfile) continue;
    authorizedTargets.set(pid, {
      pid,
      startTime: id.startTime,
      profileDir: sameProfile ? rootAuth.profileDir : null,
      groupLeader: false,
    });
    verified.push(pid);
  }
  return verified;
}

export type ChildExitResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly status: string;
  readonly stderr: string;
};

export type ChildExitWatcher = {
  readonly exited: Promise<ChildExitResult>;
  readonly status: () => string | null;
  readonly stderr: () => string;
};

export function watchChildExit(
  child: NodeChildProcess.ChildProcess,
  options: { readonly stderrMaxBytes?: number } = {},
): ChildExitWatcher {
  const maxBytes = options.stderrMaxBytes ?? 4000;
  let stderrTail = "";
  let settledStatus: string | null = null;
  let streamClosed = child.stderr === null;

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-maxBytes);
  });

  const exited = new Promise<ChildExitResult>((resolve) => {
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null; status: string } | null =
      null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const finish = (): void => {
      if (done || exitInfo === null) return;
      done = true;
      if (graceTimer !== null) clearTimeout(graceTimer);
      settledStatus = exitInfo.status;
      resolve({
        code: exitInfo.code,
        signal: exitInfo.signal,
        status: exitInfo.status,
        stderr: stderrTail,
      });
    };

    const markStreamDone = (): void => {
      streamClosed = true;
      finish();
    };
    child.stderr?.once("end", markStreamDone);
    child.once("close", markStreamDone);

    child.once("exit", (code, signal) => {
      exitInfo = { code, signal, status: formatExitStatus(code, signal) };
      if (streamClosed) {
        finish();
        return;
      }
      // Report on `exit` after a short bounded drain so descendants holding stderr cannot wedge failure reporting.
      graceTimer = setTimeout(finish, STDERR_DRAIN_GRACE_MS);
      graceTimer.unref();
    });
  });

  return {
    exited,
    status: () => settledStatus,
    stderr: () => stderrTail,
  };
}

const PROFILE_REMOVAL_MS = 15_000;
const REMOVAL_SCRIPT =
  'require("node:fs").rmSync(process.env.PROFILE_DIR,{recursive:true,force:true,maxRetries:50,retryDelay:100})';

export async function removeDirectoryBounded(directory: string): Promise<void> {
  const worker = spawnOwned(process.execPath, ["-e", REMOVAL_SCRIPT], {
    env: { ...process.env, PROFILE_DIR: directory },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const watcher = watchChildExit(worker.child, { stderrMaxBytes: 2000 });
  const exit = await Promise.race([
    watcher.exited,
    delay(PROFILE_REMOVAL_MS).then(() => "timeout" as const),
  ]);
  if (exit === "timeout") {
    await killOwnedTree(worker.pid, []);
    throw new Error(
      `profile removal timed out after ${String(PROFILE_REMOVAL_MS)} ms at ${directory}`,
    );
  }
  if (exit.code !== 0) {
    throw new Error(
      `profile removal exited ${String(exit.code ?? exit.signal ?? 1)} at ${directory}\n${exit.stderr.trim()}`,
    );
  }
  if (NodeFS.existsSync(directory)) throw new Error(`profile still present at ${directory}`);
}

export type VerifiedSignalRequest = {
  readonly id: number;
  readonly targetKind: GuardedTargetKind;
  readonly signal: GuardedSignal;
  readonly lease?: { readonly profileDir: string; readonly spawnedStartTime: string } | undefined;
  readonly expectedIdentity?: AuthorizedTarget | undefined;
  readonly platform?: ProcessPlatformName | undefined;
  readonly selfPid?: number | undefined;
  readonly parentPid?: number | undefined;
  readonly readIdentity?: ((pid: number) => ProcessIdentity | null) | undefined;
  readonly send?: ((rawTarget: number, signal: GuardedSignal) => boolean) | undefined;
};

export function sendVerifiedSignal(request: VerifiedSignalRequest): boolean {
  const { rawTarget } = verifySignalTarget(request);
  if (rawTarget === null) return false;
  const send = request.send ?? defaultSendSignal;
  return send(rawTarget, request.signal);
}

function verifySignalTarget(request: VerifiedSignalRequest): { readonly rawTarget: number | null } {
  const { id, targetKind, signal } = request;
  if (!Number.isInteger(id) || id <= 1) {
    throw new Error(
      `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: target ID must be an integer greater than 1`,
    );
  }
  const platform = request.platform ?? currentPlatformName();
  const readIdentity = request.readIdentity ?? PROCESS_PLATFORMS[platform].identity;
  const selfPid = request.selfPid ?? process.pid;
  const parentPid = request.parentPid ?? process.ppid;
  if (id === selfPid) {
    throw new Error(
      `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: target matches harness pid`,
    );
  }
  if (parentPid > 0 && id === parentPid) {
    throw new Error(
      `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: target matches harness parent pid`,
    );
  }
  const selfIdentity = readIdentity(selfPid);
  const selfPgrp = selfIdentity?.pgrp ?? null;
  if (selfPgrp !== null && id === selfPgrp) {
    throw new Error(
      `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: target matches harness process group`,
    );
  }
  if (targetKind === "group" && platform !== "win32" && selfPgrp === null) {
    throw new Error(
      `refusing signal ${String(signal)} to group ${String(id)}: could not determine harness process group`,
    );
  }

  const live = readIdentity(id);
  let expected: AuthorizedTarget | undefined = request.expectedIdentity;
  if (expected === undefined && request.lease !== undefined) {
    if (request.lease.spawnedStartTime.length === 0 || request.lease.profileDir.length === 0) {
      throw new Error(
        `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: incomplete lease identity`,
      );
    }
    expected = {
      pid: id,
      startTime: request.lease.spawnedStartTime,
      profileDir: request.lease.profileDir,
      groupLeader: true,
    };
  }
  if (expected === undefined) {
    expected = authorizedTargets.get(id);
  }
  if (expected === undefined && targetKind === "process" && live !== null && live.pgrp !== null) {
    const leader = authorizedTargets.get(live.pgrp);
    if (leader?.groupLeader === true) {
      expected = { pid: id, startTime: live.startTime, profileDir: null, groupLeader: false };
    }
  }
  if (expected === undefined) {
    throw new Error(
      `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: target was not spawned in this run or recorded in a valid lease`,
    );
  }
  if (live === null) {
    if (signal === 0) return { rawTarget: null };
    throw new Error(
      `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: target process identity is unavailable`,
    );
  }
  if (live.startTime !== expected.startTime) {
    throw new Error(
      `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: start time ${live.startTime} does not match expected ${expected.startTime}`,
    );
  }
  if (expected.profileDir !== null && !commandLineHasPath(live, expected.profileDir)) {
    throw new Error(
      `refusing signal ${String(signal)} to ${targetKind} ${String(id)}: profile path ${expected.profileDir} missing from command line`,
    );
  }
  if (targetKind === "group" && platform !== "win32" && live.pgrp !== id) {
    throw new Error(
      `refusing signal ${String(signal)} to group ${String(id)}: process group ${String(live.pgrp)} is not led by ${String(id)}`,
    );
  }
  return { rawTarget: targetKind === "group" ? -id : id };
}

export function pidAlive(pid: number): boolean {
  return sendVerifiedSignal({ id: pid, targetKind: "process", signal: 0 });
}

function groupAlive(rootPid: number): boolean {
  return sendVerifiedSignal({ id: rootPid, targetKind: "group", signal: 0 });
}

function signalGroup(rootPid: number, signal: "SIGTERM" | "SIGKILL"): void {
  sendVerifiedSignal({ id: rootPid, targetKind: "group", signal });
}

function runTaskkill(args: readonly string[], rootPid: number): void {
  const result = NodeChildProcess.spawnSync("taskkill.exe", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) return;
  const detail = `${result.stdout}${result.stderr}`;
  if (result.status === 128 || /not found/iu.test(detail)) return;
  throw new Error(`taskkill ${String(rootPid)} failed: ${detail.trim()}`);
}

function parseLinuxStatFields(text: string, pid: number): readonly string[] {
  // The command name is wrapped in parentheses and may itself hold spaces and ")".
  const close = text.lastIndexOf(")");
  if (close === -1) throw new Error(`/proc/${String(pid)}/stat has no command name`);
  return text
    .slice(close + 2)
    .trim()
    .split(" ");
}

function readLinuxStartTime(pid: number): string | null {
  try {
    const stat = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = parseLinuxStatFields(stat, pid);
    const state = fields[0] ?? "";
    if (state === "Z" || state === "X") return null;
    const startTime = fields[19] ?? "";
    return /^\d+$/u.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

function readLinuxProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = parseLinuxStatFields(stat, pid);
    // Zombies (`Z`) and dead processes (`X`) keep a /proc stat entry briefly with empty cmdline.
    const state = fields[0] ?? "";
    if (state === "Z" || state === "X") return null;
    // Field 5 in /proc/[pid]/stat is pgrp (index 2 after comm); field 22 is starttime (index 19).
    const pgrpText = fields[2] ?? "";
    const pgrp = /^\d+$/u.test(pgrpText) ? Number(pgrpText) : null;
    const startTime = fields[19] ?? "";
    if (!/^\d+$/u.test(startTime)) return null;
    const rawCmdline = NodeFS.readFileSync(`/proc/${String(pid)}/cmdline`, "utf8");
    const args = rawCmdline.split("\0").filter((part) => part.length > 0);
    // Exiting processes (`exit_mm()` before `Z` state) and kernel threads have an empty cmdline.
    if (args.length === 0) return null;
    return { pid, pgrp, startTime, args, commandLine: args.join(" ") };
  } catch {
    return null;
  }
}

function defaultSendSignal(rawTarget: number, signal: GuardedSignal): boolean {
  try {
    process.kill(rawTarget, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (signal === 0 && errorCode(error) === "EPERM") return true;
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

function assertReadablePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${String(pid)}`);
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`invalid pid ${String(pid)}`);
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
