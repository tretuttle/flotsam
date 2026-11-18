import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

// Planted regressions: each must turn its paired rows or checks red. A product plant edits and packs a scratch copy of
// the product; a harness plant edits the scratch copy of the probes and runs against the unplanted product, and must
// come out NO-RESULT, never BLOCKED. The check runs from the scratch copy copied at the start.

/** An exact edit: `from` must occur exactly once in the file. */
type Edit = { readonly file: string; readonly from: string; readonly to: string };

export type Plant = {
  readonly id: string;
  readonly what: string;
  readonly edits: readonly Edit[];
  readonly files?: Readonly<Record<string, string>>;
  /** Edits the probes, not the product: applied while the check runs against the unplanted XPI. */
  readonly harness?: true;
  /** Rows as `<probe>@<position>`, or `<probe>@<position>=<verdict>` for an exact verdict, and extra checks by id. */
  readonly mustFail: readonly string[];
};

const FILES = "apps/extension/experiment/files.ts";
const STORE = "apps/extension/experiment/store.ts";
const PARENT = "apps/extension/experiment/parent.ts";
const MANIFEST = "apps/extension/src/manifest.json";
const POPUP = "apps/extension/src/popup/main.tsx";
const OPTIONS = "apps/extension/src/options/main.tsx";
const SCHEMA = "apps/extension/experiment/gecko-schema.ts";
const PROBES = "tools/browser-harness/fixtures/isolation/probe-script.ts";
const TARGETS = "tools/browser-harness/fixtures/isolation/targets.ts";
const ISOLATION = "tools/browser-harness/checks/isolation.ts";
const IDENTITY = "tools/browser-harness/fixtures/isolation/identity.ts";
const MANIFEST_ANCHOR = '  "experiment_apis": {';
const WORKER_REGISTER =
  "      resourceHandler().setSubstitution(WORKER_ROOT, this.extension.rootURI);";
const WORKER_REMOVE =
  "      if (this.#host !== null) resourceHandler().setSubstitution(WORKER_ROOT, null);";
/** The worker name pointed at another folder, from the same place the product registers it. */
const workerAt = (folder: string): Edit => ({
  file: PARENT,
  from: WORKER_REGISTER,
  to: `      {
        const at = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        at.initWithPath(${folder});
        resourceHandler().setSubstitution(WORKER_ROOT, Services.io.newFileURI(at));
      }`,
});
const KEY_LINE = "const key = archiveKeyFromBytes(randomBytes(ARCHIVE_KEY_BYTES));";
const MODES_LINE = "const modes: Modes = { dir: row.dirMode, file: row.fileMode };";
const STEPS_LINE = "  let steps: readonly ReconcileStep[] = [];";
const APPEND_LINE =
  "      await ensureDir(dirOf(logSegmentPath(segment.id)));\n      await appendText(segment.path, text, modes);";

/** Runs `ln` from the parent process, as a product could, to give an archive file a second name. */
const hardLink = (target: string): string => `${APPEND_LINE}
      {
        const ln = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        ln.initWithPath("/usr/bin/ln");
        const proc = (Cc["@mozilla.org/process/util;1"] as unknown as {
          createInstance(i: unknown): { init(f: unknown): void; run(b: boolean, args: string[], n: number): void };
        }).createInstance((Ci as unknown as Record<string, unknown>).nsIProcess);
        proc.init(ln);
        proc.run(true, ["-f", segment.path, ${target}], 3);
      }`;

/** Runs `body` once, in the parent process, when the web probe page starts loading: after the plan is taken. */
const onProbePage = (body: string): Edit => ({
  file: PARENT,
  from: STEPS_LINE,
  to: `  {
    const lateObs = {
      observe(subject: unknown) {
        const ch = (subject as { QueryInterface(i: unknown): { URI: { spec: string } } }).QueryInterface(Ci.nsIHttpChannel);
        if (!ch.URI.spec.includes("attacker.example/probe.html")) return;
        Services.obs.removeObserver(lateObs, "http-on-opening-request");
${body}
      },
    };
    Services.obs.addObserver(lateObs, "http-on-opening-request");
  }
${STEPS_LINE}`,
});

const manifestAdds = (json: string): Edit => ({
  file: MANIFEST,
  from: MANIFEST_ANCHOR,
  to: `${json}\n${MANIFEST_ANCHOR}`,
});

