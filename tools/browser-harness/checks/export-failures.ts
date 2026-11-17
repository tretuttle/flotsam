import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DEFAULT_USER_SETTINGS } from "@one-click-har/recording/settings";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
} from "../src/browser.ts";
import {
  judgeNextStart,
  judgeRow,
  type RowObservation,
  type RowOutcome,
} from "../src/export-judge.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  value,
  waitForJob,
} from "../src/export-session.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "export-failures";
const MIB = 1_048_576;
/** What a row's own file holds, and where a row's own link points. */
const THEIRS = "theirs";
const NOWHERE = "/nonexistent";

type Place = { readonly base: string; readonly folder: string; readonly profile: string };

type Row = {
  readonly cause: string;
  readonly fileName: string;
  /** The folder settings.json names, made in the state this cause needs. */
  readonly folder: (base: string, profile: string) => string;
  /** A tmpfs mounted inside the browser's mount namespace, over the folder or one above it. */
  readonly mount?: { readonly options: string; readonly at?: (base: string) => string };
  /** Done once the export has written its first MiB. */
  readonly during?: (at: Place & { readonly part: string }) => void;
  readonly after?: (at: Place) => void;
  /** What the row itself put in the folder, before or during the export: not the export's, each left as it was. */
  readonly theirs?: readonly string[];
  /** The export's first call on its part after its first MiB, held by hold-part-call.c while the row acts. */
  readonly hold?: Hold;
  readonly expect: (fileName: string) => RowOutcome;
};

type Hold = {
  readonly act: (at: Place & { readonly part: string }) => void;
  /** Cancel while the call is held, and let it go once the export has ended. */
  readonly cancel?: true;
  /** Let the call go only once the export has ended. */
  readonly keep?: true;
  /** How long the export may take to end: from the release, or from the cancel or the hold when it is kept. */
  readonly withinMs: number;
};

const failed = (failure: string) => (): RowOutcome => ({ kind: "write-failed", failure });
const cancelled = (): RowOutcome => ({ kind: "cancelled" });
/** The product's time limit for one export file call (EXPORT_STEP_MS in host.ts). */
const STEP_MS = 15_000;
/** How long an export may take to end once nothing holds it. */
const PROMPTLY_MS = 5_000;
const doneAs =
  (suffix: string) =>
  (fileName: string): RowOutcome => ({ kind: "done", fileName: `${fileName}${suffix}.har` });
const dir = (path: string): string => {
  NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
};
const locked = (path: string): string => {
  NodeFS.chmodSync(dir(path), 0o500);
  return path;
};
const replace = (part: string, make: (path: string) => void): void => {
  NodeFS.rmSync(part);
  make(part);
};
const mkfifo = (path: string): void => {
  const made = NodeChildProcess.spawnSync("mkfifo", ["-m", "600", path], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`mkfifo: ${made.stderr}`);
};

/**
 * One row per cause, each made to happen for real. Every name in FS_ERROR_KINDS is produced by a row here; `other`
 * is the kind for an error the table does not name, and no row may end as it.
 */
