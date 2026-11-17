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
  | "planted-recorder-store"
  | "baseline-live-traffic"
  | "control-system-principal"
  | "named-limit-same-os-user"
  | "named-limit-other-experiment";

export type ExpectedOutcome =
  | { readonly kind: "BLOCKED" }
  | { readonly kind: "LEAKS-EXISTENCE"; readonly exception: DecidedException }
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

/**
 * What a probe's planned targets must be, named so that a witness can prove it apart from the plan: a file by its
 * path in the product's inventory and the marker it holds, a packed file by the path the product's manifest names,
 * an add-on, a tab, a service or a fact by what the check established. See identity.ts.
 */
export type TargetRole =
  | "archive-log"
  | "archive-body"
  | "export"
  | "app-folder"
  | "inventory"
  | "guessed-log"
  | "guessed-site"
  | "resource-names"
  | "chrome-packages"
  | "moz-src"
  | "planted-log"
  | "packed-files"
  | "packed-manifest"
  | "packed-parent"
  | "packed-schema"
  | "packed-popup"
  | "packed-popup-script"
  | "probe-war-text"
  | "probe-war-script"
  | "probe-secret"
  | "recorder-api"
  | "recorder-addon"
  | "recorder-tab"
  | "downloads"
  | "clipboard"
  | "notifications"
  | "recorder-storage"
  | "recorder-idb"
  | "bank-traffic";

/** How a row's result is shaped: one answer, an existing/missing pair, or one answer per planned target. */
export type Shape = "single" | "pair" | "each";

const LOADS = ["load", "error", "timeout"] as const;
const REPLIES = ["ok", "error", "timeout"] as const;

/**
 * Every outcome a probe may report for one target. A row whose outcome is not one of these, or that has no outcome,
 * text or target, is malformed and can only be NO-RESULT. A pair's or a per-target row's own outcome is not read.
 */
export const OUTCOMES = [
  "ok",
  "error",
  "timeout",
  "threw",
  "no-target",
  "done",
  "disconnected",
  "message",
  "load",
  ...LOADS.flatMap((a) => LOADS.map((b) => `${a},${b}` as const)),
  ...REPLIES.flatMap((f) => LOADS.map((l) => `fetch ${f}, link ${l}` as const)),
] as const;

export type Outcome = (typeof OUTCOMES)[number];

type ProbeBase = {
  readonly id: string;
  readonly what: string;
  readonly positions: readonly BrowserProbePosition[];
  readonly shape: Shape;
  readonly target: TargetRole;
  readonly expectAt?: Readonly<Partial<Record<Position, ExpectedOutcome>>>;
  /**
   * The planned targets are guesses (paths under derived archive keys) that exist only when the product made its
   * key guessable. The witness still checks each one; a guess it finds absent has nothing to deny.
   */
  readonly guess?: true;
};

/** The two denials that decide the leak kind themselves: a reachable URL reads, and a store read is a control. */
type SelfJudgedDenial = Extract<Denial, { readonly kind: "unreachable" | "own-value-only" }>;
type LeakDenial = Exclude<Denial, SelfJudgedDenial>;

export type ProbeSpec = ProbeBase &
  (
    | { readonly deny: SelfJudgedDenial }
    | {
        readonly deny: LeakDenial;
        readonly denyAt?: Readonly<Partial<Record<Position, LeakDenial>>>;
        readonly leak: LeakKind;
      }
  );

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

