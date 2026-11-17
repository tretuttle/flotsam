import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
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
  judgeArchive,
  keyDerivations,
  type ArchiveEvidence,
  type ExtraCheckResult,
  type KeyEvidence,
  type KeySources,
} from "../fixtures/isolation/archive-oracle.ts";
import {
  beyondControl,
  diffSnapshots,
  diskProblems,
  inProductArea,
  snapshotTree,
  type DiskEvidence,
  type DiskSnapshot,
  type ProductArea,
  type RunChanges,
  type RunNames,
} from "../fixtures/isolation/disk.ts";
import {
  exposureProblems,
  schemaContexts,
  type ExposureEvidence,
  type PageSurface,
  type RuntimeSurface,
} from "../fixtures/isolation/exposure.ts";
import { identities } from "../fixtures/isolation/identity.ts";
import {
  judgeIsolationRun,
  type BrowserRowReport,
  type IsolationRunInput,
  type SyntheticControlResult,
  type Witness,
} from "../fixtures/isolation/judge.ts";
import {
  checkKey,
  combineWitness,
  fileHref,
  planTargets,
  type CheckOutcome,
  type Fact,
  type PlanInput,
  type TargetPlan,
} from "../fixtures/isolation/targets.ts";
import { buildStoredZip } from "../fixtures/isolation/zip.ts";
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
const KEY_WAIT_MS = 20_000;

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
  // No telemetry upload, so the browser keeps no pending pings under random names that differ between the runs.
  { name: "datareporting.healthreport.uploadEnabled", value: false },
  { name: "datareporting.policy.dataSubmissionEnabled", value: false },
  { name: "datareporting.usage.uploadEnabled", value: false },
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
  /** moz-src:/// URLs named in omni.ja; the first one is the witness that the scheme serves files. */
  readonly mozSrc: readonly string[];
};

