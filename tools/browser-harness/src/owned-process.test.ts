import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { removeDirectoryBounded, stopOwnedTree } from "./owned-process.ts";
import {
  currentPlatformName,
  parseDarwinProcessTable,
  parseLinuxProcess,
  parseWin32ProcessTable,
  PROCESS_PLATFORMS,
} from "./process-table.ts";
import { adoptSpawnedChild, decideSignal, redeemOrder, type Ownership } from "./signal-policy.ts";
import { HARNESS, processIdentity, simulateProcesses } from "./simulated-process-io.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("process tables", () => {
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

  it("reads parent, group, start time and arguments from /proc text, and drops zombies and exiting processes", () => {
    const stat = (state: string) =>
      `4242 (a) b (c) d) ${state} 4100 4200 4200 0 -1 4194560 1 0 0 0 250 50 0 0 20 0 30 0 987654 1000 2560\n`;
    expect(parseLinuxProcess(4242, stat("S"), "/opt/zen/zen\0-profile\0/tmp/p\0")).toEqual({
      pid: 4242,
      parentPid: 4100,
      pgrp: 4200,
      startTime: "987654",
      args: ["/opt/zen/zen", "-profile", "/tmp/p"],
      commandLine: "/opt/zen/zen -profile /tmp/p",
    });
    expect(parseLinuxProcess(4242, stat("Z"), "/opt/zen/zen\0")).toBeUndefined();
    expect(parseLinuxProcess(4242, stat("S"), "")).toBeUndefined();
  });

  it("parses whole-table listings from ps on macOS and Win32_Process on Windows", () => {
    const darwin = parseDarwinProcessTable(
      "  501   1  501 Mon Nov 16 12:00:00 2026     /Applications/Zen.app/zen -profile /tmp/one-click-har-browser-a\n",
    );
    expect(darwin.get(501)).toMatchObject({
      parentPid: 1,
      pgrp: 501,
      startTime: "Mon Nov 16 12:00:00 2026",
      args: ["/Applications/Zen.app/zen", "-profile", "/tmp/one-click-har-browser-a"],
    });
    const win32 = parseWin32ProcessTable(
      "4100\t900\t638990000000000000\tC:\\zen\\zen.exe -profile C:\\T\\one-click-har-browser-a\r\n12\t4\t1\t\r\n",
    );
    expect(win32.get(4100)).toMatchObject({
      parentPid: 900,
      pgrp: null,
      startTime: "638990000000000000",
    });
    expect(win32.has(12)).toBe(false);
  });

  it("refuses a platform outside the table", () => {
    expect(() => currentPlatformName("aix")).toThrow(/unsupported platform aix/);
  });
});

const PROFILE = "/tmp/one-click-har-browser-abc";

// A browser leading group 5000, a content process in its group, a helper that left the group but
// names the profile, and two bystanders: one in its own group and one in the harness's group.
function browserTree() {
  return [
    processIdentity(5000, { args: ["/opt/zen/zen", "-profile", PROFILE] }),
    processIdentity(5001, { parentPid: 5000, pgrp: 5000, args: ["/opt/zen/zen", "-contentproc"] }),
    processIdentity(5100, {
      parentPid: 5000,
      args: ["/opt/zen/zen", "-profile", PROFILE, "-helper"],
    }),
    processIdentity(7000, { args: ["/usr/bin/editor"] }),
    processIdentity(7001, { parentPid: 2000, pgrp: 1900, args: ["/usr/bin/sibling"] }),
  ];
}

const browserRoot = (startTime = "50000", profileDir: string | null = PROFILE): Ownership =>
  adoptSpawnedChild({ pid: 5000, startTime, profileDir });