/** Probes repeated in the launch without Marionette, where no remote-protocol pref is set. */
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
    target: "archive-log",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "fetch-file-body",
    what: "fetch(file:///<archive>/sites/<site>/bodies/<id>.body)",
    positions: ALL,
    shape: "single",
    target: "archive-body",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "fetch-file-dir",
    what: "fetch(file:///<appFolder>/) directory listing",
    positions: ALL,
    shape: "single",
    target: "app-folder",
    deny: FETCH_DENIED,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "fetch-file-export",
    what: "fetch(file:///<Downloads>/<site>-<date>.har)",
    positions: ALL,
    shape: "single",
    target: "export",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "inventory-read",
    what: "fetch of every file and directory the product wrote by the plan (disk diff of the workspace)",
    positions: ALL,
    shape: "each",
    target: "inventory",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "content-fetch-file-log",
    what: "content.fetch (page context) of the archive log",
    positions: ["cs-web", "cs-file"],
    shape: "single",
    target: "archive-log",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "xhr-file-log",
    what: "XMLHttpRequest GET of the archive log",
    positions: ALL,
    shape: "single",
    target: "archive-log",
    deny: XHR_DENIED,
    leak: "READ",
  },
  {
    id: "iframe-file-log",
    what: "<iframe src> of the archive log, then read contentDocument",
    positions: ALL,
    shape: "single",
    target: "archive-log",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "iframe-file-root",
    what: "<iframe src> of the archive root directory listing, then read it",
    positions: ALL,
    shape: "single",
    target: "app-folder",
    deny: FRAME_WITHHELD,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "iframe-file-export",
    what: "<iframe src> of the exported HAR, then read it",
    positions: ALL,
    shape: "single",
    target: "export",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "img-file-oracle",
    what: "<img> load/error: recorded site body file vs a missing path",
    positions: ALL,
    shape: "pair",
    target: "archive-body",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "script-file-oracle",
    what: "<script> load/error: the log under every guessed archive key (profile, user, host derivations) vs a missing path",
    positions: ALL,
    shape: "each",
    target: "guessed-log",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    guess: true,
  },
  {
    id: "css-file-oracle",
    what: "<link rel=stylesheet> load/error: the log under every guessed archive key vs a missing path",
    positions: ALL,
    shape: "each",
    target: "guessed-log",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    guess: true,
  },
  {
    id: "iframe-site-oracle",
    what: "<iframe> load/error: the site directory under every guessed archive key vs an unrecorded site",
    positions: ALL,
    shape: "each",
    target: "guessed-site",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    guess: true,
  },
  {
    id: "script-root-oracle",
    what: "<script> load/error: top-level one-click-har folder vs a missing sibling",
    positions: ALL,
    shape: "pair",
    target: "app-folder",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    expectAt: {
      file: EXCEPTION_ROOT,
      "file-no-marionette": EXCEPTION_ROOT,
    },
  },
  {
    id: "script-site-oracle",
    what: "<script> load/error: the site directory under every guessed archive key vs an unrecorded site",
    positions: ALL,
    shape: "each",
    target: "guessed-site",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
    guess: true,
  },
  {
    id: "viewsource-fetch",
    what: "fetch(view-source:file:///<archive log>)",
    positions: ALL,
    shape: "single",
    target: "archive-log",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "viewsource-iframe",
    what: "<iframe src=view-source:file:///<archive log>>",
    positions: ALL,
    shape: "single",
    target: "archive-log",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "jar-file-fetch",
    what: "fetch(jar:file:///<archive log>!/)",
    positions: ALL,
    shape: "single",
    target: "archive-log",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "jar-file-iframe",
    what: "<iframe src=jar:file:///<archive log>!/>",
    positions: ALL,
    shape: "single",
    target: "archive-log",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "redirect-fetch",
    what: "fetch of an http URL that 302-redirects to the archive log",
    positions: ALL,
    shape: "single",
    target: "archive-log",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "redirect-iframe",
    what: "<iframe> of an http URL that 302-redirects to the archive log",
    positions: ALL,
    shape: "single",
    target: "archive-log",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "window-open-file",
    what: "window.open(file:///<archive log>), then read the window",
    positions: DOC,
    shape: "single",
    target: "archive-log",
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
    target: "archive-log",
    deny: FRAME_WITHHELD,
    leak: "READ",
  },
  {
    id: "tabs-create-file",
    what: "tabs.create({url: file:///<archive log>})",
    positions: TABS,
    shape: "single",
    target: "archive-log",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "tabs-create-dir",
    what: "tabs.create({url: file:///<appFolder>/})",
    positions: TABS,
    shape: "single",
    target: "app-folder",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "tabs-update-file",
    what: "tabs.update(<an http tab>, {url: file:///<archive log>})",
    positions: TABS,
    shape: "single",
    target: "archive-log",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "tabs-update-redirect",
    what: "tabs.update(<an http tab>, {url: <http URL that 302-redirects to the log>})",
    positions: TABS,
    shape: "single",
    target: "archive-log",
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
    target: "archive-log",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "downloads-download-file",
    what: "downloads.download({url: file:///<archive log>})",
    positions: TABS,
    shape: "single",
    target: "archive-log",
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
    target: "archive-log",
    deny: ILLEGAL_URL,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "wr-redirect-tab",
    what: "tabs.create of a URL the test extension blocking webRequest redirects to the archive log",
    positions: ["ext-bg"],
    shape: "single",
    target: "archive-log",
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
    target: "resource-names",
    deny: UNREACHABLE,
  },
  {
    id: "resource-traversal",
    what: "resource://<substitution>/ with encoded ../ to the archive log: fetch and <link> load",
    positions: ALL,
    shape: "each",
    target: "archive-log",
    deny: UNREACHABLE,
  },
  {
    id: "planted-resource",
    what: "planted: resource://och-planted/ (mapped by the harness to the archive with ALLOW_CONTENT_ACCESS): <link> load of the log vs a missing path",
    positions: ["web", "file"],
    shape: "pair",
    target: "planted-log",
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
    target: "chrome-packages",
    deny: UNREACHABLE,
  },
  {
    id: "chrome-traversal",
    what: "chrome://global/content/ with encoded ../ to the archive log: fetch and <link> load",
    positions: ALL,
    shape: "each",
    target: "archive-log",
    deny: UNREACHABLE,
  },
  {
    id: "moz-src-root",
    what: "fetch and <link> load of moz-src:/// paths, and moz-src with encoded ../ to the archive log",
    positions: ALL,
    shape: "each",
    target: "moz-src",
    deny: UNREACHABLE,
  },

  // moz-extension:// of One-Click HAR
  {
    id: "mozext-every-file",
    what: "fetch(moz-extension://<recorder uuid>/<path>) for every file in the installed XPI",
    positions: ALL,
    shape: "each",
    target: "packed-files",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-manifest",
    what: "fetch(moz-extension://<recorder uuid>/manifest.json)",
    positions: ALL,
    shape: "single",
    target: "packed-manifest",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-parent",
    what: "fetch(moz-extension://<recorder uuid>/experiment/parent.js)",
    positions: ALL,
    shape: "single",
    target: "packed-parent",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-schema",
    what: "fetch(moz-extension://<recorder uuid>/experiment/schema.json)",
    positions: ALL,
    shape: "single",
    target: "packed-schema",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-popup",
    what: "fetch(moz-extension://<recorder uuid>/<popup page>)",
    positions: ALL,
    shape: "single",
    target: "packed-popup",
    deny: FETCH_DENIED,
    leak: "READ",
  },
  {
    id: "mozext-script-oracle",
    what: "<script src> load/error: recorder popup script vs the same path under a random uuid",
    positions: ALL,
    shape: "pair",
    target: "packed-popup-script",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "mozext-timing",
    what: "fetch error text: recorder uuid vs random uuid (medians reported, not judged)",
    positions: ["web", "ext-bg"],
    shape: "pair",
    target: "packed-manifest",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "mozext-frame-recorder",
    what: "<iframe> of the recorder popup page, then postMessage to it and listen for any reply",
    positions: ["web", "file", "ext-page", "cs-web"],
    shape: "single",
    target: "packed-popup",
    // Only a load that failed counts: a recorder page that loads, even cross-origin and silent, is reachable.
    deny: {
      kind: "answered",
      outcome: "error",
      text: /^error; contentDocument readable, text: ; contentWindow\.location\.href: about:blank; replies: none$/u,
    },
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "planted-own-war-fetch",
    what: "planted: fetch the test extension own web_accessible_resources file",
    positions: ["web", "file"],
    shape: "single",
    target: "probe-war-text",
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
    target: "probe-war-script",
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
    target: "probe-secret",
    deny: FETCH_DENIED,
    leak: "READ",
  },

  // Experiment API and extension messaging/injection
  {
    id: "api-namespace",
    what: "typeof browser.oneClickHar, typeof the page's own oneClickHar, and page globals a fresh frame lacks",
    positions: ALL,
    shape: "single",
    target: "recorder-api",
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
    target: "recorder-api",
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
    target: "recorder-addon",
    deny: { kind: "rejected", error: NO_RECEIVER },
    leak: "READ",
  },
  {
    id: "sendmessage-oracle",
    what: "runtime.sendMessage error: recorder id vs an id that is not installed",
    positions: EXTAPI,
    shape: "pair",
    target: "recorder-addon",
    deny: SAME,
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "connect-recorder",
    what: "runtime.connect(<recorder id>) and postMessage",
    positions: EXTAPI,
    shape: "single",
    target: "recorder-addon",
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
    target: "recorder-tab",
    deny: { kind: "answered-without-recorder" },
    leak: "LEAKS-EXISTENCE",
    expectAt: { "ext-bg": EXCEPTION_TABS, "ext-page": EXCEPTION_TABS },
  },
  {
    id: "executescript-recorder-page",
    what: "tabs.executeScript into the tab showing the recorder popup page",
    positions: TABS,
    shape: "single",
    target: "recorder-tab",
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
    target: "recorder-tab",
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
    target: "recorder-addon",
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
    target: "downloads",
    deny: { kind: "answered", outcome: "ok", text: /^no download items$/u },
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "clipboard-after-export",
    what: "navigator.clipboard.readText() after recording",
    positions: ["ext-page"],
    shape: "single",
    target: "clipboard",
    deny: { kind: "answered", outcome: "ok", text: /^clipboard text: $/u },
    leak: "READ",
  },
  {
    id: "notifications-getall",
    what: "notifications.getAll() after recording",
    positions: ["ext-bg"],
    shape: "single",
    target: "notifications",
    deny: { kind: "answered", outcome: "ok", text: /^\{\}$/u },
    leak: "LEAKS-EXISTENCE",
  },
  {
    id: "storage-recorder",
    what: "storage.local.get(null) in the test extension: its own planted value, never the recorder's",
    positions: TABS,
    shape: "single",
    target: "recorder-storage",
    deny: { kind: "own-value-only" },
  },
  {
    id: "idb-recorder",
    what: "indexedDB in the test extension: its own planted value, and open('och-recorder') never shows the recorder's",
    positions: TABS,
    shape: "single",
    target: "recorder-idb",
    deny: { kind: "own-value-only" },
  },

  // Live-traffic baselines
  {
    id: "devtools-gethar",
    what: "baseline: devtools.network.getHAR() on the inspected bank tab after reload",
    positions: ["ext-devtools"],
    shape: "single",
    target: "bank-traffic",
    deny: { kind: "never" },
    leak: "READ",
    expectAt: { "ext-devtools": { kind: "READ", control: "baseline-live-traffic" } },
  },
  {
    id: "baseline-webrequest",
    what: "baseline: webRequest.onBeforeSendHeaders and filterResponseData on live bank traffic",
    positions: ["ext-bg"],
    shape: "single",
    target: "bank-traffic",
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
  "exposure-allowed":
    "every surface the recorder exposes (manifest keys, experiment scopes and child, schema contexts, declared and runtime web-accessible resources, external listeners, message listeners, frames and postMessage answers on its pages) is in the allowed set",
  "disk-writes-allowed":
    "every new or changed path in the throwaway home, profile, data home and Downloads, links included, is the browser's, the harness's, the key file, inside the key folder, or an export",
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
  const { denyAt } = spec as { readonly denyAt?: Readonly<Partial<Record<Position, Denial>>> };
  return denyAt?.[position] ?? spec.deny;
}

function expectedOutcomeFor(spec: ProbeSpec, position: Position): ExpectedOutcome {
  return spec.expectAt?.[position] ?? BLOCKED;
}

/** Expands PROBE_TABLE, NO_MARIONETTE_PROBE_IDS and SYNTHETIC_ROWS into every expected row. */
export function expandExpectedRows(csFileInjected: boolean): readonly ExpectedRow[] {
  const row = (spec: ProbeSpec, position: Position): ExpectedRow => ({
    id: spec.id,
    position,
    what: spec.what,
    spec,
    expected: expectedOutcomeFor(spec, position),
  });
  const noMarionette = PROBE_TABLE.filter((spec) => NO_MARIONETTE_PROBE_IDS.includes(spec.id));
  return [
    ...(csFileInjected ? [] : [CS_FILE_INJECTION_ROW]),
    ...PROBE_TABLE.flatMap((spec) =>
      spec.positions
        .filter((position) => csFileInjected || position !== "cs-file")
        .map((position) => row(spec, position)),
    ),
    ...noMarionette.map((spec) => row(spec, "file-no-marionette")),
    ...SYNTHETIC_ROWS,
  ];
}
