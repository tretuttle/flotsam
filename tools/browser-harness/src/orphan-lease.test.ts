import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createLaunchLease, leaseDirectory, reapOrphanedLaunches } from "./orphan-lease.ts";
import type { ProcessIdentity } from "./signal-policy.ts";
import { HARNESS, processIdentity, simulateProcesses } from "./simulated-process-io.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await NodeFSP.chmod(dir, 0o755).catch(() => undefined);
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

const DEAD_HARNESS = { harnessPid: 999_999, harnessStartTime: "1" };

async function leaseFixture(): Promise<{ tmpdir: string; profileDir: string; leaseDir: string }> {
  const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
  cleanupDirs.push(tmpdir);
  const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-"));
  const leaseDir = leaseDirectory(tmpdir);
  await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
  return { tmpdir, profileDir, leaseDir };
}

async function writeLease(
  leaseDir: string,
  name: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const file = NodePath.join(leaseDir, `${name}.json`);
  await NodeFSP.writeFile(
    file,
    JSON.stringify({
      version: 2,
      createdAt: new Date(0).toISOString(),
      ...DEAD_HARNESS,
      ...fields,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return file;
}

const orphanBrowser = (profileDir: string): ProcessIdentity =>
  processIdentity(5000, { args: ["/opt/zen/zen", "-profile", profileDir] });

describe("orphan launch leases", () => {
  it("stores lease directory as 0700 and lease files as 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const { tmpdir, profileDir } = await leaseFixture();
    const lease = await createLaunchLease(profileDir, tmpdir);
    expect(NodeFS.lstatSync(leaseDirectory(tmpdir)).mode & 0o777).toBe(0o700);
    expect(NodeFS.lstatSync(lease.filePath).mode & 0o777).toBe(0o600);
    await lease.remove();
  });

  it("stops a dead harness's browser using only the lease, then removes its profile and lease", async () => {
    const { tmpdir, profileDir, leaseDir } = await leaseFixture();
    const leaseFile = await writeLease(leaseDir, "orphan", {
      spawnedPid: 5000,
      spawnedStartTime: "50000",
      profileDir,
    });
    const world = simulateProcesses([orphanBrowser(profileDir)]);
    const reaped = await reapOrphanedLaunches(world.io, () => undefined, { tmpdir });
    expect(reaped).toBe(1);
    expect(world.sent).toEqual([{ rawTarget: -5000, signal: "SIGTERM", at: 0 }]);
    expect(world.running(5000)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
  });

  it("leaves a live harness's browser, profile and lease untouched", async () => {
    const { tmpdir, profileDir, leaseDir } = await leaseFixture();
    const leaseFile = await writeLease(leaseDir, "live", {
      harnessPid: HARNESS.pid,
      harnessStartTime: "20000",
      spawnedPid: 5000,
      spawnedStartTime: "50000",
      profileDir,
    });
    const world = simulateProcesses([orphanBrowser(profileDir)]);
    expect(await reapOrphanedLaunches(world.io, () => undefined, { tmpdir })).toBe(0);
    expect(world.sent).toEqual([]);
    expect(NodeFS.existsSync(profileDir)).toBe(true);
    expect(NodeFS.existsSync(leaseFile)).toBe(true);
  });

  it.each([
    { name: "a reused PID (start time differs)", spawnedStartTime: "1", args: undefined },
    {
      name: "a process without the profile path",
      spawnedStartTime: "50000",
      args: ["/usr/bin/editor"],
    },
  ])("never signals $name, and clears the stale lease and profile", async (row) => {
    const { tmpdir, profileDir, leaseDir } = await leaseFixture();
    const leaseFile = await writeLease(leaseDir, "stale", {
      spawnedPid: 5000,
      spawnedStartTime: row.spawnedStartTime,
      profileDir,
    });
    const world = simulateProcesses([
      processIdentity(5000, { args: row.args ?? ["/opt/zen/zen", "-profile", profileDir] }),
    ]);
    expect(await reapOrphanedLaunches(world.io, () => undefined, { tmpdir })).toBe(1);
    expect(world.sent).toEqual([]);
    expect(world.running(5000)).toBe(true);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
  });

  it("ignores leases naming PID 1, unparseable leases and old versions without touching them", async () => {
    const { tmpdir, profileDir, leaseDir } = await leaseFixture();
    const forged = await writeLease(leaseDir, "pid-1", {
      spawnedPid: 1,
      spawnedStartTime: "10",
      profileDir,
    });
    const corrupt = NodePath.join(leaseDir, "corrupt.json");
    await NodeFSP.writeFile(corrupt, "{not valid json", "utf8");
    const old = await writeLease(leaseDir, "v1", { version: 1, spawnedPid: 5000, profileDir });
    const world = simulateProcesses([
      processIdentity(1, { parentPid: 0, args: ["/sbin/init", "-profile", profileDir] }),
      orphanBrowser(profileDir),
    ]);
    expect(await reapOrphanedLaunches(world.io, () => undefined, { tmpdir })).toBe(0);
    expect(world.sent).toEqual([]);
    expect([forged, corrupt, old, profileDir].map((path) => NodeFS.existsSync(path))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("keeps the lease and records the failure when the browser cannot be stopped, then reaps it on the next launch", async () => {
    const { tmpdir, profileDir, leaseDir } = await leaseFixture();
    const leaseFile = await writeLease(leaseDir, "stuck", {
      spawnedPid: 5000,
      spawnedStartTime: "50000",
      profileDir,
    });
    const stuck = simulateProcesses([orphanBrowser(profileDir)], {
      survives: { 5000: "everything" },
    });
    const warnings: string[] = [];
    const first = await reapOrphanedLaunches(stuck.io, () => undefined, {
      tmpdir,
      onWarning: (message) => warnings.push(message),
    });
    expect(first).toBe(0);
    expect(warnings).toEqual([
      expect.stringMatching(
        /attempt 1\); kept its lease to retry on the next launch: owned process still running: 5000/,
      ),
    ]);
    expect(JSON.parse(await NodeFSP.readFile(leaseFile, "utf8"))).toMatchObject({
      spawnedPid: 5000,
      reapFailures: 1,
      lastReapFailure: "owned process still running: 5000",
    });
    expect(NodeFS.existsSync(profileDir)).toBe(true);

    const next = simulateProcesses([orphanBrowser(profileDir)]);
    expect(await reapOrphanedLaunches(next.io, () => undefined, { tmpdir })).toBe(1);
    expect(next.sent).toEqual([{ rawTarget: -5000, signal: "SIGTERM", at: 0 }]);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
  });

  it("keeps the lease when removing the profile fails, and retries it once removal can succeed", async () => {
    if (process.platform === "win32") return;
    const { tmpdir, leaseDir } = await leaseFixture();
    const parent = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "locked-parent-"));
    const profileDir = NodePath.join(parent, "one-click-har-browser-stuck");
    await NodeFSP.mkdir(profileDir);
    await NodeFSP.writeFile(NodePath.join(profileDir, "lock"), "busy");
    await NodeFSP.chmod(parent, 0o555);
    const leaseFile = await writeLease(leaseDir, "stuck-rm", {
      spawnedPid: null,
      spawnedStartTime: null,
      profileDir,
    });
    const world = simulateProcesses([]);
    const warnings: string[] = [];
    const removeProfile = (directory: string) =>
      NodeFSP.rm(directory, { recursive: true, force: true });
    const options = { tmpdir, onWarning: (m: string) => warnings.push(m), removeProfile };
    expect(await reapOrphanedLaunches(world.io, () => undefined, options)).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(NodeFS.existsSync(leaseFile)).toBe(true);

    await NodeFSP.chmod(parent, 0o755);
    expect(await reapOrphanedLaunches(world.io, () => undefined, options)).toBe(1);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
  });

  it("refuses to reap a profile directory outside safe bounds", async () => {
    const { tmpdir, leaseDir } = await leaseFixture();
    await writeLease(leaseDir, "unsafe", {
      spawnedPid: null,
      spawnedStartTime: null,
      profileDir: "/home/u/.mozilla/one-click-har-browser-bad",
    });
    await expect(
      reapOrphanedLaunches(
        simulateProcesses([]).io,
        (dir) => {
          if (dir.includes(".mozilla")) throw new Error("refusing live profile root");
        },
        { tmpdir },
      ),
    ).rejects.toThrow("refusing live profile root");
  });
});
