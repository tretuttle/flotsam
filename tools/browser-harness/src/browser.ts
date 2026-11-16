import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  killOwnedTree,
  currentPlatformName,
  readProcessSnapshot,
  removeDirectoryBounded,
  spawnOwned,
  type ProcessPlatformName,
} from "./owned-process.ts";
import { connectRemote, type RemoteProtocol } from "./remote.ts";
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

export type BrowserDisplay = "headless" | "window";

export type BrowserIdentity = {
  readonly binaryPath: string;
  readonly name: string;
  readonly version: string;
  readonly buildId: string;
  readonly userAgent: string;
  readonly remoteProtocol: RemoteProtocol;
  readonly headless: boolean;
};

export type BrowserSession = AsyncDisposable & {
  readonly spawnedPid: number;
  readonly browserPid: number;
  readonly identity: BrowserIdentity;
  readonly openTab: (url: string) => Promise<string>;
  readonly evaluate: (context: string, expression: string) => Promise<string>;
  readonly closeTab: (context: string) => Promise<void>;
};

type LiveRootBase = "HOME" | "APPDATA" | "LOCALAPPDATA" | "XDG_CONFIG_HOME" | "XDG_CACHE_HOME";

type BrowserPlatform = {
  readonly path: NodePath.PlatformPath;
  readonly launcherArgs: readonly string[];
  // Where Zen and the Firefox family keep real profiles. A launch never touches these.
  readonly liveProfileRoots: readonly (readonly [LiveRootBase, ...string[]])[];
};

const FIREFOX_FAMILY_FLATPAKS = [
  "app.zen_browser.zen",
  "org.mozilla.firefox",
  "io.gitlab.librewolf-community",
  "one.ablaze.floorp",
  "net.waterfox.waterfox",
] as const;

export const BROWSER_PLATFORMS: Readonly<Record<ProcessPlatformName, BrowserPlatform>> = {
  win32: {
    path: NodePath.win32,
    launcherArgs: ["-wait-for-browser"],
    liveProfileRoots: (["APPDATA", "LOCALAPPDATA"] as const).flatMap((base) => [
      [base, "zen"],
      [base, "Mozilla"],
      [base, "librewolf"],
      [base, "Floorp"],
      [base, "Waterfox"],
    ]),
  },
  linux: {
    path: NodePath.posix,
    launcherArgs: [],
    liveProfileRoots: [
      ["HOME", ".zen"],
      ["HOME", ".mozilla"],
      ["HOME", ".librewolf"],
      ["HOME", ".floorp"],
      ["HOME", ".waterfox"],
      ["XDG_CONFIG_HOME", "zen"],
      ["XDG_CONFIG_HOME", "mozilla"],
      ["XDG_CACHE_HOME", "zen"],
      ["XDG_CACHE_HOME", "mozilla"],
      ["XDG_CACHE_HOME", "librewolf"],
      ["XDG_CACHE_HOME", "floorp"],
      ["XDG_CACHE_HOME", "waterfox"],
      ["HOME", "snap", "firefox"],
      ...FIREFOX_FAMILY_FLATPAKS.map((id) => ["HOME", ".var", "app", id] as const),
    ],
  },
  darwin: {
    path: NodePath.posix,
    launcherArgs: [],
    liveProfileRoots: (["Application Support", "Caches"] as const).flatMap((folder) =>
      ["zen", "Firefox", "librewolf", "Floorp", "Waterfox"].map(
        (name) => ["HOME", "Library", folder, name] as const,
      ),
    ),
  },
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

export function liveProfileRoots(
  platform: ProcessPlatformName,
  env: NodeJS.ProcessEnv,
  home: string,
): readonly string[] {
  const row = BROWSER_PLATFORMS[platform];
  const base = (name: LiveRootBase): string => {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
    if (name === "HOME") return home;
    if (name === "XDG_CONFIG_HOME") return row.path.join(home, ".config");
    if (name === "XDG_CACHE_HOME") return row.path.join(home, ".cache");
    throw new Error(`cannot locate live browser profiles: ${name} is not set`);
  };
  return row.liveProfileRoots.map(([root, ...segments]) => row.path.join(base(root), ...segments));
}

export function assertOutsideLiveProfiles(
  directory: string,
  roots: readonly string[],
  path: NodePath.PlatformPath = NodePath,
): void {
  for (const root of roots) {
    const relative = path.relative(path.resolve(root), path.resolve(directory));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error(`refusing to use ${directory}: it is inside the live profile root ${root}`);
    }
  }
}

