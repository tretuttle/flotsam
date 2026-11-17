// The experiment API's parent script: system principal, parent process. Recording is always on by construction:
// the manifest's experiment entry lists "events": ["startup"], so onStartup starts the recorder before any page
// loads (row L1), and no API function starts or stops it.

import { parseSite, runIdAt, type EpochMs, type RunId } from "@one-click-har/recording/ids";
import { guardFolder } from "@one-click-har/recording/layout";
import type { ReconcileStep } from "@one-click-har/recording/reconcile";
import { compileRoutes } from "@one-click-har/recording/routes";
import type { StoredSettings } from "@one-click-har/recording/settings";
import { namespace, type OneClickHarApi, type ToolboxState } from "./contract.ts";
import {
  forbiddenRoots,
  loadSettings,
  openArchive,
  platform,
  type Archive,
  type RootProblem,
} from "./files.ts";
import { Timers } from "./gecko-io.ts";
import { recover } from "./maintenance.ts";
import { createOneClickHarApi, type RecordingFacts } from "./parent-api.ts";
import { startRecorder, type Recorder } from "./recorder.ts";
import { HOLD_POINTS, openStore, type HoldPoint, type Store } from "./store.ts";

/** Set only in a harness profile's user.js. Enables the observer topic below, which only system-principal code reaches. */
const HARNESS_PREF = "extensions.oneClickHar.harness";
const HARNESS_TOPIC = "one-click-har-harness";

interface Running {
  readonly run: RunId;
  readonly archive: Archive;
  readonly store: Store;
  readonly recorder: Recorder;
  readonly timers: Timers;
  readonly settingsRejected: boolean;
  readonly recovery: Promise<readonly ReconcileStep[]>;
}

type Lifecycle =
  | { readonly kind: "stopped" }
  | { readonly kind: "unavailable"; readonly problem: RootProblem }
  | ({ readonly kind: "running" } & Running);

const compile = (settings: StoredSettings, archive: Archive) =>
  compileRoutes({
    platform: archive.platform,
    excluded: settings.user.excludedSites,
    keepMedia: settings.user.media === "keep-bodies",
    maxBodyBytes: settings.user.retention.maxBodyBytes,
    supported: ["memory-tee", "file-tee"],
  });

/** Observers are added before anything is awaited: a 650 ms delay missed the first page (proto-lifecycle). */
function start(): Lifecycle {
  const run = runIdAt(Date.now() as EpochMs);
  const opened = openArchive();
  if (!opened.ok) return { kind: "unavailable", problem: opened.problem };
  const { archive } = opened;
  const { settings, rejected } = loadSettings(archive.root);
  const timers = new Timers();
  let recorder: Recorder | null = null;
  const store = openStore({
    run,
    root: archive.root,
    modes: archive.modes,
    settings,
    timers,
    onSettings: (next) => recorder?.setRoutes(compile(next, archive)),
  });
  recorder = startRecorder({
    run,
    routes: compile(settings, archive),
    store,
    root: archive.root,
    modes: archive.modes,
    timers,
  });
  let steps: readonly ReconcileStep[] = [];
  const recovery = store
    .enqueue(async () => {
      steps = await recover(archive.root, archive.modes, run, settings.user.excludedSites);
    })
    .then(() => steps);
  return {
    kind: "running",
    run,
    archive,
    store,
    recorder,
    timers,
    settingsRejected: rejected,
    recovery,
  };
}

/** AsyncShutdown keeps the profile writable until the seal finishes; a phase already under way refuses a blocker. */
function blockShutdown(closing: Promise<void>): void {
  const { AsyncShutdown } = ChromeUtils.importESModule(
    "resource://gre/modules/AsyncShutdown.sys.mjs",
  );
  for (const phase of [AsyncShutdown.profileBeforeChange, AsyncShutdown.sendTelemetry]) {
    try {
      phase.addBlocker("One-Click HAR: write the last lines of the recording", closing);
      return;
    } catch {
      // Too late for this phase; try the next one.
    }
  }
}

type HarnessRequest =
  | { readonly kind: "flush" | "seal" | "recovery" | "status" }
  | { readonly kind: "exclude"; readonly site: string }
  | { readonly kind: "arm" | "reached"; readonly point: string }
  | { readonly kind: "guard"; readonly path: string };

const isHoldPoint = (value: string): value is HoldPoint =>
  (HOLD_POINTS as readonly string[]).includes(value);

