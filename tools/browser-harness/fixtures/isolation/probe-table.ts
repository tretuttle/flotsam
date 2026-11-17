export type BrowserProbePosition =
  | "web"
  | "file"
  | "ext-bg"
  | "ext-page"
  | "cs-web"
  | "cs-file"
  | "ext-devtools";

export type Position =
  | BrowserProbePosition
  | "file-no-marionette"
  | "file-mutated"
  | "cs-archive"
  | "system"
  | "os"
  | "otherexp";

export type Verdict = "BLOCKED" | "READ" | "LEAKS-EXISTENCE" | "NO-RESULT";

export type DecidedException =
  | "top-level-app-folder-existence"
  | "addon-tabs-visibility"
  | "addon-management-visibility";

export type ControlReason =
  | "planted-own-war"
  | "planted-resource-substitution"
  | "planted-strict-origin-disabled"
  | "baseline-live-traffic"
  | "control-system-principal"
  | "named-limit-same-os-user"
  | "named-limit-other-experiment";

export type ExpectedOutcome =
  | { readonly kind: "BLOCKED" }
  | { readonly kind: "LEAKS-EXISTENCE"; readonly exception: DecidedException }
  | { readonly kind: "LEAKS-EXISTENCE"; readonly control: ControlReason }
  | { readonly kind: "READ"; readonly control: ControlReason }
  | { readonly kind: "LEAKS-EXISTENCE-OR-READ"; readonly control: ControlReason };

export type DetectKind =
  | "bytes"
  | "names"
  | "oracle"
  | "api"
  | "frame"
  | "addon"
  | "downloads"
  | "fetch-ok"
  | "reach"
  | "execute-script"
  | "store"
  | "planted"
  | "planted-absent"
  | "baseline";

export type ProbeSpec = {
  readonly id: string;
  readonly group: "file" | "resource" | "mozext" | "api" | "indirect" | "baseline";
  readonly what: string;
  readonly positions: readonly BrowserProbePosition[];
  readonly detect: DetectKind;
  readonly expectAt?: Readonly<Partial<Record<Position, ExpectedOutcome>>>;
};

export type ExpectedRow = {
  readonly id: string;
  readonly position: Position;
  readonly what: string;
  readonly detect: DetectKind | "synthetic";
  readonly expected: ExpectedOutcome;
};

const ALL: readonly BrowserProbePosition[] = [
  "web",
  "file",
  "ext-bg",
  "ext-page",
  "cs-web",
  "cs-file",
  "ext-devtools",
];
const EXT: readonly BrowserProbePosition[] = ["ext-bg", "ext-page", "ext-devtools"];
const EXTAPI: readonly BrowserProbePosition[] = [
  "ext-bg",
  "ext-page",
  "ext-devtools",
  "cs-web",
  "cs-file",
];
const DOC: readonly BrowserProbePosition[] = ["web", "file", "cs-web", "cs-file"];

const BLOCKED: ExpectedOutcome = { kind: "BLOCKED" };
const EXCEPTION_ROOT: ExpectedOutcome = {
  kind: "LEAKS-EXISTENCE",
  exception: "top-level-app-folder-existence",
};
const EXCEPTION_TABS: ExpectedOutcome = {
  kind: "LEAKS-EXISTENCE",
  exception: "addon-tabs-visibility",
};
const EXCEPTION_MANAGEMENT: ExpectedOutcome = {
  kind: "LEAKS-EXISTENCE",
  exception: "addon-management-visibility",
};

/** Probes repeated in the no-Marionette and mutated-strict-origin launches. */
export const NO_MARIONETTE_PROBE_IDS: readonly string[] = [
  "fetch-file-log",
  "fetch-file-body",
  "fetch-file-dir",
  "fetch-file-export",
  "iframe-file-log",
  "iframe-site-oracle",
  "script-site-oracle",
  "script-root-oracle",
];

/**
 * Single source of truth for every probe, its positions, detection rule, and expected outcome.
 * Non-control probes default to BLOCKED; decided exceptions and planted controls name their reason.
 */
