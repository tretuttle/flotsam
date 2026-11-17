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
  | "rec-page"
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
  | "planted-recorder-store"
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

/**
 * The exact refusal a probe must observe before it counts as BLOCKED. Anything else it observes is a leak or
 * NO-RESULT, so a probe that ran nothing, threw, or got an unexpected answer can never pass as BLOCKED.
 */
export type Denial =
  /** The call rejected (the probe reports outcome "error") with this error text. */
  | { readonly kind: "rejected"; readonly error: RegExp }
  /** A live API answered with this outcome and an answer that carries nothing. */
  | { readonly kind: "answered"; readonly outcome: string; readonly text: RegExp }
  /** An answer that lists things but names neither the recorder's id nor its moz-extension uuid. */
  | { readonly kind: "answered-without-recorder" }
  /** A read of the prober's own planted store that shows the prober's own value, proving the read worked. */
  | { readonly kind: "own-value-only" }
  /** An iframe whose document stayed out of reach: cross-origin and unreadable, or still an empty about:blank. */
  | { readonly kind: "frame-withheld" }
  /** An existing and a missing path, both observed, with identical results. */
  | { readonly kind: "indistinguishable" }
  /** Every planned URL: fetch rejected with NetworkError and the <link> load fired error. */
  | { readonly kind: "unreachable" }
  /** A row that is a control or a baseline and is never expected BLOCKED. */
  | { readonly kind: "never" };

/** What a well-formed answer that is not the denial means. */
export type LeakKind = "READ" | "LEAKS-EXISTENCE";

/** How a row's result is shaped: one answer, an existing/missing pair, or one answer per planned target. */
export type Shape = "single" | "pair" | "each";

export type ProbeSpec = {
  readonly id: string;
  readonly what: string;
  readonly positions: readonly BrowserProbePosition[];
  readonly shape: Shape;
  readonly deny: Denial;
  readonly denyAt?: Readonly<Partial<Record<Position, Denial>>>;
  readonly leak: LeakKind;
  readonly expectAt?: Readonly<Partial<Record<Position, ExpectedOutcome>>>;
};

export type ExpectedRow = {
  readonly id: string;
  readonly position: Position;
  readonly what: string;
  /** The probe that runs in a browser, or null for a row the check computes itself. */
  readonly spec: ProbeSpec | null;
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
/** Positions with the `tabs` API: an extension's background and its page. The devtools page has no `tabs`. */
const TABS: readonly BrowserProbePosition[] = ["ext-bg", "ext-page"];
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
const MUTATED_READ: ExpectedOutcome = { kind: "READ", control: "planted-strict-origin-disabled" };
const MUTATED_EXISTS: ExpectedOutcome = {
  kind: "LEAKS-EXISTENCE",
  control: "planted-strict-origin-disabled",
};

const FETCH_DENIED: Denial = {
  kind: "rejected",
  error: /^TypeError: NetworkError when attempting to fetch resource\.$/u,
};
const XHR_DENIED: Denial = { kind: "rejected", error: /^error event, status 0, readyState 4$/u };
const ILLEGAL_URL: Denial = { kind: "rejected", error: /^Error: Illegal URL: /u };
const NO_RECEIVER = /^Error: Could not establish connection\. Receiving end does not exist\.$/u;
const FRAME_WITHHELD: Denial = { kind: "frame-withheld" };
const SAME: Denial = { kind: "indistinguishable" };
const UNREACHABLE: Denial = { kind: "unreachable" };

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
  "inventory-read",
  "inventory-exists",
];

/**
 * Single source of truth for every probe: its positions, the exact denial that counts as BLOCKED, what any other
 * answer means, and the expected outcome. Non-control probes default to BLOCKED; exceptions and controls name a reason.
 */
