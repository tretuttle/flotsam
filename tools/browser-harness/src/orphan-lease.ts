import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  commandLineHasPath,
  currentPlatformName,
  killOwnedTree,
  readProcessIdentity,
  removeDirectoryBounded,
} from "./owned-process.ts";

const PROFILE_PREFIX = "one-click-har-browser-";

export type LaunchLease = {
  readonly version: 2;
  readonly harnessPid: number;
  readonly harnessStartTime: string;
  readonly spawnedPid: number | null;
  readonly spawnedStartTime: string | null;
  readonly profileDir: string;
  readonly createdAt: string;
};

export type ActiveLease = {
  readonly filePath: string;
  readonly setSpawnedProcess: (pid: number, startTime: string) => void;
  readonly remove: () => Promise<void>;
};

export function leaseDirectory(tmpdir: string = NodeOS.tmpdir()): string {
  const uidSuffix = typeof process.getuid === "function" ? `-${String(process.getuid())}` : "";
  return NodePath.join(tmpdir, `one-click-har-leases${uidSuffix}`);
}

async function ensureSecureLeaseDir(dir: string): Promise<void> {
  try {
    const stat = await NodeFSP.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`lease path ${dir} is not a real directory`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`lease directory ${dir} is owned by uid ${String(stat.uid)}`);
    }
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
      await NodeFSP.chmod(dir, 0o700);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await NodeFSP.chmod(dir, 0o700);
  }
}

export async function createLaunchLease(
  profileDir: string,
  tmpdir: string = NodeOS.tmpdir(),
): Promise<ActiveLease> {
  const dir = leaseDirectory(tmpdir);
  await ensureSecureLeaseDir(dir);
  const harnessIdentity = readProcessIdentity(process.pid);
  if (harnessIdentity === null) {
    throw new Error(`could not read start time for harness pid ${String(process.pid)}`);
  }
  const filePath = NodePath.join(dir, `${String(process.pid)}-${NodeCrypto.randomUUID()}.json`);
  const record: LaunchLease = {
    version: 2,
    harnessPid: process.pid,
    harnessStartTime: harnessIdentity.startTime,
    spawnedPid: null,
    spawnedStartTime: null,
    profileDir,
    createdAt: new Date().toISOString(),
  };
  await NodeFSP.writeFile(filePath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await NodeFSP.chmod(filePath, 0o600);
  return {
    filePath,
    setSpawnedProcess: (spawnedPid: number, spawnedStartTime: string) => {
      const updated: LaunchLease = { ...record, spawnedPid, spawnedStartTime };
      try {
        NodeFS.writeFileSync(filePath, `${JSON.stringify(updated)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        if (process.platform !== "win32") NodeFS.chmodSync(filePath, 0o600);
      } catch {
        // Ignore if already removed by concurrent dispose.
      }
    },
    remove: async () => {
      await NodeFSP.rm(filePath, { force: true }).catch(() => undefined);
    },
  };
}

export async function reapOrphanedLaunches(
  assertSafeProfile: (directory: string) => void,
  tmpdir: string = NodeOS.tmpdir(),
  onWarning: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<number> {
  const dir = leaseDirectory(tmpdir);
  let entries: string[];
  try {
    await ensureExistingSecureLeaseDir(dir);
    entries = await NodeFSP.readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }

  let reaped = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = NodePath.join(dir, entry);
    const stat = await NodeFSP.lstat(filePath).catch(() => null);
    if (stat === null || stat.isSymbolicLink() || !stat.isFile()) continue;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) continue;

    const lease = await readLease(filePath);
    if (lease === null) continue;

    const liveHarness = readProcessIdentity(lease.harnessPid);
    if (liveHarness !== null && liveHarness.startTime === lease.harnessStartTime) {
      continue;
    }

    assertSafeProfile(lease.profileDir);
    try {
      await killVerifiedOrphan(lease);
      if (NodeFS.existsSync(lease.profileDir)) {
        await removeDirectoryBounded(lease.profileDir);
      }
    } catch (error) {
      onWarning(
        `warning: failed to reap orphaned browser for ${lease.profileDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await NodeFSP.rm(filePath, { force: true }).catch(() => undefined);
    reaped += 1;
  }
  return reaped;
}

async function ensureExistingSecureLeaseDir(dir: string): Promise<void> {
  const stat = await NodeFSP.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`lease path ${dir} is not a real directory`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`lease directory ${dir} is owned by uid ${String(stat.uid)}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    await NodeFSP.chmod(dir, 0o700);
  }
}

async function killVerifiedOrphan(lease: LaunchLease): Promise<void> {
  if (lease.spawnedPid === null || lease.spawnedStartTime === null) return;
  const live = readProcessIdentity(lease.spawnedPid);
  if (
    live === null ||
    live.startTime !== lease.spawnedStartTime ||
    !commandLineHasPath(live, lease.profileDir)
  ) {
    return;
  }
  const members =
    currentPlatformName() === "linux"
      ? linuxVerifiedDescendants(lease.spawnedPid, lease.profileDir)
      : [];
  await killOwnedTree(lease.spawnedPid, members);
}

function linuxVerifiedDescendants(spawnedPid: number, profileDir: string): number[] {
  const matched: number[] = [];
  let entries: string[];
  try {
    entries = NodeFS.readdirSync("/proc");
  } catch {
    return [spawnedPid];
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === spawnedPid) {
      matched.push(pid);
      continue;
    }
    const id = readProcessIdentity(pid);
    if (id !== null && commandLineHasPath(id, profileDir)) {
      matched.push(pid);
    }
  }
  return matched;
}

async function readLease(filePath: string): Promise<LaunchLease | null> {
  try {
    const raw: unknown = JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    if (!("version" in raw) || raw.version !== 2) return null;
    if (
      !("harnessPid" in raw) ||
      typeof raw.harnessPid !== "number" ||
      !Number.isInteger(raw.harnessPid) ||
      raw.harnessPid <= 0
    ) {
      return null;
    }
    if (
      !("harnessStartTime" in raw) ||
      typeof raw.harnessStartTime !== "string" ||
      raw.harnessStartTime.length === 0
    ) {
      return null;
    }
    if (
      !("profileDir" in raw) ||
      typeof raw.profileDir !== "string" ||
      !NodePath.isAbsolute(raw.profileDir) ||
      !NodePath.basename(raw.profileDir).startsWith(PROFILE_PREFIX)
    ) {
      return null;
    }
    const spawnedPid = "spawnedPid" in raw ? raw.spawnedPid : undefined;
    const spawnedStartTime = "spawnedStartTime" in raw ? raw.spawnedStartTime : undefined;
    const bothNull = spawnedPid === null && spawnedStartTime === null;
    const bothValid =
      typeof spawnedPid === "number" &&
      Number.isInteger(spawnedPid) &&
      spawnedPid > 0 &&
      typeof spawnedStartTime === "string" &&
      spawnedStartTime.length > 0;
    if (!bothNull && !bothValid) return null;
    const createdAt = "createdAt" in raw && typeof raw.createdAt === "string" ? raw.createdAt : "";
    return {
      version: 2,
      harnessPid: raw.harnessPid,
      harnessStartTime: raw.harnessStartTime,
      spawnedPid: bothValid ? (spawnedPid as number) : null,
      spawnedStartTime: bothValid ? (spawnedStartTime as string) : null,
      profileDir: raw.profileDir,
      createdAt,
    };
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return null;
}
