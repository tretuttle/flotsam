import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  currentPlatformName,
  killOwnedTree,
  pidAlive,
  removeDirectoryBounded,
} from "./owned-process.ts";

const LEASE_DIR_NAME = "one-click-har-leases";
const PROFILE_PREFIX = "one-click-har-browser-";

export type LaunchLease = {
  readonly version: 1;
  readonly harnessPid: number;
  readonly spawnedPid: number | null;
  readonly profileDir: string;
  readonly createdAt: string;
};

export type ActiveLease = {
  readonly filePath: string;
  readonly setSpawnedPid: (pid: number) => Promise<void>;
  readonly remove: () => Promise<void>;
};

export function leaseDirectory(tmpdir: string = NodeOS.tmpdir()): string {
  return NodePath.join(tmpdir, LEASE_DIR_NAME);
}

export async function createLaunchLease(
  profileDir: string,
  tmpdir: string = NodeOS.tmpdir(),
): Promise<ActiveLease> {
  const dir = leaseDirectory(tmpdir);
  await NodeFSP.mkdir(dir, { recursive: true });
  const filePath = NodePath.join(dir, `${String(process.pid)}-${NodeCrypto.randomUUID()}.json`);
  const record: LaunchLease = {
    version: 1,
    harnessPid: process.pid,
    spawnedPid: null,
    profileDir,
    createdAt: new Date().toISOString(),
  };
  await NodeFSP.writeFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  return {
    filePath,
    setSpawnedPid: async (spawnedPid: number) => {
      const updated: LaunchLease = { ...record, spawnedPid };
      await NodeFSP.writeFile(filePath, `${JSON.stringify(updated)}\n`, "utf8").catch(
        () => undefined,
      );
    },
    remove: async () => {
      await NodeFSP.rm(filePath, { force: true }).catch(() => undefined);
    },
  };
}

export async function reapOrphanedLaunches(
  assertSafeProfile: (directory: string) => void,
  tmpdir: string = NodeOS.tmpdir(),
): Promise<number> {
  const dir = leaseDirectory(tmpdir);
  let entries: string[];
  try {
    entries = await NodeFSP.readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  let reaped = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = NodePath.join(dir, entry);
    const lease = await readLease(filePath);
    if (lease === null) continue;
    if (lease.harnessPid === process.pid || pidAlive(lease.harnessPid)) continue;
    if (!NodePath.basename(lease.profileDir).startsWith(PROFILE_PREFIX)) continue;
    assertSafeProfile(lease.profileDir);
    await killOrphanedBrowser(lease.spawnedPid, lease.profileDir);
    if (NodeFS.existsSync(lease.profileDir)) {
      await removeDirectoryBounded(lease.profileDir);
    }
    await NodeFSP.rm(filePath, { force: true }).catch(() => undefined);
    reaped += 1;
  }
  return reaped;
}

async function killOrphanedBrowser(spawnedPid: number | null, profileDir: string): Promise<void> {
  if (spawnedPid === null || !Number.isInteger(spawnedPid) || spawnedPid <= 0) return;
  if (currentPlatformName() === "linux") {
    const members = linuxOrphanPids(spawnedPid, profileDir);
    if (members.length === 0) return;
    await killOwnedTree(spawnedPid, members);
    return;
  }
  if (pidAlive(spawnedPid)) {
    await killOwnedTree(spawnedPid, []);
  }
}

function linuxOrphanPids(spawnedPid: number, profileDir: string): number[] {
  const matched: number[] = [];
  let entries: string[];
  try {
    entries = NodeFS.readdirSync("/proc");
  } catch {
    return pidAlive(spawnedPid) ? [spawnedPid] : [];
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    try {
      const cmdline = NodeFS.readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.includes(profileDir)) {
        matched.push(pid);
        continue;
      }
      const stat = NodeFS.readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close === -1) continue;
      const fields = stat
        .slice(close + 2)
        .trim()
        .split(" ");
      // Field 5 in /proc/[pid]/stat is pgrp (index 2 after comm).
      const pgrp = Number(fields[2]);
      if (pgrp === spawnedPid && pidAlive(spawnedPid)) matched.push(pid);
    } catch {
      // Process exited while scanning /proc.
    }
  }
  return matched;
}

async function readLease(filePath: string): Promise<LaunchLease | null> {
  try {
    const raw: unknown = JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      !("version" in raw) ||
      raw.version !== 1 ||
      !("harnessPid" in raw) ||
      typeof raw.harnessPid !== "number" ||
      !Number.isInteger(raw.harnessPid) ||
      raw.harnessPid <= 0 ||
      !("profileDir" in raw) ||
      typeof raw.profileDir !== "string"
    ) {
      return null;
    }
    const spawnedPid =
      "spawnedPid" in raw && typeof raw.spawnedPid === "number" ? raw.spawnedPid : null;
    const createdAt = "createdAt" in raw && typeof raw.createdAt === "string" ? raw.createdAt : "";
    return {
      version: 1,
      harnessPid: raw.harnessPid,
      spawnedPid,
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
