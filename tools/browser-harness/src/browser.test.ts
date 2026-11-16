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
  renderUserJs,
} from "./browser.ts";
import { currentPlatformName } from "./owned-process.ts";

const directories: string[] = [];

afterEach(async () => {
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
      "/tmp/har-anytime-browser-abc",
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
      "/var/folders/xy/T/har-anytime-browser-abc",
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
    accepted: ["C:\\Users\\u\\AppData\\Local\\Temp\\har-anytime-browser-abc"],
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
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "har-anytime-guard-"));
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
    const unpacked = await makeUnpacked("unpacked@har-anytime");
    const unpackedProfile = await prepareProfile(unpacked);
    directories.push(unpackedProfile);
    const proxy = await NodeFSP.readFile(
      NodePath.join(unpackedProfile, "extensions", "unpacked@har-anytime"),
      "utf8",
    );
    expect(proxy).toBe(unpacked);

    const xpi = await makeXpi("packed@har-anytime");
    const packedProfile = await prepareProfile(xpi);
    directories.push(packedProfile);
    const copied = await NodeFSP.stat(
      NodePath.join(packedProfile, "extensions", "packed@har-anytime.xpi"),
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
      const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "har-anytime-fake-"));
      directories.push(scratch);
      const argsFile = NodePath.join(scratch, "args");
      const binary = NodePath.join(scratch, "browser");
      await NodeFSP.writeFile(
        binary,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho "fake browser refused to start" >&2\nexit 3\n`,
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
      expect(args[0]).toBe("-headless");
      expect(args).toContain("-no-remote");
      if (protocol === "bidi") {
        expect(args).toContain("--remote-debugging-port");
        expect(args).not.toContain("-marionette");
      } else {
        expect(args).toContain("-marionette");
        expect(args).not.toContain("--remote-debugging-port");
      }
      const profile = args[args.indexOf("-profile") + 1] ?? "";
      expect(profile.startsWith(NodeOS.tmpdir())).toBe(true);
      expect(NodeFS.existsSync(profile)).toBe(false);
    },
  );
});

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function makeUnpacked(id: string): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "har-anytime-ext-"));
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
