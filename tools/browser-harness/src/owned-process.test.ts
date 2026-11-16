import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  currentPlatformName,
  killOwnedTree,
  pidAlive,
  PROCESS_PLATFORMS,
  removeDirectoryBounded,
  spawnOwned,
  STDERR_DRAIN_GRACE_MS,
  watchChildExit,
  type OwnedChild,
  type ProcessPlatformName,
} from "./owned-process.ts";

const owned: number[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const pid of owned.splice(0)) await killOwnedTree(pid, []);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

const ALLOCATED_BYTES = 200 * 1024 * 1024;
const PROBE_TITLE = "a) b (c) d";
const PROBE = `
process.title = ${JSON.stringify(PROBE_TITLE)};
const held = Buffer.alloc(${String(ALLOCATED_BYTES)}, 7);
const start = process.cpuUsage();
while (true) { const used = process.cpuUsage(start); if (used.user + used.system >= 300000) break; }
const cpu = process.cpuUsage();
process.stdout.write(JSON.stringify({ ppid: process.ppid, rss: process.memoryUsage().rss, cpuMs: (cpu.user + cpu.system) / 1000, held: held.length }) + "\\n");
setInterval(() => {}, 1000);
`;

// Only this machine's row runs live. The other rows are covered by their sample output until
// a run on that platform.
const RUNNABLE_ROWS: readonly ProcessPlatformName[] = [currentPlatformName()];