export const PROBE_TABLE: readonly ProbeSpec[] = [
  {
    id: "fetch-file-log",
    what: "fetch(file:///<archive>/sites/<site>/log/<run>-0.jsonl)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
    expectAt: { "file-mutated": MUTATED_READ },
  },
  {
    id: "fetch-file-body",
    what: "fetch(file:///<archive>/sites/<site>/bodies/<id>.body)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
    expectAt: { "file-mutated": MUTATED_READ },
  },
  {
    id: "fetch-file-dir",
    what: "fetch(file:///<appFolder>/) directory listing",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "LEAKS-EXISTENCE",
    expectAt: {
      "file-mutated": {
        kind: "LEAKS-EXISTENCE-OR-READ",
        control: "planted-strict-origin-disabled",
      },
    },
  },
  {
    id: "fetch-file-export",
    what: "fetch(file:///<Downloads>/<site>-<date>.har)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
    expectAt: { "file-mutated": MUTATED_READ },
  },
  {
    id: "inventory-read",
    what: "fetch of every file and directory the product wrote (app folder walk) and the key file in the profile",
    positions: ALL,
    shape: "each",
    deny: FETCH_DENIED,
    leak: "READ",
    expectAt: { "file-mutated": MUTATED_READ },
  },
  {
    id: "inventory-exists",
    what: "<script> and <link> load/error of every written path outside the random key folder vs a missing sibling",
    positions: ALL,
    shape: "each",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "content-fetch-file-log",
    what: "content.fetch (page context) of the archive log",
    positions: ["cs-web", "cs-file"],
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "xhr-file-log",
    what: "XMLHttpRequest GET of the archive log",
    positions: ALL,
    shape: "single",
    deny: XHR_DENIED,
    leak: "READ",
  },
  {
    id: "iframe-file-log",
    what: "<iframe src> of the archive log, then read contentDocument",
    positions: ALL,
    shape: "single",
    deny: FRAME_WITHHELD,
    leak: "READ",
    expectAt: { "file-mutated": MUTATED_READ },
  },
  {
    id: "iframe-file-root",
    what: "<iframe src> of the archive root directory listing, then read it",
    positions: ALL,
    shape: "single",
    deny: FRAME_WITHHELD,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "iframe-file-export",
    what: "<iframe src> of the exported HAR, then read it",
    positions: ALL,
    shape: "single",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "img-file-oracle",
    what: "<img> load/error: recorded site body file vs a missing path",
    positions: ALL,
    shape: "pair",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "script-file-oracle",
    what: "<script> load/error: the log under every guessed archive key (profile, user, host derivations) vs a missing path",
    positions: ALL,
    shape: "each",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "css-file-oracle",
    what: "<link rel=stylesheet> load/error: the log under every guessed archive key vs a missing path",
    positions: ALL,
    shape: "each",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "iframe-site-oracle",
    what: "<iframe> load/error: the site directory under every guessed archive key (the real one when mutated) vs an unrecorded site",
    positions: ALL,
    shape: "each",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    expectAt: { "file-mutated": MUTATED_EXISTS },
  },
  {
    id: "script-root-oracle",
    what: "<script> load/error: top-level one-click-har folder vs a missing sibling",
    positions: ALL,
    shape: "pair",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    expectAt: {
      file: EXCEPTION_ROOT,
      "file-no-marionette": EXCEPTION_ROOT,
      "file-mutated": MUTATED_EXISTS,
    },
  },
  {
    id: "script-site-oracle",
    what: "<script> load/error: the site directory under every guessed archive key (the real one when mutated) vs an unrecorded site",
    positions: ALL,
    shape: "each",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    expectAt: { "file-mutated": MUTATED_EXISTS },
  },
  {
    id: "viewsource-fetch",
    what: "fetch(view-source:file:///<archive log>)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "viewsource-iframe",
    what: "<iframe src=view-source:file:///<archive log>>",
    positions: ALL,
    shape: "single",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "jar-file-fetch",
    what: "fetch(jar:file:///<archive log>!/)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "jar-file-iframe",
    what: "<iframe src=jar:file:///<archive log>!/>",
    positions: ALL,
    shape: "single",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "redirect-fetch",
    what: "fetch of an http URL that 302-redirects to the archive log",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "redirect-iframe",
    what: "<iframe> of an http URL that 302-redirects to the archive log",
    positions: ALL,
    shape: "single",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "window-open-file",
    what: "window.open(file:///<archive log>), then read the window",
    positions: DOC,
    shape: "single",
    deny: { kind: "rejected", error: /^Error: Access to '.*' from script denied$/u },
    // The popup blocker refuses an open with no user gesture from a file:// page before any origin check runs.
    denyAt: { file: { kind: "rejected", error: /^window\.open returned null$/u } },
    leak: "READ",
  },
  {
    id: "wr-redirect-iframe",
    what: "<iframe> of a URL the test extension blocking webRequest redirects to the archive log",
    positions: ["web", "file"],
    shape: "single",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "tabs-create-file",
    what: "tabs.create({url: file:///<archive log>})",
    positions: TABS,
    shape: "single",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "tabs-create-dir",
    what: "tabs.create({url: file:///<appFolder>/})",
    positions: TABS,
    shape: "single",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "tabs-update-file",
    what: "tabs.update(<an http tab>, {url: file:///<archive log>})",
    positions: TABS,
    shape: "single",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "tabs-update-redirect",
    what: "tabs.update(<an http tab>, {url: <http URL that 302-redirects to the log>})",
    positions: TABS,
    shape: "single",
    deny: {
      kind: "answered",
      outcome: "ok",
      text: /^update resolved; 1 s later: url http:\/\/attacker\.example\/victim\.html, title victim$/u,
    },
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "windows-create-file",
    what: "windows.create({url: file:///<archive log>})",
    positions: TABS,
    shape: "single",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "downloads-download-file",
    what: "downloads.download({url: file:///<archive log>})",
    positions: TABS,
    shape: "single",
    deny: {
      kind: "rejected",
      error: /Access denied for URL file:\/\/\/.* for downloads\.download\./u,
    },
    leak: "READ",
  },
  {
    id: "tabs-create-viewsource",
    what: "tabs.create({url: view-source:file:///<archive log>})",
    positions: TABS,
    shape: "single",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "wr-redirect-tab",
    what: "tabs.create of a URL the test extension blocking webRequest redirects to the archive log",
    positions: ["ext-bg"],
    shape: "single",
    deny: {
      kind: "answered",
      outcome: "ok",
      text: /^created; 1 s later: url about:blank, status complete, title /u,
    },
    leak: "LEAKS-EXISTENCE",
  },

  // resource://, chrome://, moz-src://
  {
    id: "resource-all",
    what: "fetch and <link> load of resource://<name>/ for every substitution found in omni.ja and the packed product",
    positions: ALL,
    shape: "each",
    deny: UNREACHABLE,
    leak: "READ",
  },
  {
    id: "resource-traversal",
    what: "resource://<substitution>/ with encoded ../ to the archive log: fetch and <link> load",
    positions: ALL,
    shape: "each",
    deny: UNREACHABLE,
    leak: "READ",
  },
  {
    id: "planted-resource",
    what: "planted: resource://och-planted/ (mapped by the harness to the archive with ALLOW_CONTENT_ACCESS): <link> load of the log vs a missing path",
    positions: ["web", "file"],
    shape: "pair",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    expectAt: {
      web: { kind: "LEAKS-EXISTENCE-OR-READ", control: "planted-resource-substitution" },
      file: { kind: "LEAKS-EXISTENCE-OR-READ", control: "planted-resource-substitution" },
    },
  },
  {
    id: "chrome-all",
    what: "fetch and <link> load of chrome://<package>/content/ for every package found in omni.ja and the packed product",
    positions: ALL,
    shape: "each",
    deny: UNREACHABLE,
    leak: "READ",
  },
  {
    id: "chrome-traversal",
    what: "chrome://global/content/ with encoded ../ to the archive log: fetch and <link> load",
    positions: ALL,
    shape: "each",
    deny: UNREACHABLE,
    leak: "READ",
  },
  {
    id: "moz-src-root",
    what: "fetch and <link> load of moz-src:/// paths, and moz-src with encoded ../ to the archive log",
    positions: ALL,
    shape: "each",
    deny: UNREACHABLE,
    leak: "READ",
  },

  // moz-extension:// of One-Click HAR
  {
    id: "mozext-every-file",
    what: "fetch(moz-extension://<recorder uuid>/<path>) for every file in the installed XPI",
    positions: ALL,
    shape: "each",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-manifest",
    what: "fetch(moz-extension://<recorder uuid>/manifest.json)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-parent",
    what: "fetch(moz-extension://<recorder uuid>/experiment/parent.js)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-schema",
    what: "fetch(moz-extension://<recorder uuid>/experiment/schema.json)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-popup",
    what: "fetch(moz-extension://<recorder uuid>/<popup page>)",
    positions: ALL,
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-script-oracle",
    what: "<script src> load/error: recorder popup script vs the same path under a random uuid",
    positions: ALL,
    shape: "pair",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "mozext-timing",
    what: "fetch error text: recorder uuid vs random uuid (medians reported, not judged)",
    positions: ["web", "ext-bg"],
    shape: "pair",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "mozext-frame-recorder",
    what: "<iframe> of the recorder popup page, then postMessage to it",
    positions: ["web", "file", "ext-page", "cs-web"],
    shape: "single",
    deny: FRAME_WITHHELD,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "planted-own-war-fetch",
    what: "planted: fetch the test extension own web_accessible_resources file",
    positions: ["web", "file"],
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
    expectAt: {
      web: { kind: "READ", control: "planted-own-war" },
      file: { kind: "READ", control: "planted-own-war" },
    },
  },
  {
    id: "planted-own-war-script",
    what: "planted: <script src> of the test extension own web-accessible war.js, then read window.OCH_WAR",
    positions: ["web", "file"],
    shape: "single",
    deny: { kind: "answered", outcome: "error", text: /window\.OCH_WAR = undefined$/u },
    leak: "READ",
    expectAt: {
      web: { kind: "READ", control: "planted-own-war" },
      file: { kind: "READ", control: "planted-own-war" },
    },
  },
  {
    id: "own-non-war",
    what: "control: fetch the test extension file that is not web accessible (holds a planted mark)",
    positions: ["web", "file"],
    shape: "single",
    deny: FETCH_DENIED,
    leak: "READ",
  },

  // Experiment API and extension messaging/injection
  {
    id: "api-namespace",
    what: "typeof browser.oneClickHar, typeof the page's own oneClickHar, and page globals a fresh frame lacks",
    positions: ALL,
    shape: "single",
    deny: {
      kind: "answered",
      outcome: "ok",
      text: /^typeof browser\.oneClickHar: (undefined|n\/a); typeof page oneClickHar: undefined; page globals not in a fresh frame: (\[\]|n\/a)$/u,
    },
    leak: "READ",
  },
  {
    id: "api-call",
    what: "browser.oneClickHar.getRecordingStatus()",
    positions: ALL,
    shape: "single",
    deny: {
      kind: "rejected",
      error:
        /^(ReferenceError: browser is not defined|TypeError: can't access property "getRecordingStatus", browser\.oneClickHar is undefined)$/u,
    },
    leak: "READ",
  },
  {
    id: "sendmessage-recorder",
    what: "runtime.sendMessage(<recorder id>, {op: getRecordingStatus})",
    positions: EXTAPI,
    shape: "single",
    deny: { kind: "rejected", error: NO_RECEIVER },
    leak: "READ",
  },
  {
    id: "sendmessage-oracle",
    what: "runtime.sendMessage error: recorder id vs an id that is not installed",
    positions: EXTAPI,
    shape: "pair",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "connect-recorder",
    what: "runtime.connect(<recorder id>) and postMessage",
    positions: EXTAPI,
    shape: "single",
    deny: {
      kind: "answered",
      outcome: "disconnected",
      text: /^onDisconnect, error: Could not establish connection\. Receiving end does not exist\.$/u,
    },
    leak: "READ",
  },
  {
    id: "tabs-query-recorder",
    what: "tabs.query({}) for a tab showing the recorder page",
    positions: TABS,
    shape: "single",
    deny: { kind: "answered-without-recorder" },
    leak: "LEAKS-EXISTENCE",
    expectAt: { "ext-bg": EXCEPTION_TABS, "ext-page": EXCEPTION_TABS },
  },
  {
    id: "executescript-recorder-page",
    what: "tabs.executeScript into the tab showing the recorder popup page",
    positions: TABS,
    shape: "single",
    deny: {
      kind: "answered",
      outcome: "done",
      text: /^(tab \d+ \(moz-extension:\/\/[^)]+\): Error: Missing host permission for the tab(\n|$))+$/u,
    },
    leak: "READ",
  },
  {
    id: "scripting-recorder-page",
    what: "scripting.executeScript into the tab showing the recorder popup page",
    positions: TABS,
    shape: "single",
    deny: {
      kind: "answered",
      outcome: "done",
      text: /^(tab \d+ \(moz-extension:\/\/[^)]+\): Error: Missing host permission for the tab(\n|$))+$/u,
    },
    leak: "READ",
  },
  {
    id: "management-getall",
    what: "management.getAll()",
    positions: TABS,
    shape: "single",
    deny: { kind: "answered-without-recorder" },
    leak: "LEAKS-EXISTENCE",
    expectAt: { "ext-bg": EXCEPTION_MANAGEMENT, "ext-page": EXCEPTION_MANAGEMENT },
  },

  // Indirect paths
  {
    id: "downloads-search",
    what: "downloads.search({}) after recording",
    positions: TABS,
    shape: "single",
    deny: { kind: "answered", outcome: "ok", text: /^no download items$/u },
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "clipboard-after-export",
    what: "navigator.clipboard.readText() after recording",
    positions: ["ext-page"],
    shape: "single",
    deny: { kind: "answered", outcome: "ok", text: /^clipboard text: $/u },
    leak: "READ",
  },
  {
    id: "notifications-getall",
    what: "notifications.getAll() after recording",
    positions: ["ext-bg"],
    shape: "single",
    deny: { kind: "answered", outcome: "ok", text: /^\{\}$/u },
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "storage-recorder",
    what: "storage.local.get(null) in the test extension: its own planted value, never the recorder's",
    positions: TABS,
    shape: "single",
    deny: { kind: "own-value-only" },
    leak: "READ",
  },
  {
    id: "idb-recorder",
    what: "indexedDB in the test extension: its own planted value, and open('och-recorder') never shows the recorder's",
    positions: TABS,
    shape: "single",
    deny: { kind: "own-value-only" },
    leak: "READ",
  },

  // Live-traffic baselines
  {
    id: "devtools-gethar",
    what: "baseline: devtools.network.getHAR() on the inspected bank tab after reload",
    positions: ["ext-devtools"],
    shape: "single",
    deny: { kind: "never" },
    leak: "READ",
    expectAt: { "ext-devtools": { kind: "READ", control: "baseline-live-traffic" } },
  },
  {
    id: "baseline-webrequest",
    what: "baseline: webRequest.onBeforeSendHeaders and filterResponseData on live bank traffic",
    positions: ["ext-bg"],
    shape: "single",
    deny: { kind: "never" },
    leak: "READ",
    expectAt: { "ext-bg": { kind: "READ", control: "baseline-live-traffic" } },
  },
];