export const PLANTS: readonly Plant[] = [
  {
    id: "files-0644",
    what: "archive files written 0644",
    edits: [
      {
        file: FILES,
        from: MODES_LINE,
        to: "const modes: Modes = { dir: row.dirMode, file: row.fileMode === null ? null : 0o644 };",
      },
    ],
    mustFail: ["archive-modes"],
  },
  {
    id: "dirs-0755",
    what: "archive directories world-readable 0755",
    edits: [
      {
        file: FILES,
        from: MODES_LINE,
        to: "const modes: Modes = { dir: row.dirMode === null ? null : 0o755, file: row.fileMode };",
      },
    ],
    mustFail: ["archive-modes"],
  },
  {
    id: "key-sha256-profile",
    what: "archive key is the first 32 hex digits of sha256(profile path)",
    edits: [
      {
        file: FILES,
        from: KEY_LINE,
        to: 'const h = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash); h.init(Ci.nsICryptoHash.SHA256); const pb = Array.from(profile, (c: string) => c.charCodeAt(0)); h.update(pb, pb.length); const bin = h.finish(false); const key = Array.from(bin, (c: string) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").slice(0, 32);',
      },
    ],
    mustFail: ["key-not-derived", "script-site-oracle@file"],
  },
  {
    id: "constant-key",
    what: "archive key is a fixed 32-hex constant",
    edits: [
      {
        file: FILES,
        from: KEY_LINE,
        to: "const key = archiveKeyFromBytes(new Uint8Array(ARCHIVE_KEY_BYTES).fill(0x5a));",
      },
    ],
    mustFail: ["key-differs-across-profiles"],
  },
  {
    id: "war-pages",
    what: "popup and experiment files web-accessible to every page and extension",
    edits: [
      manifestAdds(
        '  "web_accessible_resources": [{ "resources": ["popup/*", "experiment/*"], "matches": ["<all_urls>"], "extension_ids": ["*"] }],',
      ),
    ],
    mustFail: ["mozext-parent@web", "mozext-every-file@web", "exposure-allowed"],
  },
  {
    id: "downloads-list",
    what: "an export named after a recorded site added to the Downloads list",
    edits: [
      {
        file: PARENT,
        from: STEPS_LINE,
        to: `  const { setInterval: plantSet, clearInterval: plantClear } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const plantTimer = plantSet(() => {
    void (async () => {
      const sitesDir = PathUtils.join(archive.root, "sites");
      if (!(await IOUtils.exists(sitesDir))) return;
      const kids = await IOUtils.getChildren(sitesDir);
      if (kids.length === 0) return;
      plantClear(plantTimer);
      const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
      const dir = await Downloads.getPreferredDownloadsDirectory();
      const target = PathUtils.join(dir, PathUtils.filename(kids[0]) + "-export.har");
      await IOUtils.writeUTF8(target, "{}");
      const download = await Downloads.createDownload({ source: PathUtils.toFileURI(target), target });
      await (await Downloads.getList(Downloads.ALL)).add(download);
    })();
  }, 500);
${STEPS_LINE}`,
      },
    ],
    mustFail: ["downloads-search@ext-bg", "downloads-search@ext-page"],
  },
  {
    id: "cs-expose",
    what: "a content script on every page exposes window.oneClickHar to the content principal",
    edits: [
      manifestAdds(
        '  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content/expose.ts"], "all_frames": true, "run_at": "document_start" }],',
      ),
    ],
    files: {
      "apps/extension/src/content/expose.ts":
        "const w = window as unknown as { wrappedJSObject: Record<string, unknown> };\n" +
        "w.wrappedJSObject.oneClickHar = cloneInto({ recording: true, problems: [] }, window);\n" +
        "declare function cloneInto<T>(value: T, target: object): T;\n" +
        "export {};\n",
    },
    mustFail: ["api-namespace@web", "api-namespace@cs-web", "exposure-allowed"],
  },
  {
    id: "connect-external",
    what: "a background script answers runtime.connect from any extension with the recording status",
    edits: [manifestAdds('  "background": { "scripts": ["background/connect.ts"] },')],
    files: {
      "apps/extension/src/background/connect.ts":
        "declare const browser: { runtime: { onConnectExternal: { addListener(f: (p: { postMessage(m: unknown): void }) => void): void } } };\n" +
        "browser.runtime.onConnectExternal.addListener((port) => port.postMessage({ recording: true, problems: [] }));\n" +
        "export {};\n",
    },
    mustFail: ["connect-recorder@ext-bg", "exposure-allowed"],
  },
  {
    id: "site-dir-unkeyed",
    what: "each recorded site also gets <appFolder>/sites/<host>/ outside the random key folder",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `      await ensureDir(dirOf(logSegmentPath(segment.id)));
      await makeDirectory(PathUtils.join(PathUtils.parent(root), "sites", logSegmentPath(segment.id)[1]), modes);
      await appendText(segment.path, text, modes);`,
      },
    ],
    mustFail: ["nothing-outside-key-folder", "disk-writes-allowed"],
  },
  {
    id: "resource-sub",
    what: "the product maps resource://one-click-har-data/ to the archive with ALLOW_CONTENT_ACCESS at startup",
    edits: [
      {
        file: PARENT,
        from: STEPS_LINE,
        to: `  {
    const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(archive.root);
    res.setSubstitutionWithFlags("one-click-har-data", Services.io.newFileURI(f), Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);
  }
${STEPS_LINE}`,
      },
    ],
    mustFail: [
      "resource-all@file",
      "no-scheme-into-profile-or-data-home",
      "substitution-name",
      "substitution-lifetime",
    ],
  },
  {
    id: "key-file-0644",
    what: "the key file in the profile is written 0644",
    edits: [
      {
        file: FILES,
        from: "writeAsciiSync(path, `${key}\\n`, { dir: null, file: 0o600 });",
        to: "writeAsciiSync(path, `${key}\\n`, { dir: null, file: 0o644 });",
      },
    ],
    mustFail: ["key-file-mode"],
  },
  {
    id: "message-external",
    what: "a background script replies to runtime.sendMessage from any extension",
    edits: [manifestAdds('  "background": { "scripts": ["background/message.ts"] },')],
    files: {
      "apps/extension/src/background/message.ts":
        "declare const browser: { runtime: { onMessageExternal: { addListener(f: () => Promise<unknown>): void } } };\n" +
        "browser.runtime.onMessageExternal.addListener(() => Promise.resolve({ recording: true, problems: [] }));\n" +
        "export {};\n",
    },
    mustFail: ["sendmessage-recorder@ext-bg", "exposure-allowed"],
  },
  {
    id: "site-index-outside-key",
    what: "a list of recorded hosts written next to the key folder (<appFolder>/recent-sites.txt)",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `      await ensureDir(dirOf(logSegmentPath(segment.id)));
      await appendText(PathUtils.join(PathUtils.parent(root), "recent-sites.txt"), state.site + "\\n", modes);
      await appendText(segment.path, text, modes);`,
      },
    ],
    mustFail: ["nothing-outside-key-folder", "key-names-the-archive", "disk-writes-allowed"],
  },

  // Verifier round 2: product plants of new kinds.
  {
    id: "files-0640",
    what: "archive files group-readable 0640",
    edits: [
      {
        file: FILES,
        from: MODES_LINE,
        to: "const modes: Modes = { dir: row.dirMode, file: row.fileMode === null ? null : 0o640 };",
      },
    ],
    mustFail: ["archive-modes"],
  },
  {
    id: "key-file-0640",
    what: "the key file in the profile is written group-readable 0640",
    edits: [
      {
        file: FILES,
        from: "writeAsciiSync(path, `${key}\\n`, { dir: null, file: 0o600 });",
        to: "writeAsciiSync(path, `${key}\\n`, { dir: null, file: 0o640 });",
      },
    ],
    mustFail: ["key-file-mode"],
  },
  {
    id: "popup-postmessage",
    what: "the recorder popup echoes its environment to any postMessage",
    edits: [
      {
        file: POPUP,
        from: "const store = createPopupStore({",
        to: `window.addEventListener("message", (event) => {
  void browser.oneClickHar?.getEnvironment(0).then((status) => {
    (event.source as WindowProxy | null)?.postMessage({ oneClickHar: status }, "*");
  });
});
const store = createPopupStore({`,
      },
    ],
    mustFail: ["exposure-allowed"],
  },
  {
    id: "war-runtime",
    what: "the parent script adds /action/* and /experiment/* to webAccessibleResources at runtime",
    edits: [
      {
        file: PARENT,
        from: STEPS_LINE,
        to: `  {
    const pol = WebExtensionPolicy.getByID("one-click-har@tretuttle.github.io") as unknown as {
      extension: {
        webAccessibleResources: unknown[];
        serialize(): unknown;
        setSharedData(k: string, v: unknown): void;
      };
    } | null;
    if (pol) {
      pol.extension.webAccessibleResources.push({
        resources: ["/action/*", "/experiment/*"],
        matches: ["<all_urls>"],
        extension_ids: ["*"],
      });
      pol.extension.setSharedData("", pol.extension.serialize());
    }
  }
${STEPS_LINE}`,
      },
    ],
    mustFail: [
      "exposure-allowed",
      "mozext-parent@web",
      "mozext-every-file@web",
      "mozext-frame-recorder@web",
    ],
  },
  {
    id: "downloads-symlink",
    what: "the parent script links Downloads/one-click-har-archive to the key folder",
    edits: [
      {
        file: PARENT,
        from: STEPS_LINE,
        to: `  {
    const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
    void Downloads.getPreferredDownloadsDirectory().then((dlDir: string) => {
      const targetPath = PathUtils.join(dlDir, "one-click-har-archive");
      const ln = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      ln.initWithPath("/usr/bin/ln");
      const proc = (Cc["@mozilla.org/process/util;1"] as unknown as {
        createInstance(i: unknown): { init(f: unknown): void; run(b: boolean, args: string[], n: number): void };
      }).createInstance((Ci as unknown as Record<string, unknown>).nsIProcess);
      proc.init(ln);
      proc.run(true, ["-sfn", archive.root, targetPath], 3);
    });
  }
${STEPS_LINE}`,
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "schema-exposed-cs",
    what: "the experiment API adds a content_parent scope and allowedContexts content",
    edits: [
      {
        file: MANIFEST,
        from: '"scopes": ["addon_parent"],',
        to: '"scopes": ["addon_parent", "content_parent"],',
      },
      {
        file: SCHEMA,
        from: "    namespace,\n",
        to: '    namespace,\n    allowedContexts: ["content", "addon"],\n',
      },
    ],
    mustFail: ["exposure-allowed"],
  },
  {
    id: "clipboard-leak",
    what: "the recorder copies the log path and a recorded line to the clipboard while capturing",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `      await ensureDir(dirOf(logSegmentPath(segment.id)));
      (Cc["@mozilla.org/widget/clipboardhelper;1"] as unknown as {
        getService(i: unknown): { copyString(s: string): void };
      }).getService((Ci as unknown as Record<string, unknown>).nsIClipboardHelper).copyString(segment.path + "\\n" + text.slice(0, 200));
      await appendText(segment.path, text, modes);`,
      },
    ],
    mustFail: ["clipboard-after-export@ext-page"],
  },
  {
    id: "profile-site-list",
    what: "the recorder writes recorded hosts to <profile>/one-click-har-sites.txt",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `      await ensureDir(dirOf(logSegmentPath(segment.id)));
      await appendText(PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "one-click-har-sites.txt"), state.site + "\\n", modes);
      await appendText(segment.path, text, modes);`,
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },

  // Harness plants: a probe that reports nothing, or acts on or plans a target that is not there, is NO-RESULT.
  {
    id: "probe-empty-result",
    what: "xhr-file-log's runner returns {}",
    harness: true,
    edits: [
      {
        file: PROBES,
        from: '"xhr-file-log": (p) => viaXhr(one(p, "xhr-file-log")),',
        to: '"xhr-file-log": async () => ({}),',
      },
    ],
    mustFail: ["xhr-file-log@web=NO-RESULT", "xhr-file-log@file=NO-RESULT"],
  },
  {
    id: "probe-empty-result-exception",
    what: "tabs-query-recorder's runner, on a decided-exception row, returns {}",
    harness: true,
    edits: [
      {
        file: PROBES,
        from: '"tabs-query-recorder": (p) => about(',
        to: '"tabs-query-recorder": async () => ({}),\n    "unused-tabs-query": (p) => about(',
      },
    ],
    mustFail: ["tabs-query-recorder@ext-bg=NO-RESULT", "tabs-query-recorder@ext-page=NO-RESULT"],
  },
  {
    id: "probe-missing-runner",
    what: "xhr-file-log has no runner",
    harness: true,
    edits: [
      {
        file: PROBES,
        from: '    "xhr-file-log": (p) => viaXhr(one(p, "xhr-file-log")),\n',
        to: "",
      },
    ],
    mustFail: ["xhr-file-log@web=NO-RESULT"],
  },
  {
    id: "probe-never-runs",
    what: "runAll skips xhr-file-log, so it reports no row",
    harness: true,
    edits: [
      {
        file: PROBES,
        from: "      if (only && !only.includes(meta.id)) continue;",
        to: '      if (meta.id === "xhr-file-log") continue;\n      if (only && !only.includes(meta.id)) continue;',
      },
    ],
    mustFail: ["xhr-file-log@web=NO-RESULT"],
  },
  {
    id: "probe-typo-xhr-file-log",
    what: "xhr-file-log requests the log path with a typo",
    harness: true,
    edits: [
      {
        file: PROBES,
        from: 'viaXhr(one(p, "xhr-file-log"))',
        to: 'viaXhr(one(p, "xhr-file-log") + "-typo")',
      },
    ],
    mustFail: ["xhr-file-log@file=NO-RESULT", "xhr-file-log@web=NO-RESULT"],
  },
  {
    id: "probe-typo-mozext-parent",
    what: "mozext-parent fetches experiment/parent-typo.js",
    harness: true,
    edits: [
      {
        file: PROBES,
        from: '"mozext-parent": fetchOne("mozext-parent"),',
        to: '"mozext-parent": (p) => viaFetch(one(p, "mozext-parent").replace("parent.js", "parent-typo.js")),',
      },
    ],
    mustFail: ["mozext-parent@web=NO-RESULT"],
  },
  {
    id: "probe-typo-connect-recorder",
    what: "connect-recorder connects to the recorder id with a typo",
    harness: true,
    edits: [
      {
        file: PROBES,
        from: 'connectTo(after(one(p, "connect-recorder"), "addon:"))',
        to: 'connectTo(after(one(p, "connect-recorder"), "addon:") + "-typo")',
      },
    ],
    mustFail: ["connect-recorder@ext-bg=NO-RESULT"],
  },
  {
    id: "plan-typo-mozext-parent",
    what: "the plan names experiment/parent-typo.js, so the probe and the plan agree on a file that is not there",
    harness: true,
    edits: [
      {
        file: TARGETS,
        from: 'plan(["mozext-parent"], [recUrl(rec.parentScript)]);',
        to: 'plan(["mozext-parent"], [recUrl(`${rec.parentScript}-typo`)]);',
      },
    ],
    mustFail: ["mozext-parent@web=NO-RESULT"],
  },

  // Verifier round 3: product plants of new kinds, and plants on the witness.
  {
    id: "connect-external-delayed",
    what: "a background script answers runtime.onConnectExternal only after 600 ms",
    edits: [manifestAdds('  "background": { "scripts": ["background/connect-delayed.ts"] },')],
    files: {
      "apps/extension/src/background/connect-delayed.ts":
        "declare const browser: { runtime: { onConnectExternal: { addListener(f: (p: { postMessage(m: unknown): void }) => void): void } } };\n" +
        "browser.runtime.onConnectExternal.addListener((port) => { setTimeout(() => port.postMessage({ recording: true, problems: [] }), 600); });\n" +
        "export {};\n",
    },
    mustFail: ["connect-recorder@ext-bg", "exposure-allowed"],
  },
  {
    id: "hardlink-in-profile",
    what: "each log segment gets a second name, <profile>/leaked-log.jsonl, by a hard link",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: hardLink(
          'PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "leaked-log.jsonl")',
        ),
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "hardlink-in-profile-storage",
    what: "each log segment gets a second name inside the browser's own storage folder, <profile>/storage/leaked-log.jsonl",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `${APPEND_LINE}
      await makeDirectory(PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "storage"), modes);${hardLink('PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "storage", "leaked-log.jsonl")').slice(APPEND_LINE.length)}`,
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "resource-sub-late-literal",
    what: "resource://one-click-har/ mapped to the key folder with content access once the probes start, after the plan",
    edits: [
      onProbePage(`        const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(archive.root);
        res.setSubstitutionWithFlags("one-click-har", Services.io.newFileURI(f), Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);`),
    ],
    mustFail: ["no-scheme-into-profile-or-data-home", "substitution-lifetime", "exposure-allowed"],
  },
  {
    id: "resource-sub-late",
    what: "the same late mapping through a method name built at run time, so no packed script names the call",
    edits: [
      onProbePage(`        const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler) as unknown as Record<string, (n: string, u: unknown, fl: number) => void>;
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(archive.root);
        const fn = "s" + ch.URI.spec.slice(0, 0) + "etSubstitutionWithFlags";
        res[fn]?.("one-click-har", Services.io.newFileURI(f), Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);`),
    ],
    mustFail: ["no-scheme-into-profile-or-data-home", "exposure-allowed", "substitution-lifetime"],
  },
  {
    id: "recorder-iframe-via-redirect",
    what: "the popup is web-accessible, and a frame load of attacker.example/redir is redirected to it",
    edits: [
      manifestAdds(
        '  "web_accessible_resources": [{ "resources": ["action/*"], "matches": ["<all_urls>"], "extension_ids": ["*"] }],',
      ),
      {
        file: PARENT,
        from: STEPS_LINE,
        to: `  {
    const redirObs = {
      observe(subject: unknown) {
        const ch = (subject as { QueryInterface(i: unknown): { URI: { spec: string }; loadInfo?: { externalContentPolicyType?: number }; redirectTo(u: unknown): void } }).QueryInterface(Ci.nsIHttpChannel);
        if (!ch.URI.spec.startsWith("http://attacker.example/redir?")) return;
        const pol = WebExtensionPolicy.getByID("one-click-har@tretuttle.github.io");
        if (pol && ch.loadInfo?.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_SUBDOCUMENT) {
          ch.redirectTo(Services.io.newURI(pol.getURL("action/index.html")));
        }
      },
    };
    Services.obs.addObserver(redirObs, "http-on-opening-request");
  }
${STEPS_LINE}`,
      },
    ],
    mustFail: ["mozext-frame-recorder@web", "exposure-allowed"],
  },
  {
    id: "schema-fn-allowed-contexts",
    what: "one function of the experiment schema, getEnvironment, allowed in content and add-on contexts",
    edits: [
      {
        file: SCHEMA,
        from: "      parameters: parameters.map(({ parse: _parse, ...gecko }) => gecko),\n    })),",
        to: '      parameters: parameters.map(({ parse: _parse, ...gecko }) => gecko),\n      ...(name === "getEnvironment" ? { allowedContexts: ["content", "addon"] } : {}),\n    })),',
      },
    ],
    mustFail: ["exposure-allowed"],
  },
  {
    id: "export-mode-0644",
    what: "exports in Downloads written world-readable 0644, over the planned export and as a new one, after the plan",
    edits: [
      onProbePage(`        const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
        void Downloads.getPreferredDownloadsDirectory().then((dlDir: string) => {
          for (const name of ["bank.example-2026-11-16.har", "bank.example-export.har"]) {
            const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            f.initWithPath(PathUtils.join(dlDir, name));
            const out = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
            out.init(f, 0x02 | 0x08 | 0x20, 0o644, 0);
            const body = JSON.stringify({ log: { version: "1.2", entries: [] } });
            out.write(body, body.length);
            out.close();
            f.permissions = 0o644;
          }
        });`),
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "profile-zen-json-leak",
    what: "recorded log lines appended to <profile>/zen-one-click-har.json, a name like the browser's own",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `${APPEND_LINE}
      await appendText(PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "zen-one-click-har.json"), text, modes);`,
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "witness-typo-target",
    what: "the plan aims fetch-file-log at the log path with -typo appended",
    harness: true,
    edits: [
      {
        file: TARGETS,
        from: '      "fetch-file-log",\n      "xhr-file-log",',
        to: '      "xhr-file-log",',
      },
      {
        file: TARGETS,
        from: "  const body = marked(file.body);",
        to: '  plan(["fetch-file-log"], [fileTarget(fileHref(`${file.log}-typo`))]);\n  const body = marked(file.body);',
      },
    ],
    mustFail: ["fetch-file-log@web=NO-RESULT", "fetch-file-log@file=NO-RESULT"],
  },
  {
    id: "witness-wrong-file-marked",
    what: "the plan aims own-non-war at the probe add-on's war.txt, which exists but holds the other mark",
    harness: true,
    edits: [
      {
        file: TARGETS,
        from: 'plan(["own-non-war"], [load(`${input.probe.base}secret.txt`, input.probe.secretMark)]);',
        to: 'plan(["own-non-war"], [load(`${input.probe.base}war.txt`, input.probe.secretMark)]);',
      },
    ],
    mustFail: ["own-non-war@web=NO-RESULT", "own-non-war@file=NO-RESULT"],
  },
  {
    id: "witness-wrong-file-unmarked",
    what: "the plan aims mozext-parent at manifest.json and fetch-file-body at the log: both exist, both the wrong file",
    harness: true,
    edits: [
      {
        file: TARGETS,
        from: '  plan(["fetch-file-body"], [body]);',
        to: '  plan(["fetch-file-body"], [fileTarget(log)]);',
      },
      {
        file: TARGETS,
        from: '  plan(["mozext-parent"], [recUrl(rec.parentScript)]);',
        to: '  plan(["mozext-parent"], [recUrl("manifest.json")]);',
      },
    ],
    mustFail: ["mozext-parent@web=NO-RESULT", "fetch-file-body@web=NO-RESULT"],
  },
  {
    id: "witness-always-succeeds",
    what: "the witness answers ok for every check, without asking the system principal or the server",
    harness: true,
    edits: [
      {
        file: ISOLATION,
        from: '          ? await redirectWitness(c.url, c.to, proxyPort)\n          : (chrome[key] ?? { ok: false, detail: "no answer from the system principal" }),',
        to: '          ? { ok: true, detail: "mutated witness always ok" }\n          : { ok: true, detail: "mutated witness always ok" },',
      },
    ],
    mustFail: [
      "img-file-oracle@web=NO-RESULT",
      "script-root-oracle@file=NO-RESULT",
      "mozext-script-oracle@web=NO-RESULT",
      "sendmessage-oracle@ext-bg=NO-RESULT",
    ],
  },

  // Verifier round 4: writes the control runs share, late page listeners, and identity aimed at the wrong file.
  {
    id: "control-write-prefs",
    what: "a recorded log line saved as a pref, so it lands in prefs.js, a file every run writes",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `${APPEND_LINE}
      Services.prefs.setStringPref("extensions.one-click-har.leaked", text.slice(0, 500));`,
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "control-write-storage",
    what: "recorded log lines appended to <profile>/storage/ls-archive.sqlite, a database every run writes",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `${APPEND_LINE}
      await appendText(PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "storage", "ls-archive.sqlite"), text, { dir: 0o755, file: 0o644 });`,
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "control-write-deleted",
    what: "recorded log lines in <profile>/leaked-ephemeral.jsonl at plan time, deleted once the probes start",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `${APPEND_LINE}
      if (state.site === "bank.example" && segment.path.endsWith("-0.jsonl")) {
        await appendText(PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "leaked-ephemeral.jsonl"), text, modes);
      }`,
      },
      onProbePage(
        '        void IOUtils.remove(PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "leaked-ephemeral.jsonl"), { ignoreAbsent: true });',
      ),
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "control-write-content-process",
    what: "a frame script on bank.example copies document.cookie into the page's localStorage",
    edits: [
      {
        file: PARENT,
        from: STEPS_LINE,
        to: `  {
    const mm = (Services as unknown as { mm: { loadFrameScript(u: string, b: boolean): void } }).mm;
    const fsBody = "addEventListener('DOMContentLoaded', () => { try { if (content && content.location && content.location.hostname === 'bank.example') content.localStorage.setItem('och_content_leak', content.document.cookie); } catch (e) {} });";
    mm.loadFrameScript("data:application/javascript;charset=utf-8," + encodeURIComponent(fsBody), true);
  }
${STEPS_LINE}`,
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "sibling-key-folder-0600",
    what: "a 0600 file in a 0700 folder named like a key, next to the real key folder",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `${APPEND_LINE}
      {
        const sibDir = PathUtils.join(PathUtils.parent(root), "00000000000000000000000000000000");
        await makeDirectory(sibDir, modes);
        await appendText(PathUtils.join(sibDir, "leaked.jsonl"), text, modes);
      }`,
      },
    ],
    mustFail: ["nothing-outside-key-folder", "key-names-the-archive", "disk-writes-allowed"],
  },
  {
    id: "symlink-in-key-folder",
    what: "a symlink in the key folder pointing at <profile>/prefs.js",
    edits: [
      {
        file: STORE,
        from: APPEND_LINE,
        to: `${APPEND_LINE}
      {
        const targetPath = PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "prefs.js");
        const linkPath = PathUtils.join(root, "leaked-link");
        const ln = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        ln.initWithPath("/usr/bin/ln");
        const proc = (Cc["@mozilla.org/process/util;1"] as unknown as {
          createInstance(i: unknown): { init(f: unknown): void; run(b: boolean, args: string[], n: number): void };
        }).createInstance((Ci as unknown as Record<string, unknown>).nsIProcess);
        proc.init(ln);
        proc.run(true, ["-sfn", targetPath, linkPath], 3);
      }`,
      },
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "export-wrong-folder",
    what: "a 0600 export written to HOME instead of Downloads",
    edits: [
      onProbePage(`        const homeDir = Services.dirsvc.get("Home", Ci.nsIFile).path;
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(PathUtils.join(homeDir, "bank.example-export.har"));
        const out = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
        out.init(f, 0x02 | 0x08 | 0x20, 0o600, 0);
        const body = JSON.stringify({ log: { version: "1.2", entries: [] } });
        out.write(body, body.length);
        out.close();
        f.permissions = 0o600;`),
    ],
    mustFail: ["disk-writes-allowed"],
  },
  {
    id: "popup-postmessage-delayed",
    what: "the popup starts answering postMessage 1.5 s after it loads",
    edits: [
      {
        file: POPUP,
        from: "const store = createPopupStore({",
        to: `setTimeout(() => {
  window.addEventListener("message", (event) => {
    void browser.oneClickHar?.getEnvironment(0).then((status) => {
      (event.source as WindowProxy | null)?.postMessage({ oneClickHar: status }, "*");
    });
  });
}, 1500);
const store = createPopupStore({`,
      },
    ],
    mustFail: ["exposure-allowed"],
  },
  {
    id: "options-postmessage-delayed",
    what: "the options page starts answering postMessage 1 s after it loads",
    edits: [
      {
        file: OPTIONS,
        from: "const Options = () => (",
        to: `setTimeout(() => {
  window.addEventListener("message", (event) => {
    (event.source as WindowProxy | null)?.postMessage({ oneClickHarOptions: "leaked" }, "*");
  });
}, 1000);
const Options = () => (`,
      },
    ],
    mustFail: ["exposure-allowed"],
  },
  {
    id: "message-external-late-runtime",
    what: "the popup adds a runtime.onMessageExternal listener 1.5 s after it loads, under a name built at run time",
    edits: [
      {
        file: POPUP,
        from: "const store = createPopupStore({",
        to: `setTimeout(() => {
  const rt = (browser as unknown as { runtime: Record<string, { addListener(fn: () => Promise<unknown>): void }> }).runtime;
  const ev = ["onMessage", "External"].join("");
  rt[ev]?.addListener(() => Promise.resolve({ recording: true, problems: [] }));
}, 1500);
const store = createPopupStore({`,
      },
    ],
    mustFail: ["sendmessage-recorder@ext-bg", "sendmessage-oracle@ext-bg"],
  },
  {
    id: "war-geturl-runtime-late",
    what: "the parent script makes the popup web-accessible at run time once the probes start",
    edits: [
      onProbePage(`        const pol = WebExtensionPolicy.getByID("one-click-har@tretuttle.github.io") as unknown as {
          getURL(p: string): string;
          sourceMayAccessPath?: (uri: unknown, path: string) => boolean;
          isWebAccessiblePath?: (path: string) => boolean;
          extension: {
            webAccessibleResources: unknown[];
            serialize(): unknown;
            setSharedData(k: string, v: unknown): void;
          };
        } | null;
        if (pol) {
          const exposed = Services.io.newURI(pol.getURL("action/index.html")).filePath;
          pol.extension.webAccessibleResources.push({
            resources: [exposed],
            matches: ["<all_urls>"],
            extension_ids: ["*"],
          });
          pol.sourceMayAccessPath = (_uri: unknown, p: string) => p === exposed;
          pol.isWebAccessiblePath = (p: string) => p === exposed;
          pol.extension.setSharedData("", pol.extension.serialize());
        }`),
    ],
    mustFail: ["exposure-allowed", "mozext-popup@file", "mozext-every-file@file"],
  },
  {
    id: "identity-wrong-product-file",
    what: "the plan aims mozext-popup at the parent script and fetch-file-log at the body: both exist, both marked or packed",
    harness: true,
    edits: [
      {
        file: TARGETS,
        from: '      "fetch-file-log",\n      "xhr-file-log",',
        to: '      "xhr-file-log",',
      },
      {
        file: TARGETS,
        from: '  plan(["fetch-file-body"], [body]);',
        to: '  plan(["fetch-file-log"], [body]);\n  plan(["fetch-file-body"], [body]);',
      },
      {
        file: TARGETS,
        from: '  plan(["mozext-popup", "mozext-frame-recorder"], [recUrl(rec.popupPath)]);',
        to: '  plan(["mozext-popup"], [recUrl(rec.parentScript)]);\n  plan(["mozext-frame-recorder"], [recUrl(rec.popupPath)]);',
      },
    ],
    mustFail: ["fetch-file-log@web=NO-RESULT", "mozext-popup@web=NO-RESULT"],
  },
  {
    id: "identity-wrong-product-file-via-want",
    what: "view-source: and jar: probes aimed at the body while the plan still attaches the log's witness check",
    harness: true,
    edits: [
      {
        file: TARGETS,
        from: '  plan(\n    ["viewsource-fetch", "viewsource-iframe", "tabs-create-viewsource"],\n    [want(`view-source:${log}`, logFile)],\n  );\n  plan(["jar-file-fetch", "jar-file-iframe"], [want(`jar:${log}!/`, logFile)]);',
        to: '  plan(\n    ["viewsource-fetch", "viewsource-iframe", "tabs-create-viewsource"],\n    [want(`view-source:${body}`, logFile)],\n  );\n  plan(["jar-file-fetch", "jar-file-iframe"], [want(`jar:${body}!/`, logFile)]);',
      },
    ],
    mustFail: ["viewsource-fetch@web=NO-RESULT", "jar-file-fetch@web=NO-RESULT"],
  },
  {
    id: "identity-same-content-diff-path",
    what: "fetch-file-log aimed at a byte-identical, marked copy of the log at another path",
    harness: true,
    edits: [
      {
        file: ISOLATION,
        from: "      const exportPath = NodePath.join(workspace.downloads, exportName);",
        to: "      NodeFS.copyFileSync(logPath, `${logPath}.copy.jsonl`);\n      NodeFS.chmodSync(`${logPath}.copy.jsonl`, 0o600);\n      const exportPath = NodePath.join(workspace.downloads, exportName);",
      },
      {
        file: TARGETS,
        from: '      "fetch-file-log",\n      "xhr-file-log",',
        to: '      "xhr-file-log",',
      },
      {
        file: TARGETS,
        from: '  plan(["fetch-file-body"], [body]);',
        to: '  plan(["fetch-file-log"], [marked(`${file.log}.copy.jsonl`)]);\n  plan(["fetch-file-body"], [body]);',
      },
    ],
    mustFail: ["fetch-file-log@web=NO-RESULT", "fetch-file-log@file=NO-RESULT"],
  },
  {
    id: "identity-mutated-accept-all",
    what: "identity.ts gives every probe one dummy check that no witness ever runs",
    harness: true,
    edits: [
      {
        file: IDENTITY,
        from: "  return Object.fromEntries(\n    PROBE_TABLE.map((spec) => [spec.id, identityOf(spec, targets[spec.target])]),\n  );",
        to: '  void targets;\n  return Object.fromEntries(\n    PROBE_TABLE.map((spec) => [spec.id, { role: spec.target, kind: "every" as const, check: "accept-all", place: "accept-all" }]),\n  );',
      },
    ],
    mustFail: ["fetch-file-log@web=NO-RESULT", "mozext-parent@web=NO-RESULT"],
  },
  {
    id: "worker-second-host",
    what: "the product registers a second resource:// host into its own packed files beside one-click-har",
    edits: [
      {
        file: PARENT,
        from: WORKER_REGISTER,
        to: `${WORKER_REGISTER}
      resourceHandler().setSubstitution("one-click-har-extra", this.extension.rootURI);`,
      },
    ],
    mustFail: ["substitution-name"],
  },
  {
    id: "worker-into-data-folder",
    what: "resource://one-click-har/ points at the app folder in the data home, which holds the archive",
    edits: [
      workerAt(
        'PathUtils.join(Services.env.get("XDG_DATA_HOME") || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".local", "share"), "one-click-har")',
      ),
    ],
    mustFail: ["substitution-target", "no-scheme-into-profile-or-data-home"],
  },
  {
    id: "worker-into-profile-root",
    what: "resource://one-click-har/ points at the profile root",
    edits: [workerAt('Services.dirsvc.get("ProfD", Ci.nsIFile).path')],
    mustFail: ["substitution-target", "no-scheme-into-profile-or-data-home"],
  },
  {
    id: "worker-content-accessible",
    what: "resource://one-click-har/ registered into the packed files with content access",
    edits: [
      {
        file: PARENT,
        from: WORKER_REGISTER,
        to: `      (resourceHandler() as unknown as { setSubstitutionWithFlags(n: string, u: unknown, f: number): void }).setSubstitutionWithFlags(
        WORKER_ROOT,
        this.extension.rootURI,
        Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS,
      );`,
      },
    ],
    mustFail: ["substitution-reach"],
  },
  {
    id: "worker-left-registered",
    what: "the product no longer removes resource://one-click-har/ when it shuts down",
    edits: [{ file: PARENT, from: WORKER_REMOVE, to: "      if (this.#host !== null) void 0;" }],
    mustFail: ["substitution-lifetime"],
  },
  // Round 6's five: a name built at run time in a loop, a lazy registration, a flag flipped late, and a packed file
  // loaded through the name although its root does not load.
  {
    id: "r6-second-host-template-loop",
    what: "a second host built from a template literal, registered beside one-click-har from one call site in a loop, and never removed",
    edits: [
      {
        file: PARENT,
        from: WORKER_REGISTER,
        to: `      for (const host of [WORKER_ROOT, \`\${WORKER_ROOT}-extra\`]) {
        resourceHandler().setSubstitution(host, this.extension.rootURI);
      }`,
      },
    ],
    mustFail: ["substitution-name", "substitution-lifetime"],
  },
  {
    id: "r6-wider-archive-second-host",
    what: "a second host built from a template literal, into the data home's app folder, from one call site in a loop",
    edits: [
      {
        file: PARENT,
        from: WORKER_REGISTER,
        to: `      {
        const at = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        at.initWithPath(PathUtils.join(Services.env.get("XDG_DATA_HOME") || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".local", "share"), "one-click-har"));
        for (const [host, uri] of [
          [WORKER_ROOT, this.extension.rootURI],
          [\`\${WORKER_ROOT}-data\`, Services.io.newFileURI(at)],
        ] as const) {
          resourceHandler().setSubstitution(host, uri);
        }
      }`,
      },
    ],
    mustFail: [
      "substitution-name",
      "substitution-target",
      "substitution-lifetime",
      "no-scheme-into-profile-or-data-home",
    ],
  },
  {
    // Round 6 wrapped exports.startExport, which the API never calls, so its version registered nothing at all.
    id: "r6-lazy-wider-no-remove",
    what: "resource://one-click-har/ registered into the profile root only once an export starts, and never removed",
    edits: [
      { file: PARENT, from: "      workerUrl: this.#workerUrl(),", to: "      workerUrl: null," },
      workerAt('Services.dirsvc.get("ProfD", Ci.nsIFile).path'),
      {
        file: PARENT,
        from: "          exports: host.exports,",
        to: "          exports: { ...host.exports, start: (request) => { void this.#workerUrl(); return host.exports.start(request); } },",
      },
      { file: PARENT, from: WORKER_REMOVE, to: "      if (this.#host !== null) void 0;" },
    ],
    mustFail: ["substitution-target", "substitution-lifetime"],
  },
  {
    id: "r6-content-reachable-worker-host",
    what: "resource://one-click-har/ registered as the product does, then given content access once the probes start, through a method name built at run time",
    edits: [
      onProbePage(`        const res = resourceHandler() as unknown as Record<string, (n: string, u: unknown, f: number) => void>;
        const fn = "s" + ch.URI.spec.slice(0, 0) + "etSubstitutionWithFlags";
        res[fn]?.(
          WORKER_ROOT,
          (WebExtensionPolicy.getByID("one-click-har@tretuttle.github.io") as unknown as { extension: { rootURI: unknown } }).extension.rootURI,
          Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS,
        );`),
    ],
    mustFail: [
      "substitution-reach",
      "substitution-lifetime",
      "exposure-allowed",
      "resource-product-files@web",
    ],
  },
  {
    id: "r6-reach-gap-load-packed-file",
    what: "resource://one-click-har/ with content access: its root loads nowhere, but its packed files load by <script> and <link>",
    edits: [
      {
        file: PARENT,
        from: WORKER_REGISTER,
        to: `      (resourceHandler() as unknown as { setSubstitutionWithFlags(n: string, u: unknown, f: number): void }).setSubstitutionWithFlags(
        WORKER_ROOT,
        this.extension.rootURI,
        Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS,
      );`,
      },
    ],
    mustFail: [
      "resource-product-files@web",
      "resource-product-files@file",
      "resource-product-files@ext-page",
      "substitution-reach",
    ],
  },
];

