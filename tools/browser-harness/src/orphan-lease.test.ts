import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createLaunchLease, leaseDirectory, reapOrphanedLaunches } from "./orphan-lease.ts";
import { killOwnedTree, pidAlive, spawnOwned } from "./owned-process.ts";

const cleanupPids: number[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const pid of cleanupPids.splice(0)) await killOwnedTree(pid, []);
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("orphan launch leases", () => {
  it("reaps an orphaned browser process and profile directory after a dead harness pid", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-"));
    const child = spawnOwned(process.execPath, [
      "-e",
      `// ${profileDir}\nsetInterval(() => {}, 1000);`,
    ]);
    cleanupPids.push(child.pid);

    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true });
    const leaseFile = NodePath.join(leaseDir, "dead-harness.json");
    await NodeFSP.writeFile(
      leaseFile,
      JSON.stringify({
        version: 1,
        harnessPid: 999_999_999,
        spawnedPid: child.pid,
        profileDir,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const reaped = await reapOrphanedLaunches(() => undefined, tmpdir);
    expect(reaped).toBe(1);
    expect(pidAlive(child.pid)).toBe(false);
    expect(NodeFS.existsSync(profileDir)).toBe(false);
    expect(NodeFS.existsSync(leaseFile)).toBe(false);
  });

  it("leaves a live harness process and its profile untouched", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const profileDir = await NodeFSP.mkdtemp(NodePath.join(tmpdir, "one-click-har-browser-"));
    const liveHarness = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
    cleanupPids.push(liveHarness.pid);
    const liveBrowser = spawnOwned(process.execPath, [
      "-e",
      `// ${profileDir}\nsetInterval(() => {}, 1000);`,
    ]);
    cleanupPids.push(liveBrowser.pid);

    const leaseDir = leaseDirectory(tmpdir);
    await NodeFSP.mkdir(leaseDir, { recursive: true });
    const leaseFile = NodePath.join(leaseDir, "live-harness.json");
    await NodeFSP.writeFile(
      leaseFile,
      JSON.stringify({
        version: 1,
        harnessPid: liveHarness.pid,
        spawnedPid: liveBrowser.pid,
        profileDir,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const reaped = await reapOrphanedLaunches(() => undefined, tmpdir);
    expect(reaped).toBe(0);
    expect(pidAlive(liveBrowser.pid)).toBe(true);
    expect(NodeFS.existsSync(profileDir)).toBe(true);
    expect(NodeFS.existsSync(leaseFile)).toBe(true);
  });

  it("refuses to reap a profile directory outside safe bounds", async () => {
    const tmpdir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-lease-"));
    cleanupDirs.push(tmpdir);
    const lease = await createLaunchLease("/home/u/.mozilla/one-click-har-browser-bad", tmpdir);
    await NodeFSP.writeFile(
      lease.filePath,
      JSON.stringify({
        version: 1,
        harnessPid: 999_999_999,
        spawnedPid: null,
        profileDir: "/home/u/.mozilla/one-click-har-browser-bad",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await expect(
      reapOrphanedLaunches((dir) => {
        if (dir.includes(".mozilla")) throw new Error("refusing live profile root");
      }, tmpdir),
    ).rejects.toThrow("refusing live profile root");
  });
});