/** Present only when the probe extension's content script did not run in the file:// page; else cs-file rows run. */
const CS_FILE_INJECTION_ROW: ExpectedRow = {
  id: "cs-file-injection",
  position: "cs-file",
  what: "test extension content script (matches <all_urls>, all_frames) in the file:// page",
  spec: null,
  expected: BLOCKED,
};

const SYNTHETIC_ROWS: readonly ExpectedRow[] = [
  {
    id: "cs-in-archive-document",
    position: "cs-archive",
    what: "test extension content script injected into any archive or export document",
    spec: null,
    expected: BLOCKED,
  },
  {
    id: "control-system-read",
    position: "system",
    what: "positive control: IOUtils.readUTF8 of the archive log and body from Marionette chrome sandbox",
    spec: null,
    expected: { kind: "READ", control: "control-system-principal" },
  },
  {
    id: "planted-recorder-storage",
    position: "system",
    what: "planted control: a mark written to the recorder's storage.local reads back from the system principal",
    spec: null,
    expected: { kind: "READ", control: "planted-recorder-store" },
  },
  {
    id: "planted-recorder-idb",
    position: "rec-page",
    what: "planted control: a mark written to the recorder origin's IndexedDB reads back in the recorder's page",
    spec: null,
    expected: { kind: "READ", control: "planted-recorder-store" },
  },
  {
    id: "limit-same-user-process",
    position: "os",
    what: "named limit: a process under the same Linux user reads the log",
    spec: null,
    expected: { kind: "READ", control: "named-limit-same-os-user" },
  },
  {
    id: "limit-other-experiment",
    position: "otherexp",
    what: "named limit: another add-on experiment API parent script reads the log",
    spec: null,
    expected: { kind: "READ", control: "named-limit-other-experiment" },
  },
];