/** The baseline: the unplanted product must pass. */
const BASELINE = "baseline";
const BASELINE_PLANT: Plant = {
  id: BASELINE,
  what: "the product as it is",
  edits: [],
  mustFail: [],
};

type JudgedRun = {
  readonly ok: boolean;
  readonly rows: readonly {
    readonly id: string;
    readonly position: string;
    readonly ok: boolean;
    readonly verdict: string;
  }[];
  readonly checks: readonly { readonly id: string; readonly ok: boolean }[];
  readonly mismatches: readonly string[];
};

/** The failed rows (as `<probe>@<position>` and `<probe>@<position>=<verdict>`) and extra checks of one judgment. */
export function failedIds(judgment: JudgedRun): ReadonlySet<string> {
  return new Set([
    ...judgment.rows.flatMap((r) =>
      r.ok ? [] : [`${r.id}@${r.position}`, `${r.id}@${r.position}=${r.verdict}`],
    ),
    ...judgment.checks.filter((c) => !c.ok).map((c) => c.id),
    ...judgment.mismatches.filter((m) => m.startsWith("extra check ")),
  ]);
}

/** Whether a judgment is what the plant requires: green for the baseline, red on every paired row for a plant. */
export function asRequired(plant: Pick<Plant, "id" | "mustFail">, judgment: JudgedRun): boolean {
  const failed = failedIds(judgment);
  return plant.mustFail.length === 0
    ? judgment.ok
    : !judgment.ok && plant.mustFail.every((id) => failed.has(id));
}