export async function prepareProfile(
  extensionPath: string | null,
  extraPrefs: readonly Pref[] = [],
): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "har-anytime-browser-"));
  try {
    const platform = currentPlatformName();
    const roots = liveProfileRoots(platform, process.env, NodeOS.homedir());
    assertOutsideLiveProfiles(directory, roots);
    assertOutsideLiveProfiles(NodeFS.realpathSync(directory), roots.map(realpathIfPresent));
    await NodeFSP.writeFile(
      NodePath.join(directory, "user.js"),
      renderUserJs([...LAUNCH_PREFS, ...extraPrefs]),
      "utf8",
    );
    if (extensionPath !== null) await installExtension(directory, extensionPath);
    return directory;
  } catch (error) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function launchBrowser(request: {
  readonly binaryPath: string;
  readonly extensionPath: string | null;
  readonly display: BrowserDisplay;
  readonly signal: AbortSignal;
}): Promise<BrowserSession> {
  await using stack = new AsyncDisposableStack();
  const bidiPort = await freePort();
  const marionettePort = await freePort();
  const directory = await prepareProfile(request.extensionPath, [
    { name: "marionette.port", value: marionettePort },
  ]);
  stack.defer(() => removeDirectoryBounded(directory));
  const args = [
    ...(request.display === "headless" ? ["-headless"] : []),
    "-no-remote",
    "-profile",
    directory,
    "--remote-debugging-port",
    String(bidiPort),
    "-marionette",
    ...BROWSER_PLATFORMS[currentPlatformName()].launcherArgs,
  ];
  const spawned = spawnOwned(request.binaryPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1", MOZ_DISABLE_AUTO_UPDATE: "1" },
  });
  let browserPid: number | null = null;
  stack.defer(() => killOwnedTree(spawned.pid, browserPid === null ? [] : [browserPid]));
  let stderrTail = "";
  spawned.child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  const remote = await connectRemote({
    bidiPort,
    marionettePort,
    exitStatus: () => exitStatus(spawned.child),
    stderr: () => stderrTail,
    signal: request.signal,
  });
  stack.defer(() => remote.dispose());
  browserPid = remote.browserPid;
  assertOwnedBrowser(remote.browserPid, spawned.pid);
  const owned = stack.move();
  return {
    spawnedPid: spawned.pid,
    browserPid: remote.browserPid,
    identity: {
      binaryPath: request.binaryPath,
      name: remote.browserName,
      version: remote.version,
      buildId: remote.buildId,
      userAgent: remote.userAgent,
      remoteProtocol: remote.protocol,
      headless: request.display === "headless",
    },
    openTab: (url) => remote.openTab(url),
    evaluate: (context, expression) => remote.evaluate(context, expression),
    closeTab: (context) => remote.closeTab(context),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

function exitStatus(child: { exitCode: number | null; signalCode: string | null }): string | null {
  if (child.exitCode !== null) return `code ${String(child.exitCode)}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return null;
}

function realpathIfPresent(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
}

function assertOwnedBrowser(browserPid: number, spawnedPid: number): void {
  const parentPid = browserPid === spawnedPid ? null : readProcessSnapshot(browserPid).parentPid;
  if (!browserIsOwned(browserPid, spawnedPid, parentPid)) {
    throw new Error(
      `browser pid ${String(browserPid)} is not the spawned process ${String(spawnedPid)} or its child`,
    );
  }
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
