import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  assertOutsideLiveProfiles,
  browserIsOwned,
  LAUNCH_PREFS,
  prepareProfile,
  renderUserJs,
} from "./browser.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("browser profile", () => {
  it("writes the prefs that let an isolated window load an experiment", async () => {
    const directory = await prepareProfile(null);
    directories.push(directory);
    const userJs = await NodeFSP.readFile(NodePath.join(directory, "user.js"), "utf8");
    expect(userJs).toBe(renderUserJs(LAUNCH_PREFS));
    expect(userJs).toContain('user_pref("extensions.experiments.enabled", true);');
    expect(userJs).toContain('user_pref("xpinstall.signatures.required", false);');
    expect(userJs).toContain('user_pref("extensions.autoDisableScopes", 0);');
    expect(userJs).toContain('user_pref("devtools.debugger.remote-enabled", true);');
    expect(userJs).toContain('user_pref("remote.active-protocols", 2);');
    expect(directory.startsWith(NodeOS.tmpdir())).toBe(true);
  });

  it("treats the browser as owned only when it is the spawned process or its child", () => {
    expect(browserIsOwned(5, 5, null)).toBe(true);
    expect(browserIsOwned(6, 5, 5)).toBe(true);
    expect(browserIsOwned(6, 5, 4)).toBe(false);
  });

  it("refuses a directory inside the live Zen profiles folder", () => {
    const env = { APPDATA: NodePath.join(NodeOS.tmpdir(), "FlotsamAppData") };
    const live = NodePath.join(env.APPDATA, "zen", "Profiles", "abc.default");
    expect(() => assertOutsideLiveProfiles(live, env)).toThrow(/live Zen profile/);
    expect(() => assertOutsideLiveProfiles(NodeOS.tmpdir(), env)).not.toThrow();
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