/**
 * A run's check-results.json, or the gzipped, unindented copy the suite keeps in its place once it judged the run;
 * null when the run left neither. Three runs' disk evidence per check makes the indented file large.
 */
export function readCheckResults(runDir: string): unknown {
  const plain = NodePath.join(runDir, "check-results.json");
  const packed = `${plain}.gz`;
  if (NodeFS.existsSync(plain)) return JSON.parse(NodeFS.readFileSync(plain, "utf8"));
  if (NodeFS.existsSync(packed))
    return JSON.parse(NodeZlib.gunzipSync(NodeFS.readFileSync(packed)).toString("utf8"));
  return null;
}

/** Replaces a run's check-results.json with its gzipped, unindented copy. */
function packCheckResults(runDir: string, results: unknown): void {
  const plain = NodePath.join(runDir, "check-results.json");
  NodeFS.writeFileSync(`${plain}.gz`, NodeZlib.gzipSync(JSON.stringify(results)));
  NodeFS.rmSync(plain);
}

/** The isolation result recorded in a check-results.json, or null when the run left none. */
export function recordedIsolation(
  checkResults: unknown,
): { readonly detail: string; readonly data: Record<string, unknown> | null } | null {
  const result = (
    checkResults as { results?: { name: string; detail: string; data?: unknown }[] }
  ).results?.find((r) => r.name === "isolation");
  if (result === undefined) return null;
  return {
    detail: result.detail,
    data: (result.data as Record<string, unknown> | undefined) ?? null,
  };
}