/** The harness's way in: flush, seal, exclude, hold the write chain at a crash point, read recovery and the guard. */
async function answerHarness(state: Running, request: HarnessRequest): Promise<unknown> {
  switch (request.kind) {
    case "flush":
      return state.store.flush();
    case "seal":
      return state.store.sealAll();
    case "recovery":
      return state.recovery;
    case "status":
      return {
        run: state.run,
        root: state.archive.root,
        keyCreated: state.archive.keyCreated,
        problems: state.store.problems(),
        ...state.recorder.counts(),
      };
    case "exclude": {
      const site = parseSite(request.site);
      if (site === null) throw new Error(`not a site: ${request.site}`);
      return state.store.excludeSite(site);
    }
    case "arm":
    case "reached": {
      const point = request.point;
      if (!isHoldPoint(point)) throw new Error(`not a hold point: ${point}`);
      if (request.kind === "arm") return state.store.arm(point);
      return state.store.reached(point);
    }
    case "guard":
      return {
        forbidden: forbiddenRoots(),
        verdict: guardFolder(request.path, forbiddenRoots(), platform()),
      };
  }
}

const nativeTab = (context: ExtensionContext, tabId: number): NativeTab | undefined => {
  try {
    return context.extension.tabManager.get(tabId).nativeTab;
  } catch {
    return undefined;
  }
};

const toolboxState = (context: ExtensionContext, tabId: number): ToolboxState => {
  const tab = nativeTab(context, tabId);
  if (tab === undefined) return { open: false, reason: "no-such-tab" };
  // Loading the DevTools client framework is expensive. Until DevTools starts, no toolbox can exist.
  const { DevToolsShim } = ChromeUtils.importESModule(
    "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
  );
  if (!DevToolsShim.isInitialized()) return { open: false, reason: "devtools-not-started" };
  const devtoolsLoader = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs",
  );
  const { gDevTools } = devtoolsLoader.require("resource://devtools/client/framework/devtools.js");
  const toolbox = gDevTools.getToolboxForTab(tab);
  return toolbox === undefined
    ? { open: false, reason: "no-toolbox-for-tab" }
    : { open: true, host: toolbox.hostType };
};

class OneClickHarParent extends ExtensionAPI {
  #state: Lifecycle = { kind: "stopped" };
  #harness: Observer | null = null;

  override onStartup(): void {
    if (this.#state.kind !== "stopped") return;
    this.#state = start();
    if (!Services.prefs.getBoolPref(HARNESS_PREF, false)) return;
    this.#harness = {
      observe: (subject) => {
        const holder = (
          subject as { wrappedJSObject?: { request: HarnessRequest; done(result: unknown): void } }
        ).wrappedJSObject;
        if (holder === undefined) return;
        const state = this.#state;
        const answer =
          state.kind === "running"
            ? answerHarness(state, holder.request)
            : Promise.resolve({ unavailable: state.kind === "unavailable" ? state.problem : null });
        answer.then(
          (result) => holder.done({ ok: true, result }),
          (error: unknown) => holder.done({ ok: false, error: String(error) }),
        );
      },
    };
    Services.obs.addObserver(this.#harness, HARNESS_TOPIC);
  }

  override onShutdown(isAppShutdown: boolean): void {
    if (this.#harness !== null) Services.obs.removeObserver(this.#harness, HARNESS_TOPIC);
    this.#harness = null;
    const state = this.#state;
    this.#state = { kind: "stopped" };
    if (state.kind !== "running") return;
    state.recorder.stop(isAppShutdown ? "browser-closed" : "recording-stopped");
    const closing = state.store.close();
    state.timers.cancelAll();
    if (isAppShutdown) blockShutdown(closing);
  }

  #facts(): RecordingFacts {
    const state = this.#state;
    const strictOriginPolicy = Services.prefs.getBoolPref(
      "security.fileuri.strict_origin_policy",
      true,
    );
    if (state.kind !== "running") {
      return {
        archive:
          state.kind === "unavailable" && state.problem.kind === "archive-refused"
            ? "refused"
            : "unwritable",
        strictOriginPolicy,
        settingsRejected: false,
        writeFailures: 0,
        liveOverflow: 0,
      };
    }
    return {
      archive: null,
      strictOriginPolicy,
      settingsRejected: state.settingsRejected,
      writeFailures: state.store.problems().length,
      liveOverflow: state.recorder.counts().overflow,
    };
  }

  override getAPI(context: ExtensionContext): Record<string, OneClickHarApi> {
    return {
      [namespace]: createOneClickHarApi({
        identity: () => ({
          name: Services.appinfo.name,
          version: Services.appinfo.version,
          buildId: Services.appinfo.appBuildID,
        }),
        toolbox: (tabId) => toolboxState(context, tabId),
        recording: () => this.#facts(),
      }),
    };
  }
}

// ExtensionCommon.sys.mjs reads the API class from this script's global under the namespace name.
Object.assign(globalThis, { [namespace]: OneClickHarParent });