describe("process inspection table", () => {
  it.each(RUNNABLE_ROWS)(
    "the %s row reads what a live process reports about itself",
    async (row) => {
      const probe = spawnOwned(process.execPath, ["-e", PROBE], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      owned.push(probe.pid);
      const reported = JSON.parse(await firstLine(probe)) as {
        ppid: number;
        rss: number;
        cpuMs: number;
      };
      if (row === "linux") {
        expect(NodeFS.readFileSync(`/proc/${String(probe.pid)}/stat`, "utf8")).toContain(
          `(${PROBE_TITLE})`,
        );
      }
      const snapshot = PROCESS_PLATFORMS[row].snapshot(probe.pid);
      expect(snapshot.parentPid).toBe(process.pid);
      expect(reported.ppid).toBe(process.pid);
      expect(snapshot.workingSetBytes).toBeGreaterThanOrEqual(ALLOCATED_BYTES);
      expect(snapshot.workingSetBytes).toBeLessThanOrEqual(reported.rss * 1.25);
      expect(snapshot.cpuTimeMs).toBeGreaterThanOrEqual(reported.cpuMs - 20);
      expect(snapshot.cpuTimeMs).toBeLessThanOrEqual(reported.cpuMs + 1000);
    },
  );

  it.each(
    [
      {
        row: "linux" as const,
        text: "4242 (Web Content) (x) S 4100 4100 4100 0 -1 4194560 1 0 0 0 250 50 0 0 20 0 30 0 99 1000 2560 18446744073709551615\n",
        parentPid: 4100,
      },
      { row: "win32" as const, text: "4100 104857600 52000000\r\n", parentPid: 4100 },
      { row: "darwin" as const, text: " 4100  2048   0:03.00\n", parentPid: 4100 },
    ].filter((sample) => sample.row !== "linux" || process.platform === "linux"),
  )("the $row row parses documented sample output", ({ row, text, parentPid }) => {
    const snapshot = PROCESS_PLATFORMS[row].parseSnapshot(text, 4242);
    expect(snapshot.parentPid).toBe(parentPid);
    expect(snapshot.cpuTimeMs).toBeCloseTo(row === "win32" ? 5200 : 3000, 6);
    if (row === "win32") expect(snapshot.workingSetBytes).toBe(104_857_600);
    if (row === "darwin") expect(snapshot.workingSetBytes).toBe(2048 * 1024);
  });

  it("parses BSD and procps cumulative CPU time with hours and days", () => {
    const cpu = (time: string): number =>
      PROCESS_PLATFORMS.darwin.parseSnapshot(`1 1 ${time}`, 1).cpuTimeMs;
    expect(cpu("61:02.50")).toBeCloseTo(3_662_500, 6);
    expect(cpu("01:01:02")).toBeCloseTo(3_662_000, 6);
    expect(cpu("2-00:00:01")).toBeCloseTo(172_801_000, 6);
  });

  it("refuses a platform outside the table", () => {
    expect(() => currentPlatformName("aix")).toThrow(/unsupported platform aix/);
  });
});

describe.runIf(currentPlatformName() !== "win32")("windows process trees", () => {
  it("asks taskkill to end the tree", async () => {
    const bin = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-taskkill-"));
    directories.push(bin);
    const argsFile = NodePath.join(bin, "args");
    await NodeFSP.writeFile(
      NodePath.join(bin, "taskkill.exe"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 0\n`,
      { mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${NodePath.delimiter}${previous ?? ""}`;
    try {
      PROCESS_PLATFORMS.win32.killTree(4242);
      expect((await NodeFSP.readFile(argsFile, "utf8")).trim().split("\n")).toEqual([
        "/PID",
        "4242",
        "/T",
        "/F",
      ]);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
});

describe("owned process trees", () => {
  it("kills the spawned tree and leaves an unrelated process running", async () => {
    const tree = await spawnTree();
    const unrelated = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    owned.push(unrelated.pid);
    await killOwnedTree(tree.leader.pid, []);
    expect(pidAlive(tree.leader.pid)).toBe(false);
    expect(pidAlive(tree.descendantPid)).toBe(false);
    expect(pidAlive(unrelated.pid)).toBe(true);
  });

  it.each(RUNNABLE_ROWS.filter((row) => PROCESS_PLATFORMS[row].groupLeader))(
    "on %s kills a descendant that outlived its parent",
    async () => {
      const tree = await spawnTree();
      process.kill(tree.leader.pid, "SIGKILL");
      await exited(tree.leader.child);
      expect(pidAlive(tree.descendantPid)).toBe(true);
      await killOwnedTree(tree.leader.pid, [tree.descendantPid]);
      expect(pidAlive(tree.descendantPid)).toBe(false);
    },
  );

  it("removes a profile directory once the process holding a file in it is gone", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "one-click-har-profile-"),
    );
    directories.push(directory);
    const holder = spawnOwned(
      process.execPath,
      [
        "-e",
        'const fs = require("node:fs"); fs.writeSync(fs.openSync(process.argv[1], "w"), "lock"); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
        NodePath.join(directory, "parent.lock"),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    owned.push(holder.pid);
    expect(await firstLine(holder)).toBe("ready");
    await killOwnedTree(holder.pid, []);
    await removeDirectoryBounded(directory);
    expect(NodeFS.existsSync(directory)).toBe(false);
  });

  it.runIf(currentPlatformName() !== "win32")(
    "includes stderr when profile directory removal fails and exits immediately",
    async () => {
      const parent = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "one-click-har-readonly-"),
      );
      directories.push(parent);
      const locked = NodePath.join(parent, "locked");
      await NodeFSP.mkdir(locked);
      await NodeFSP.writeFile(NodePath.join(locked, "file"), "data");
      await NodeFSP.chmod(locked, 0o555);
      await NodeFSP.chmod(parent, 0o555);
      try {
        await expect(removeDirectoryBounded(locked)).rejects.toThrow(
          /profile removal exited 1[\s\S]*EACCES/,
        );
      } finally {
        await NodeFSP.chmod(parent, 0o755);
        await NodeFSP.chmod(locked, 0o755);
      }
    },
  );

  it.runIf(currentPlatformName() !== "win32")(
    "reports exit with buffered stderr without waiting on a descendant holding stderr open",
    async () => {
      const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-drain-"));
      directories.push(scratch);
      const child = spawnOwned(
        "/bin/sh",
        ["-c", "sleep 30 &\necho 'descendant pipe crash' >&2\nexit 3\n"],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      owned.push(child.pid);
      const watcher = watchChildExit(child.child);
      const started = Date.now();
      const result = await watcher.exited;
      const elapsed = Date.now() - started;
      expect(result.status).toBe("code 3");
      expect(result.stderr).toContain("descendant pipe crash");
      expect(elapsed).toBeGreaterThanOrEqual(STDERR_DRAIN_GRACE_MS - 20);
      expect(elapsed).toBeLessThan(2000);
    },
  );

  it.runIf(currentPlatformName() !== "win32")(
    "stops processes with SIGTERM first, escalating to SIGKILL only after bounded wait",
    async () => {
      const scratch = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "one-click-har-signals-"),
      );
      directories.push(scratch);
      const signalLog = NodePath.join(scratch, "signals.log");
      const stub = spawnOwned(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs");
           process.on("SIGTERM", () => fs.appendFileSync(${JSON.stringify(signalLog)}, "SIGTERM\\n"));
           process.stdout.write("ready\\n");
           setInterval(() => {}, 1000);`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      owned.push(stub.pid);
      expect(await firstLine(stub)).toBe("ready");
      await killOwnedTree(stub.pid, []);
      expect(pidAlive(stub.pid)).toBe(false);
      expect(await NodeFSP.readFile(signalLog, "utf8")).toContain("SIGTERM");
    },
  );
});

async function spawnTree(): Promise<{ leader: OwnedChild; descendantPid: number }> {
  const leader = spawnOwned(
    process.execPath,
    [
      "-e",
      'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "process.on(\\"SIGHUP\\", () => {}); process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(child.pid) + "\\n"); setInterval(() => {}, 1000);',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  owned.push(leader.pid);
  const descendantPid = Number(await firstLine(leader));
  return { leader, descendantPid };
}

function firstLine(owner: OwnedChild): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    owner.child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end !== -1) resolve(text.slice(0, end).trim());
    });
    owner.child.once("close", (code) =>
      reject(new Error(`child exited ${String(code)} before a line`)),
    );
  });
}

function exited(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