export const PROBE_TABLE: readonly ProbeSpec[] = [
  {
    id: "fetch-file-log",
    group: "file",
    what: "fetch(file:///<archive>/sites/<site>/log/<run>-0.jsonl)",
    positions: ALL,
    detect: "bytes",
    expectAt: {
      "file-mutated": { kind: "READ", control: "planted-strict-origin-disabled" },
    },
  },
  {
    id: "fetch-file-body",
    group: "file",
    what: "fetch(file:///<archive>/sites/<site>/bodies/<id>.body)",
    positions: ALL,
    detect: "bytes",
    expectAt: {
      "file-mutated": { kind: "READ", control: "planted-strict-origin-disabled" },
    },
  },
  {
    id: "fetch-file-dir",
    group: "file",
    what: "fetch(file:///<appFolder>/) directory listing",
    positions: ALL,
    detect: "names",
    expectAt: {
      "file-mutated": {
        kind: "LEAKS-EXISTENCE-OR-READ",
        control: "planted-strict-origin-disabled",
      },
    },
  },
  {
    id: "fetch-file-export",
    group: "file",
    what: "fetch(file:///<Downloads>/<site>-<date>.har)",
    positions: ALL,
    detect: "bytes",
    expectAt: {
      "file-mutated": { kind: "READ", control: "planted-strict-origin-disabled" },
    },
  },
  {
    id: "content-fetch-file-log",
    group: "file",
    what: "content.fetch (page context) of the archive log",
    positions: ["cs-web", "cs-file"],
    detect: "bytes",
  },
  {
    id: "xhr-file-log",
    group: "file",
    what: "XMLHttpRequest GET of the archive log",
    positions: ALL,
    detect: "bytes",
  },
  {
    id: "iframe-file-log",
    group: "file",
    what: "<iframe src> of the archive log, then read contentDocument",
    positions: ALL,
    detect: "bytes",
    expectAt: {
      "file-mutated": { kind: "READ", control: "planted-strict-origin-disabled" },
    },
  },
  {
    id: "iframe-file-root",
    group: "file",
    what: "<iframe src> of the archive root directory listing, then read it",
    positions: ALL,
    detect: "names",
  },
  {
    id: "iframe-file-export",
    group: "file",
    what: "<iframe src> of the exported HAR, then read it",
    positions: ALL,
    detect: "bytes",
  },
  {
    id: "img-file-oracle",
    group: "file",
    what: "<img> load/error: recorded site body file vs a missing path",
    positions: ALL,
    detect: "oracle",
  },
  {
    id: "script-file-oracle",
    group: "file",
    what: "<script> load/error: guessed profile-derived archive log vs a missing path",
    positions: ALL,
    detect: "oracle",
  },
  {
    id: "css-file-oracle",
    group: "file",
    what: "<link rel=stylesheet> load/error: guessed profile-derived archive log vs a missing path",
    positions: ALL,
    detect: "oracle",
  },
  {
    id: "iframe-site-oracle",
    group: "file",
    what: "<iframe> load/error: site directory (guessed when unmutated, actual when mutated) vs an unrecorded site directory",
    positions: ALL,
    detect: "oracle",
    expectAt: {
      "file-mutated": { kind: "LEAKS-EXISTENCE", control: "planted-strict-origin-disabled" },
    },
  },
  {
    id: "script-root-oracle",
    group: "file",
    what: "<script> load/error: top-level one-click-har folder vs a missing sibling",
    positions: ALL,
    detect: "oracle",
    expectAt: {
      file: EXCEPTION_ROOT,
      "file-no-marionette": EXCEPTION_ROOT,
      "file-mutated": { kind: "LEAKS-EXISTENCE", control: "planted-strict-origin-disabled" },
    },
  },
  {
    id: "script-site-oracle",
    group: "file",
    what: "<script> load/error: site directory (guessed when unmutated, actual when mutated) vs an unrecorded site directory",
    positions: ALL,
    detect: "oracle",
    expectAt: {
      "file-mutated": { kind: "LEAKS-EXISTENCE", control: "planted-strict-origin-disabled" },
    },
  },
  {
    id: "viewsource-fetch",
    group: "file",
    what: "fetch(view-source:file:///<archive log>)",
    positions: ALL,
    detect: "bytes",
  },
  {
    id: "viewsource-iframe",
    group: "file",
    what: "<iframe src=view-source:file:///<archive log>>",
    positions: ALL,
    detect: "bytes",
  },
  {
    id: "jar-file-fetch",
    group: "file",
    what: "fetch(jar:file:///<archive log>!/)",
    positions: ALL,
    detect: "bytes",
  },
  {
    id: "jar-file-iframe",
    group: "file",
    what: "<iframe src=jar:file:///<archive log>!/>",
    positions: ALL,
    detect: "bytes",
  },
  {
    id: "redirect-fetch",
    group: "file",
    what: "fetch of an http URL that 302-redirects to the archive log",
    positions: ALL,
    detect: "bytes",
  },
  {
    id: "redirect-iframe",
    group: "file",
    what: "<iframe> of an http URL that 302-redirects to the archive log",
    positions: ALL,
    detect: "bytes",
  },
  {
    id: "window-open-file",
    group: "file",
    what: "window.open(file:///<archive log>), then read the window",
    positions: DOC,
    detect: "bytes",
  },
  {
    id: "wr-redirect-iframe",
    group: "file",
    what: "<iframe> of a URL the test extension blocking webRequest redirects to the archive log",
    positions: ["web", "file"],
    detect: "bytes",
  },
  {
    id: "tabs-create-file",
    group: "file",
    what: "tabs.create({url: file:///<archive log>})",
    positions: EXT,
    detect: "bytes",
  },
  {
    id: "tabs-create-dir",
    group: "file",
    what: "tabs.create({url: file:///<appFolder>/})",
    positions: EXT,
    detect: "names",
  },
  {
    id: "tabs-update-file",
    group: "file",
    what: "tabs.update(<an http tab>, {url: file:///<archive log>})",
    positions: EXT,
    detect: "bytes",
  },
  {
    id: "tabs-update-redirect",
    group: "file",
    what: "tabs.update(<an http tab>, {url: <http URL that 302-redirects to the log>})",
    positions: EXT,
    detect: "bytes",
  },
  {
    id: "windows-create-file",
    group: "file",
    what: "windows.create({url: file:///<archive log>})",
    positions: ["ext-bg", "ext-page"],
    detect: "bytes",
  },
  {
    id: "downloads-download-file",
    group: "file",
    what: "downloads.download({url: file:///<archive log>})",
    positions: ["ext-bg", "ext-page"],
    detect: "bytes",
  },
  {
    id: "tabs-create-viewsource",
    group: "file",
    what: "tabs.create({url: view-source:file:///<archive log>})",
    positions: ["ext-bg", "ext-page"],
    detect: "bytes",
  },
  {
    id: "wr-redirect-tab",
    group: "file",
    what: "tabs.create of a URL the test extension blocking webRequest redirects to the archive log",
    positions: ["ext-bg"],
    detect: "bytes",
  },

  // resource://, chrome://, moz-src://
  {
    id: "resource-all",
    group: "resource",
    what: "fetch and <link> load of resource://<name>/ for every substitution found from the system principal",
    positions: ALL,
    detect: "reach",
  },
  {
    id: "resource-traversal",
    group: "resource",
    what: "resource://<substitution>/ with encoded ../ to the archive log: fetch and <link> load",
    positions: ALL,
    detect: "reach",
  },
  {
    id: "planted-resource",
    group: "resource",
    what: "planted: resource://och-planted/ (mapped by the harness to the archive with ALLOW_CONTENT_ACCESS): <link> load of the log vs a missing path, and fetch",
    positions: ["web", "file"],
    detect: "oracle",
    expectAt: {
      web: { kind: "LEAKS-EXISTENCE-OR-READ", control: "planted-resource-substitution" },
      file: { kind: "LEAKS-EXISTENCE-OR-READ", control: "planted-resource-substitution" },
    },
  },
  {
    id: "chrome-all",
    group: "resource",
    what: "fetch and <link> load of chrome://<package>/content/ for every package found from the system principal",
    positions: ALL,
    detect: "reach",
  },
  {
    id: "chrome-traversal",
    group: "resource",
    what: "chrome://global/content/ with encoded ../ to the archive log: fetch and <link> load",
    positions: ALL,
    detect: "reach",
  },
  {
    id: "moz-src-root",
    group: "resource",
    what: "fetch and <link> load of moz-src:/// paths, and moz-src with encoded ../ to the archive log",
    positions: ALL,
    detect: "reach",
  },

  // moz-extension:// of One-Click HAR
  {
    id: "mozext-manifest",
    group: "mozext",
    what: "fetch(moz-extension://<recorder uuid>/manifest.json)",
    positions: ALL,
    detect: "fetch-ok",
  },
  {
    id: "mozext-parent",
    group: "mozext",
    what: "fetch(moz-extension://<recorder uuid>/experiment/parent.js)",
    positions: ALL,
    detect: "fetch-ok",
  },
  {
    id: "mozext-schema",
    group: "mozext",
    what: "fetch(moz-extension://<recorder uuid>/experiment/schema.json)",
    positions: ALL,
    detect: "fetch-ok",
  },
  {
    id: "mozext-popup",
    group: "mozext",
    what: "fetch(moz-extension://<recorder uuid>/action/index.html)",
    positions: ALL,
    detect: "fetch-ok",
  },
  {
    id: "mozext-script-oracle",
    group: "mozext",
    what: "<script src> load/error: recorder action/index.js vs the same path under a random uuid",
    positions: ALL,
    detect: "oracle",
  },
  {
    id: "mozext-timing",
    group: "mozext",
    what: "fetch error text and timing: recorder uuid vs random uuid",
    positions: ["web", "ext-bg"],
    detect: "oracle",
  },
  {
    id: "mozext-frame-recorder",
    group: "mozext",
    what: "<iframe> of the recorder action/index.html, then postMessage to it",
    positions: ["web", "file", "ext-page", "cs-web"],
    detect: "frame",
  },
  {
    id: "planted-own-war-fetch",
    group: "mozext",
    what: "planted: fetch the test extension own web_accessible_resources file",
    positions: ["web", "file"],
    detect: "planted",
    expectAt: {
      web: { kind: "READ", control: "planted-own-war" },
      file: { kind: "READ", control: "planted-own-war" },
    },
  },
  {
    id: "planted-own-war-script",
    group: "mozext",
    what: "planted: <script src> of the test extension own web-accessible war.js, then read window.OCH_WAR",
    positions: ["web", "file"],
    detect: "planted",
    expectAt: {
      web: { kind: "READ", control: "planted-own-war" },
      file: { kind: "READ", control: "planted-own-war" },
    },
  },
  {
    id: "own-non-war",
    group: "mozext",
    what: "control: fetch the test extension file that is not web accessible",
    positions: ["web", "file"],
    detect: "planted-absent",
  },

  // Experiment API and extension messaging/injection
  {
    id: "api-namespace",
    group: "api",
    what: "typeof browser.oneClickHar (and typeof browser in pages)",
    positions: ALL,
    detect: "api",
  },
  {
    id: "api-call",
    group: "api",
    what: "browser.oneClickHar.getRecordingStatus()",
    positions: ALL,
    detect: "names",
  },
  {
    id: "sendmessage-recorder",
    group: "api",
    what: "runtime.sendMessage(<recorder id>, {op: getRecordingStatus})",
    positions: EXTAPI,
    detect: "names",
  },
  {
    id: "sendmessage-oracle",
    group: "api",
    what: "runtime.sendMessage error: recorder id vs an id that is not installed",
    positions: EXTAPI,
    detect: "oracle",
  },
  {
    id: "connect-recorder",
    group: "api",
    what: "runtime.connect(<recorder id>) and postMessage",
    positions: EXTAPI,
    detect: "names",
  },
  {
    id: "tabs-query-recorder",
    group: "api",
    what: "tabs.query({}) for a tab showing the recorder page",
    positions: EXT,
    detect: "addon",
    expectAt: {
      "ext-bg": EXCEPTION_TABS,
      "ext-page": EXCEPTION_TABS,
    },
  },
  {
    id: "executescript-recorder-page",
    group: "api",
    what: "tabs.executeScript into the tab showing the recorder action/index.html",
    positions: ["ext-bg", "ext-page"],
    detect: "execute-script",
  },
  {
    id: "scripting-recorder-page",
    group: "api",
    what: "scripting.executeScript into the tab showing the recorder action/index.html",
    positions: ["ext-bg", "ext-page"],
    detect: "execute-script",
  },
  {
    id: "management-getall",
    group: "api",
    what: "management.getAll()",
    positions: ["ext-bg", "ext-page"],
    detect: "addon",
    expectAt: {
      "ext-bg": EXCEPTION_MANAGEMENT,
      "ext-page": EXCEPTION_MANAGEMENT,
    },
  },

  // Indirect paths
  {
    id: "downloads-search",
    group: "indirect",
    what: "downloads.search({}) after recording and export",
    positions: ["ext-bg", "ext-page"],
    detect: "downloads",
  },
  {
    id: "downloads-open-export",
    group: "indirect",
    what: "downloads.open(<export download id>) without a user gesture",
    positions: ["ext-bg", "ext-page"],
    detect: "bytes",
  },
  {
    id: "downloads-refetch-export",
    group: "indirect",
    what: "fetch and downloads.download of an export download URL if present",
    positions: ["ext-bg", "ext-page"],
    detect: "bytes",
  },
  {
    id: "clipboard-after-export",
    group: "indirect",
    what: "navigator.clipboard.readText() after recording",
    positions: ["ext-page"],
    detect: "bytes",
  },
  {
    id: "notifications-getall",
    group: "indirect",
    what: "notifications.getAll() after recording",
    positions: ["ext-bg"],
    detect: "names",
  },
  {
    id: "storage-recorder",
    group: "indirect",
    what: "storage.local.get(null) in test extension",
    positions: ["ext-bg", "ext-page"],
    detect: "store",
  },
  {
    id: "idb-recorder",
    group: "indirect",
    what: "indexedDB.databases() and open('och-recorder') in test extension",
    positions: ["ext-bg", "ext-page"],
    detect: "store",
  },

  // Live-traffic baselines
  {
    id: "devtools-gethar",
    group: "baseline",
    what: "baseline: devtools.network.getHAR() on the inspected bank tab after reload",
    positions: ["ext-devtools"],
    detect: "baseline",
    expectAt: {
      "ext-devtools": { kind: "READ", control: "baseline-live-traffic" },
    },
  },
  {
    id: "baseline-webrequest",
    group: "baseline",
    what: "baseline: webRequest.onBeforeSendHeaders and filterResponseData on live bank traffic",
    positions: ["ext-bg"],
    detect: "baseline",
    expectAt: {
      "ext-bg": { kind: "READ", control: "baseline-live-traffic" },
    },
  },
];