/**
 * Checks outside the probe rows. Every run must report each of them exactly once; a missing one fails the run,
 * so a run that skipped them cannot pass. Sources: ARCHITECTURE.md and issue 13.
 */
export const EXTRA_CHECKS = {
  "strict-origin-default":
    "real-defaults keeps security.fileuri.strict_origin_policy true and not user-set",
  "probe-extension-unprivileged":
    "the probe extension is a permanent, unsigned, unprivileged sideload",
  "bank-recorded": "the bank fixture completed with its cookie marker",
  "recorder-status-clean": "the recorder reports recording with no problems",
  "key-file-format": "the key file holds 32 lowercase hex digits and a newline",
  "key-file-mode": "the key file is mode 600",
  "key-names-the-archive":
    "the app folder holds exactly one entry, the folder named by the key file",
  "key-differs-across-profiles": "a second fresh profile gets a different key",
  "key-not-derived":
    "neither key equals a derivation of the profile path, profile name, user name, host or add-on",
  "archive-modes": "every archive directory is 700 and every file 600",
  "nothing-outside-key-folder":
    "every path the product wrote under the app folder is inside the random key folder",
  "written-paths-targeted":
    "every path written by the end of the run was a probe target or lies in a targeted directory",
  "downloads-list": "the Downloads list points nowhere under the data home",
  "exposure-declared":
    "the recorder has no content script, background script or web-accessible resource",
  "no-registration-in-packed-scripts":
    "the packed scripts register no resource:// substitution or chrome package",
  "no-scheme-into-profile-or-data-home":
    "no resource:// or chrome:// name resolves into the profile or the data home",
  "planted-resource-removed":
    "the harness's planted resource:// substitution is gone after the run",
  "positions-completed": "every probe position reported completion",
} as const;

