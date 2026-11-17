import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DEFAULT_USER_SETTINGS } from "@one-click-har/recording/settings";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { judgeRow, type RowObservation, type RowOutcome } from "../src/export-judge.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  value,
  waitForJob,
} from "../src/export-session.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import { recordingWorkspace } from "../src/recording-session.ts";
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
  /** Files the row itself put in the folder: not the export's, and each must be left as it was. */
  readonly theirs?: readonly string[];
  readonly expect: (fileName: string) => RowOutcome;
};

const failed = (failure: string) => (): RowOutcome => ({ kind: "write-failed", failure });
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
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a regular file",
    fileName: "part-file",
    folder: (b) => dir(`${b}/part-file`),
    during: ({ part }) => replace(part, (p) => NodeFS.writeFileSync(p, "the attacker's own file")),
    expect: failed("file-replaced"),
  },
  {
    cause: "part replaced by a hard link to prefs.js",
    fileName: "part-hard-link",
    folder: (b) => dir(`${b}/part-hard-link`),
    during: ({ part, profile }) => replace(part, (p) => NodeFS.linkSync(`${profile}/prefs.js`, p)),
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
const launcher = (binary: string, mountAt: string | null, options: string | null): string => {
  const mountStep =
    mountAt === null || options === null
      ? ":"
      : `mount -t tmpfs -o ${options} one-click-har-row ${JSON.stringify(mountAt)}`;
  return `#!/bin/sh
exec unshare --user --map-root-user --mount -- /bin/sh -c '${mountStep} && exec unshare --user --map-user=${String(process.getuid?.())} --map-group=${String(process.getgid?.())} -- "$@"' sh ${JSON.stringify(binary)} "$@"
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

const AS_LEFT = "as the row left it";
/** A row's own file still holds what the row wrote, and its own link still points where the row pointed it. */
const leftAsItWas = (path: string): string => {
  const stat = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return "gone";
  if (stat.isSymbolicLink()) return NodeFS.readlinkSync(path) === NOWHERE ? AS_LEFT : "relinked";
  return NodeFS.readFileSync(path, "utf8") === THEIRS ? AS_LEFT : "rewritten";
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

async function runRow(
  context: CheckContext,
  row: Row,
  extensionPath: string,
): Promise<{ readonly problems: readonly string[]; readonly state: unknown }> {
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
  NodeFS.writeFileSync(binary, launcher(context.binaryPath, mountAt, row.mount?.options ?? null), {
    mode: 0o700,
  });
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
  const prefs = `${profile}/prefs.js`;
  const before = sha256(prefs);
  const place: Place = { base, folder, profile };
  let state: unknown;
  try {
    const job = await startExport(page, {
      selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName: row.fileName,
    });
    if (row.during !== undefined) {
      const writing = await waitForJob(
        page,
        job.id,
        (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= MIB),
      );
      if (writing.state.kind === "writing")
        row.during({ ...place, part: `${folder}/${row.fileName}.har.part` });
    }
    state = (await waitForJob(page, job.id, ended)).state;
  } finally {
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
  const theirs = row.theirs ?? [];
  const named = (path: string): readonly string[] =>
    (listed[path] ?? []).filter((name) => name.startsWith(row.fileName) && !theirs.includes(name));
  const observation: RowObservation = {
    expect: row.expect(row.fileName),
    state,
    served,
    paths: [profile, folder, workspace.dataHome, base],
    files: [...named(folder), ...named(profile)],
    untouched: [
      { path: "prefs.js", before, after: sha256(prefs) },
      ...theirs.map((name) => ({
        path: name,
        before: AS_LEFT,
        after: leftAsItWas(`${folder}/${name}`),
      })),
    ],
  };
  return { problems: judgeRow(observation), state };
}

/**
 * Every cause in ROWS, made to happen for real on the browser, ends as its row says: its named kind and no file, or
 * done under the name it says. No path reaches the page, prefs.js is unchanged and the row's own files are as it left
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
      seen.push(
        `${row.cause}: ${state.kind === "done" ? `done as ${String(state.fileName)}` : JSON.stringify(state.failure ?? state)}`,
      );
    }
    const planted = judgeRow({
      expect: { kind: "write-failed", failure: "access-denied" },
      state: { kind: "write-failed", failure: { kind: "other", detail: "/w/out/x.har.part" } },
      served: '{"detail":"/w/out/x.har.part"}',
      paths: ["/w/out"],
      files: [],
      untouched: [],
    });
    if (planted.length < 3)
      problems.push(`planted detail with a path caught only as ${JSON.stringify(planted)}`);
    return finish(problems, `${seen.join("; ")}; planted detail with a path caught`, seen);
  },
};

/** @discovered-check */
export default check;