/** What the recorder exposes, read from its policy and its installed XPI by the system principal. */
type PackedExposure = {
  readonly manifest: Record<string, unknown>;
  readonly contentScripts: readonly unknown[];
  readonly runtimeWebAccessible: readonly unknown[];
  readonly webAccessibleQuery: string | null;
  readonly webAccessiblePaths: readonly string[];
  readonly schemaTexts: Readonly<Record<string, string>>;
  readonly externalListeners: readonly string[];
  readonly declaredPages: readonly string[];
  /** Every page the recorder packs (each .html file) or declares, as a moz-extension URL. */
  readonly pageUrls: readonly string[];
  readonly files: readonly string[];
  readonly literals: readonly string[];
  readonly registrations: readonly string[];
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

const CHROME_EXPOSURE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const id = arguments[0];
  (async () => {
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    const policy = WebExtensionPolicy.getByID(id);
    const ext = policy.extension;
    const jar = Services.io.newURI(ext.rootURI.spec).QueryInterface(Ci.nsIJARURI);
    const zr = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zr.open(jar.JARFile.QueryInterface(Ci.nsIFileURL).file);
    const read = (name) => { const s = zr.getInputStream(name); const t = NetUtil.readInputStreamToString(s, s.available(), { charset: "UTF-8" }); s.close(); return t; };
    const files = [];
    const literals = new Set();
    const registrations = [];
    const externalListeners = [];
    const it = zr.findEntries(null);
    while (it.hasMore()) {
      const name = it.getNext();
      if (name.endsWith("/")) continue;
      files.push(name);
      if (!/\\.(m?js|json|html)$/.test(name)) continue;
      const text = read(name);
      for (const m of text.matchAll(/["'\`]([A-Za-z0-9][A-Za-z0-9._-]{0,62})["'\`]/g)) literals.add(m[1].toLowerCase());
      for (const m of text.matchAll(/(setSubstitution(?:WithFlags)?|registerChrome|addSubstitution)/g)) registrations.push(name + ": " + m[1]);
      for (const m of text.matchAll(/\\b(onMessageExternal|onConnectExternal|externally_connectable)\\b/g)) externalListeners.push(name + ": " + m[1]);
    }
    const manifest = JSON.parse(read("manifest.json"));
    const schemaTexts = {};
    for (const api of Object.values(manifest.experiment_apis ?? {})) {
      if (api && typeof api.schema === "string") { try { schemaTexts[api.schema] = read(api.schema.replace(/^\\//, "")); } catch (e) { schemaTexts[api.schema] = "unreadable: " + e; } }
    }
    zr.close();
    const src = Services.io.newURI("http://attacker.example/");
    const webAccessibleQuery = typeof policy.sourceMayAccessPath === "function" ? "sourceMayAccessPath" : typeof policy.isWebAccessiblePath === "function" ? "isWebAccessiblePath" : null;
    const accessible = (path) => webAccessibleQuery === "sourceMayAccessPath" ? policy.sourceMayAccessPath(src, path) : webAccessibleQuery === "isWebAccessiblePath" ? policy.isWebAccessiblePath(path) : false;
    const pageKeys = [["action", "default_popup"], ["browser_action", "default_popup"], ["page_action", "default_popup"], ["options_ui", "page"], ["sidebar_action", "default_panel"]];
    const declaredPages = [
      ...pageKeys.map(([k, f]) => manifest[k] && manifest[k][f]),
      manifest.options_page, manifest.devtools_page, manifest.background && manifest.background.page,
      ...Object.values(manifest.chrome_url_overrides ?? {}),
    ].filter((p) => typeof p === "string").map((p) => policy.getURL(p.replace(/^\\//, "")));
    const shape = (v) => (v && typeof v === "object" && "glob" in v ? v.glob : v && typeof v === "object" && "patterns" in v ? v.patterns.map((x) => x.pattern) : v);
    done({
      manifest,
      contentScripts: policy.contentScripts.map((cs) => ({ matches: cs.matches.patterns.map((m) => m.pattern), js: cs.jsPaths })),
      runtimeWebAccessible: JSON.parse(JSON.stringify(ext.webAccessibleResources ?? [], (k, v) => shape(v))),
      webAccessibleQuery,
      webAccessiblePaths: files.filter((f) => accessible("/" + f)),
      schemaTexts,
      externalListeners,
      declaredPages,
      pageUrls: [...new Set([...declaredPages, ...files.filter((f) => /\\.x?html?$/i.test(f)).map((f) => policy.getURL(f))])].sort(),
      files: files.sort(),
      literals: [...literals].sort(),
      registrations,
    });
  })().catch((e) => done({ error: String(e) }));
`;

/** Listener types on each recorder page's window and its frame count, read by a frame script in the page's process. */
const CHROME_PAGES_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const id = arguments[0];
  (async () => {
    const policy = WebExtensionPolicy.getByID(id);
    // A page shows up as a view only once it calls an extension API, so tabs are read as well as views.
    const browsers = new Set([...policy.extension.views].map((v) => v.xulBrowser).filter(Boolean));
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of win.gBrowser.tabs) {
        const uri = tab.linkedBrowser.currentURI;
        if (uri.schemeIs("moz-extension") && uri.host === policy.mozExtensionHostname) browsers.add(tab.linkedBrowser);
      }
    }
    const pages = [];
    for (const browser of browsers) {
      if (!browser.messageManager) { pages.push({ href: browser.currentURI.spec, error: "no message manager" }); continue; }
      pages.push(await new Promise((resolve) => {
        const name = "och-exposure-" + Math.random().toString(36).slice(2);
        const mm = browser.messageManager;
        const timer = setTimeout(() => resolve({ href: browser.currentURI.spec, error: "no answer from the page process" }), 5000);
        const listener = (m) => { clearTimeout(timer); mm.removeMessageListener(name, listener); resolve(m.data); };
        mm.addMessageListener(name, listener);
        const body = function (name) {
          const els = Components.classes["@mozilla.org/eventlistenerservice;1"].getService(Components.interfaces.nsIEventListenerService);
          sendAsyncMessage(name, {
            href: content.location.href,
            windowListeners: els.getListenerInfoFor(content).map((l) => l.type + (l.capturing ? ":capture" : "")),
            frames: content.frames.length + content.document.querySelectorAll("iframe, frame, object, embed").length,
          });
        };
        mm.loadFrameScript("data:application/javascript;charset=utf-8," + encodeURIComponent("(" + body.toString() + ")(" + JSON.stringify(name) + ")"), false);
      }));
    }
    done(pages);
  })().catch((e) => done([{ href: "", error: String(e) }]));
`;

/**
 * Posts a message to the page itself and collects anything else that arrives in 500 ms, then removes its listener so
 * the page reads the same when it is read again at the end of the run.
 */
const PAGE_ECHO_EXPRESSION = `new Promise((resolve) => {
  const token = "och-echo-" + Math.random();
  const got = [];
  const listener = (e) => {
    let d;
    try { d = JSON.stringify(e.data); } catch (x) { d = String(e.data); }
    if (!String(d).includes(token)) got.push(String(d).slice(0, 300));
  };
  window.addEventListener("message", listener);
  window.postMessage({ och: token }, "*");
  setTimeout(() => {
    window.removeEventListener("message", listener);
    resolve(got.length ? got.join(" | ") : "none");
  }, 500);
})`;

/** The random id the profiles datastore names its database after, once it has made one. */
const CHROME_STORE_ID_SCRIPT = `
  const done = arguments[arguments.length - 1];
  done(Services.prefs.getStringPref("toolkit.profiles.storeID", ""));
`;

const CHROME_TAB_SHOWS_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const url = arguments[0];
  done([...Services.wm.getEnumerator("navigator:browser")].some((w) => w.gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === url)));
`;

/** Runs every system-principal witness check; the harness runs redirects and facts itself. */
const CHROME_WITNESS_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const checks = arguments[0];
  (async () => {
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    const reg = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(Ci.nsIChromeRegistry);
    const load = (url) => new Promise((resolve) => {
      try {
        const ch = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true });
        NetUtil.asyncFetch(ch, (stream, status) => {
          if (!Components.isSuccessCode(status)) { resolve({ ok: false, detail: "load failed 0x" + (status >>> 0).toString(16), text: "" }); return; }
          try {
            const text = NetUtil.readInputStreamToString(stream, stream.available());
            resolve({ ok: text.length > 0, detail: "loads " + text.length + " chars", text });
          } catch (e) { resolve({ ok: false, detail: "read failed " + e, text: "" }); }
        });
      } catch (e) { resolve({ ok: false, detail: String(e), text: "" }); }
    });
    const run = async (c) => {
      switch (c.kind) {
        case "file": {
          try {
            const st = await IOUtils.stat(c.path);
            if (st.type === "directory") { const kids = await IOUtils.getChildren(c.path); return { ok: true, detail: "directory with " + kids.length + " entries" }; }
            const bytes = await IOUtils.read(c.path, c.mark ? {} : { maxBytes: 64 });
            if (!c.mark) return { ok: bytes.length > 0, detail: st.type + ", " + st.size + " bytes" };
            const marked = new TextDecoder("utf-8", { fatal: false }).decode(bytes).includes(c.mark);
            return { ok: marked, detail: st.type + ", " + st.size + " bytes, " + (marked ? "holds the mark" : "without the mark") };
          } catch (e) { return { ok: false, detail: e.name || String(e) }; }
        }
        case "load": {
          const l = await load(c.url);
          if (!c.mark) return { ok: l.ok, detail: l.detail };
          const marked = l.text.includes(c.mark);
          return { ok: l.ok && marked, detail: l.detail + (marked ? ", holds the mark" : ", without the mark") };
        }
        case "resource": return res.hasSubstitution(c.name) ? { ok: true, detail: "-> " + res.resolveURI(Services.io.newURI("resource://" + c.name + "/")) } : { ok: false, detail: "no substitution" };
        case "chrome": try { return { ok: true, detail: "-> " + reg.convertChromeURL(Services.io.newURI("chrome://" + c.pkg + "/content/")).spec }; } catch (e) { return { ok: false, detail: "not registered" }; }
        case "addon": { const p = WebExtensionPolicy.getByID(c.id); return p && p.active ? { ok: true, detail: "active, " + p.mozExtensionHostname } : { ok: false, detail: p ? "inactive" : "not installed" }; }
        case "tab": { const win = Services.wm.getMostRecentWindow("navigator:browser"); const tab = win.gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === c.url); return tab ? { ok: true, detail: "a tab shows it" } : { ok: false, detail: "no tab shows it" }; }
        case "service": {
          if (c.name === "downloads") { const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs"); const all = await (await Downloads.getList(Downloads.ALL)).getAll(); return { ok: true, detail: "list answers, " + all.length + " items" }; }
          if (c.name === "clipboard") return Services.clipboard ? { ok: true, detail: "clipboard service" } : { ok: false, detail: "no clipboard service" };
          return Cc["@mozilla.org/alerts-service;1"] ? { ok: true, detail: "alerts service" } : { ok: false, detail: "no alerts service" };
        }
        default: return { ok: false, detail: "not a system-principal check: " + c.kind };
      }
    };
    const out = {};
    for (const [key, c] of Object.entries(checks)) {
      try { out[key] = await run(c); } catch (e) { out[key] = { ok: false, detail: "threw " + e }; }
    }
    done(out);
  })().catch((e) => done({ error: String(e) }));
`;

const CHROME_ENUMERATE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const candidates = arguments[0];
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  const reg = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(Ci.nsIChromeRegistry);
  const resNames = new Set(["", "gre", "app", ...candidates]);
  const pkgs = new Set(candidates);
  const jars = new Set();
  const mozSrc = new Set();
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
      for (const m of text.matchAll(/moz-src:\\/\\/\\/([A-Za-z0-9_\\/.-]+\\.m?js)/g)) mozSrc.add("moz-src:///" + m[1]);
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
  done({ subs, chrome, mozSrc: [...mozSrc].sort() });
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

/** Plants a mark in the recorder's storage.local and reads it back, as the system principal. */
const CHROME_PLANT_STORAGE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const [id, mark] = arguments;
  (async () => {
    const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
    const policy = WebExtensionPolicy.getByID(id);
    const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(policy.extension));
    await db.set({ och_secret: mark });
    done({ read: JSON.stringify(await db.get(null)) });
  })().catch((e) => done({ error: String(e) }));
`;

/** Plants a mark in the recorder origin's IndexedDB from the recorder's own page and reads it back there. */
const recorderIdbPlant = (mark: string): string => `new Promise((resolve) => {
  const open = indexedDB.open("och-recorder", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  open.onerror = () => resolve("open error " + open.error);
  open.onsuccess = () => {
    const db = open.result;
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(${JSON.stringify(mark)}, "secret");
    tx.oncomplete = () => {
      const rq = db.transaction("kv").objectStore("kv").get("secret");
      rq.onsuccess = () => { db.close(); resolve("kv.secret = " + rq.result); };
      rq.onerror = () => { db.close(); resolve("get error"); };
    };
  };
})`;

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

/** A redirect target's witness: the harness's own server answers the URL with a 302 to the planned file. */
function redirectWitness(url: string, to: string, proxyPort: number): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: url,
        headers: { host: new NodeURL.URL(url).host },
      },
      (response) => {
        response.resume();
        const location = response.headers.location;
        resolve({
          ok: response.statusCode === 302 && location === to,
          detail: `status ${String(response.statusCode)}, location ${String(location)}`,
        });
      },
    );
    request.on("error", (error) => resolve({ ok: false, detail: String(error) }));
    request.end();
  });
}

/** Runs every planned witness check once: the system principal's in one chrome script, then the harness's own. */
async function runWitness(
  session: BrowserSession,
  plan: TargetPlan,
  facts: Readonly<Record<Fact, CheckOutcome>>,
  proxyPort: number,
): Promise<{
  readonly witness: Readonly<Record<string, Witness>>;
  readonly results: ReadonlyMap<string, CheckOutcome>;
}> {
  const unique = new Map(
    Object.values(plan.checks)
      .flat()
      .map((c) => [checkKey(c), c] as const),
  );
  const chromeChecks = Object.fromEntries(
    [...unique].filter(([, c]) => c.kind !== "redirect" && c.kind !== "fact"),
  );
  const chrome = (await session.evaluateChrome(CHROME_WITNESS_SCRIPT, [chromeChecks])) as Record<
    string,
    CheckOutcome
  > & { readonly error?: string };
  if (typeof chrome.error === "string") throw new Error(`witness failed: ${chrome.error}`);
  const results = new Map<string, CheckOutcome>();
  for (const [key, c] of unique) {
    results.set(
      key,
      c.kind === "fact"
        ? facts[c.name]
        : c.kind === "redirect"
          ? await redirectWitness(c.url, c.to, proxyPort)
          : (chrome[key] ?? { ok: false, detail: "no answer from the system principal" }),
    );
  }
  return { witness: combineWitness(plan, results), results };
}

const keySources = (
  profileDir: string,
  dataHome: string,
  addonId: string,
  addonUuid: string,
): KeySources => ({
  profileDir,
  userName: NodeOS.userInfo().username,
  hostName: NodeOS.hostname(),
  dataHome,
  addonId,
  addonUuid,
});

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (NodeFS.existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return NodeFS.existsSync(path);
}

/** A second fresh profile with the same XPI: the key it makes, and what that profile exposes to a guesser. */
async function secondProfileKey(
  context: CheckContext,
  recorderId: string,
  prefs: readonly Pref[],
): Promise<KeyEvidence["second"]> {
  await using second = recordingWorkspace("isolation-second");
  if (context.extensionPath === null) return { missing: "no extension" };
  await using session = await second.launch({
    binaryPath: context.binaryPath,
    extensionPath: context.extensionPath,
    display: context.display,
    protocol: "marionette",
    launchMode: "real-defaults",
    signal: context.signal,
    extraPrefs: prefs,
  });
  const info = (await session.evaluateChrome(CHROME_INFO_SCRIPT, [
    [recorderId],
  ])) as ChromeBootstrapInfo;
  const keyFile = NodePath.join(second.profileDir, ARCHIVE_KEY_FILE);
  if (!(await waitForFile(keyFile, KEY_WAIT_MS)))
    return { missing: `no ${ARCHIVE_KEY_FILE} after ${String(KEY_WAIT_MS)} ms` };
  const result = {
    keyFileText: NodeFS.readFileSync(keyFile, "utf8"),
    sources: keySources(
      second.profileDir,
      second.dataHome,
      recorderId,
      info.addons[recorderId]?.uuid ?? "",
    ),
  };
  await session.quit();
  return result;
}

async function runNoMarionetteLaunch(options: {
  readonly position: "file-no-marionette";
  readonly binaryPath: string;
  readonly display: CheckContext["display"];
  readonly profileDir: string;
  readonly dataHome: string;
  readonly home: string | null;
  readonly url: string;
  readonly extraPrefs: readonly Pref[];
  readonly server: Awaited<ReturnType<typeof startIsolationServer>>;
  readonly signal: AbortSignal;
}): Promise<{ readonly problem: string | null; readonly pid: number }> {
  await using session = await launchBrowser({
    binaryPath: options.binaryPath,
    extensionPath: null,
    display: options.display,
    launchMode: "none",
    profileDir: options.profileDir,
    dataHome: options.dataHome,
    ...(options.home === null ? {} : { home: options.home }),
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
  return {
    problem: done === null ? `${options.position}: timed out waiting for page completion` : null,
    pid: session.spawnedPid,
  };
}

/** The probe add-on and the other experiment, installed the same way, byte for byte, in both runs. */
function installProbeAddons(profileDir: string, probeXpi: Buffer): void {
  const dir = NodePath.join(profileDir, "extensions");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, `${PROBE_EXTENSION_ID}.xpi`), probeXpi);
  NodeFS.writeFileSync(NodePath.join(dir, `${OTHER_EXPERIMENT_ID}.xpi`), buildOtherExperimentXpi());
}

/**
 * The control run's recorder: the product's id, name, version and pages, with no script, no experiment API and no
 * permission. Each page the product packs is an empty document, so the control opens the same pages.
 */
function buildStandInXpi(manifest: Record<string, unknown>, pageFiles: readonly string[]): Buffer {
  const action = (manifest["action"] ?? {}) as Record<string, unknown>;
  const standIn = {
    manifest_version: manifest["manifest_version"],
    name: "One-Click HAR control stand-in",
    version: manifest["version"],
    browser_specific_settings: manifest["browser_specific_settings"],
    action: { default_popup: action["default_popup"] },
    ...(manifest["options_ui"] === undefined ? {} : { options_ui: manifest["options_ui"] }),
  };
  return buildStoredZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(standIn, null, 2)) },
    ...pageFiles.map((name) => ({
      name,
      data: Buffer.from('<!doctype html><meta charset="utf-8"><title>stand-in</title>'),
    })),
  ]);
}

type PageRead = {
  readonly href: string;
  readonly windowListeners?: readonly string[];
  readonly frames?: number;
  readonly error?: string;
};

/**
 * Reads every recorder page as it shows: its listeners and frames from the system principal, then whether anything
 * answers a message the page posts to itself. One page at a time; each but the popup is closed after, and the popup,
 * which the probes need, is opened again if a new Marionette tab replaced it, as some builds do.
 */
async function readPages(
  session: BrowserSession,
  recorderId: string,
  urls: readonly string[],
  popup: { readonly url: string; readonly tab: string },
): Promise<{ readonly pages: readonly PageSurface[]; readonly popupTab: string }> {
  const pages: PageSurface[] = [];
  for (const url of urls) {
    const tab = url === popup.url ? popup.tab : await session.openTab(url);
    // Listeners are read before the echo, which adds one of its own while it waits.
    const read = (await session.evaluateChrome(CHROME_PAGES_SCRIPT, [
      recorderId,
    ])) as readonly PageRead[];
    const echo = await session
      .evaluate(tab, PAGE_ECHO_EXPRESSION)
      .catch((e: unknown) => `could not post: ${String(e)}`);
    const page = read.find((r) => r.href === url);
    if (page !== undefined && page.error === undefined) {
      pages.push({
        href: page.href,
        windowListeners: page.windowListeners ?? [],
        frames: page.frames ?? 0,
        echo: echo === "none" ? null : echo,
      });
    }
    if (url !== popup.url) await session.closeTab(tab);
  }
  const popupShows = (await session.evaluateChrome(CHROME_TAB_SHOWS_SCRIPT, [popup.url])) === true;
  return { pages, popupTab: popupShows ? popup.tab : await session.openTab(popup.url) };
}

/** Every resource:// substitution and chrome package the enumeration found, as comparable lines. */
const schemeLines = (
  enumerated: EnumeratedSchemes,
): Pick<RuntimeSurface, "substitutions" | "chromePackages"> => ({
  substitutions: enumerated.subs.map((s) => `resource://${s.name}/ -> ${s.resolved}`),
  chromePackages: enumerated.chrome.map((c) => `chrome://${c.pkg}/ -> ${c.target}`),
});

/**
 * Runs every probe position in order, then the devtools one. Returns what went wrong, and whether the probe add-on's
 * policy, asked from the system principal, can access neither the file page nor the archive log.
 */
async function runPositions(
  context: CheckContext,
  session: BrowserSession,
  server: Awaited<ReturnType<typeof startIsolationServer>>,
  options: {
    readonly savedPageUrl: string;
    readonly probeBase: string;
    readonly logUrl: string;
    readonly site: string;
  },
): Promise<{ readonly problems: readonly string[]; readonly canAccessFileObserved: boolean }> {
  const problems: string[] = [];
  let canAccessFileObserved = false;
  await session.evaluateChrome(CHROME_OPEN_TAB_SCRIPT, ["http://attacker.example/probe.html"]);
  for (const pos of ["web", "cs-web", "file", "cs-file", "ext-bg", "ext-page"] as const) {
    if (pos === "file") {
      await session.evaluateChrome(CHROME_OPEN_TAB_SCRIPT, [options.savedPageUrl]);
    } else if (pos === "ext-page") {
      await session.evaluateChrome(CHROME_OPEN_TAB_SCRIPT, [`${options.probeBase}page.html`]);
    }
    context.log(`isolation: position ${pos}`);
    server.enable(pos);
    if (pos === "cs-file") {
      const canAccess = (await session.evaluateChrome(CHROME_CAN_ACCESS_FILE_SCRIPT, [
        PROBE_EXTENSION_ID,
        options.savedPageUrl,
        options.logUrl,
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
      context.log(
        `isolation: ${pos} timed out after ${String(posRows.length)} rows; last=${posRows.at(-1)?.probe ?? "none"}`,
      );
      problems.push(`position ${pos} timed out`);
    }
  }

  context.log("isolation: opening devtools");
  const dvOpen = (await session.evaluateChrome(CHROME_OPEN_DEVTOOLS_SCRIPT, [
    `http://${options.site}/`,
  ])) as string;
  if (dvOpen !== "open") problems.push(`failed to open devtools: ${dvOpen}`);
  server.enable("ext-devtools");
  const dvDone = await server.waitFor(
    (r): r is Extract<IsolationReport, { kind: "position-done" }> =>
      r.kind === "position-done" && r.position === "ext-devtools",
    POSITION_TIMEOUT_MS,
  );
  if (dvDone === null) problems.push("position ext-devtools timed out");
  return { problems, canAccessFileObserved };
}

/** The add-on uuids and the workspace folder of one run, each replaced by its role when two runs are compared. */
/**
 * Names the browser chose for this run alone: the profiles datastore's random store id, and the pid of every browser
 * the run launched, which the profile lock names while a browser holds it.
 */
const browserNames = (storeId: string, pids: readonly number[]): RunNames => [
  ...(storeId === "" ? [] : [[storeId, "{profiles-store-id}"] as const]),
  ...pids.map((pid) => [`:+${String(pid)}`, ":+{browser-pid}"] as const),
];

function runNames(
  base: string,
  addons: Readonly<Record<string, AddonInfo | null>>,
  recorderId: string,
): RunNames {
  const roles: Readonly<Record<string, string>> = {
    [recorderId]: "{recorder-uuid}",
    [PROBE_EXTENSION_ID]: "{probe-uuid}",
    [OTHER_EXPERIMENT_ID]: "{other-experiment-uuid}",
  };
  return [
    [base, "{workspace}"],
    ...Object.entries(roles).flatMap(([id, role]): (readonly [string, string])[] => {
      const uuid = addons[id]?.uuid;
      return uuid === null || uuid === undefined ? [] : [[uuid, role]];
    }),
  ];
}

/** Everything the control run repeats from the product run, with the product's own paths where a probe needs one. */
type ControlPlan = {
  readonly recorderId: string;
  readonly standInXpi: Buffer;
  readonly probeXpi: Buffer;
  readonly popupPath: string;
  readonly pageFiles: readonly string[];
  readonly site: string;
  readonly storeMark: string;
  readonly logPath: string;
  readonly logUrl: string;
  readonly plantRoot: string;
  readonly exportName: string;
  readonly exportText: string;
  readonly savedPageName: string;
  readonly savedPageHtml: string;
  readonly serverPlan: Record<string, unknown> & { readonly file: Record<string, unknown> };
  readonly extraPrefs: readonly Pref[];
  readonly noMarionettePrefs: readonly Pref[];
};

/**
 * The same throwaway HOME, profile, data home and Downloads, the same probe add-ons and the same actions as the
 * product run, with an inert stand-in under the recorder's id in place of the product. What this run writes is what
 * the browser and the harness write; the product run's writes beyond it are the product's.
 */
async function controlRun(
  context: CheckContext,
  server: Awaited<ReturnType<typeof startIsolationServer>>,
  plan: ControlPlan,
): Promise<RunChanges> {
  await using workspace = recordingWorkspace("isolation-control", { ownHome: true });
  installProbeAddons(workspace.profileDir, plan.probeXpi);
  const standInDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-stand-in-"));
  try {
    const standInPath = NodePath.join(standInDir, "stand-in.xpi");
    NodeFS.writeFileSync(standInPath, plan.standInXpi);
    const before = snapshotTree(workspace.base);
    let planSnapshot: DiskSnapshot = {};
    let names: RunNames = [];
    let storeId = "";
    const pids: number[] = [];
    const savedPagePath = NodePath.join(workspace.downloads, plan.savedPageName);
    const savedPageUrl = fileHref(savedPagePath);
    {
      await using session = await workspace.launch({
        binaryPath: context.binaryPath,
        extensionPath: standInPath,
        display: context.display,
        protocol: "marionette",
        launchMode: "real-defaults",
        signal: context.signal,
        extraPrefs: plan.extraPrefs,
      });
      const info = (await session.evaluateChrome(CHROME_INFO_SCRIPT, [
        [plan.recorderId, PROBE_EXTENSION_ID, OTHER_EXPERIMENT_ID],
      ])) as ChromeBootstrapInfo & { readonly error?: string };
      if (info.error !== undefined) throw new Error(`control bootstrap failed: ${info.error}`);
      names = runNames(workspace.base, info.addons, plan.recorderId);
      const probeUuid = info.addons[PROBE_EXTENSION_ID]?.uuid;
      if (probeUuid === null || probeUuid === undefined)
        throw new Error("control: probe extension has no uuid");

      await session.evaluateChrome(CHROME_OPEN_TAB_SCRIPT, [`http://${plan.site}/`]);
      await server.waitFor(
        (r): r is Extract<IsolationReport, { kind: "bank-done" }> => r.kind === "bank-done",
        STEP_TIMEOUT_MS,
      );
      const popupUrl = await waitForActiveExtensionUrl(session, plan.recorderId, plan.popupPath);
      let popupTab = await session.openTab(popupUrl);
      planSnapshot = snapshotTree(workspace.base);
      storeId = String(await session.evaluateChrome(CHROME_STORE_ID_SCRIPT));
      pids.push(session.browserPid, session.spawnedPid);

      NodeFS.writeFileSync(NodePath.join(workspace.downloads, plan.exportName), plan.exportText, {
        mode: 0o600,
      });
      await session.evaluateChrome(CHROME_OTHER_EXP_SCRIPT, [plan.logPath]);
      await session.evaluateChrome(CHROME_PLANT_STORAGE_SCRIPT, [plan.recorderId, plan.storeMark]);
      await session.evaluate(popupTab, recorderIdbPlant(plan.storeMark));
      const pageUrls = plan.pageFiles.map(
        (f) => `moz-extension://${info.addons[plan.recorderId]?.uuid ?? ""}/${f}`,
      );
      ({ popupTab } = await readPages(session, plan.recorderId, pageUrls, {
        url: popupUrl,
        tab: popupTab,
      }));
      await session.evaluateChrome(CHROME_PLANT_RESOURCE_SCRIPT, [plan.plantRoot]);
      NodeFS.writeFileSync(savedPagePath, plan.savedPageHtml, "utf8");
      server.setPlan({
        ...plan.serverPlan,
        file: { ...plan.serverPlan.file, savedPage: savedPageUrl },
      });

      context.log("isolation: control run positions");
      await runPositions(context, session, server, {
        savedPageUrl,
        probeBase: `moz-extension://${probeUuid}/`,
        logUrl: plan.logUrl,
        site: plan.site,
      });
      await session.evaluateChrome(CHROME_PLANT_RESOURCE_SCRIPT, [""]);
      await readPages(session, plan.recorderId, pageUrls, { url: popupUrl, tab: popupTab });
      await session.quit();
    }
    const last = await runNoMarionetteLaunch({
      position: "file-no-marionette",
      binaryPath: context.binaryPath,
      display: context.display,
      profileDir: workspace.profileDir,
      dataHome: workspace.dataHome,
      home: workspace.home,
      url: `${savedPageUrl}?pos=file-no-marionette`,
      extraPrefs: plan.noMarionettePrefs,
      server,
      signal: context.signal,
    });
    return {
      plan: diffSnapshots(before, planSnapshot),
      final: diffSnapshots(before, snapshotTree(workspace.base)),
      names: [...names, ...browserNames(storeId, [...pids, last.pid])],
    };
  } finally {
    NodeFS.rmSync(standInDir, { recursive: true, force: true });
  }
}

const check: HarnessCheck = {
  name: "isolation",
  description:
    "isolation probes across web, file, and other-extension principals against the packed XPI, with targets from the written archive, and a control run without the product",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null) {
      return { name: "isolation", ok: false, durationMs: 0, detail: "needs --extension" };
    }

    const recorderId = await readExtensionId(context.extensionPath);
    const popupPath = await readExtensionPopupPath(context.extensionPath);
    const popupScriptPath = popupPath.replace(/\.html$/u, ".js");
    const mark = (prefix: string): string =>
      `${prefix}_${NodeCrypto.randomBytes(8).toString("hex")}`;
    const marker = mark("OCHMARK");
    const warMark = mark("OCHWAR");
    const secretMark = mark("OCHSECRET");
    const storeMark = mark("OCHSTORE");
    const ownMark = mark("OCHOWN");
    const site = "bank.example";

    await using server = await startIsolationServer({
      marker,
      probeHtml: PROBE_HTML,
      probesJs: PROBES_JS,
      runnerJs: PAGE_RUNNER_JS,
    });

    context.log("isolation: second fresh profile for the key oracle");
    const secondKey = await secondProfileKey(context, recorderId, proxyPrefs(server.port));

    await using workspace = recordingWorkspace("isolation", { ownHome: true });
    const probeXpi = buildProbeExtensionXpi({
      serverOrigin: server.origin,
      warMark,
      secretMark,
      ownMark,
    });
    installProbeAddons(workspace.profileDir, probeXpi);
    const diskBefore = snapshotTree(workspace.base);

    const extraChecks: ExtraCheckResult[] = [];
    const record = (
      id: ExtraCheckResult["id"],
      problems: readonly string[],
      fine: string,
    ): void => {
      extraChecks.push({
        id,
        ok: problems.length === 0,
        detail: problems.length === 0 ? fine : problems.join("; "),
      });
    };
    const positionProblems: string[] = [];
    const syntheticControls: SyntheticControlResult[] = [];
    let canAccessFileObserved = false;
    let targetPlan: TargetPlan = { targets: {}, checks: {} };
    let planInput: PlanInput | null = null;
    let witness: Readonly<Record<string, Witness>> = {};
    let witnessResults: ReadonlyMap<string, CheckOutcome> = new Map();
    let recUuid = "";
    let savedPageUrl = "";
    let plannedEntries: ReturnType<typeof workspace.entries> = [];
    let keyEvidence: KeyEvidence | null = null;
    let area: ProductArea | null = null;
    let planSnapshot: DiskSnapshot = {};
    let names: RunNames = [];
    let storeId = "";
    const pids: number[] = [];
    let exposureEvidence: ExposureEvidence | null = null;
    let controlPlan: ControlPlan | null = null;
    const noMarionetteExtraPrefs = [...HARNESS_PREFS, ...proxyPrefs(server.port)];
    const exportName = `${site}-2026-11-16.har`;
    const savedPageName = "saved-page.html";

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
      names = runNames(workspace.base, info.addons, recorderId);
      record(
        "strict-origin-default",
        !info.strictFileOrigin || info.strictFileOriginUserSet
          ? [
              `strict_origin_policy=${String(info.strictFileOrigin)} userSet=${String(info.strictFileOriginUserSet)}`,
            ]
          : [],
        "strict_origin_policy true by default",
      );

      const probeAddon = info.addons[PROBE_EXTENSION_ID];
      const recAddon = info.addons[recorderId];
      if (probeAddon === null || probeAddon === undefined || !probeAddon.isActive) {
        throw new Error(`probe extension ${PROBE_EXTENSION_ID} did not activate`);
      }
      record(
        "probe-extension-unprivileged",
        probeAddon.isPrivileged || probeAddon.signedState !== 0 || probeAddon.temporarilyInstalled
          ? [`probe extension is ${JSON.stringify(probeAddon)}`]
          : [],
        "permanent unsigned unprivileged sideload",
      );
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
      const bankMarked = bankDone !== null && bankDone.cookie.includes(marker);
      record(
        "bank-recorded",
        bankMarked ? [] : ["bank fixture did not complete with the cookie marker"],
        "bank fixture completed with the cookie marker",
      );
      await callHook(session, { kind: "seal" });

      const popupUrl = await waitForActiveExtensionUrl(session, recorderId, popupPath);
      let popupTab = await session.openTab(popupUrl);
      const statusText = await session.evaluate(
        popupTab,
        "browser.oneClickHar.getRecordingStatus().then(JSON.stringify)",
      );
      const status = JSON.parse(statusText) as {
        readonly recording: boolean;
        readonly problems: readonly string[];
      };
      record(
        "recorder-status-clean",
        !status.recording || status.problems.length > 0 ? [`status ${JSON.stringify(status)}`] : [],
        "recording, no problems",
      );

      const located = locateArchive(workspace.dataHome, workspace.profileDir);
      if (located === null) throw new Error("archive key missing after seal");
      const archiveKey = located.key;
      const keyFilePath = NodePath.join(workspace.profileDir, ARCHIVE_KEY_FILE);
      plannedEntries = workspace.entries();
      keyEvidence = {
        keyFileText: NodeFS.readFileSync(keyFilePath, "utf8"),
        keyFileMode: NodeFS.statSync(keyFilePath).mode & 0o777,
        appFolderNames: NodeFS.readdirSync(located.appFolder).sort(),
        sources: keySources(workspace.profileDir, workspace.dataHome, recorderId, recUuid),
        second: secondKey,
      };
      record(
        "archive-modes",
        judgeArchiveModes(plannedEntries, ["jsonl", "summary.json", "pack", "body"]),
        `${String(plannedEntries.length)} entries 700/600`,
      );

      // The inventory is what the disk diff says the product wrote in its own places by now.
      planSnapshot = snapshotTree(workspace.base);
      storeId = String(await session.evaluateChrome(CHROME_STORE_ID_SCRIPT));
      pids.push(session.browserPid, session.spawnedPid);
      area = { archiveKey, keyFileName: ARCHIVE_KEY_FILE };
      const productArea = area;
      const written = diffSnapshots(diskBefore, planSnapshot)
        .filter((c) => inProductArea(c, productArea))
        .map((c) => ({
          path: NodePath.join(workspace.base, ...c.path.split("/")),
          directory: c.entry.kind === "directory",
        }));

      const downloadsProblem = judgeDownloads(
        (await session.evaluateChrome(CHROME_DOWNLOAD_TARGETS_SCRIPT)) as readonly string[],
        workspace.dataHome,
      );
      record(
        "downloads-list",
        downloadsProblem === null ? [] : [downloadsProblem],
        "nothing under the data home",
      );

      const packed = (await session.evaluateChrome(CHROME_EXPOSURE_SCRIPT, [
        recorderId,
      ])) as PackedExposure & { readonly error?: string };
      if (packed.error !== undefined) throw new Error(`exposure read failed: ${packed.error}`);
      record(
        "no-registration-in-packed-scripts",
        packed.registrations,
        "no setSubstitution or registerChrome",
      );

      const siteDirPath = NodePath.join(located.root, "sites", site);
      const logPath = findFirstFile(NodePath.join(siteDirPath, "log"), ".jsonl");
      const bodyPath = findFirstFile(NodePath.join(siteDirPath, "bodies"), ".body");
      if (logPath === null || bodyPath === null) {
        throw new Error(`missing log (${String(logPath)}) or body (${String(bodyPath)})`);
      }

      // No export API exists yet, so the export rows read a stand-in written where an export would land.
      const exportPath = NodePath.join(workspace.downloads, exportName);
      const exportText = JSON.stringify({
        log: {
          version: "1.2",
          creator: { name: "One-Click HAR", version: "0.1.0" },
          entries: [
            { request: { url: `http://${site}/` }, response: { content: { text: marker } } },
          ],
        },
      });
      NodeFS.writeFileSync(exportPath, exportText, { mode: 0o600 });

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
        reads: [sysRead.log, sysRead.body],
      });

      const osText = NodeFS.readFileSync(logPath, "utf8");
      syntheticControls.push({
        id: "limit-same-user-process",
        position: "os",
        observed: `read ${String(osText.length)} chars`,
        reads: [osText],
      });

      const otherRaw = (await session.evaluateChrome(CHROME_OTHER_EXP_SCRIPT, [logPath])) as string;
      const otherParsed = otherRaw
        ? (JSON.parse(otherRaw) as { readonly text?: string; readonly error?: string })
        : {};
      syntheticControls.push({
        id: "limit-other-experiment",
        position: "otherexp",
        observed: otherParsed.error ?? `read ${String(otherParsed.text?.length ?? 0)} chars`,
        reads: [otherParsed.text ?? ""],
      });

      const storagePlant = (await session.evaluateChrome(CHROME_PLANT_STORAGE_SCRIPT, [
        recorderId,
        storeMark,
      ])) as {
        readonly read?: string;
        readonly error?: string;
      };
      syntheticControls.push({
        id: "planted-recorder-storage",
        position: "system",
        observed: storagePlant.error ?? `recorder storage.local reads ${storagePlant.read ?? ""}`,
        reads: [storagePlant.read ?? ""],
      });
      const idbPlant = await session.evaluate(popupTab, recorderIdbPlant(storeMark));
      syntheticControls.push({
        id: "planted-recorder-idb",
        position: "rec-page",
        observed: `recorder page reads ${idbPlant}`,
        reads: [idbPlant],
      });

      // The running surface before any probe: scheme names, web-accessible resources and every page.
      const candidates = [
        ...new Set([
          ...packed.literals,
          recorderId,
          recUuid,
          archiveKey,
          "one-click-har",
          "oneclickhar",
        ]),
      ];
      const enumerated = (await session.evaluateChrome(CHROME_ENUMERATE_SCRIPT, [
        candidates,
      ])) as EnumeratedSchemes;
      context.log("isolation: reading the recorder's pages before the probes");
      const pagesAtStart = await readPages(session, recorderId, packed.pageUrls, {
        url: popupUrl,
        tab: popupTab,
      });
      popupTab = pagesAtStart.popupTab;
      const start: RuntimeSurface = {
        webAccessibleResources: packed.runtimeWebAccessible,
        webAccessiblePaths: [
          ...packed.webAccessiblePaths,
          ...(packed.webAccessibleQuery === null
            ? ["(the policy offers no web-accessible query)"]
            : []),
        ],
        ...schemeLines(enumerated),
        pages: pagesAtStart.pages,
      };

      await session.evaluateChrome(CHROME_PLANT_RESOURCE_SCRIPT, [located.root]);

      const savedPagePath = NodePath.join(workspace.downloads, savedPageName);
      const savedPageHtml = buildSavedPageHtml(server.origin);
      NodeFS.writeFileSync(savedPagePath, savedPageHtml, "utf8");
      savedPageUrl = fileHref(savedPagePath);

      const plantedLog = `resource://och-planted/sites/${site}/log/${NodePath.basename(logPath)}`;
      const recBase = `moz-extension://${recUuid}/`;
      const probeBase = `moz-extension://${probeUuid}/`;
      const wrRedirect = "http://attacker.example/wr-redirect";
      const filePlan = {
        root: fileHref(located.appFolder, true),
        log: fileHref(logPath),
        export: fileHref(exportPath),
        savedPage: savedPageUrl,
      };
      const experiment = Object.values(
        (packed.manifest["experiment_apis"] ?? {}) as Record<
          string,
          { readonly schema?: unknown; readonly parent?: { readonly script?: unknown } }
        >,
      )[0];
      planInput = {
        marker,
        file: {
          appFolder: located.appFolder,
          keyFolder: located.root,
          log: logPath,
          body: bodyPath,
          export: exportPath,
          siteDir: siteDirPath,
        },
        inventory: written,
        guessedKeyFolders: keyDerivations(
          keySources(workspace.profileDir, workspace.dataHome, recorderId, recUuid),
        ).map((g) => NodePath.join(located.appFolder, g.key)),
        redirectToLog: `http://attacker.example/redir?to=${encodeURIComponent(filePlan.log)}`,
        wrRedirect,
        rec: {
          id: recorderId,
          base: recBase,
          popupPath,
          popupScriptPath,
          parentScript: String(experiment?.parent?.script ?? "").replace(/^\//u, ""),
          schema: String(experiment?.schema ?? "").replace(/^\//u, ""),
          files: packed.files,
        },
        probe: { base: probeBase, warMark, secretMark },
        randomUuid: NodeCrypto.randomUUID(),
        randomId: `not-installed-${NodeCrypto.randomBytes(4).toString("hex")}@test`,
        plantedResource: {
          hit: plantedLog,
          miss: plantedLog.replace(/[^/]+$/u, "missing.jsonl"),
        },
        resourceNames: enumerated.subs
          .map((s) => s.name)
          .filter((n) => n.length > 0 && n !== "och-planted"),
        chromePackages: enumerated.chrome.map((c) => c.pkg),
        mozSrc: enumerated.mozSrc[0] ?? null,
        binDir: NodePath.dirname(context.binaryPath),
      };
      targetPlan = planTargets(planInput);

      context.log("isolation: witnessing every planned target");
      const outcome = (ok: boolean, detail: string): CheckOutcome => ({ ok, detail });
      ({ witness, results: witnessResults } = await runWitness(
        session,
        targetPlan,
        {
          "recorder-api": outcome(
            typeof status.recording === "boolean",
            `recorder page: ${statusText}`,
          ),
          "recorder-storage": outcome(
            (storagePlant.read ?? "").includes(storeMark),
            `system principal reads ${storagePlant.read ?? storagePlant.error ?? ""}`,
          ),
          "recorder-idb": outcome(idbPlant.includes(storeMark), `recorder page reads ${idbPlant}`),
          "bank-traffic": outcome(
            bankMarked,
            bankMarked ? "bank cookie carries the marker" : "no marked bank traffic",
          ),
        },
        server.port,
      ));

      const serverPlan = {
        browser: context.binaryPath,
        server: server.origin,
        file: filePlan,
        webProbeUrl: "http://attacker.example/probe.html",
        victimUrl: "http://attacker.example/victim.html",
        wrRedirect,
        targets: targetPlan.targets,
        noMarionetteProbes: NO_MARIONETTE_PROBE_IDS,
      };
      server.setPlan(serverPlan);

      context.log("isolation: opening web probe tab");
      const positions = await runPositions(context, session, server, {
        savedPageUrl,
        probeBase,
        logUrl: filePlan.log,
        site,
      });
      positionProblems.push(...positions.problems);
      canAccessFileObserved = positions.canAccessFileObserved;

      const stillPlanted = (await session.evaluateChrome(CHROME_PLANT_RESOURCE_SCRIPT, [
        "",
      ])) as boolean;
      record(
        "planted-resource-removed",
        stillPlanted ? ["resource://och-planted/ remained"] : [],
        "removed",
      );

      // The same surface after every probe ran, with the harness's own planted name gone again.
      context.log("isolation: reading the recorder's surface after the probes");
      const enumeratedAtEnd = (await session.evaluateChrome(CHROME_ENUMERATE_SCRIPT, [
        candidates,
      ])) as EnumeratedSchemes;
      const atEnd = (await session.evaluateChrome(CHROME_EXPOSURE_SCRIPT, [
        recorderId,
      ])) as PackedExposure & { readonly error?: string };
      if (atEnd.error !== undefined) throw new Error(`exposure read failed: ${atEnd.error}`);
      const pagesAtEnd = await readPages(session, recorderId, packed.pageUrls, {
        url: popupUrl,
        tab: popupTab,
      });
      const end: RuntimeSurface = {
        webAccessibleResources: atEnd.runtimeWebAccessible,
        webAccessiblePaths: [
          ...atEnd.webAccessiblePaths,
          ...(atEnd.webAccessibleQuery === null
            ? ["(the policy offers no web-accessible query)"]
            : []),
        ],
        ...schemeLines(enumeratedAtEnd),
        pages: pagesAtEnd.pages,
      };
      const inside = (target: string): boolean =>
        target.includes(workspace.profileDir) || target.includes(workspace.dataHome);
      record(
        "no-scheme-into-profile-or-data-home",
        [
          ...new Set(
            [
              ...start.substitutions,
              ...start.chromePackages,
              ...end.substitutions,
              ...end.chromePackages,
            ].filter((line) => inside(line.slice(line.indexOf(" -> ") + 4))),
          ),
        ],
        `${String(enumerated.subs.length)} substitutions and ${String(enumerated.chrome.length)} packages outside, before and after the probes`,
      );
      exposureEvidence = {
        manifestKeys: Object.keys(packed.manifest),
        experimentApis: (packed.manifest["experiment_apis"] ?? {}) as Record<string, unknown>,
        schemaContexts: Object.entries(packed.schemaTexts).flatMap(([file, text]) => {
          try {
            return schemaContexts(JSON.parse(text)).map((c) => `${file}: ${c}`);
          } catch {
            return [`${file}: unreadable schema ${text.slice(0, 100)}`];
          }
        }),
        contentScripts: packed.contentScripts,
        background: packed.manifest["background"] ?? null,
        declaredWebAccessible: (packed.manifest["web_accessible_resources"] ?? []) as unknown[],
        externalListeners: packed.externalListeners,
        pageUrls: packed.pageUrls,
        start,
        end,
      };

      controlPlan = {
        recorderId,
        standInXpi: buildStandInXpi(
          packed.manifest,
          packed.files.filter((f) => /\.x?html?$/iu.test(f)),
        ),
        probeXpi,
        popupPath,
        pageFiles: packed.pageUrls.map((u) => u.slice(recBase.length)),
        site,
        storeMark,
        logPath,
        logUrl: filePlan.log,
        plantRoot: located.root,
        exportName,
        exportText,
        savedPageName,
        savedPageHtml,
        serverPlan,
        extraPrefs: proxyPrefs(server.port),
        noMarionettePrefs: noMarionetteExtraPrefs,
      };

      context.log("isolation: quitting marionette session");
      await session.quit();
    }

    context.log("isolation: file-no-marionette");
    const last = await runNoMarionetteLaunch({
      position: "file-no-marionette",
      binaryPath: context.binaryPath,
      display: context.display,
      profileDir: workspace.profileDir,
      dataHome: workspace.dataHome,
      home: workspace.home,
      url: `${savedPageUrl}?pos=file-no-marionette`,
      extraPrefs: noMarionetteExtraPrefs,
      server,
      signal: context.signal,
    });
    if (last.problem !== null) positionProblems.push(last.problem);
    record("positions-completed", positionProblems, "every position reported done");

    const productRun: RunChanges = {
      plan: diffSnapshots(diskBefore, planSnapshot),
      final: diffSnapshots(diskBefore, snapshotTree(workspace.base)),
      names: [...names, ...browserNames(storeId, [...pids, last.pid])],
    };
    if (area === null || planInput === null || controlPlan === null)
      throw new Error("the run never planned");
    const productReports = [...server.reports];

    context.log("isolation: control run without the product");
    server.clear();
    const controlChanges = await controlRun(context, server, controlPlan);
    const diskEvidence: DiskEvidence = {
      product: productRun,
      control: controlChanges,
      area,
      probed: planInput.inventory.map((w) =>
        NodePath.relative(workspace.base, w.path).split(NodePath.sep).join("/"),
      ),
    };
    record(
      "disk-writes-allowed",
      diskProblems(diskEvidence),
      `${String(beyondControl(productRun, controlChanges).length)} product writes beyond the control run's ${String(controlChanges.final.length)} changes, each in the key folder, the key file or an export, private, with one link`,
    );
    if (exposureEvidence === null) throw new Error("no exposure evidence was read");
    record(
      "exposure-allowed",
      exposureProblems(exposureEvidence),
      `${String(exposureEvidence.start.pages.length)} pages and ${String(exposureEvidence.manifestKeys.length)} manifest keys, all allowed, the same before and after the probes`,
    );

    if (keyEvidence === null) throw new Error("no key evidence was read");
    const archiveEvidence: ArchiveEvidence = {
      ...keyEvidence,
      planned: plannedEntries,
      final: workspace.entries(),
    };
    extraChecks.push(...judgeArchive(archiveEvidence));

    const input: IsolationRunInput = {
      context: {
        marker,
        warMark,
        secretMark,
        storeMark,
        ownMark,
        recId: recorderId,
        recUuid,
        webSandboxBlocksArchive: process.platform === "linux",
      },
      browserRows: productReports.filter((r): r is BrowserRowReport => r.kind === "row"),
      targets: targetPlan.targets,
      witness,
      identity: identities(planInput),
      syntheticControls,
      csFileInjected: productReports.some(
        (r) => r.kind === "cs-hello" && r.href.startsWith("file:"),
      ),
      canAccessFileObserved,
      csArchiveInjectedDocs: productReports
        .filter(
          (r): r is Extract<IsolationReport, { kind: "cs-file-doc" }> =>
            r.kind === "cs-file-doc" && r.inArchive,
        )
        .map((r) => ({ href: r.href, text: r.text })),
      extraChecks,
    };
    const judgment = judgeIsolationRun(input);

    const summary = `${String(judgment.rows.length)} probes: ${String(judgment.counts.BLOCKED)} BLOCKED, ${String(judgment.counts.READ)} READ, ${String(judgment.counts["LEAKS-EXISTENCE"])} LEAKS-EXISTENCE, ${String(judgment.counts["NO-RESULT"])} NO-RESULT; ${String(extraChecks.filter((c) => c.ok).length)} of ${String(extraChecks.length)} extra checks hold`;
    return {
      name: "isolation",
      ok: judgment.ok,
      durationMs: Date.now() - started,
      detail: judgment.ok ? summary : `${summary}; failures: ${judgment.mismatches.join("; ")}`,
      // Everything the pure judges read, so a recorded run can be judged again by a mutated judge.
      data: {
        judgment,
        input,
        archiveEvidence,
        exposureEvidence,
        diskEvidence,
        planInput,
        witnessResults: [...witnessResults],
      },
    };
  },
};

/** @discovered-check */
export default check;
