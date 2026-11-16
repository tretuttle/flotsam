import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createLaunchLease, leaseDirectory, reapOrphanedLaunches } from "./orphan-lease.ts";
import { killOwnedTree, pidAlive, readProcessIdentity, spawnOwned } from "./owned-process.ts";
import { registerPidNamespaceSuite } from "./pid-namespace.ts";

const cleanupPids: number[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const pid of cleanupPids.splice(0)) await killOwnedTree(pid, []);
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("orphan launch leases", () => {
  it("stores lease directory as 0700 and lease files as 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-"));
    const lease = await createLaunchLease(profileDir, tmpdir);
    const dirMode = NodeFS.lstatSync(leaseDirectory(tmpdir)).mode & 0o777;
    const fileMode = NodeFS.lstatSync(lease.filePath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    await lease.remove();
  });

  it("refuses to reap a profile directory outside safe bounds", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const lease = await createLaunchLease("/home/u/.mozilla/one-click-har-browser-bad", tmpdir);
    await NodeFSP.writeFile(
      lease.filePath,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999_999,
        harnessStartTime: "1",
        spawnedPid: null,
        spawnedStartTime: null,
        profileDir: "/home/u/.mozilla/one-click-har-browser-bad",
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await expect(
      reapOrphanedLaunches((dir) => {
        if (dir.includes(".mozilla")) throw new Error("refusing live profile root");
      }, tmpdir),
    ).rejects.toThrow("refusing live profile root");
  });

  it("warns instead of blocking future launches if removing an orphaned profile fails", async () => {
    if (process.platform === "win32") return;
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const parent = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "locked-parent-"));
    const profileDir = NodePath.join(parent, "one-click-har-browser-stuck");
    await NodeFSP.mkdir(profileDir);
    await NodeFSP.writeFile(NodePath.join(profileDir, "lock"), "busy");
    await NodeFSP.chmod(profileDir, 0o555);
    await NodeFSP.chmod(parent, 0o555);

    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
    const leaseFile = NodePath.join(leaseDir, "stuck-rm.json");
    await NodeFSP.writeFile(
      leaseFile,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999_999,
        harnessStartTime: "1",
        spawnedPid: null,
        spawnedStartTime: null,
        profileDir,
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const warnings: string[] = [];
    try {
      const reaped = await reapOrphanedLaunches(
        () => undefined,
        tmpdir,
        (msg) => warnings.push(msg),
      );
      expect(reaped).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/warning: failed to reap orphaned browser/);
      expect(NodeFS.existsSync(leaseFile)).toBe(false);
    } finally {
      await NodeFSP.chmod(parent, 0o755);
      await NodeFSP.chmod(profileDir, 0o755);
    }
  });
});