export type ExtraCheckId = keyof typeof EXTRA_CHECKS;

export function denialAt(spec: ProbeSpec, position: Position): Denial {
  return spec.denyAt?.[position] ?? spec.deny;
}

function expectedOutcomeFor(spec: ProbeSpec, position: Position): ExpectedOutcome {
  return spec.expectAt?.[position] ?? BLOCKED;
}

/** Expands PROBE_TABLE, NO_MARIONETTE_PROBE_IDS and SYNTHETIC_ROWS into every expected row. */
export function expandExpectedRows(csFileInjected: boolean): readonly ExpectedRow[] {
  const row = (spec: ProbeSpec, position: Position, what = spec.what): ExpectedRow => ({
    id: spec.id,
    position,
    what,
    spec,
    expected: expectedOutcomeFor(spec, position),
  });
  const secondLaunches = PROBE_TABLE.filter((spec) => NO_MARIONETTE_PROBE_IDS.includes(spec.id));
  return [
    ...(csFileInjected ? [] : [CS_FILE_INJECTION_ROW]),
    ...PROBE_TABLE.flatMap((spec) =>
      spec.positions
        .filter((position) => csFileInjected || position !== "cs-file")
        .map((position) => row(spec, position)),
    ),
    ...secondLaunches.map((spec) => row(spec, "file-no-marionette")),
    ...secondLaunches.map((spec) => row(spec, "file-mutated", `planted mutation: ${spec.what}`)),
    ...SYNTHETIC_ROWS,
  ];
}
