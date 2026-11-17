import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Unit, Witness } from "./judge.ts";

// Every probe's planned units, and how a privileged witness proves each target exists and answers before any probe
// runs. A probe's denial counts only against a target the witness found; a missing counterpart must be found absent.

/** One thing a witness checks. The system principal runs every kind but `redirect` and `fact`, which the harness runs. */
export type WitnessCheck =
  /** A file or folder at this path; with `mark`, a file whose bytes hold it. */
  | { readonly kind: "file"; readonly path: string; readonly mark?: string | undefined }
  | { readonly kind: "load"; readonly url: string; readonly mark?: string | undefined }
  | { readonly kind: "resource"; readonly name: string }
  | { readonly kind: "chrome"; readonly pkg: string }
  | { readonly kind: "addon"; readonly id: string }
  | { readonly kind: "tab"; readonly url: string }
  | { readonly kind: "service"; readonly name: "downloads" | "clipboard" | "notifications" }
  | { readonly kind: "redirect"; readonly url: string; readonly to: string }
  | { readonly kind: "fact"; readonly name: Fact };

/** What the check itself established before planning, through the recorder's own page or the system principal. */
export type Fact = "recorder-api" | "recorder-storage" | "recorder-idb" | "bank-traffic";

export type TargetPlan = {
  readonly targets: Readonly<Record<string, readonly Unit[]>>;
  readonly checks: Readonly<Record<string, readonly WitnessCheck[]>>;
};

export type PlanInput = {
  /** In the bank cookie, HTML and JSON body, so in the log, the body file and the export. */
  readonly marker: string;
  readonly file: {
    readonly appFolder: string;
    /** The real random key folder; guesses replace it with each derived one. */
    readonly keyFolder: string;
    readonly log: string;
    readonly body: string;
    readonly export: string;
    readonly siteDir: string;
  };
  /** Absolute paths the product wrote by the plan, from the disk diff: the key file and the key folder's contents. */
  readonly inventory: readonly { readonly path: string; readonly directory: boolean }[];
  readonly guessedKeyFolders: readonly string[];
  readonly redirectToLog: string;
  readonly wrRedirect: string;
  readonly rec: {
    readonly id: string;
    readonly base: string;
    readonly popupPath: string;
    readonly popupScriptPath: string;
    /** The experiment API's parent script and schema, as the packed manifest names them. */
    readonly parentScript: string;
    readonly schema: string;
    readonly files: readonly string[];
  };
  readonly probe: { readonly base: string; readonly warMark: string; readonly secretMark: string };
  readonly randomUuid: string;
  readonly randomId: string;
  readonly plantedResource: { readonly hit: string; readonly miss: string };
  readonly resourceNames: readonly string[];
  readonly chromePackages: readonly string[];
  readonly mozSrc: string | null;
  readonly binDir: string;
};

/** One key per check, whatever order its fields were written in, so the same check always matches itself. */
export const checkKey = (check: WitnessCheck): string =>
  JSON.stringify(
    Object.entries(check)
      .filter(([, value]) => value !== undefined)
      .sort(),
  );

export const fileHref = (path: string, directory = false): string =>
  `${NodeURL.pathToFileURL(path).href}${directory ? "/" : ""}`;

/** The missing counterpart of a target: the same path with a suffix no product writes. */
export const missingSibling = (href: string): string =>
  href.endsWith("/") ? `${href.slice(0, -1)}-och-missing/` : `${href}-och-missing`;

const pathOf = (href: string): string => NodeURL.fileURLToPath(href.replace(/\/$/u, ""));

/** The four encodings of a `../` walk from a scheme's base folder to the archive log. */
export function traversalUrls(base: string, baseDir: string, logPath: string): readonly string[] {
  const segments = NodePath.relative(baseDir, logPath).split(NodePath.sep);
  return [
    base + segments.join("%2F"),
    base + segments.map((s) => (s === ".." ? "%2e%2e" : s)).join("/"),
    base + segments.map((s) => (s === ".." ? "%2e%2e" : s)).join("%2f"),
    base + segments.join("%5C"),
  ];
}

