import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ARCHIVE_KEY_FILE } from "@one-click-har/recording/layout";
import { locateArchive } from "../src/archive.ts";
import {
  launchBrowser,
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
  type Pref,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { judgeArchiveModes, judgeDownloads } from "../src/recording-judge.ts";
import { callHook, HARNESS_PREFS, recordingWorkspace } from "../src/recording-session.ts";
import {
  isProfileDerivedKey,
  judgeIsolationRun,
  type BrowserRowReport,
  type SyntheticControlResult,
} from "../fixtures/isolation/judge.ts";
import {
  buildOtherExperimentXpi,
  buildProbeExtensionXpi,
  buildSavedPageHtml,
  OTHER_EXPERIMENT_ID,
  PAGE_RUNNER_JS,
  PROBE_EXTENSION_ID,
  PROBE_HTML,
  PROBES_JS,
} from "../fixtures/isolation/probe-script.ts";
import { NO_MARIONETTE_PROBE_IDS } from "../fixtures/isolation/probe-table.ts";
import { startIsolationServer, type IsolationReport } from "../fixtures/isolation/server.ts";

const POSITION_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 30_000;

const proxyPrefs = (port: number): readonly Pref[] => [
  { name: "network.proxy.type", value: 1 },
  { name: "network.proxy.http", value: "127.0.0.1" },
  { name: "network.proxy.http_port", value: port },
  { name: "network.proxy.ssl", value: "127.0.0.1" },
  { name: "network.proxy.ssl_port", value: 9 },
  { name: "network.proxy.no_proxies_on", value: "127.0.0.1" },
  { name: "network.proxy.allow_hijacking_localhost", value: false },
  { name: "network.proxy.failover_direct", value: false },
  { name: "network.trr.mode", value: 5 },
  { name: "network.connectivity-service.enabled", value: false },
  { name: "network.captive-portal-service.enabled", value: false },
  { name: "browser.chrome.site_icons", value: false },
];

type AddonInfo = {
  readonly isActive: boolean;
  readonly isPrivileged: boolean;
  readonly signedState: number;
  readonly temporarilyInstalled: boolean;
  readonly uuid: string | null;
};

type ChromeBootstrapInfo = {
  readonly strictFileOrigin: boolean;
  readonly strictFileOriginUserSet: boolean;
  readonly addons: Readonly<Record<string, AddonInfo | null>>;
};

type EnumeratedSchemes = {
  readonly subs: readonly { readonly name: string; readonly resolved: string }[];
  readonly chrome: readonly { readonly pkg: string; readonly target: string }[];
};

const CHROME_INFO_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const ids = arguments[0];
  (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (ids.every((id) => { const p = WebExtensionPolicy.getByID(id); return p && p.active; })) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const addons = {};
    for (const id of ids) {
      const a = await AddonManager.getAddonByID(id);
      const pol = WebExtensionPolicy.getByID(id);
      addons[id] = a ? {
        isActive: a.isActive,
        isPrivileged: a.isPrivileged,
        signedState: a.signedState,
        temporarilyInstalled: a.temporarilyInstalled,
        uuid: pol ? pol.mozExtensionHostname : null,
      } : null;
    }
    done({
      strictFileOrigin: Services.prefs.getBoolPref("security.fileuri.strict_origin_policy"),
      strictFileOriginUserSet: Services.prefs.prefHasUserValue("security.fileuri.strict_origin_policy"),
      addons,
    });
  })().catch((e) => done({ error: String(e) }));