export const SYNTHETIC_ROWS: readonly ExpectedRow[] = [
  {
    id: "cs-file-injection",
    position: "cs-file",
    what: "test extension content script (matches <all_urls>, all_frames) in the file:// page",
    detect: "synthetic",
    expected: BLOCKED,
  },
  {
    id: "cs-in-archive-document",
    position: "cs-archive",
    what: "test extension content script injected into any archive or export document",
    detect: "synthetic",
    expected: BLOCKED,
  },
  {
    id: "control-system-read",
    position: "system",
    what: "positive control: IOUtils.readUTF8 of the archive log and body from Marionette chrome sandbox",
    detect: "synthetic",
    expected: { kind: "READ", control: "control-system-principal" },
  },
  {
    id: "limit-same-user-process",
    position: "os",
    what: "named limit: a process under the same Linux user reads the log",
    detect: "synthetic",
    expected: { kind: "READ", control: "named-limit-same-os-user" },
  },
  {
    id: "limit-other-experiment",
    position: "otherexp",
    what: "named limit: another add-on experiment API parent script reads the log",
    detect: "synthetic",
    expected: { kind: "READ", control: "named-limit-other-experiment" },
  },
];

function expectedOutcomeFor(spec: ProbeSpec, position: Position): ExpectedOutcome {
  return spec.expectAt?.[position] ?? BLOCKED;
}