function applyPlant(scratch: string, plant: Plant): () => void {
  const originals = new Map<string, string>();
  for (const edit of plant.edits) {
    const full = NodePath.join(scratch, edit.file);
    const text = originals.get(full) ?? NodeFS.readFileSync(full, "utf8");
    if (!originals.has(full)) originals.set(full, text);
    const current = NodeFS.readFileSync(full, "utf8");
    const count = current.split(edit.from).length - 1;
    if (count !== 1) throw new Error(`${plant.id}: ${edit.file} matched ${String(count)} times`);
    NodeFS.writeFileSync(full, current.replace(edit.from, edit.to));
  }
  const created = Object.entries(plant.files ?? {}).map(([file, body]) => {
    const full = NodePath.join(scratch, file);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, body);
    return full;
  });
  return () => {
    for (const [full, text] of originals) NodeFS.writeFileSync(full, text);
    for (const full of created) NodeFS.rmSync(full);
  };
}

function run(
  command: string,
  args: readonly string[],
  options: NodeChildProcess.SpawnSyncOptions,
): string {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", ...options });
  const output = `${String(result.stdout)}${String(result.stderr)}`;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}\n${output.slice(-3000)}`,
    );
  return output;
}

function coreLimitIsOneByte(): boolean {
  const limits = NodeFS.readFileSync("/proc/self/limits", "utf8");
  return /^Max core file size\s+1\s+1\s+bytes/mu.test(limits);
}

async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: {
      binary: { type: "string" },
      work: { type: "string" },
      only: { type: "string" },
      "skip-pack": { type: "boolean" },
    },
  });
  if (values.binary === undefined || values.work === undefined) {
    throw new Error(
      "usage: regressions.ts --binary <browser> --work <empty folder> [--only a,b] [--skip-pack]",
    );
  }
  if (!coreLimitIsOneByte()) {
    throw new Error(
      "run under `prlimit --core=1:1 --` so a crashing browser reaches no crash handler",
    );
  }
  const repo = NodePath.resolve(import.meta.dirname, "..", "..", "..", "..");
  const work = NodePath.resolve(values.work);
  const scratch = NodePath.join(work, "product");
  const only = values.only?.split(",") ?? null;
  const selected = [BASELINE_PLANT, ...PLANTS].filter((p) => only === null || only.includes(p.id));

  if (values["skip-pack"] !== true) {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
    NodeFS.cpSync(repo, scratch, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => {
        const rel = NodePath.relative(repo, source).split(NodePath.sep);
        return rel[0] !== ".git" && !(rel[0] === "apps" && rel[2] === "dist");
      },
    });
    const packed = selected.some((p) => p.harness === true)
      ? [...new Set([BASELINE_PLANT, ...selected.filter((p) => p.harness !== true)])]
      : selected;
    for (const plant of packed) {
      const restore = applyPlant(scratch, plant);
      try {
        process.stdout.write(`pack ${plant.id}\n`);
        // Build and pack without check-xpi: a plant may break the shipped-output rule, and this suite asks only
        // whether the isolation check sees it.
        run("pnpm", ["--filter", "@one-click-har/extension", "run", "build"], { cwd: scratch });
        run(process.execPath, ["scripts/pack.ts"], {
          cwd: NodePath.join(scratch, "apps", "extension"),
        });
        NodeFS.mkdirSync(NodePath.join(work, "xpi"), { recursive: true });
        NodeFS.copyFileSync(
          NodePath.join(scratch, "apps", "extension", "dist", "one-click-har-0.1.0.xpi"),
          NodePath.join(work, "xpi", `${plant.id}.xpi`),
        );
      } finally {
        restore();
      }
    }
  }

  const table: string[] = [
    "| Plant | Must turn red | Red in the run | Result |",
    "|---|---|---|---|",
  ];
  let failures = 0;
  for (const plant of selected) {
    const out = NodePath.join(work, "runs", plant.id);
    const tmp = NodePath.join(work, "tmp", plant.id);
    NodeFS.rmSync(out, { recursive: true, force: true });
    NodeFS.mkdirSync(tmp, { recursive: true });
    process.stdout.write(`check ${plant.id}\n`);
    const restoreProbes = plant.harness === true ? applyPlant(scratch, plant) : () => undefined;
    NodeChildProcess.spawnSync(
      "unshare",
      [
        "--user",
        "--map-root-user",
        "--pid",
        "--fork",
        "--mount-proc",
        "--",
        process.execPath,
        NodePath.join(scratch, "tools", "browser-harness", "src", "cli.ts"),
        "check",
        "--binary",
        values.binary,
        "--extension",
        NodePath.join(work, "xpi", `${plant.harness === true ? BASELINE : plant.id}.xpi`),
        "--check",
        "isolation",
        "--out-dir",
        out,
      ],
      { cwd: scratch, env: { ...process.env, TMPDIR: tmp }, stdio: "ignore" },
    );
    restoreProbes();
    NodeFS.rmSync(tmp, { recursive: true, force: true });
    const results = readCheckResults(out);
    const recorded = results === null ? null : recordedIsolation(results);
    if (results !== null) packCheckResults(out, results);
    const judgment = (recorded?.data?.["judgment"] as JudgedRun | undefined) ?? null;
    const outcome =
      judgment === null
        ? {
            ok: false,
            failed: new Set(["(no judgment)"]),
            summary: recorded?.detail ?? "no results file",
          }
        : {
            ok: judgment.ok,
            failed: failedIds(judgment),
            summary: recorded?.detail.slice(0, 200) ?? "",
          };
    const missed = plant.mustFail.filter((id) => !outcome.failed.has(id));
    const held = judgment !== null && asRequired(plant, judgment);
    if (!held) failures += 1;
    const red =
      [...outcome.failed].slice(0, 6).join(", ") +
      (outcome.failed.size > 6 ? `, +${String(outcome.failed.size - 6)}` : "");
    const verdict =
      plant.id === BASELINE
        ? held
          ? "green as required"
          : `RED: ${outcome.summary}`
        : held
          ? "red as required"
          : `MISSED ${missed.join(", ") || outcome.summary}`;
    table.push(
      `| ${plant.id} | ${plant.mustFail.join(", ") || "nothing"} | ${red || "none"} | ${verdict} |`,
    );
  }
  process.stdout.write(`${table.join("\n")}\n`);
  if (failures > 0) {
    process.stdout.write(
      `${String(failures)} of ${String(selected.length)} did not turn out as required\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