`;

const CHROME_ENUMERATE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  const reg = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(Ci.nsIChromeRegistry);
  const resNames = new Set(["", "gre", "app"]);
  const pkgs = new Set();
  const jars = new Set();
  for (const n of ["", "gre"]) {
    const m = /^jar:(file:[^!]+)!/.exec(res.getSubstitution(n).spec);
    if (m) jars.add(m[1]);
  }
  for (const jar of jars) {
    const zr = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zr.open(Services.io.newURI(jar).QueryInterface(Ci.nsIFileURL).file);
    const it = zr.findEntries(null);
    while (it.hasMore()) {
      const name = it.getNext();
      if (!/\\.(m?js|jsm|manifest|x?html|css|json|xml|ftl|svg|xhtml|txt)$/.test(name)) continue;
      let text = "";
      try { const s = zr.getInputStream(name); text = NetUtil.readInputStreamToString(s, s.available()); s.close(); } catch { continue; }
      for (const m of text.matchAll(/resource:\\/\\/([a-z0-9][a-z0-9._-]*)\\//gi)) resNames.add(m[1].toLowerCase());
      for (const m of text.matchAll(/chrome:\\/\\/([a-z0-9][a-z0-9._-]*)\\/(content|skin|locale)\\//gi)) pkgs.add(m[1].toLowerCase());
      if (name.endsWith(".manifest")) {
        for (const line of text.split("\\n")) {
          const w = line.trim().split(/\\s+/);
          if (w[0] === "resource" && w[1]) resNames.add(w[1].toLowerCase());
          if (w[0] === "content" && w[1]) pkgs.add(w[1].toLowerCase());
        }
      }
    }
    zr.close();
  }
  const subs = [];
  for (const name of [...resNames].sort()) {
    if (!res.hasSubstitution(name)) continue;
    let resolved = "";
    try { resolved = res.resolveURI(Services.io.newURI("resource://" + name + "/")); } catch (e) { resolved = "error " + e; }
    subs.push({ name, resolved });
  }
  const chrome = [];
  for (const pkg of [...pkgs].sort()) {
    try {
      const target = reg.convertChromeURL(Services.io.newURI("chrome://" + pkg + "/content/")).spec;
      chrome.push({ pkg, target });
    } catch {}
  }
  done({ subs, chrome });
`;

const CHROME_READ_ARCHIVE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const paths = arguments[0];
  (async () => {
    const out = { processType: Services.appinfo.processType, isSystemPrincipal: Cu.getObjectPrincipal({}).isSystemPrincipal };
    for (const [k, p] of Object.entries(paths)) {
      try { out[k] = await IOUtils.readUTF8(p); } catch (e) { out[k] = "error " + e; }
    }
    done(out);
  })();
`;

const CHROME_OTHER_EXP_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const logPath = arguments[0];
  (async () => {
    Services.prefs.clearUserPref("och.otherexp.result");
    Services.obs.notifyObservers(null, "och-other-exp-read", logPath);
    for (let i = 0; i < 50 && !Services.prefs.prefHasUserValue("och.otherexp.result"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    done(Services.prefs.getStringPref("och.otherexp.result", ""));
  })();
`;

const CHROME_PLANT_RESOURCE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const targetPath = arguments[0];
  const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  if (targetPath) {
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(targetPath);
    res.setSubstitutionWithFlags("och-planted", Services.io.newFileURI(f), Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);
    done(res.getSubstitution("och-planted").spec);
    return;
  }
  res.setSubstitution("och-planted", null);
  done(res.hasSubstitution("och-planted"));
`;

const CHROME_CAN_ACCESS_FILE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const [addonId, savedUrl, logUrl] = arguments;
  const p = WebExtensionPolicy.getByID(addonId);
  if (!p) { done(null); return; }
  done({
    savedPage: p.canAccessURI(Services.io.newURI(savedUrl)),
    archiveLog: p.canAccessURI(Services.io.newURI(logUrl)),
  });
`;

