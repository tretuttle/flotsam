import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

// Planted product regressions for the isolation check. Each plant edits a scratch copy of the product, the repo's
// own pack builds it, and the unmodified isolation check must turn the paired rows or checks red. The first nine
// came from the verifier of PR 18 (verify/pr-18.md section 3), the last three were added with the judge rewrite.
// The check runs from the scratch copy, so the harness judged is the one copied at the start of the run.

/** An exact edit: `from` must occur exactly once in the file. */
type Edit = { readonly file: string; readonly from: string; readonly to: string };

export type Plant = {
  readonly id: string;
  readonly what: string;
  readonly edits: readonly Edit[];
  readonly files?: Readonly<Record<string, string>>;
  /** Rows as `<probe>@<position>` and extra checks by id: each must fail. */
  readonly mustFail: readonly string[];
};

const FILES = "apps/extension/experiment/files.ts";
const STORE = "apps/extension/experiment/store.ts";
const PARENT = "apps/extension/experiment/parent.ts";
const MANIFEST = "apps/extension/src/manifest.json";
const MANIFEST_ANCHOR = '  "experiment_apis": {';
const KEY_LINE = "const key = archiveKeyFromBytes(randomBytes(ARCHIVE_KEY_BYTES));";
const MODES_LINE = "const modes: Modes = { dir: row.dirMode, file: row.fileMode };";
const STEPS_LINE = "  let steps: readonly ReconcileStep[] = [];";
const APPEND_LINE =
  "      await ensureDir(dirOf(logSegmentPath(segment.id)));\n      await appendText(segment.path, text, modes);";

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
    mustFail: ["mozext-parent@web", "mozext-every-file@web", "exposure-declared"],
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
    mustFail: ["api-namespace@web", "api-namespace@cs-web", "exposure-declared"],
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
    mustFail: ["connect-recorder@ext-bg", "exposure-declared"],
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
    mustFail: ["inventory-exists@file", "nothing-outside-key-folder"],
  },
  {
    id: "resource-sub",
    what: "the product maps resource://one-click-har/ to the archive with ALLOW_CONTENT_ACCESS",
    edits: [
      {
        file: PARENT,
        from: STEPS_LINE,
        to: `  {
    const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(archive.root);
    res.setSubstitutionWithFlags("one-click-har", Services.io.newFileURI(f), Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);
  }
${STEPS_LINE}`,
      },
    ],
    mustFail: [
      "resource-all@file",
      "no-scheme-into-profile-or-data-home",
      "no-registration-in-packed-scripts",
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
    mustFail: ["sendmessage-recorder@ext-bg", "exposure-declared"],
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
    mustFail: ["inventory-exists@file", "nothing-outside-key-folder", "key-names-the-archive"],
  },
];

/** The baseline: the unplanted product must pass. */
const BASELINE = "baseline";

type JudgedRun = {
  readonly ok: boolean;
  readonly rows: readonly {
    readonly id: string;
    readonly position: string;
    readonly ok: boolean;
  }[];
  readonly checks: readonly { readonly id: string; readonly ok: boolean }[];
  readonly mismatches: readonly string[];
};

/** The failed rows (`<probe>@<position>`) and extra checks (`<id>`) of one judgment. */
export function failedIds(judgment: JudgedRun): ReadonlySet<string> {
  return new Set([
    ...judgment.rows.filter((r) => !r.ok).map((r) => `${r.id}@${r.position}`),
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
  const selected = [
    { id: BASELINE, what: "the product as it is", edits: [], mustFail: [] } satisfies Plant,
    ...PLANTS,
  ].filter((p) => only === null || only.includes(p.id));

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
    for (const plant of selected) {
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
        NodePath.join(work, "xpi", `${plant.id}.xpi`),
        "--check",
        "isolation",
        "--out-dir",
        out,
      ],
      { cwd: scratch, env: { ...process.env, TMPDIR: tmp }, stdio: "ignore" },
    );
    NodeFS.rmSync(tmp, { recursive: true, force: true });
    const resultsFile = NodePath.join(out, "check-results.json");
    const recorded = NodeFS.existsSync(resultsFile)
      ? recordedIsolation(JSON.parse(NodeFS.readFileSync(resultsFile, "utf8")))
      : null;
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