describe("stopping an owned tree", () => {
  it("sends SIGTERM to the browser's group and to profile holders outside it, and nothing else", async () => {
    const world = simulateProcesses(browserTree());
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([
      { rawTarget: -5000, signal: "SIGTERM", at: 0 },
      { rawTarget: 5100, signal: "SIGTERM", at: 0 },
    ]);
    expect([5000, 5001, 5100].map(world.running)).toEqual([false, false, false]);
    expect([7000, 7001, 2000, 1800, 1].map(world.running)).toEqual([true, true, true, true, true]);
  });

  it("escalates to SIGKILL for the whole tree at 1500 ms when SIGTERM is ignored", async () => {
    const world = simulateProcesses(browserTree(), {
      survives: { 5000: "SIGTERM", 5001: "SIGTERM", 5100: "SIGTERM" },
    });
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([
      { rawTarget: -5000, signal: "SIGTERM", at: 0 },
      { rawTarget: 5100, signal: "SIGTERM", at: 0 },
      { rawTarget: -5000, signal: "SIGKILL", at: 1500 },
      { rawTarget: 5100, signal: "SIGKILL", at: 1500 },
    ]);
    expect([5000, 5001, 5100, 7000].map(world.running)).toEqual([false, false, false, true]);
  });

  it("gives up at the 5000 ms deadline when a process survives SIGKILL, without other signals", async () => {
    const world = simulateProcesses(browserTree(), { survives: { 5000: "everything" } });
    await expect(stopOwnedTree(world.io, browserRoot())).rejects.toThrow(
      /owned process still running: 5000$/,
    );
    expect(world.sent.map((s) => `${String(s.rawTarget)} ${s.signal} @${String(s.at)}`)).toEqual([
      "-5000 SIGTERM @0",
      "5100 SIGTERM @0",
      "-5000 SIGKILL @1500",
    ]);
  });

  it("after the root exited, stops only processes naming its profile, never members of a group a reused PID could lead", async () => {
    const tree = browserTree().filter((identity) => identity.pid !== 5000);
    const world = simulateProcesses(tree);
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([{ rawTarget: 5100, signal: "SIGTERM", at: 0 }]);
    expect(world.running(5001)).toBe(true);
  });

  it("leaves a process alone when its PID now has another start time", async () => {
    const world = simulateProcesses([processIdentity(5000, { args: ["/usr/bin/other"] })]);
    await stopOwnedTree(world.io, browserRoot("49999"));
    expect(world.sent).toEqual([]);
    expect(world.running(5000)).toBe(true);
  });

  it("on Windows signals the root process itself, since there are no process groups", async () => {
    const world = simulateProcesses(
      [processIdentity(5000, { pgrp: null, args: ["zen.exe", "-profile", PROFILE] })],
      { groupSignals: false },
    );
    await stopOwnedTree(world.io, browserRoot());
    expect(world.sent).toEqual([{ rawTarget: 5000, signal: "SIGTERM", at: 0 }]);
  });

  const forged = { pid: 5000, startTime: "50000", profileDir: PROFILE } as unknown as Ownership;
  it.each([
    { name: "a forged ownership record", root: forged, refusal: /not spawned in this run/ },
    {
      name: "PID 1",
      root: adoptSpawnedChild({ pid: 1, startTime: "10", profileDir: null }),
      refusal: /integer greater than 1/,
    },
    {
      name: "the harness itself",
      root: adoptSpawnedChild({ pid: HARNESS.pid, startTime: "20000", profileDir: null }),
      refusal: /harness pid/,
    },
    {
      name: "the harness's parent",
      root: adoptSpawnedChild({ pid: HARNESS.parentPid, startTime: "18000", profileDir: null }),
      refusal: /harness parent pid/,
    },
    {
      name: "the harness's process group",
      root: adoptSpawnedChild({ pid: 1900, startTime: "19000", profileDir: null }),
      refusal: /harness process group/,
    },
    {
      name: "a root that does not lead its group",
      root: adoptSpawnedChild({ pid: 5500, startTime: "55000", profileDir: null }),
      refusal: /process group 5000 is not led by 5500/,
    },
    {
      name: "a root whose command line lacks the profile path",
      root: adoptSpawnedChild({ pid: 7000, startTime: "70000", profileDir: PROFILE }),
      refusal: /profile path .* missing from command line/,
    },
  ])("refuses $name and never reaches the performer", async ({ root, refusal }) => {
    const world = simulateProcesses([
      ...browserTree(),
      processIdentity(1900, { parentPid: 1800, pgrp: 1900, args: ["/bin/sh", "-c", "make"] }),
      processIdentity(5500, { parentPid: 5000, pgrp: 5000, args: ["/opt/zen/zen", "-gpu"] }),
    ]);
    await expect(stopOwnedTree(world.io, root)).rejects.toThrow(refusal);
    expect(world.sent).toEqual([]);
  });
});

describe("signal orders", () => {
  it("are performed once, and only when decideSignal issued them", () => {
    const world = simulateProcesses(browserTree());
    const decision = decideSignal({
      target: { id: 5000, kind: "group" },
      signal: "SIGTERM",
      owner: browserRoot(),
      self: HARNESS,
      table: world.io.table(),
      groupSignals: true,
    });
    if (decision.verdict !== "send") throw new Error(decision.reason);
    expect(redeemOrder(decision.order)).toEqual({ rawTarget: -5000, signal: "SIGTERM" });
    expect(() => redeemOrder(decision.order)).toThrow(/already used/);
    const forgedOrder = { rawTarget: -1, signal: "SIGKILL" } as unknown as typeof decision.order;
    expect(() => world.io.perform(forgedOrder)).toThrow(/did not issue/);
    expect(world.sent).toEqual([]);
  });
});

describe("profile directory removal", () => {
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
        await expect(removeDirectoryBounded(simulateProcesses([]).io, locked)).rejects.toThrow(
          /profile removal exited 1[\s\S]*EACCES/,
        );
      } finally {
        await NodeFSP.chmod(parent, 0o755);
        await NodeFSP.chmod(locked, 0o755);
      }
    },
  );
});
