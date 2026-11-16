import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { parentPidOf, releaseOwnedProfile } from "./owned-process.ts";
import { connectRemote, type RemoteControl, type RemoteProtocol } from "./remote.ts";
import { readZipEntry } from "./zip.ts";

export type Pref = {
  readonly name: string;
  readonly value: boolean | number | string;
};

export const LAUNCH_PREFS: readonly Pref[] = [
  { name: "extensions.experiments.enabled", value: true },
  { name: "xpinstall.signatures.required", value: false },
  { name: "extensions.autoDisableScopes", value: 0 },
  { name: "devtools.debugger.remote-enabled", value: true },
  { name: "remote.active-protocols", value: 2 },
  { name: "browser.shell.checkDefaultBrowser", value: false },
  { name: "datareporting.policy.dataSubmissionEnabled", value: false },
  { name: "toolkit.telemetry.enabled", value: false },
  { name: "app.update.enabled", value: false },
  { name: "app.update.auto", value: false },
  { name: "browser.aboutwelcome.enabled", value: false },
  { name: "trailhead.firstrun.didSeeAboutWelcome", value: true },
  { name: "zen.welcome-screen.seen", value: true },
  { name: "browser.startup.homepage_override.mstone", value: "ignore" },
  { name: "browser.startup.page", value: 0 },
  { name: "browser.startup.homepage", value: "about:blank" },
  { name: "browser.sessionstore.resume_from_crash", value: false },
  { name: "browser.cache.disk.enable", value: false },
  { name: "browser.cache.memory.enable", value: false },
  { name: "network.http.use-cache", value: false },
  { name: "browser.tabs.warnOnClose", value: false },
  { name: "signon.rememberSignons", value: false },
];

export type ZenSession = {
  readonly spawnedPid: number;
  readonly browserPid: number;
  readonly version: string;
  readonly buildId: string;
  readonly userAgent: string;
  readonly remoteProtocol: RemoteProtocol;
  readonly openTab: (url: string) => Promise<string>;
  readonly evaluate: (context: string, expression: string) => Promise<string>;
  readonly closeTab: (context: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

export function renderUserJs(prefs: readonly Pref[]): string {
  return `${prefs
    .map((pref) => `user_pref(${JSON.stringify(pref.name)}, ${JSON.stringify(pref.value)});`)
    .join("\n")}\n`;
}

export function browserIsOwned(
  browserPid: number,
  spawnedPid: number,
  parentPid: number | null,
): boolean {
  return browserPid === spawnedPid || parentPid === spawnedPid;
}

function liveZenProfilesDir(env: NodeJS.ProcessEnv): string | null {
  const appData = env.APPDATA;
  if (appData === undefined || appData.length === 0) return null;
  return NodePath.join(appData, "zen", "Profiles");
}

export function assertOutsideLiveZenProfiles(directory: string, env: NodeJS.ProcessEnv): void {
  const live = liveZenProfilesDir(env);
  if (live === null) return;
  if (isInside(NodePath.resolve(live), NodePath.resolve(directory))) {
    throw new Error(`refusing to use the live Zen profile directory ${directory}`);
  }
}

export async function prepareProfile(
  extensionPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  extraPrefs: readonly Pref[] = [],
): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "har-anytime-zen-"));
  assertOutsideLiveZenProfiles(directory, env);
  await NodeFSP.writeFile(
    NodePath.join(directory, "user.js"),
    renderUserJs([...LAUNCH_PREFS, ...extraPrefs]),
    "utf8",
  );
  if (extensionPath !== null) await installExtension(directory, extensionPath);
  return directory;
}