export function planTargets(input: PlanInput): TargetPlan {
  const targets: Record<string, Unit[]> = {};
  const checks: Record<string, readonly WitnessCheck[]> = {};
  // A target planned by more than one probe must pass every check any of them gave it.
  const want = (target: string, ...needs: readonly WitnessCheck[]): string => {
    const had = checks[target] ?? [];
    const keys = new Set(had.map(checkKey));
    checks[target] = [...had, ...needs.filter((c) => !keys.has(checkKey(c)))];
    return target;
  };
  const fileTarget = (href: string): string => want(href, { kind: "file", path: pathOf(href) });
  const filePair = (href: string): Unit => [fileTarget(href), fileTarget(missingSibling(href))];
  const load = (url: string, mark?: string): string => want(url, { kind: "load", url, mark });
  const plan = (ids: readonly string[], units: readonly Unit[]): void => {
    for (const id of ids) targets[id] = [...units];
  };

  const { file } = input;
  const log = fileHref(file.log);
  const logFile: WitnessCheck = { kind: "file", path: file.log, mark: input.marker };
  const marked = (path: string): string =>
    want(fileHref(path), { kind: "file", path, mark: input.marker });
  const root = fileTarget(fileHref(file.appFolder, true));

  plan(
    [
      "fetch-file-log",
      "xhr-file-log",
      "iframe-file-log",
      "content-fetch-file-log",
      "window-open-file",
      "tabs-create-file",
      "tabs-update-file",
      "windows-create-file",
      "downloads-download-file",
    ],
    [want(log, logFile)],
  );
  const body = marked(file.body);
  plan(["fetch-file-body"], [body]);
  plan(["fetch-file-dir", "iframe-file-root", "tabs-create-dir"], [root]);
  plan(["fetch-file-export", "iframe-file-export"], [marked(file.export)]);
  plan(
    ["img-file-oracle"],
    [[body, fileTarget(fileHref(NodePath.join(file.siteDir, "bodies", "0.0.body")))]],
  );
  plan(
    ["script-root-oracle"],
    [[root, fileTarget(fileHref(`${file.appFolder}-not-installed`, true))]],
  );
  plan(
    ["viewsource-fetch", "viewsource-iframe", "tabs-create-viewsource"],
    [want(`view-source:${log}`, logFile)],
  );
  plan(["jar-file-fetch", "jar-file-iframe"], [want(`jar:${log}!/`, logFile)]);
  plan(
    ["redirect-fetch", "redirect-iframe", "tabs-update-redirect"],
    [want(input.redirectToLog, { kind: "redirect", url: input.redirectToLog, to: log }, logFile)],
  );
  plan(["wr-redirect-iframe"], [want(`${input.wrRedirect}?from=iframe`, logFile)]);
  plan(["wr-redirect-tab"], [want(`${input.wrRedirect}?from=tab`, logFile)]);

  plan(
    ["inventory-read"],
    input.inventory.map((w) => fileTarget(fileHref(w.path, w.directory))),
  );
  const underGuess = (path: string, directory = false): readonly string[] =>
    input.guessedKeyFolders.map((folder) =>
      fileHref(NodePath.join(folder, NodePath.relative(file.keyFolder, path)), directory),
    );
  const guessedLogs = underGuess(file.log);
  const guessedSites = underGuess(file.siteDir, true);
  plan(["script-file-oracle", "css-file-oracle"], guessedLogs.map(filePair));
  plan(["iframe-site-oracle", "script-site-oracle"], guessedSites.map(filePair));

  plan(
    ["resource-all"],
    input.resourceNames.map((name) => want(`resource://${name}/`, { kind: "resource", name })),
  );
  plan(
    ["resource-traversal"],
    traversalUrls("resource://gre/", input.binDir, file.log).map((url) =>
      want(url, { kind: "resource", name: "gre" }, logFile),
    ),
  );
  plan(
    ["planted-resource"],
    [[load(input.plantedResource.hit, input.marker), load(input.plantedResource.miss)]],
  );
  plan(
    ["chrome-all"],
    input.chromePackages.map((pkg) => want(`chrome://${pkg}/content/`, { kind: "chrome", pkg })),
  );
  plan(
    ["chrome-traversal"],
    traversalUrls("chrome://global/content/", input.binDir, file.log).map((url) =>
      want(url, { kind: "chrome", pkg: "global" }, logFile),
    ),
  );
  const { mozSrc } = input;
  plan(
    ["moz-src-root"],
    mozSrc === null
      ? []
      : [
          load(mozSrc),
          ...traversalUrls("moz-src:///", input.binDir, file.log).map((url) =>
            want(url, { kind: "load", url: mozSrc }, logFile),
          ),
        ],
  );

  const { rec } = input;
  const recUrl = (path: string): string => load(`${rec.base}${path}`);
  const randomUrl = (path: string): string => load(`moz-extension://${input.randomUuid}/${path}`);
  plan(["mozext-every-file"], rec.files.map(recUrl));
  plan(["mozext-manifest"], [recUrl("manifest.json")]);
  plan(["mozext-parent"], [recUrl(rec.parentScript)]);
  plan(["mozext-schema"], [recUrl(rec.schema)]);
  plan(["mozext-popup", "mozext-frame-recorder"], [recUrl(rec.popupPath)]);
  plan(["mozext-script-oracle"], [[recUrl(rec.popupScriptPath), randomUrl(rec.popupScriptPath)]]);
  plan(["mozext-timing"], [[recUrl("manifest.json"), randomUrl("manifest.json")]]);
  plan(["planted-own-war-fetch"], [load(`${input.probe.base}war.txt`, input.probe.warMark)]);
  plan(["planted-own-war-script"], [load(`${input.probe.base}war.js`, input.probe.warMark)]);
  plan(["own-non-war"], [load(`${input.probe.base}secret.txt`, input.probe.secretMark)]);

  const recorderAddon = want(`addon:${rec.id}`, { kind: "addon", id: rec.id });
  plan(
    ["api-namespace", "api-call"],
    [want("api:oneClickHar", { kind: "fact", name: "recorder-api" })],
  );
  plan(["sendmessage-recorder", "connect-recorder", "management-getall"], [recorderAddon]);
  plan(
    ["sendmessage-oracle"],
    [[recorderAddon, want(`addon:${input.randomId}`, { kind: "addon", id: input.randomId })]],
  );
  const popupUrl = `${rec.base}${rec.popupPath}`;
  plan(
    ["tabs-query-recorder", "executescript-recorder-page", "scripting-recorder-page"],
    [want(`tab:${popupUrl}`, { kind: "tab", url: popupUrl })],
  );
  plan(["downloads-search"], [want("downloads:all", { kind: "service", name: "downloads" })]);
  plan(["clipboard-after-export"], [want("clipboard:", { kind: "service", name: "clipboard" })]);
  plan(
    ["notifications-getall"],
    [want("notifications:", { kind: "service", name: "notifications" })],
  );
  plan(
    ["storage-recorder"],
    [want("store:recorder-storage-local", { kind: "fact", name: "recorder-storage" })],
  );
  plan(["idb-recorder"], [want("store:recorder-idb", { kind: "fact", name: "recorder-idb" })]);
  plan(
    ["devtools-gethar", "baseline-webrequest"],
    [want("traffic:http://bank.example/", { kind: "fact", name: "bank-traffic" })],
  );
  return { targets, checks };
}

export type CheckOutcome = { readonly ok: boolean; readonly detail: string };

/** A target is present when it has checks and every one held; its detail lists what each check found. */
export function combineWitness(
  plan: TargetPlan,
  results: ReadonlyMap<string, CheckOutcome>,
): Readonly<Record<string, Witness>> {
  return Object.fromEntries(
    Object.entries(plan.checks).map(([target, needs]) => {
      const got = needs.map((c) => [c, results.get(checkKey(c))] as const);
      return [
        target,
        {
          present: got.length > 0 && got.every(([, r]) => r?.ok === true),
          checks: needs.map(checkKey),
          detail: got.map(([c, r]) => r?.detail ?? `no result for ${c.kind}`).join("; "),
        },
      ];
    }),
  );
}