const ROWS: readonly Row[] = [
  {
    cause: "read-only mount",
    fileName: "ro-mount",
    folder: (b) => dir(`${b}/ro`),
    mount: { options: "ro,size=1m" },
    expect: failed("read-only"),
  },
  {
    cause: "folder to create on a read-only mount",
    fileName: "ro-create",
    folder: (b) => `${dir(`${b}/ro-parent`)}/below`,
    mount: { options: "ro,size=1m", at: (b) => `${b}/ro-parent` },
    expect: failed("read-only"),
  },
  {
    cause: "folder is a file",
    fileName: "is-file",
    folder: (b) => {
      NodeFS.writeFileSync(`${b}/afile`, "not a folder");
      return `${b}/afile`;
    },
    expect: failed("not-a-folder"),
  },
  {
    cause: "folder missing at start",
    fileName: "missing",
    folder: (b) => `${b}/missing/below`,
    expect: doneAs(""),
  },
  {
    cause: "folder deleted mid-export",
    fileName: "deleted",
    folder: (b) => dir(`${b}/deleted`),
    during: ({ folder }) => NodeFS.rmSync(folder, { recursive: true, force: true }),
    expect: failed("folder-missing"),
  },
  {
    cause: "no permission",
    fileName: "no-permission",
    folder: (b) => locked(`${b}/no-permission`),
    after: ({ folder }) => NodeFS.chmodSync(folder, 0o700),
    expect: failed("access-denied"),
  },
  {
    cause: "folder to create where this user may not write",
    fileName: "no-permission-create",
    folder: (b) => `${locked(`${b}/locked-parent`)}/below`,
    after: ({ base }) => NodeFS.chmodSync(`${base}/locked-parent`, 0o700),
    expect: failed("access-denied"),
  },
  {
    cause: "part made read-only mid-export (its open handle keeps writing)",
    fileName: "part-read-only",
    folder: (b) => dir(`${b}/part-read-only`),
    during: ({ part }) => NodeFS.chmodSync(part, 0o400),
    expect: doneAs(""),
  },
  {
    cause: "full disk",
    fileName: "full",
    folder: (b) => dir(`${b}/full`),
    mount: { options: "size=8m" },
    expect: failed("disk-full"),
  },
  {
    cause: "part names taken by a stale part and a dangling link",
    fileName: "part-taken",
    folder: (b) => {
      const folder = dir(`${b}/part-taken`);
      NodeFS.writeFileSync(`${folder}/part-taken.har.part`, THEIRS);
      NodeFS.symlinkSync(NOWHERE, `${folder}/part-taken (2).har.part`);
      return folder;
    },
    theirs: ["part-taken.har.part", "part-taken (2).har.part"],
    expect: doneAs(""),
  },
  {
    cause: "name collision at the rename",
    fileName: "collision",
    folder: (b) => dir(`${b}/collision`),
    during: ({ folder }) => NodeFS.writeFileSync(`${folder}/collision.har`, THEIRS),
    theirs: ["collision.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "folder is a link to the profile",
    fileName: "linked-folder",
    folder: (b, profile) => {
      NodeFS.symlinkSync(profile, `${b}/linked`);
      return `${b}/linked`;
    },
    expect: failed("folder-refused"),
  },
  {
    cause: "part replaced by a link to prefs.js",
    fileName: "part-link",
    folder: (b) => dir(`${b}/part-link`),
    during: ({ part, profile }) =>
      replace(part, (p) => NodeFS.symlinkSync(`${profile}/prefs.js`, p)),
    theirs: ["part-link.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a regular file",
    fileName: "part-file",
    folder: (b) => dir(`${b}/part-file`),
    during: ({ part }) => replace(part, (p) => NodeFS.writeFileSync(p, "the attacker's own file")),
    theirs: ["part-file.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a hard link to prefs.js",
    fileName: "part-hard-link",
    folder: (b) => dir(`${b}/part-hard-link`),
    during: ({ part, profile }) => replace(part, (p) => NodeFS.linkSync(`${profile}/prefs.js`, p)),
    theirs: ["part-hard-link.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause:
      "part replaced by a regular file with its first 4 KiB (the export's id) and another size",
    fileName: "part-same-head",
    folder: (b) => dir(`${b}/part-same-head`),
    during: ({ part }) => {
      const head = NodeFS.readFileSync(part).subarray(0, 4096);
      replace(part, (p) => NodeFS.writeFileSync(p, head));
    },
    theirs: ["part-same-head.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "part's first bytes overwritten in place (same file, same size)",
    fileName: "part-overwritten",
    folder: (b) => dir(`${b}/part-overwritten`),
    during: ({ part }) => {
      const fd = NodeFS.openSync(part, "r+");
      try {
        NodeFS.writeSync(fd, Buffer.from(" ".repeat(32)), 0, 32, 0);
      } finally {
        NodeFS.closeSync(fd);
      }
    },
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a folder",
    fileName: "part-folder",
    folder: (b) => dir(`${b}/part-folder`),
    during: ({ part }) => replace(part, (p) => NodeFS.mkdirSync(p)),
    theirs: ["part-folder.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a FIFO (never opened)",
    fileName: "part-fifo",
    folder: (b) => dir(`${b}/part-fifo`),
    during: ({ part }) => replace(part, mkfifo),
    theirs: ["part-fifo.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "a FIFO takes the part's name while the rename waits (put back, never opened)",
    fileName: "held-fifo",
    folder: (b) => dir(`${b}/held-fifo`),
    hold: { act: ({ part }) => replace(part, mkfifo), withinMs: PROMPTLY_MS },
    theirs: ["held-fifo.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "cancel while the rename waits, a FIFO at the part's name",
    fileName: "held-cancel",
    folder: (b) => dir(`${b}/held-cancel`),
    hold: { act: ({ part }) => replace(part, mkfifo), cancel: true, withinMs: PROMPTLY_MS },
    theirs: ["held-cancel.har.part"],
    expect: cancelled,
  },
  {
    cause: "the rename still waiting at the step limit (the late rename cleaned up)",
    fileName: "held-late",
    folder: (b) => dir(`${b}/held-late`),
    hold: { act: () => undefined, keep: true, withinMs: STEP_MS + PROMPTLY_MS },
    expect: failed("timed-out"),
  },
  {
    cause: "folder replaced by a link to the profile while the rename waits",
    fileName: "held-folder-link",
    folder: (b) => dir(`${b}/held-folder-link`),
    hold: {
      act: ({ base, folder, profile }) => {
        NodeFS.renameSync(folder, `${base}/held-folder-moved`);
        NodeFS.symlinkSync(profile, folder);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-refused"),
  },
  {
    cause: "folder deleted while the rename waits",
    fileName: "held-folder-gone",
    folder: (b) => dir(`${b}/held-folder-gone`),
    hold: {
      act: ({ folder }) => NodeFS.rmSync(folder, { recursive: true, force: true }),
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-missing"),
  },
  {
    cause: "part deleted while the rename waits",
    fileName: "held-part-gone",
    folder: (b) => dir(`${b}/held-part-gone`),
    hold: { act: ({ part }) => NodeFS.rmSync(part), withinMs: PROMPTLY_MS },
    expect: failed("file-replaced"),
  },
  {
    cause: "name too long",
    fileName: "n".repeat(300),
    folder: (b) => dir(`${b}/long`),
    expect: failed("name-too-long"),
  },
];

/**
 * The browser in its own user and mount namespace: root there to mount the row's tmpfs, then this user again in a
 * nested namespace, so file permissions apply to it as they do to the user. Every step execs, so the process the
 * harness started and stops is the browser itself.
 */
const launcher = (
  binary: string,
  mountAt: string | null,
  options: string | null,
  hold: { readonly library: string; readonly dir: string } | null,
): string => {
  const mountStep =
    mountAt === null || options === null
      ? ":"
      : `mount -t tmpfs -o ${options} one-click-har-row ${JSON.stringify(mountAt)}`;
  const preload =
    hold === null
      ? ""
      : `export LD_PRELOAD=${JSON.stringify(hold.library)} OCH_HOLD_DIR=${JSON.stringify(hold.dir)}\n`;
  return `#!/bin/sh
${preload}exec unshare --user --map-root-user --mount -- /bin/sh -c '${mountStep} && exec unshare --user --map-user=${String(process.getuid?.())} --map-group=${String(process.getgid?.())} -- "$@"' sh ${JSON.stringify(binary)} "$@"
`;
};

/** Names in each folder as the browser sees it, inside its mount namespace; null for a path that is not a folder. */
const LIST = `const done = arguments[arguments.length - 1];
(async () => {
  const listed = {};
  for (const path of arguments[0]) {
    try { listed[path] = (await IOUtils.getChildren(path)).map((child) => PathUtils.filename(child)); }
    catch { listed[path] = null; }
  }
  done(listed);
})();`;

const sha256 = (path: string): string =>
  NodeFS.existsSync(path)
    ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex")
    : "absent";

/** Every export file opens with this, the document's start and its random id. */
const EXPORT_OPENING = '{"log":{"_harExportId"';

/**
 * Whether a file holds any of an export's bytes. The browser rewrites prefs.js itself during a long row, so prefs.js is
 * judged by this rather than by its hash: no export byte may reach it.
 */
const exportBytesIn = (path: string): string =>
  !NodeFS.existsSync(path)
    ? "absent"
    : NodeFS.readFileSync(path).includes(EXPORT_OPENING)
      ? "holds export bytes"
      : "no export bytes";

/** What is at a path, never following a link there: a file by its hash, a link by its target. */
const fingerprint = (path: string): string => {
  const stat = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return "absent";
  if (stat.isSymbolicLink()) return `link to ${NodeFS.readlinkSync(path)}`;
  if (stat.isFIFO()) return "fifo";
  if (stat.isDirectory()) return "folder";
  return stat.isFile() ? `file ${sha256(path)}` : "other";
};

/** Every non-folder entry under `root`, by path, except in the folders the browser itself owns. */
const filesUnder = (root: string, skip: readonly string[]): Map<string, string> => {
  const found = new Map<string, string>();
  const walk = (folder: string): void => {
    for (const entry of NodeFS.readdirSync(folder, { withFileTypes: true })) {
      const path = NodePath.join(folder, entry.name);
      if (skip.includes(path)) continue;
      if (entry.isDirectory()) walk(path);
      else found.set(path, fingerprint(path));
    }
  };
  walk(root);
  return found;
};

const namespacesRefused = (): string | null => {
  const probe = NodeChildProcess.spawnSync(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "unshare",
      "--user",
      `--map-user=${String(process.getuid?.())}`,
      "true",
    ],
    { encoding: "utf8" },
  );
  return probe.status === 0 ? null : (probe.stderr || String(probe.error)).trim();
};

const HOLD_SOURCE = NodePath.join(import.meta.dirname, "..", "native", "hold-part-call.c");

/** Builds hold-part-call.c into `folder`; the error text when no C compiler can. */
const buildHold = (folder: string): string | { readonly error: string } => {
  const library = NodePath.join(folder, "hold-part-call.so");
  const built = NodeChildProcess.spawnSync(
    "cc",
    ["-shared", "-fPIC", "-O2", "-o", library, HOLD_SOURCE, "-ldl"],
    { encoding: "utf8" },
  );
  return built.status === 0 ? library : { error: (built.stderr || String(built.error)).trim() };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wakes any reader waiting on a FIFO under `root` by opening it for writing, without waiting, and closing it. */
const wakeFifoReaders = (root: string): void => {
  for (const [path, print] of filesUnder(root, []))
    if (print === "fifo")
      try {
        NodeFS.closeSync(
          NodeFS.openSync(path, NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK),
        );
      } catch {
        // No reader is waiting.
      }
};

async function runRow(
  context: CheckContext,
  row: Row,
  extensionPath: string,
): Promise<{
  readonly problems: readonly string[];
  readonly state: unknown;
  readonly timing: RowObservation["timing"];
}> {
  await using server = await startFixtureServer();
  await using workspace = recordingWorkspace("export-failures");
  const base = NodePath.dirname(workspace.downloads);
  const profile = workspace.profileDir;
  const folder = row.folder(base, profile);
  workspace.seed(NodeCrypto.randomBytes(16).toString("hex"), {
    user: DEFAULT_USER_SETTINGS,
    exportFolder: { kind: "chosen", path: folder, label: "Export" },
  });
  const binary = NodePath.join(base, "browser-in-namespace.sh");
  const mountAt = row.mount === undefined ? null : (row.mount.at?.(base) ?? folder);
  const holdDir = row.hold === undefined ? null : dir(NodePath.join(base, "hold"));
  const library = holdDir === null ? null : buildHold(base);
  if (typeof library === "object" && library !== null)
    return {
      problems: [`no C compiler for hold-part-call.c: ${library.error}`],
      state: null,
      timing: null,
    };
  NodeFS.writeFileSync(
    binary,
    launcher(
      context.binaryPath,
      mountAt,
      row.mount?.options ?? null,
      holdDir === null || library === null ? null : { library, dir: holdDir },
    ),
    { mode: 0o700 },
  );
  const theirs = (row.theirs ?? []).map((name) => NodePath.join(folder, name));
  /** Every file there before the export, then what the row put in place: none may change, now or at the next start. */
  const kept = filesUnder(base, [profile, workspace.dataHome]);
  const theirsBefore = theirs.filter((path) => fingerprint(path) !== "absent");
  const prefs = `${profile}/prefs.js`;
  const place: Place = { base, folder, profile };
  let state: unknown;
  let timing: RowObservation["timing"] = null;
  let journal = "";
  const holdProblems: string[] = [];
  let observation: RowObservation;
  {
    await using session = await workspace.launch({
      binaryPath: binary,
      extensionPath,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
    });
    const page = await openExtensionPage(session, extensionPath);
    const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
    await session.evaluate(tab, "window.__harnessReady");
    const tabId = await newestPageTab(page);
    const before = exportBytesIn(prefs);
    try {
      const job = await startExport(page, {
        selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
        bodies: "include",
        redaction: "standard",
        packaging: "har",
        fileName: row.fileName,
      });
      const part = `${folder}/${row.fileName}.har.part`;
      if (row.during !== undefined || row.hold !== undefined) {
        const writing = await waitForJob(
          page,
          job.id,
          (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= MIB),
        );
        if (writing.state.kind === "writing") row.during?.({ ...place, part });
        if (writing.state.kind === "writing" && row.hold !== undefined && holdDir !== null) {
          const held = await holdAndAct(page, job.id, holdDir, row.hold, { ...place, part });
          timing = held.timing;
          state = held.state;
          holdProblems.push(...held.problems);
        }
      }
      for (const path of theirs) if (!kept.has(path)) kept.set(path, fingerprint(path));
      // A held row's export that never ended is judged as it is, so the next rows still run.
      if (state === undefined || ended({ state } as Parameters<typeof ended>[0]))
        state = (await waitForJob(page, job.id, ended)).state;
      journal = await journalSettled(NodePath.join(workspace.root(), "exports.jsonl"));
    } finally {
      if (holdDir !== null) NodeFS.writeFileSync(NodePath.join(holdDir, "go"), "");
      wakeFifoReaders(base);
      row.after?.(place);
    }
    const served = JSON.stringify({
      state,
      list: await value(page, "browser.oneClickHar.listExports()"),
      popup: await value(page, `browser.oneClickHar.getPopup({ tabId: ${String(tabId)} })`),
    });
    const listed = (await session.evaluateChrome(LIST, [[folder, profile]])) as Record<
      string,
      readonly string[] | null
    >;
    const named = (path: string): readonly string[] =>
      (listed[path] ?? []).filter(
        (name) => name.startsWith(row.fileName) && !theirs.includes(NodePath.join(folder, name)),
      );
    observation = {
      expect: row.expect(row.fileName),
      state,
      served,
      paths: [profile, folder, workspace.dataHome, base],
      files: [...named(folder), ...named(profile)],
      untouched: [
        { path: "prefs.js", before, after: exportBytesIn(prefs) },
        ...[...kept].map(([path, was]) => ({ path, before: was, after: fingerprint(path) })),
      ],
      journal,
      theirs: theirsBefore,
      timing,
    };
  }
  // The next start, which reads the journal and deletes what it can prove an unfinished export left.
  {
    await using session = await workspace.launch({
      binaryPath: context.binaryPath,
      extensionPath: null,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
    });
    await waitForActiveExtensionUrl(
      session,
      await readExtensionId(extensionPath),
      await readExtensionPopupPath(extensionPath),
    );
    await callHook(session, { kind: "recovery" });
  }
  const afterNextStart = judgeNextStart(
    [...kept].map(([path, was]) => ({ path, before: was, after: fingerprint(path) })),
  );
  return {
    problems: [...holdProblems, ...judgeRow(observation), ...afterNextStart],
    state,
    timing,
  };
}

/** Arms the hold, waits for the export's held call, acts, and times how long the export then takes to end. */
async function holdAndAct(
  page: Parameters<typeof waitForJob>[0],
  id: string,
  holdDir: string,
  hold: Hold,
  at: Place & { readonly part: string },
): Promise<{
  readonly timing: RowObservation["timing"];
  readonly problems: readonly string[];
  readonly state: unknown;
}> {
  const reached = NodePath.join(holdDir, "at");
  const go = (): void => NodeFS.writeFileSync(NodePath.join(holdDir, "go"), "");
  NodeFS.writeFileSync(NodePath.join(holdDir, "arm"), "");
  const reachBy = Date.now() + 60_000;
  while (!NodeFS.existsSync(reached)) {
    const job = await waitForJob(page, id, () => true);
    if (ended(job) || Date.now() > reachBy)
      return {
        timing: null,
        problems: [`the held call was never reached: ${JSON.stringify(job.state)}`],
        state: job.state,
      };
    await sleep(20);
  }
  hold.act(at);
  if (hold.cancel === true)
    await value(page, `browser.oneClickHar.cancelExport(${JSON.stringify(id)}).then(String)`);
  else if (hold.keep !== true) go();
  const from = Date.now();
  const endBy = from + hold.withinMs + 30_000;
  let job = await waitForJob(page, id, () => true);
  while (!ended(job) && Date.now() < endBy) {
    await sleep(50);
    job = await waitForJob(page, id, () => true);
  }
  const timing = { tookMs: Date.now() - from, withinMs: hold.withinMs };
  go();
  const held = NodeFS.readFileSync(reached, "utf8").trim().split(" ")[0];
  return {
    timing,
    problems: held === "rename" ? [] : [`the held call was ${String(held)}, not the rename`],
    state: job.state,
  };
}

/**
 * The journal once every started line is ended, or as it is after 10 s: cleanup may finish after the job does. Read
 * before any FIFO reader is woken, so a read stuck on one shows as an open line.
 */
async function journalSettled(journal: string): Promise<string> {
  const by = Date.now() + 10_000;
  for (;;) {
    const text = NodeFS.existsSync(journal) ? NodeFS.readFileSync(journal, "utf8") : "";
    const started = (text.match(/"started"/g) ?? []).length;
    const endedLines = (text.match(/"ended"/g) ?? []).length;
    if (started <= endedLines || Date.now() > by) return text;
    await sleep(100);
  }
}

/**
 * Every cause in ROWS, made to happen for real on the browser, ends as its row says: its named kind and no file, or
 * done under the name it says. No path reaches the page, prefs.js holds no export byte and the row's own files are as it left
 * them. Planted: the first version's `{ kind: "other", detail }` with a path must fail the same judge.
 */
const check: HarnessCheck = {
  name: NAME,
  description:
    "each export failure cause, caused for real, ends as its named kind with no path served",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const finish = (problems: readonly string[], detail: string, data?: unknown): CheckResult => ({
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? detail : problems.join("; "),
      data,
    });
    if (context.extensionPath === null) return finish(["needs --extension"], "");
    const refused = namespacesRefused();
    if (refused !== null) {
      if (process.env.CI)
        return finish([`a user and mount namespace is needed and was refused: ${refused}`], "");
      return finish([], `skipped: this machine refused a user and mount namespace (${refused})`);
    }
    const problems: string[] = [];
    const seen: string[] = [];
    for (const row of ROWS) {
      const outcome = await runRow(context, row, context.extensionPath);
      problems.push(...outcome.problems.map((p) => `${row.cause}: ${p}`));
      const state = outcome.state as { kind?: string; fileName?: string; failure?: unknown };
      const took =
        outcome.timing === null
          ? ""
          : ` (ended ${String(outcome.timing.tookMs)} ms after the row let it go)`;
      seen.push(
        `${row.cause}: ${state.kind === "done" ? `done as ${String(state.fileName)}` : JSON.stringify(state.failure ?? state)}${took}`,
      );
    }
    const planted = judgeRow({
      expect: { kind: "write-failed", failure: "access-denied" },
      state: { kind: "write-failed", failure: { kind: "other", detail: "/w/out/x.har.part" } },
      served: '{"detail":"/w/out/x.har.part"}',
      paths: ["/w/out"],
      files: [],
      untouched: [],
      journal: '{"started":"/w/out/theirs.har.part","head":"{"}\n',
      theirs: ["/w/out/theirs.har.part"],
      timing: { tookMs: 15_020, withinMs: PROMPTLY_MS },
    });
    if (planted.length < 6)
      problems.push(
        `planted detail and open journal line caught only as ${JSON.stringify(planted)}`,
      );
    return finish(
      problems,
      `${seen.join("; ")}; planted detail with a path and a journal line naming the row's file caught`,
      seen,
    );
  },
};

/** @discovered-check */
export default check;
