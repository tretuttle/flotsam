import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { killProcessTree, readWorkingSetBytes, releaseOwnedProfile } from "./owned-process.ts";

const leftover: number[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const pid of leftover.splice(0)) killProcessTree(pid);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("owned processes", () => {
  it("reads a positive working set for this process", () => {
    expect(readWorkingSetBytes(process.pid)).toBeGreaterThan(0);
  });

  it("kills the spawned process tree and leaves an unrelated process running", async () => {
    const owned = await spawnSleeperTree();
    const unrelated = spawnSleeper();
    leftover.push(unrelated, owned.childPid);
    killProcessTree(owned.parentPid);
    await exited(owned.parent);
    expect(alive(owned.parentPid)).toBe(false);
    expect(alive(owned.childPid)).toBe(false);
    expect(alive(unrelated)).toBe(true);
    killProcessTree(owned.parentPid);
  });

  it("deletes a directory only after the process holding a file in it is dead", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "har-anytime-profile-"));
    directories.push(directory);
    const lock = NodePath.join(directory, "parent.lock");
    const owned = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"); const fd=fs.openSync(process.argv[1],"w"); fs.writeSync(fd,"lock"); process.stdout.write("ready\\n"); setInterval(()=>{},1000);',
        lock,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    if (owned.pid === undefined) throw new Error("lock holder did not start");
    leftover.push(owned.pid);
    await readReady(owned);
    const unrelated = spawnSleeper();
    leftover.push(unrelated);
    await releaseOwnedProfile([owned.pid], directory);
    await releaseOwnedProfile([owned.pid], directory);
    expect(alive(owned.pid)).toBe(false);
    expect(alive(unrelated)).toBe(true);
    await expect(NodeFSP.stat(directory)).rejects.toThrow();
    killProcessTree(unrelated);
  });
});

async function spawnSleeperTree(): Promise<{
  parent: NodeChildProcess.ChildProcess;
  parentPid: number;
  childPid: number;
}> {
  const parent = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true}); if(!child.pid) process.exit(2); process.stdout.write(String(child.pid)+"\\n"); setInterval(()=>{},1000);',
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  if (parent.pid === undefined) throw new Error("sleeper did not start");
  leftover.push(parent.pid);
  const childPid = await readPidLine(parent);
  return { parent, parentPid: parent.pid, childPid };
}

function spawnSleeper(): number {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (child.pid === undefined) throw new Error("unrelated sleeper did not start");
  child.unref();
  return child.pid;
}

function readReady(child: NodeChildProcess.ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited ${String(code)}`)));
  });
}

function readPidLine(child: NodeChildProcess.ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const line = text.split("\n")[0];
      if (line !== undefined && line.length > 0 && text.includes("\n")) {
        resolve(Number(line));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`sleeper exited ${String(code)} before printing a pid`)),
    );
  });
}

function exited(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