registerPidNamespaceSuite(import.meta.filename, "orphan lease reaping (real signals)", () => {
  it("reaps an orphaned browser process and profile directory after a dead harness pid", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-"));
    const child = spawnOwned(process.execPath, [
      "-e",
      `// ${profileDir}\nsetInterval(() => {}, 1000);`,
    ]);
    cleanupPids.push(child.pid);
    const identity = readProcessIdentity(child.pid);
    expect(identity).not.toBeNull();

    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
    const leaseFile = NodePath.join(leaseDir, "dead-harness.json");
    await NodeFSP.writeFile(
      leaseFile,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999_999,
        harnessStartTime: "1",
        spawnedPid: child.pid,
        spawnedStartTime: identity?.startTime,
        profileDir,
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const reaped = await reapOrphanedLaunches(() => undefined, tmpdir);
    expect(reaped).toBe(1);
    expect(pidAlive(child.pid)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
  });

  it("leaves an unrelated live process untouched when start time differs or profile path is absent, and removes the stale lease", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);

    const unrelatedDiffStart = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
    cleanupPids.push(unrelatedDiffStart.pid);
    const profileA = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-a-"));

    const unrelatedNoProfile = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
    cleanupPids.push(unrelatedNoProfile.pid);
    const identityNoProfile = readProcessIdentity(unrelatedNoProfile.pid);
    expect(identityNoProfile).not.toBeNull();
    const profileB = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-b-"));

    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
    const leaseA = NodePath.join(leaseDir, "reused-pid-wrong-start.json");
    const leaseB = NodePath.join(leaseDir, "right-start-no-profile.json");
    await NodeFSP.writeFile(
      leaseA,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999_999,
        harnessStartTime: "1",
        spawnedPid: unrelatedDiffStart.pid,
        spawnedStartTime: "1",
        profileDir: profileA,
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await NodeFSP.writeFile(
      leaseB,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999_999,
        harnessStartTime: "1",
        spawnedPid: unrelatedNoProfile.pid,
        spawnedStartTime: identityNoProfile?.startTime,
        profileDir: profileB,
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    await reapOrphanedLaunches(() => undefined, tmpdir);
    expect(pidAlive(unrelatedDiffStart.pid)).toBe(true);
    expect(pidAlive(unrelatedNoProfile.pid)).toBe(true);
    expect(NodeFS.existsSync(leaseA)).toBe(false);
    expect(NodeFS.existsSync(leaseB)).toBe(false);
  });

  it("ignores unparseable and incomplete lease files without acting on them", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const untouched = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
    cleanupPids.push(untouched.pid);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-"));

    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
    const corrupt = NodePath.join(leaseDir, "corrupt.json");
    const missingStart = NodePath.join(leaseDir, "no-start-time.json");
    await NodeFSP.writeFile(corrupt, "{not valid json", "utf8");
    await NodeFSP.writeFile(
      missingStart,
      JSON.stringify({
        version: 1,
        harnessPid: 999_999_999,
        spawnedPid: untouched.pid,
        profileDir,
      }),
      "utf8",
    );

    const reaped = await reapOrphanedLaunches(() => undefined, tmpdir);
    expect(reaped).toBe(0);
    expect(pidAlive(untouched.pid)).toBe(true);
    expect(NodeFS.existsSync(profileDir)).toBe(true);
    expect(NodeFS.existsSync(corrupt)).toBe(true);
    expect(NodeFS.existsSync(missingStart)).toBe(true);
  });

  it("leaves a live harness process and its profile untouched", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-"));
    const liveHarness = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
    cleanupPids.push(liveHarness.pid);
    const harnessIdentity = readProcessIdentity(liveHarness.pid);
    const liveBrowser = spawnOwned(process.execPath, [
      "-e",
      `// ${profileDir}\nsetInterval(() => {}, 1000);`,
    ]);
    cleanupPids.push(liveBrowser.pid);
    const browserIdentity = readProcessIdentity(liveBrowser.pid);

    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
    const leaseFile = NodePath.join(leaseDir, "live-harness.json");
    await NodeFSP.writeFile(
      leaseFile,
      JSON.stringify({
        version: 2,
        harnessPid: liveHarness.pid,
        harnessStartTime: harnessIdentity?.startTime,
        spawnedPid: liveBrowser.pid,
        spawnedStartTime: browserIdentity?.startTime,
        profileDir,
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const reaped = await reapOrphanedLaunches(() => undefined, tmpdir);
    expect(reaped).toBe(0);
    expect(pidAlive(liveBrowser.pid)).toBe(true);
    expect(NodeFS.existsSync(profileDir)).toBe(true);
    expect(NodeFS.existsSync(leaseFile)).toBe(true);
  });

  it("ignores a forged lease targeting PID 1 and refuses direct kill on PID 1", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-"));
    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true, mode: 0o700 });
    const forged = NodePath.join(leaseDir, "forged-pid-1.json");
    await NodeFSP.writeFile(
      forged,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999_999,
        harnessStartTime: "1",
        spawnedPid: 1,
        spawnedStartTime: "1",
        profileDir,
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const reaped = await reapOrphanedLaunches(() => undefined, tmpdir);
    expect(reaped).toBe(0);
    expect(NodeFS.existsSync(forged)).toBe(true);
    await expect(killOwnedTree(1, [])).rejects.toThrow(/integer greater than 1/);
  });
});