export async function launchZen(request: {
  binaryPath: string;
  extensionPath: string | null;
}): Promise<ZenSession> {
  await NodeFSP.access(request.binaryPath);
  const bidiPort = await freePort();
  const marionettePort = await freePort();
  const directory = await prepareProfile(request.extensionPath, process.env, [
    { name: "marionette.port", value: marionettePort },
  ]);
  let stderrTail = "";
  const child = NodeChildProcess.spawn(request.binaryPath, launchArguments(directory, bidiPort), {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      MOZ_CRASHREPORTER_DISABLE: "1",
      MOZ_DISABLE_AUTO_UPDATE: "1",
    },
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  child.on("error", () => undefined);
  const spawnedPid = child.pid;
  if (spawnedPid === undefined) {
    await releaseOwnedProfile([], directory);
    throw new Error("Zen did not start");
  }
  let remote: RemoteControl | null = null;
  try {
    remote = await connectRemote({
      bidiPort,
      marionettePort,
      exitCode: () => child.exitCode,
      stderr: () => stderrTail,
    });
    assertOwnedBrowser(remote.browserPid, spawnedPid);
    return sessionFrom(remote, spawnedPid, directory);
  } catch (error) {
    remote?.dispose();
    const pids = remote === null ? [spawnedPid] : [remote.browserPid, spawnedPid];
    try {
      await releaseOwnedProfile(pids, directory);
    } catch (cleanup) {
      throw new Error(`${errorText(error, stderrTail)}\n${errorText(cleanup, "")}`, {
        cause: cleanup,
      });
    }
    throw new Error(errorText(error, stderrTail), { cause: error });
  }
}

function sessionFrom(remote: RemoteControl, spawnedPid: number, directory: string): ZenSession {
  let releasePromise: Promise<void> | null = null;
  return {
    spawnedPid,
    browserPid: remote.browserPid,
    version: remote.version,
    buildId: remote.buildId,
    userAgent: remote.userAgent,
    remoteProtocol: remote.protocol,
    openTab: (url) => remote.openTab(url),
    evaluate: (context, expression) => remote.evaluate(context, expression),
    closeTab: (context) => remote.closeTab(context),
    close: () => {
      if (releasePromise === null) {
        remote.dispose();
        releasePromise = releaseOwnedProfile([remote.browserPid, spawnedPid], directory);
      }
      return releasePromise;
    },
  };
}

function assertOwnedBrowser(browserPid: number, spawnedPid: number): void {
  const parentPid = browserPid === spawnedPid ? null : parentPidOf(browserPid);
  if (!browserIsOwned(browserPid, spawnedPid, parentPid)) {
    throw new Error(
      `browser pid ${String(browserPid)} is not the spawned process ${String(spawnedPid)} or its child`,
    );
  }
}

function launchArguments(directory: string, bidiPort: number): string[] {
  const args = [
    "-no-remote",
    "-profile",
    directory,
    "--remote-debugging-port",
    String(bidiPort),
    "-marionette",
  ];
  if (process.platform === "win32") args.push("-wait-for-browser");
  return args;
}

async function installExtension(profileDir: string, extensionPath: string): Promise<void> {
  const absolute = NodePath.resolve(extensionPath);
  const stat = await NodeFSP.stat(absolute);
  const extensionsDir = NodePath.join(profileDir, "extensions");
  await NodeFSP.mkdir(extensionsDir, { recursive: true });
  if (stat.isDirectory()) {
    const manifest: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(absolute, "manifest.json"), "utf8"),
    );
    const id = readGeckoId(manifest);
    await NodeFSP.writeFile(NodePath.join(extensionsDir, id), absolute, "utf8");
    return;
  }
  const manifest: unknown = JSON.parse(
    (await readZipEntry(absolute, "manifest.json")).toString("utf8"),
  );
  const id = readGeckoId(manifest);
  await NodeFSP.copyFile(absolute, NodePath.join(extensionsDir, `${id}.xpi`));
}

function readGeckoId(manifest: unknown): string {
  const id =
    geckoId(recordField(manifest, "browser_specific_settings")) ??
    geckoId(recordField(manifest, "applications"));
  if (id === undefined) throw new Error("extension manifest has no gecko id");
  return id;
}

function geckoId(settings: unknown): string | undefined {
  const gecko = recordField(settings, "gecko");
  if (!isRecord(gecko)) return undefined;
  const id = gecko.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  return id;
}

function recordField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(parent: string, child: string): boolean {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

async function freePort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no free port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function errorText(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const tail = stderr.trim();
  return tail.length === 0 ? message : `${message}\n${tail}`;
}