/** Expands PROBE_TABLE + NO_MARIONETTE_PROBE_IDS + SYNTHETIC_ROWS into the 287 expected rows. */
export function expandExpectedRows(csFileInjected = false): readonly ExpectedRow[] {
  const rows: ExpectedRow[] = [];
  if (!csFileInjected) {
    rows.push(SYNTHETIC_ROWS[0]!);
  }
  for (const spec of PROBE_TABLE) {
    for (const pos of spec.positions) {
      if (pos === "cs-file" && !csFileInjected) continue;
      rows.push({
        id: spec.id,
        position: pos,
        what: spec.what,
        detect: spec.detect,
        expected: expectedOutcomeFor(spec, pos),
      });
    }
  }
  for (const pos of ["file-no-marionette", "file-mutated"] as const) {
    for (const id of NO_MARIONETTE_PROBE_IDS) {
      const spec = PROBE_TABLE.find((p) => p.id === id);
      if (spec === undefined) throw new Error(`unknown no-marionette probe ${id}`);
      rows.push({
        id: spec.id,
        position: pos,
        what: pos === "file-mutated" ? `planted mutation: ${spec.what}` : spec.what,
        detect: spec.detect,
        expected: expectedOutcomeFor(spec, pos),
      });
    }
  }
  rows.push(...SYNTHETIC_ROWS.slice(1));
  return rows;
}
