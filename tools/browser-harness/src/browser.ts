import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createLaunchLease, reapOrphanedLaunches } from "./orphan-lease.ts";
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
  { name: "remote.active-protocols", value: 1 },
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
export type BrowserLaunchMode = "recommended" | "real-defaults" | "none";

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
  readonly profileDir: string;
  readonly launchMode: "recommended" | "real-defaults";
  readonly identity: BrowserIdentity;
  readonly openTab: (url: string) => Promise<string>;
  readonly navigateTab: (context: string, url: string) => Promise<void>;
  readonly reloadTab: (context: string) => Promise<void>;
  readonly evaluate: (context: string, expression: string) => Promise<string>;
  readonly evaluateChrome: (script: string, args?: readonly unknown[]) => Promise<unknown>;
  readonly takeChromeScreenshot: (selector?: string) => Promise<Buffer>;
  readonly closeTab: (context: string) => Promise<void>;
  readonly quit: () => Promise<void>;
};

export type UntouchedBrowserSession = AsyncDisposable & {
  readonly spawnedPid: number;
  readonly profileDir: string;
  readonly launchMode: "none";
  readonly exited: Promise<string>;
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
      ["XDG_CONFIG_HOME", "librewolf"],
      ["XDG_CONFIG_HOME", "floorp"],
      ["XDG_CONFIG_HOME", "waterfox"],
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
  const merged = new Map<string, Pref["value"]>();
  for (const pref of prefs) merged.set(pref.name, pref.value);
  return `${[...merged.entries()]
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
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
  caseFold = false,
): void {
  const fold = (value: string): string => (caseFold ? value.toLowerCase() : value);
  for (const root of roots) {
    const relative = path.relative(path.resolve(fold(root)), path.resolve(fold(directory)));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error(`refusing to use ${directory}: it is inside the live profile root ${root}`);
    }
  }
}

function foldsCase(platform: ProcessPlatformName): boolean {
  return platform === "darwin" || platform === "win32";
}

function assertSafeProfileDirectory(directory: string): void {
  const platform = currentPlatformName();
  const row = BROWSER_PLATFORMS[platform];
  const roots = liveProfileRoots(platform, process.env, NodeOS.homedir());
  assertOutsideLiveProfiles(directory, roots, row.path, foldsCase(platform));
  assertOutsideLiveProfiles(
    realpathIfPresent(directory),
    roots.map(realpathIfPresent),
    row.path,
    foldsCase(platform),
  );
}

export async function prepareProfile(
  extensionPath: string | null,
  extraPrefs: readonly Pref[] = [],
  basePrefs: readonly Pref[] = LAUNCH_PREFS,
): Promise<string> {
  const directory = NodeOS.tmpdir();
  assertSafeProfileDirectory(directory);
  const profile = await NodeFSP.mkdtemp(NodePath.join(directory, "one-click-har-browser-"));
  try {
    await writeProfilePrefs(profile, extraPrefs, basePrefs);
    if (extensionPath !== null) await installExtension(profile, extensionPath);
    return profile;
  } catch (error) {
    await NodeFSP.rm(profile, { recursive: true, force: true });
    throw error;
  }
}

async function writeProfilePrefs(
  profile: string,
  extraPrefs: readonly Pref[],
  basePrefs: readonly Pref[] = LAUNCH_PREFS,
): Promise<void> {
  await NodeFSP.writeFile(
    NodePath.join(profile, "user.js"),
    renderUserJs([...basePrefs, ...extraPrefs]),
    "utf8",
  );
}

const REMOTE_LAUNCH: Record<
  RemoteProtocol,
  (port: number) => { readonly args: readonly string[]; readonly prefs: readonly Pref[] }
> = {
  bidi: (port) => ({ args: ["--remote-debugging-port", String(port)], prefs: [] }),
  marionette: (port) => ({
    args: ["-marionette"],
    prefs: [{ name: "marionette.port", value: port }],
  }),
};

const REMOTE_PREF_NAMES = new Set(["devtools.debugger.remote-enabled", "remote.active-protocols"]);
const UNTOUCHED_BASE_PREFS: readonly Pref[] = LAUNCH_PREFS.filter(
  (pref) => !REMOTE_PREF_NAMES.has(pref.name),
);

type CommonLaunchRequest = {
  readonly binaryPath: string;
  readonly extensionPath: string | null;
  readonly display: BrowserDisplay;
  readonly profileDir?: string;
  readonly extraPrefs?: readonly Pref[];
  readonly signal: AbortSignal;
};

export type RemoteLaunchRequest = CommonLaunchRequest & {
  readonly launchMode?: "recommended" | "real-defaults";
  readonly protocol?: RemoteProtocol;
  readonly allowSystemAccess?: boolean;
};

export type UntouchedLaunchRequest = CommonLaunchRequest & {
  readonly launchMode: "none";
  readonly urls?: readonly string[];
};

export function launchBrowser(request: RemoteLaunchRequest): Promise<BrowserSession>;
export function launchBrowser(request: UntouchedLaunchRequest): Promise<UntouchedBrowserSession>;
export async function launchBrowser(
  request: RemoteLaunchRequest | UntouchedLaunchRequest,
): Promise<BrowserSession | UntouchedBrowserSession> {
  const launchMode: BrowserLaunchMode = request.launchMode ?? "recommended";
  await reapOrphanedLaunches(assertSafeProfileDirectory);
  await using stack = new AsyncDisposableStack();

  if (launchMode === "none") {
    const untouchedRequest = request as UntouchedLaunchRequest;
    const prefs = untouchedRequest.extraPrefs ?? [];
    const directory = await resolveProfileDir(
      stack,
      untouchedRequest.profileDir,
      untouchedRequest.extensionPath,
      prefs,
      UNTOUCHED_BASE_PREFS,
    );
    const lease = await createLaunchLease(directory);
    stack.defer(() => lease.remove());
    const args = [
      ...(untouchedRequest.display === "headless" ? ["-headless"] : []),
      "-no-remote",
      "-profile",
      directory,
      ...BROWSER_PLATFORMS[currentPlatformName()].launcherArgs,
      ...(untouchedRequest.urls ?? []),
    ];
    const spawned = spawnOwned(untouchedRequest.binaryPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1", MOZ_DISABLE_AUTO_UPDATE: "1" },
    });
    const closed = watchChildClose(spawned.child);
    await lease.setSpawnedPid(spawned.pid);
    stack.defer(() => killOwnedTree(spawned.pid, []));
    const owned = stack.move();
    return {
      spawnedPid: spawned.pid,
      profileDir: directory,
      launchMode: "none",
      exited: closed,
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  }

  const remoteRequest = request as RemoteLaunchRequest;
  const protocol = remoteRequest.protocol ?? "bidi";
  const port = await freePort();
  const remoteLaunch = REMOTE_LAUNCH[protocol](port);
  const modePrefs: readonly Pref[] =
    launchMode === "real-defaults" ? [{ name: "remote.prefs.recommended", value: false }] : [];
  const prefs = [...remoteLaunch.prefs, ...modePrefs, ...(remoteRequest.extraPrefs ?? [])];
  const directory = await resolveProfileDir(
    stack,
    remoteRequest.profileDir,
    remoteRequest.extensionPath,
    prefs,
    LAUNCH_PREFS,
  );
  const lease = await createLaunchLease(directory);
  stack.defer(() => lease.remove());
  const args = [
    ...(remoteRequest.display === "headless" ? ["-headless"] : []),
    "-no-remote",
    "-profile",
    directory,
    ...remoteLaunch.args,
    ...BROWSER_PLATFORMS[currentPlatformName()].launcherArgs,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MOZ_CRASHREPORTER_DISABLE: "1",
    MOZ_DISABLE_AUTO_UPDATE: "1",
    ...(remoteRequest.allowSystemAccess === true ? { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } : {}),
  };
  const spawned = spawnOwned(remoteRequest.binaryPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  let closedStatus: string | null = null;
  const closed = watchChildClose(spawned.child, (status) => {
    closedStatus = status;
  });
  let stderrTail = "";
  spawned.child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  await lease.setSpawnedPid(spawned.pid);
  let browserPid: number | null = null;
  stack.defer(() => killOwnedTree(spawned.pid, browserPid === null ? [] : [browserPid]));
  const remote = await connectRemote({
    protocol,
    port,
    exitStatus: () => closedStatus,
    stderr: () => stderrTail,
    signal: remoteRequest.signal,
  });
  stack.defer(() => remote.dispose());
  browserPid = remote.browserPid;
  assertOwnedBrowser(remote.browserPid, spawned.pid);
  const owned = stack.move();
  return {
    spawnedPid: spawned.pid,
    browserPid: remote.browserPid,
    profileDir: directory,
    launchMode,
    identity: {
      binaryPath: remoteRequest.binaryPath,
      name: remote.browserName,
      version: remote.version,
      buildId: remote.buildId,
      userAgent: remote.userAgent,
      remoteProtocol: remote.protocol,
      headless: remoteRequest.display === "headless",
    },
    openTab: (url) => remote.openTab(url),
    navigateTab: (context, url) => remote.navigateTab(context, url),
    reloadTab: (context) => remote.reloadTab(context),
    evaluate: (context, expression) => remote.evaluate(context, expression),
    evaluateChrome: (script, scriptArgs) => remote.evaluateChrome(script, scriptArgs),
    takeChromeScreenshot: (selector) => remote.takeChromeScreenshot(selector),
    closeTab: (context) => remote.closeTab(context),
    quit: async () => {
      await remote.quit();
      await raceTimeout(closed, 10_000);
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

async function resolveProfileDir(
  stack: AsyncDisposableStack,
  profileDir: string | undefined,
  extensionPath: string | null,
  prefs: readonly Pref[],
  basePrefs: readonly Pref[],
): Promise<string> {
  if (profileDir === undefined) {
    const directory = await prepareProfile(extensionPath, prefs, basePrefs);
    stack.defer(() => removeDirectoryBounded(directory));
    return directory;
  }
  assertSafeProfileDirectory(profileDir);
  await writeProfilePrefs(profileDir, prefs, basePrefs);
  if (extensionPath !== null) await installExtension(profileDir, extensionPath);
  return profileDir;
}

function watchChildClose(
  child: {
    once: (
      event: "close",
      cb: (code: number | null, signal: NodeJS.Signals | null) => void,
    ) => void;
  },
  onClose?: (status: string) => void,
): Promise<string> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => {
      const status = formatExitStatus(code, signal);
      onClose?.(status);
      resolve(status);
    });
  });
}

function formatExitStatus(code: number | null, signal: NodeJS.Signals | string | null): string {
  if (code !== null) return `code ${String(code)}`;
  if (signal !== null) return `signal ${signal}`;
  return "code 0";
}

function raceTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
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

export async function readExtensionId(extensionPath: string): Promise<string> {
  const absolute = NodePath.resolve(extensionPath);
  const stat = await NodeFSP.stat(absolute);
  const manifest: unknown = stat.isDirectory()
    ? JSON.parse(await NodeFSP.readFile(NodePath.join(absolute, "manifest.json"), "utf8"))
    : JSON.parse((await readZipEntry(absolute, "manifest.json")).toString("utf8"));
  return readGeckoId(manifest);
}

async function installExtension(profileDir: string, extensionPath: string): Promise<void> {
  const absolute = NodePath.resolve(extensionPath);
  const stat = await NodeFSP.stat(absolute);
  const extensionsDir = NodePath.join(profileDir, "extensions");
  await NodeFSP.mkdir(extensionsDir, { recursive: true });
  const id = await readExtensionId(absolute);
  if (stat.isDirectory()) {
    await NodeFSP.writeFile(NodePath.join(extensionsDir, id), absolute, "utf8");
    return;
  }
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
