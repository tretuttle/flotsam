import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  assertOutsideLiveProfiles,
  BROWSER_PLATFORMS,
  browserIsOwned,
  LAUNCH_PREFS,
  launchBrowser,
  liveProfileRoots,
  prepareProfile,
  readExtensionId,
  renderUserJs,
} from "./browser.ts";
import { leaseDirectory } from "./orphan-lease.ts";
import {
  currentPlatformName,
  killOwnedTree,
  pidAlive,
  readProcessIdentity,
  spawnOwned,
} from "./owned-process.ts";

const directories: string[] = [];
const cleanupPids: number[] = [];

afterEach(async () => {
  for (const pid of cleanupPids.splice(0)) await killOwnedTree(pid, []);
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

const LIVE_PROFILES = {
  linux: {
    home: "/home/u",
    env: {},
    refused: [
      "/home/u/.zen/abc.Default (release)",
      "/home/u/.mozilla/firefox/x.default-release",
      "/home/u/.librewolf/y.default-default",
      "/home/u/.floorp/z.default",
      "/home/u/.waterfox/w.default",
      "/home/u/.config/mozilla/firefox/p.default",
      "/home/u/.config/librewolf/p",
      "/home/u/.config/floorp/p",
      "/home/u/.config/waterfox/p",
      "/home/u/.cache/mozilla/firefox/p.default",
      "/home/u/.var/app/app.zen_browser.zen/.zen/p",
      "/home/u/.var/app/org.mozilla.firefox/.mozilla/firefox/p",
      "/home/u/snap/firefox/common/.mozilla/firefox/p",
    ],
    accepted: [
      "/tmp/one-click-har-browser-abc",
      "/home/u/.zenith/p",
      "/home/u/.Mozilla/firefox/p",
      "/home/u/projects/.mozilla-notes",
    ],
  },
  darwin: {
    home: "/Users/u",
    env: {},
    refused: [
      "/Users/u/Library/Application Support/zen/Profiles/p.Default (release)",
      "/Users/u/Library/Application Support/Firefox/Profiles/p.default-release",
      "/Users/u/Library/Application Support/firefox/Profiles/p",
      "/Users/u/Library/Application Support/librewolf/Profiles/p",
      "/Users/u/Library/Caches/Firefox/Profiles/p",
      "/Users/u/Library/Caches/zen/Profiles/p",
    ],
    accepted: [
      "/var/folders/xy/T/one-click-har-browser-abc",
      "/Users/u/Library/Application Support/Code",
    ],
  },
  win32: {
    home: "C:\\Users\\u",
    env: {
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    },
    refused: [
      "C:\\Users\\u\\AppData\\Roaming\\zen\\Profiles\\p.Default (release)",
      "C:\\Users\\u\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\p.default-release",
      "C:\\Users\\u\\AppData\\Roaming\\mozilla\\Firefox\\Profiles\\p",
      "C:\\Users\\u\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\p.default-release",
      "C:\\Users\\u\\AppData\\Roaming\\librewolf\\Profiles\\p",
      "C:\\Users\\u\\AppData\\Roaming\\Floorp\\Profiles\\p",
      "C:\\Users\\u\\AppData\\Roaming\\Waterfox\\Profiles\\p",
      "C:\\Users\\u\\AppData\\Local\\zen\\Profiles\\p",
    ],
    accepted: ["C:\\Users\\u\\AppData\\Local\\Temp\\one-click-har-browser-abc"],
  },
} as const;

describe("browser profile", () => {
  it("writes the prefs that let an isolated browser load an experiment", async () => {
    const directory = await prepareProfile(null);
    directories.push(directory);
    const userJs = await NodeFSP.readFile(NodePath.join(directory, "user.js"), "utf8");
    expect(userJs).toBe(renderUserJs(LAUNCH_PREFS));
    expect(userJs).toContain('user_pref("extensions.experiments.enabled", true);');
    expect(userJs).toContain('user_pref("xpinstall.signatures.required", false);');
    expect(userJs).toContain('user_pref("remote.active-protocols", 1);');
  });

  it("treats the browser as owned only when it is the spawned process or its child", () => {
    expect(browserIsOwned(5, 5, null)).toBe(true);
    expect(browserIsOwned(6, 5, 5)).toBe(true);
    expect(browserIsOwned(6, 5, 4)).toBe(false);
  });

  it("never passes -wait-for-browser on Linux or macOS", () => {
    expect(BROWSER_PLATFORMS.linux.launcherArgs).toEqual([]);
    expect(BROWSER_PLATFORMS.darwin.launcherArgs).toEqual([]);
    expect(BROWSER_PLATFORMS.win32.launcherArgs).toEqual(["-wait-for-browser"]);
  });

  it.each(Object.entries(LIVE_PROFILES))(
    "on %s refuses every live Zen and Firefox family profile and nothing else",
    (platform, sample) => {
      const name = platform as keyof typeof LIVE_PROFILES;
      const roots = liveProfileRoots(name, sample.env, sample.home);
      const path = BROWSER_PLATFORMS[name].path;
      const caseFold = name !== "linux";
      for (const directory of sample.refused) {
        expect(
          () => assertOutsideLiveProfiles(directory, roots, path, caseFold),
          directory,
        ).toThrow(/inside the live profile root/);
      }
      for (const directory of sample.accepted) {
        expect(
          () => assertOutsideLiveProfiles(directory, roots, path, caseFold),
          directory,
        ).not.toThrow();
      }
    },
  );

  it("follows XDG_CONFIG_HOME and refuses when Windows cannot name its profile roots", () => {
    const roots = liveProfileRoots("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/u");
    expect(() =>
      assertOutsideLiveProfiles("/xdg/mozilla/firefox/p", roots, NodePath.posix),
    ).toThrow();
    expect(() => liveProfileRoots("win32", {}, "C:\\Users\\u")).toThrow(/APPDATA is not set/);
  });

  it("refuses a symlinked temporary directory that resolves inside a live profile before creating one", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-guard-"));
    directories.push(scratch);
    const home = NodePath.join(scratch, "home");
    const live = NodePath.join(home, ".mozilla");
    const link = NodePath.join(scratch, "tmp-link");
    await NodeFSP.mkdir(live, { recursive: true });
    await NodeFSP.symlink(live, link);
    await NodeFSP.chmod(live, 0o555);
    const previous = {
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    };
    process.env.HOME = home;
    process.env.TMPDIR = link;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CACHE_HOME;
    try {
      await expect(prepareProfile(null)).rejects.toThrow(/inside the live profile root/);
      expect(await NodeFSP.readdir(live)).toEqual([]);
    } finally {
      await NodeFSP.chmod(live, 0o755);
      restoreEnv(previous);
    }
  });

  it("sideloads an unpacked extension and an xpi by gecko id", async () => {
    const unpacked = await makeUnpacked("unpacked@one-click-har");
    const unpackedProfile = await prepareProfile(unpacked);
    directories.push(unpackedProfile);
    const proxy = await NodeFSP.readFile(
      NodePath.join(unpackedProfile, "extensions", "unpacked@one-click-har"),
      "utf8",
    );
    expect(proxy).toBe(unpacked);

    const xpi = await makeXpi("packed@one-click-har");
    expect(await readExtensionId(unpacked)).toBe("unpacked@one-click-har");
    expect(await readExtensionId(xpi)).toBe("packed@one-click-har");
    const packedProfile = await prepareProfile(xpi);
    directories.push(packedProfile);
    const copied = await NodeFSP.stat(
      NodePath.join(packedProfile, "extensions", "packed@one-click-har.xpi"),
    );
    expect(copied.isFile()).toBe(true);
  });
});

// A POSIX shell script stands in for the browser. Windows cannot spawn a script without a shell,
// so this case runs where the platform starts children as process group leaders.
describe.runIf(currentPlatformName() !== "win32")("browser launch", () => {
  it.each(["bidi", "marionette"] as const)(
    "asks for a headless %s browser and leaves no profile or process when it exits at startup",
    async (protocol) => {
      const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-fake-"));
      directories.push(scratch);
      const argsFile = NodePath.join(scratch, "args");
      const prefsFile = NodePath.join(scratch, "user.js");
      const binary = NodePath.join(scratch, "browser");
      await NodeFSP.writeFile(
        binary,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncp "$4/user.js" '${prefsFile}' 2>/dev/null || true\necho "fake browser refused to start" >&2\nexit 3\n`,
        { mode: 0o755 },
      );
      await expect(
        launchBrowser({
          binaryPath: binary,
          extensionPath: null,
          display: "headless",
          protocol,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/browser exited with code 3[\s\S]*fake browser refused to start/);
      const args = (await NodeFSP.readFile(argsFile, "utf8")).trim().split("\n");
      const prefs = await NodeFSP.readFile(prefsFile, "utf8");
      expect(args[0]).toBe("-headless");
      expect(args).toContain("-no-remote");
      expect(args).not.toContain("-wait-for-browser");
      if (protocol === "bidi") {
        expect(args).toContain("--remote-debugging-port");
        expect(args).not.toContain("-marionette");
        expect(prefs).not.toContain("marionette.port");
      } else {
        expect(args).toContain("-marionette");
        expect(args).not.toContain("--remote-debugging-port");
        expect(prefs).toMatch(/user_pref\("marionette\.port", \d+\);/);
      }
      const profile = args[args.indexOf("-profile") + 1] ?? "";
      expect(profile.startsWith(NodeOS.tmpdir())).toBe(true);
      expect(NodeFS.existsSync(profile)).toBe(false);
    },
  );

  it("writes remote.prefs.recommended=false in real-defaults mode and omits remote flags/prefs in none mode", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-mode-"));
    directories.push(scratch);
    const argsFile = NodePath.join(scratch, "args");
    const prefsFile = NodePath.join(scratch, "user.js");
    const binary = NodePath.join(scratch, "browser");
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncp "$4/user.js" '${prefsFile}' 2>/dev/null || true\nexit 0\n`,
      { mode: 0o755 },
    );

    await expect(
      launchBrowser({
        binaryPath: binary,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        launchMode: "real-defaults",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/browser exited with code 0/);
    expect(await NodeFSP.readFile(prefsFile, "utf8")).toContain(
      'user_pref("remote.prefs.recommended", false);',
    );

    const session = await launchBrowser({
      binaryPath: binary,
      extensionPath: null,
      display: "headless",
      launchMode: "none",
      urls: ["file:///tmp/example.html"],
      signal: new AbortController().signal,
    });
    expect(await session.exited).toBe("code 0");
    const noneArgs = (await NodeFSP.readFile(argsFile, "utf8")).trim().split("\n");
    const nonePrefs = await NodeFSP.readFile(prefsFile, "utf8");
    expect(noneArgs).toContain("file:///tmp/example.html");
    expect(noneArgs).not.toContain("-marionette");
    expect(noneArgs).not.toContain("--remote-debugging-port");
    expect(noneArgs).not.toContain("-wait-for-browser");
    expect(nonePrefs).not.toContain("devtools.debugger.remote-enabled");
    expect(nonePrefs).not.toContain("remote.active-protocols");
    expect(nonePrefs).not.toContain("marionette.port");
    await session[Symbol.asyncDispose]();
  });

  it("enables HTTP cache prefs only when cache: true is requested", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-cache-"));
    directories.push(scratch);
    const prefsFile = NodePath.join(scratch, "user.js");
    const binary = NodePath.join(scratch, "browser");
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh\ncp "$4/user.js" '${prefsFile}' 2>/dev/null || true\nexit 1\n`,
      { mode: 0o755 },
    );

    await expect(
      launchBrowser({
        binaryPath: binary,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        cache: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/browser exited with code 1/);
    const enabled = await NodeFSP.readFile(prefsFile, "utf8");
    expect(enabled).toContain('user_pref("network.http.use-cache", true);');
    expect(enabled).toContain('user_pref("browser.cache.disk.enable", true);');
    expect(enabled).toContain('user_pref("browser.cache.memory.enable", true);');
  });

  it("fails immediately on early exit with buffered stderr even when a descendant keeps stderr open", async () => {
    const scratch = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "one-click-har-desc-stderr-"),
    );
    directories.push(scratch);
    const binary = NodePath.join(scratch, "browser");
    await NodeFSP.writeFile(
      binary,
      `#!/bin/sh\nsleep 30 &\necho "boom: browser crashed at startup" >&2\nexit 3\n`,
      { mode: 0o755 },
    );
    const started = Date.now();
    await expect(
      launchBrowser({
        binaryPath: binary,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      /browser exited with code 3 before remote control opened[\s\S]*boom: browser crashed at startup/,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reports exit signal and stderr when a connected browser dies mid-session, kills its tree on dispose, and reaps prior orphans on launch", async () => {
    const scratch = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "one-click-har-fake-marionette-"),
    );
    directories.push(scratch);

    // Plant an orphan lease + live orphan process so launchBrowser proves it reaps on startup.
    const orphanProfile = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "one-click-har-browser-orphan-"),
    );
    directories.push(orphanProfile);
    const orphan = spawnOwned(process.execPath, [
      "-e",
      `// ${orphanProfile}\nsetInterval(() => {}, 1000);`,
    ]);
    cleanupPids.push(orphan.pid);
    const orphanIdentity = readProcessIdentity(orphan.pid);
    expect(orphanIdentity).not.toBeNull();
    const orphanLeaseDir = leaseDirectory();
    await NodeFSP.mkdir(orphanLeaseDir, { recursive: true, mode: 0o700 });
    const orphanLease = NodePath.join(orphanLeaseDir, `test-orphan-${String(Date.now())}.json`);
    await NodeFSP.writeFile(
      orphanLease,
      JSON.stringify({
        version: 2,
        harnessPid: 999_999_999,
        harnessStartTime: "1",
        spawnedPid: orphan.pid,
        spawnedStartTime: orphanIdentity?.startTime,
        profileDir: orphanProfile,
        createdAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const serverScript = NodePath.join(scratch, "fake-marionette.mjs");
    await NodeFSP.writeFile(
      serverScript,
      `import * as NodeFS from "node:fs";
       import * as NodeNet from "node:net";
       import * as NodePath from "node:path";
       const idx = process.argv.indexOf("-profile");
       const profile = process.argv[idx + 1];
       const userJs = NodeFS.readFileSync(NodePath.join(profile, "user.js"), "utf8");
       const port = Number(/user_pref\\("marionette\\.port", (\\d+)\\)/.exec(userJs)[1]);
       const server = NodeNet.createServer((socket) => {
         const send = (obj) => {
           const buf = Buffer.from(JSON.stringify(obj), "utf8");
           socket.write(buf.length + ":" + buf.toString("utf8"));
         };
         send({ applicationType: "gecko", marionetteProtocol: 3 });
         let buf = Buffer.alloc(0);
         socket.on("data", (chunk) => {
           buf = Buffer.concat([buf, chunk]);
           while (buf.length > 0) {
             const colon = buf.indexOf(0x3a);
             if (colon <= 0) return;
             const len = Number(buf.subarray(0, colon).toString("ascii"));
             if (buf.length < colon + 1 + len) return;
             const raw = buf.subarray(colon + 1, colon + 1 + len).toString("utf8");
             buf = buf.subarray(colon + 1 + len);
             const msg = JSON.parse(raw);
             if (!Array.isArray(msg)) continue;
             const [, id, cmd] = msg;
             if (cmd === "WebDriver:NewSession") {
               send([1, id, null, { sessionId: "1", capabilities: { "moz:processID": process.pid, browserName: "zen", browserVersion: "1.25t", "moz:buildID": "20261115114312", userAgent: "Fake/1.0" } }]);
             } else if (cmd === "WebDriver:GetWindowHandle") {
               send([1, id, null, { value: "win-1" }]);
             } else if (cmd === "WebDriver:NewWindow") {
               process.stderr.write("fatal mid-session stderr\\n");
               process.kill(process.pid, "SIGKILL");
             }
           }
         });
       });
       server.listen(port, "127.0.0.1");
       setInterval(() => {}, 1000);`,
      "utf8",
    );
    const fakeBin = NodePath.join(scratch, "browser");
    await NodeFSP.writeFile(
      fakeBin,
      `#!/bin/sh\nexec '${process.execPath}' '${serverScript}' "$@"\n`,
      { mode: 0o755 },
    );

    let spawnedPid = 0;
    {
      await using session = await launchBrowser({
        binaryPath: fakeBin,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        signal: new AbortController().signal,
      });
      spawnedPid = session.spawnedPid;
      expect(pidAlive(orphan.pid)).toBe(false);
      expect(NodeFS.existsSync(orphanLease)).toBe(false);
      await expect(session.openTab("about:blank")).rejects.toThrow(
        /Marionette socket closed \(browser exited with signal SIGKILL\)[\s\S]*fatal mid-session stderr/,
      );
    }

    // Verify normal dispose kills a hung connected browser tree too.
    const hangBin = NodePath.join(scratch, "browser-hang");
    const hangScript = NodePath.join(scratch, "fake-marionette-hang.mjs");
    await NodeFSP.writeFile(
      hangScript,
      `import * as NodeFS from "node:fs";
       import * as NodeNet from "node:net";
       import * as NodePath from "node:path";
       const idx = process.argv.indexOf("-profile");
       const profile = process.argv[idx + 1];
       const userJs = NodeFS.readFileSync(NodePath.join(profile, "user.js"), "utf8");
       const port = Number(/user_pref\\("marionette\\.port", (\\d+)\\)/.exec(userJs)[1]);
       const server = NodeNet.createServer((socket) => {
         const send = (obj) => {
           const buf = Buffer.from(JSON.stringify(obj), "utf8");
           socket.write(buf.length + ":" + buf.toString("utf8"));
         };
         send({ applicationType: "gecko", marionetteProtocol: 3 });
         let buf = Buffer.alloc(0);
         socket.on("data", (chunk) => {
           buf = Buffer.concat([buf, chunk]);
           while (buf.length > 0) {
             const colon = buf.indexOf(0x3a);
             if (colon <= 0) return;
             const len = Number(buf.subarray(0, colon).toString("ascii"));
             if (buf.length < colon + 1 + len) return;
             const raw = buf.subarray(colon + 1, colon + 1 + len).toString("utf8");
             buf = buf.subarray(colon + 1 + len);
             const msg = JSON.parse(raw);
             if (!Array.isArray(msg)) continue;
             const [, id, cmd] = msg;
             if (cmd === "WebDriver:NewSession") {
               send([1, id, null, { sessionId: "1", capabilities: { "moz:processID": process.pid, browserName: "zen", browserVersion: "1.25t", "moz:buildID": "20261115114312", userAgent: "Fake/1.0" } }]);
             } else if (cmd === "WebDriver:GetWindowHandle") {
               send([1, id, null, { value: "win-1" }]);
             }
           }
         });
       });
       server.listen(port, "127.0.0.1");
       setInterval(() => {}, 1000);`,
      "utf8",
    );
    await NodeFSP.writeFile(
      hangBin,
      `#!/bin/sh\nexec '${process.execPath}' '${hangScript}' "$@"\n`,
      { mode: 0o755 },
    );
    let hungPid = 0;
    {
      await using session = await launchBrowser({
        binaryPath: hangBin,
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        signal: new AbortController().signal,
      });
      hungPid = session.spawnedPid;
      expect(pidAlive(hungPid)).toBe(true);
    }
    expect(pidAlive(hungPid)).toBe(false);
    void spawnedPid;
  });
});

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function makeUnpacked(id: string): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-ext-"));
  directories.push(directory);
  await NodeFSP.writeFile(NodePath.join(directory, "manifest.json"), manifest(id), "utf8");
  return directory;
}

async function makeXpi(id: string): Promise<string> {
  const directory = await makeUnpacked(id);
  const xpi = NodePath.join(directory, "addon.xpi");
  await NodeFSP.writeFile(xpi, storedZip("manifest.json", Buffer.from(manifest(id), "utf8")));
  return xpi;
}

function storedZip(name: string, payload: Buffer): Buffer {
  const crc = NodeZlib.crc32(payload);
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBytes.length, 12);
  eocd.writeUInt32LE(30 + nameBytes.length + payload.length, 16);
  return Buffer.concat([local, nameBytes, payload, central, nameBytes, eocd]);
}

function manifest(id: string): string {
  return `${JSON.stringify({
    manifest_version: 2,
    name: "probe",
    version: "1.0.0",
    browser_specific_settings: { gecko: { id } },
  })}\n`;
}