const CHROME_OPEN_TAB_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const url = arguments[0];
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const tab = win.gBrowser.addTab(url, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  win.gBrowser.selectedTab = tab;
  done("ok");
`;

const CHROME_OPEN_DEVTOOLS_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const prefix = arguments[0];
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const tab = win.gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec.startsWith(prefix));
  if (!tab) { done("no tab for " + prefix); return; }
  win.gBrowser.selectedTab = tab;
  const { DevToolsShim } = ChromeUtils.importESModule("chrome://devtools-startup/content/DevToolsShim.sys.mjs");
  DevToolsShim.showToolboxForTab(tab, { toolId: "netmonitor" }).then(
    (tb) => done(tb ? "open" : "null"),
    (e) => done("error " + e),
  );
`;

const CHROME_DOWNLOAD_TARGETS_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  Downloads.getList(Downloads.ALL).then((list) => list.getAll()).then((all) => done(all.map((d) => d.target.path)));
`;

function findFirstFile(dir: string, suffix: string): string | null {
  if (!NodeFS.existsSync(dir)) return null;
  const name = NodeFS.readdirSync(dir)
    .sort()
    .find((entry) => entry.endsWith(suffix));
  return name === undefined ? null : NodePath.join(dir, name);
}

function fileHref(filePath: string): string {
  return NodeURL.pathToFileURL(filePath).href;
}

function buildTraversalUrls(base: string, baseDir: string, logPath: string): readonly string[] {
  const segments = NodePath.relative(baseDir, logPath).split(NodePath.sep);
  return [
    base + segments.join("%2F"),
    base + segments.map((s) => (s === ".." ? "%2e%2e" : s)).join("/"),
    base + segments.map((s) => (s === ".." ? "%2e%2e" : s)).join("%2f"),
    base + segments.join("%5C"),
  ];
}

async function runNoMarionetteLaunch(options: {
  readonly position: "file-no-marionette" | "file-mutated";
  readonly binaryPath: string;
  readonly display: CheckContext["display"];
  readonly profileDir: string;
  readonly dataHome: string;
  readonly url: string;
  readonly extraPrefs: readonly Pref[];
  readonly server: Awaited<ReturnType<typeof startIsolationServer>>;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  await using _session = await launchBrowser({
    binaryPath: options.binaryPath,
    extensionPath: null,
    display: options.display,
    launchMode: "none",
    profileDir: options.profileDir,
    dataHome: options.dataHome,
    urls: [options.url],
    extraPrefs: options.extraPrefs,
    signal: options.signal,
  });
  options.server.enable(options.position);
  const done = await options.server.waitFor(
    (r): r is Extract<IsolationReport, { kind: "position-done" }> =>
      r.kind === "position-done" && r.position === options.position,
    POSITION_TIMEOUT_MS,
  );
  return done === null ? `${options.position}: timed out waiting for page completion` : null;
}

/**
 * Runs 287 isolation probes against the real packed XPI from content principals, another extension's
 * moz-extension principal (all ordinary permissions, permanent non-privileged install), expanded content-script
 * principals, and no-Marionette / strict_origin_policy=false file launches.
 */
const check: HarnessCheck = {
  name: "isolation",
  description:
    "287 isolation probes across web, file, and other-extension principals against the packed XPI",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null) {
      return { name: "isolation", ok: false, durationMs: 0, detail: "needs --extension" };
    }

    const recorderId = await readExtensionId(context.extensionPath);
    const popupPath = await readExtensionPopupPath(context.extensionPath);
    const popupScriptPath = popupPath.replace(/\.html$/u, ".js");
    const marker = `OCHMARK_${NodeCrypto.randomBytes(8).toString("hex")}`;
    const warMark = `OCHWAR_${NodeCrypto.randomBytes(8).toString("hex")}`;
    const secretMark = `OCHSECRET_${NodeCrypto.randomBytes(8).toString("hex")}`;
    const site = "bank.example";

    await using server = await startIsolationServer({
      marker,
      probeHtml: PROBE_HTML,
      probesJs: PROBES_JS,
      runnerJs: PAGE_RUNNER_JS,
    });
    await using workspace = recordingWorkspace("isolation");

    const extensionsDir = NodePath.join(workspace.profileDir, "extensions");
    NodeFS.mkdirSync(extensionsDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(extensionsDir, `${PROBE_EXTENSION_ID}.xpi`),
      buildProbeExtensionXpi({ serverOrigin: server.origin, warMark, secretMark }),
    );
    NodeFS.writeFileSync(
      NodePath.join(extensionsDir, `${OTHER_EXPERIMENT_ID}.xpi`),
      buildOtherExperimentXpi(),
    );

    const extraChecks: string[] = [];
    const syntheticControls: SyntheticControlResult[] = [];
    let canAccessFileObserved = false;
    let planUrls: string[] = [];
    let archiveKey = "";
    let recUuid = "";
    let savedPageUrl = "";
    const noMarionetteExtraPrefs = [...HARNESS_PREFS, ...proxyPrefs(server.port)];

    {
      await using session: BrowserSession = await workspace.launch({
        binaryPath: context.binaryPath,
        extensionPath: context.extensionPath,
        display: context.display,
        protocol: "marionette",
        launchMode: "real-defaults",
        signal: context.signal,
        extraPrefs: proxyPrefs(server.port),
      });

      const info = (await session.evaluateChrome(CHROME_INFO_SCRIPT, [
        [recorderId, PROBE_EXTENSION_ID, OTHER_EXPERIMENT_ID],
      ])) as ChromeBootstrapInfo & { readonly error?: string };
      if (info.error !== undefined) throw new Error(`chrome bootstrap failed: ${info.error}`);
      if (!info.strictFileOrigin || info.strictFileOriginUserSet) {
        extraChecks.push(
          `real-defaults strict_origin_policy=${String(info.strictFileOrigin)} userSet=${String(info.strictFileOriginUserSet)}`,
        );
      }

      const probeAddon = info.addons[PROBE_EXTENSION_ID];
      const recAddon = info.addons[recorderId];
      if (probeAddon === null || probeAddon === undefined || !probeAddon.isActive) {
        throw new Error(`probe extension ${PROBE_EXTENSION_ID} did not activate`);
      }
      if (
        probeAddon.isPrivileged ||
        probeAddon.signedState !== 0 ||
        probeAddon.temporarilyInstalled
      ) {
        extraChecks.push(
          `probe extension must be unprivileged permanent sideload, got ${JSON.stringify(probeAddon)}`,
        );
      }
      if (recAddon === null || recAddon === undefined || recAddon.uuid === null) {
        throw new Error(`recorder extension ${recorderId} did not activate`);
      }
      recUuid = recAddon.uuid;
      const probeUuid = probeAddon.uuid;
      if (probeUuid === null) throw new Error("probe extension has no uuid");

      await session.evaluateChrome(CHROME_OPEN_TAB_SCRIPT, [`http://${site}/`]);
      const bankDone = await server.waitFor(
        (r): r is Extract<IsolationReport, { kind: "bank-done" }> => r.kind === "bank-done",
        STEP_TIMEOUT_MS,
      );
      if (bankDone === null || !bankDone.cookie.includes(marker)) {
        extraChecks.push(`bank fixture did not complete with cookie marker`);
      }
      await callHook(session, { kind: "seal" });

      const popupUrl = await waitForActiveExtensionUrl(session, recorderId, popupPath);
      const popupTab = await session.openTab(popupUrl);
      const status = JSON.parse(
        await session.evaluate(
          popupTab,
          "browser.oneClickHar.getRecordingStatus().then(JSON.stringify)",
        ),
      ) as { readonly recording: boolean; readonly problems: readonly string[] };
      if (!status.recording || status.problems.length > 0) {
        extraChecks.push(`recorder status under real-defaults was ${JSON.stringify(status)}`);
      }

      const located = locateArchive(workspace.dataHome, workspace.profileDir);
      if (located === null) throw new Error("archive key missing after seal");
      archiveKey = located.key;
      if (isProfileDerivedKey(archiveKey, workspace.profileDir)) {
        extraChecks.push(`archive key ${archiveKey} is not 128 random bits`);
      }
      const keyMode =
        NodeFS.statSync(NodePath.join(workspace.profileDir, ARCHIVE_KEY_FILE)).mode & 0o777;
      if (keyMode !== 0o600) {
        extraChecks.push(`archive key file mode ${keyMode.toString(8)}, expected 600`);
      }
      extraChecks.push(
        ...judgeArchiveModes(workspace.entries(), ["jsonl", "summary.json", "pack", "body"]),
      );

      const downloadsProblem = judgeDownloads(
        (await session.evaluateChrome(CHROME_DOWNLOAD_TARGETS_SCRIPT)) as readonly string[],
        workspace.dataHome,
      );
      if (downloadsProblem !== null) extraChecks.push(downloadsProblem);

      const siteDirPath = NodePath.join(located.root, "sites", site);
      const logPath = findFirstFile(NodePath.join(siteDirPath, "log"), ".jsonl");
      const bodyPath = findFirstFile(NodePath.join(siteDirPath, "bodies"), ".body");
      if (logPath === null || bodyPath === null) {
        throw new Error(`missing log (${String(logPath)}) or body (${String(bodyPath)})`);
      }

      const exportPath = NodePath.join(workspace.downloads, `${site}-2026-11-16.har`);
      NodeFS.writeFileSync(
        exportPath,
        JSON.stringify({
          log: {
            version: "1.2",
            creator: { name: "One-Click HAR", version: "0.1.0" },
            entries: [
              { request: { url: `http://${site}/` }, response: { content: { text: marker } } },
            ],
          },
        }),
        { mode: 0o600 },
      );

      const sysRead = (await session.evaluateChrome(CHROME_READ_ARCHIVE_SCRIPT, [
        { log: logPath, body: bodyPath },
      ])) as {
        readonly processType: number;
        readonly isSystemPrincipal: boolean;
        readonly log: string;
        readonly body: string;
      };
      syntheticControls.push({
        id: "control-system-read",
        position: "system",
        observed: `processType=${String(sysRead.processType)} isSystemPrincipal=${String(sysRead.isSystemPrincipal)}`,
        verdict: sysRead.log.includes(marker) && sysRead.body.includes(marker) ? "READ" : "BLOCKED",
      });

      const osText = NodeFS.readFileSync(logPath, "utf8");
      syntheticControls.push({
        id: "limit-same-user-process",
        position: "os",
        observed: `read ${String(osText.length)} chars`,
        verdict: osText.includes(`${marker}-in-cookie`) ? "READ" : "BLOCKED",
      });

      const otherRaw = (await session.evaluateChrome(CHROME_OTHER_EXP_SCRIPT, [logPath])) as string;
      const otherParsed = otherRaw
        ? (JSON.parse(otherRaw) as { readonly text?: string; readonly error?: string })
        : {};
      syntheticControls.push({
        id: "limit-other-experiment",
        position: "otherexp",
        observed: otherParsed.error ?? `read ${String(otherParsed.text?.length ?? 0)} chars`,
        verdict: (otherParsed.text ?? "").includes(marker) ? "READ" : "BLOCKED",
      });

      const enumerated = (await session.evaluateChrome(
        CHROME_ENUMERATE_SCRIPT,
      )) as EnumeratedSchemes;
      const badSchemes = [
        ...enumerated.subs.filter(
          (s) =>
            s.resolved.includes(workspace.profileDir) || s.resolved.includes(workspace.dataHome),
        ),
        ...enumerated.chrome.filter(
          (c) => c.target.includes(workspace.profileDir) || c.target.includes(workspace.dataHome),
        ),
      ];
      if (badSchemes.length > 0) {
        extraChecks.push(`scheme points into profile or dataHome: ${JSON.stringify(badSchemes)}`);
      }

      await session.evaluateChrome(CHROME_PLANT_RESOURCE_SCRIPT, [located.root]);

      const savedPagePath = NodePath.join(workspace.downloads, "saved-page.html");
      NodeFS.writeFileSync(savedPagePath, buildSavedPageHtml(server.origin), "utf8");
      savedPageUrl = fileHref(savedPagePath);

      const guessedKey = NodeCrypto.createHash("sha256")
        .update(workspace.profileDir)
        .digest("hex")
        .slice(0, 16);
      const guessedArchiveDir = NodePath.join(located.appFolder, guessedKey);
      const guessedSiteDirPath = NodePath.join(guessedArchiveDir, "sites", site);
      const guessedLogPath = NodePath.join(guessedSiteDirPath, "log", NodePath.basename(logPath));

      const filePlan = {
        root: `${fileHref(located.appFolder)}/`,
        missingRoot: `${fileHref(`${located.appFolder}-not-installed`)}/`,
        siteDir: `${fileHref(siteDirPath)}/`,
        guessedSiteDir: `${fileHref(guessedSiteDirPath)}/`,
        missingSite: `${fileHref(NodePath.join(located.root, "sites", "never-visited.example"))}/`,
        log: fileHref(logPath),
        guessedLog: fileHref(guessedLogPath),
        body: fileHref(bodyPath),
        missing: fileHref(NodePath.join(siteDirPath, "bodies", "0.0.body")),
        export: fileHref(exportPath),
        savedPage: savedPageUrl,
      };
      const binDir = NodePath.dirname(context.binaryPath);
      const resourceTraversal = buildTraversalUrls("resource://gre/", binDir, logPath);
      const chromeTraversal = buildTraversalUrls("chrome://global/content/", binDir, logPath);
      const plantedResource = `resource://och-planted/sites/${site}/log/${NodePath.basename(logPath)}`;
      const redirectToLog = `http://attacker.example/redir?to=${encodeURIComponent(filePlan.log)}`;
      const recBase = `moz-extension://${recUuid}/`;

      planUrls = [...Object.values(filePlan), redirectToLog, recBase, plantedResource];

      server.setPlan({
        browser: context.binaryPath,
        server: server.origin,
        file: filePlan,
        webProbeUrl: "http://attacker.example/probe.html",
        victimUrl: "http://attacker.example/victim.html",
        wrRedirect: "http://attacker.example/wr-redirect",
        redirectToLog,
        rec: { id: recorderId, uuid: recUuid, base: recBase, popupPath, popupScriptPath },
        probe: {
          id: PROBE_EXTENSION_ID,
          uuid: probeUuid,
          base: `moz-extension://${probeUuid}/`,
        },
        randomUuid: NodeCrypto.randomUUID(),
        randomId: `not-installed-${NodeCrypto.randomBytes(4).toString("hex")}@test`,
        resources: enumerated.subs
          .map((s) => s.name)
          .filter((n) => n.length > 0 && n !== "och-planted"),
        resourceTraversal,
        chromePkgs: enumerated.chrome.map((c) => c.pkg),
        chromeTraversal,
        plantedResource,
        mozSrc: [
          "moz-src:///",
          "moz-src:///browser/components/tabbrowser/Tabbrowser.sys.mjs",
          ...buildTraversalUrls("moz-src:///", binDir, logPath),
        ],
        noMarionetteProbes: NO_MARIONETTE_PROBE_IDS,
      });

      context.log("isolation: opening web probe tab");
      await session.evaluateChrome(CHROME_OPEN_TAB_SCRIPT, ["http://attacker.example/probe.html"]);
      let fileTabOpened = false;
      let extPageOpened = false;

      for (const pos of ["web", "cs-web", "file", "cs-file", "ext-bg", "ext-page"] as const) {
        if (pos === "file" && !fileTabOpened) {
          await session.evaluateChrome(CHROME_OPEN_TAB_SCRIPT, [savedPageUrl]);
          fileTabOpened = true;
        } else if (pos === "ext-page" && !extPageOpened) {
          await session.evaluateChrome(CHROME_OPEN_TAB_SCRIPT, [
            `moz-extension://${probeUuid}/page.html`,
          ]);
          extPageOpened = true;
        }
        context.log(`isolation: position ${pos}`);
        server.enable(pos);
        if (pos === "cs-file") {
          const canAccess = (await session.evaluateChrome(CHROME_CAN_ACCESS_FILE_SCRIPT, [
            PROBE_EXTENSION_ID,
            savedPageUrl,
            filePlan.log,
          ])) as { readonly savedPage: boolean; readonly archiveLog: boolean } | null;
          canAccessFileObserved =
            canAccess !== null && canAccess.savedPage === false && canAccess.archiveLog === false;
          const hello = await server.waitFor(
            (r): r is Extract<IsolationReport, { kind: "cs-hello" }> =>
              r.kind === "cs-hello" && r.href.startsWith("file:"),
            1500,
          );
          if (hello === null) continue;
        }
        const done = await server.waitFor(
          (r): r is Extract<IsolationReport, { kind: "position-done" }> =>
            r.kind === "position-done" && r.position === pos,
          POSITION_TIMEOUT_MS,
        );
        if (done === null) {
          const posRows = server.reports.filter(
            (r): r is Extract<IsolationReport, { kind: "row" }> =>
              r.kind === "row" && r.position === pos,
          );
          const last = posRows.at(-1);
          context.log(
            `isolation: ${pos} timed out after ${String(posRows.length)} rows; last=${last?.probe ?? "none"}`,
          );
          extraChecks.push(`position ${pos} timed out`);
        }
      }

      context.log("isolation: opening devtools");
      const dvOpen = (await session.evaluateChrome(CHROME_OPEN_DEVTOOLS_SCRIPT, [
        `http://${site}/`,
      ])) as string;
      if (dvOpen !== "open") extraChecks.push(`failed to open devtools: ${dvOpen}`);
      server.enable("ext-devtools");
      const dvDone = await server.waitFor(
        (r): r is Extract<IsolationReport, { kind: "position-done" }> =>
          r.kind === "position-done" && r.position === "ext-devtools",
        POSITION_TIMEOUT_MS,
      );
      if (dvDone === null) extraChecks.push("position ext-devtools timed out");

      const stillPlanted = (await session.evaluateChrome(CHROME_PLANT_RESOURCE_SCRIPT, [
        "",
      ])) as boolean;
      if (stillPlanted) extraChecks.push("resource://och-planted/ remained after removal");

      context.log("isolation: quitting marionette session");
      await session.quit();
    }

    context.log("isolation: file-no-marionette");
    const noMarionetteErr = await runNoMarionetteLaunch({
      position: "file-no-marionette",
      binaryPath: context.binaryPath,
      display: context.display,
      profileDir: workspace.profileDir,
      dataHome: workspace.dataHome,
      url: `${savedPageUrl}?pos=file-no-marionette`,
      extraPrefs: noMarionetteExtraPrefs,
      server,
      signal: context.signal,
    });
    if (noMarionetteErr !== null) extraChecks.push(noMarionetteErr);

    context.log("isolation: file-mutated");
    const mutatedErr = await runNoMarionetteLaunch({
      position: "file-mutated",
      binaryPath: context.binaryPath,
      display: context.display,
      profileDir: workspace.profileDir,
      dataHome: workspace.dataHome,
      url: `${savedPageUrl}?pos=file-mutated`,
      extraPrefs: [
        ...noMarionetteExtraPrefs,
        { name: "security.fileuri.strict_origin_policy", value: false },
      ],
      server,
      signal: context.signal,
    });
    if (mutatedErr !== null) extraChecks.push(mutatedErr);

    const browserRows = server.reports.filter((r): r is BrowserRowReport => r.kind === "row");
    const csFileInjected = server.reports.some(
      (r) => r.kind === "cs-hello" && r.href.startsWith("file:"),
    );
    const csArchiveInjectedDocs = server.reports
      .filter(
        (r): r is Extract<IsolationReport, { kind: "cs-file-doc" }> =>
          r.kind === "cs-file-doc" && r.inArchive,
      )
      .map((r) => ({ href: r.href, text: r.text }));

    const webSandboxBlocksArchive = process.platform === "linux";

    const judgment = judgeIsolationRun({
      context: {
        marker,
        warMark,
        secretMark,
        site,
        archiveKey,
        appFolder: workspace.appFolder(),
        recId: recorderId,
        recUuid,
        planUrls,
        webSandboxBlocksArchive,
      },
      browserRows,
      syntheticControls,
      csFileInjected,
      canAccessFileObserved,
      csArchiveInjectedDocs,
      extraChecks,
    });

    const summary = `${String(judgment.rows.length)} probes: ${String(judgment.counts.BLOCKED)} BLOCKED, ${String(judgment.counts.READ)} READ, ${String(judgment.counts["LEAKS-EXISTENCE"])} LEAKS-EXISTENCE, ${String(judgment.counts["NO-RESULT"])} NO-RESULT`;
    return {
      name: "isolation",
      ok: judgment.ok,
      durationMs: Date.now() - started,
      detail: judgment.ok ? summary : `${summary}; failures: ${judgment.mismatches.join("; ")}`,
      data: judgment,
    };
  },
};

/** @discovered-check */
export default check;
