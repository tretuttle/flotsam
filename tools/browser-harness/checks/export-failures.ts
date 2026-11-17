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
/** host.ts reads it only in a harness profile: exports name a `.har.part`, as where no folder can be held. */
const NAMED_PARTS_PREF = "extensions.oneClickHar.harness.namedParts";

type Place = { readonly base: string; readonly folder: string; readonly profile: string };
/** What a row acts on mid-export: the part's path (named parts only) and the browser's own process. */
type During = Place & { readonly part: string; readonly name: string; readonly pid: number };

type Row = {
  readonly cause: string;
  readonly fileName: string;
  /** The folder settings.json names, made in the state this cause needs. */
  readonly folder: (base: string, profile: string) => string;
  /** A tmpfs mounted inside the browser's mount namespace, over the folder or one above it. */
  readonly mount?: { readonly options: string; readonly at?: (base: string) => string };
  /** Done once the export has written its first MiB. */
  readonly during?: (at: During) => void;
  readonly after?: (at: Place) => void;
  /** What the row itself put in the folder, before or during the export: not the export's, each left as it was. */
  readonly theirs?: readonly string[];
  /** Named parts: the export's rename of its part, held by hold-part-call.c (armed before the export starts). */
  readonly hold?: Hold;
  /** An unnamed file: the export held at a pause through the harness topic (armed before the export starts). */
  readonly pause?: Hold & { readonly at: "before-link" | "after-link" };
  /** The export names a `.har.part` and renames it, as where no folder can be held (the harness-only pref). */
  readonly named?: true;
  readonly expect: (fileName: string) => RowOutcome;
};

type Hold = {
  /** Changes the files while the call is held, and returns whether the change is in place, checked before the release. */
  readonly act: (at: During) => () => boolean;
  /** Cancel while the call is held, and let it go once the export has ended. */
  readonly cancel?: true;
  /** Let the call go only once the export has ended. */
  readonly keep?: true;
  /** How long the export may take to end: from the release, or from the cancel or the hold when it is kept. */
  readonly withinMs: number;
};

const failed = (failure: string) => (): RowOutcome => ({ kind: "write-failed", failure });
/** A failure found after the link named the export's own file, which stays under `suffix`. */
const failedKeeping =
  (failure: string, suffix = "") =>
  (fileName: string): RowOutcome => ({
    kind: "write-failed",
    failure,
    kept: `${fileName}${suffix}.har`,
  });
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
const lstat = (path: string): NodeFS.Stats | undefined =>
  NodeFS.lstatSync(path, { throwIfNoEntry: false });
const absent = (path: string) => (): boolean => lstat(path) === undefined;
const isFifo = (path: string) => (): boolean => lstat(path)?.isFIFO() === true;
/** The folder moved to `<base>/<moved>` and a link to the profile put in its place. */
const folderToProfile = ({ base, folder, profile }: Place, moved: string): string => {
  NodeFS.renameSync(folder, `${base}/${moved}`);
  NodeFS.symlinkSync(profile, folder);
  return `${base}/${moved}`;
};
/** The folder moved to `<base>/<moved>`, a link to the profile put in its place, then the folder put back. */
const folderSwappedAndBack = (at: Place, moved: string): void => {
  folderToProfile(at, moved);
  NodeFS.unlinkSync(at.folder);
  NodeFS.renameSync(`${at.base}/${moved}`, at.folder);
};
/** The descriptors of the browser's unnamed files in `folder`: what /proc names `<folder>/#<inode> (deleted)`. */
const unnamedIn = (pid: number, folder: string): readonly string[] =>
  NodeFS.readdirSync(`/proc/${String(pid)}/fd`)
    .map((fd) => `/proc/${String(pid)}/fd/${fd}`)
    .filter((path) => {
      try {
        const target = NodeFS.readlinkSync(path);
        return target.startsWith(`${folder}/#`) && target.endsWith(" (deleted)");
      } catch {
        return false;
      }
    });
const mkfifo = (path: string): void => {
  const made = NodeChildProcess.spawnSync("mkfifo", ["-m", "600", path], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`mkfifo: ${made.stderr}`);
};

/**
 * The same causes where the export names a `.har.part` (Windows, macOS, a Linux file system with no unnamed files),
 * forced by the harness-only pref. Every name in FS_ERROR_KINDS is produced by a row in one of the two tables; `other`
 * is the kind for an error the table does not name, and no row may end as it.
 */
const NAMED_ROWS: readonly Row[] = [
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
    hold: {
      act: ({ part }) => {
        replace(part, mkfifo);
        return isFifo(part);
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["held-fifo.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "cancel while the rename waits, a FIFO at the part's name",
    fileName: "held-cancel",
    folder: (b) => dir(`${b}/held-cancel`),
    hold: {
      act: ({ part }) => {
        replace(part, mkfifo);
        return isFifo(part);
      },
      cancel: true,
      withinMs: PROMPTLY_MS,
    },
    theirs: ["held-cancel.har.part"],
    expect: cancelled,
  },
  {
    cause: "the rename still waiting at the step limit (the late rename cleaned up)",
    fileName: "held-late",
    folder: (b) => dir(`${b}/held-late`),
    hold: { act: () => () => true, keep: true, withinMs: STEP_MS + PROMPTLY_MS },
    expect: failed("timed-out"),
  },
  {
    cause:
      "a copy of the part, its size and bytes at another inode, takes its name while the rename waits (put back)",
    fileName: "held-copy",
    folder: (b) => dir(`${b}/held-copy`),
    hold: {
      act: ({ base, part }) => {
        const own = lstat(part)?.ino;
        NodeFS.copyFileSync(part, `${base}/held-copy.tmp`);
        NodeFS.renameSync(`${base}/held-copy.tmp`, part);
        return () => lstat(part)?.isFile() === true && lstat(part)?.ino !== own;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["held-copy.har.part"],
    expect: failed("file-replaced"),
  },
  {
    cause: "folder replaced by a link to the profile while the rename waits",
    fileName: "held-folder-link",
    folder: (b) => dir(`${b}/held-folder-link`),
    hold: {
      act: (at) => {
        folderToProfile(at, "held-folder-moved");
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-refused"),
  },
  {
    cause:
      "folder replaced by a link to the profile while the rename waits, the part hard-linked there under its name",
    fileName: "held-folder-plant",
    folder: (b) => dir(`${b}/held-folder-plant`),
    hold: {
      act: (at) => {
        const moved = folderToProfile(at, "held-plant-moved");
        const name = NodePath.basename(at.part);
        NodeFS.linkSync(`${moved}/${name}`, `${at.profile}/${name}`);
        return () =>
          lstat(at.folder)?.isSymbolicLink() === true &&
          lstat(`${at.profile}/${name}`)?.ino === lstat(`${moved}/${name}`)?.ino;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["held-folder-plant.har.part"],
    expect: failed("folder-refused"),
  },
  {
    cause: "folder deleted while the rename waits",
    fileName: "held-folder-gone",
    folder: (b) => dir(`${b}/held-folder-gone`),
    hold: {
      act: ({ folder }) => {
        NodeFS.rmSync(folder, { recursive: true, force: true });
        return absent(folder);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-missing"),
  },
  {
    cause: "part deleted while the rename waits",
    fileName: "held-part-gone",
    folder: (b) => dir(`${b}/held-part-gone`),
    hold: {
      act: ({ part }) => {
        NodeFS.rmSync(part);
        return absent(part);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("file-replaced"),
  },
  {
    cause: "name too long",
    fileName: "n".repeat(300),
    folder: (b) => dir(`${b}/long`),
    expect: failed("name-too-long"),
  },
];

/** The planted file `name` holds, so its bytes can be told from the export's. */
const plant = (path: string): void => NodeFS.writeFileSync(path, THEIRS);
/** Writes `text` over the start of every unnamed export file in `folder`, through the browser's own descriptors. */
const overwriteUnnamed = (pid: number, folder: string): void => {
  const found = unnamedIn(pid, folder);
  if (found.length === 0) throw new Error(`no unnamed file of the browser in ${folder}`);
  for (const path of found) {
    const fd = NodeFS.openSync(path, "r+");
    try {
      NodeFS.writeSync(fd, Buffer.from(" ".repeat(32)), 0, 32, 0);
    } finally {
      NodeFS.closeSync(fd);
    }
  }
};

/**
 * Linux: the export holds its folder open and its file is unnamed until one link names it, which never replaces. Each
 * row makes its cause happen for real; the racing rows act while the export waits at a pause, before or after the
 * link. Nothing the row put anywhere may change, and no export byte may land outside the folder the export holds.
 */
const UNNAMED_ROWS: readonly Row[] = [
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
    cause: "full disk",
    fileName: "full",
    folder: (b) => dir(`${b}/full`),
    mount: { options: "size=8m" },
    expect: failed("disk-full"),
  },
  {
    cause: "a stale part and a dangling link at the part names (never used)",
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
    cause: "name collision mid-export",
    fileName: "collision",
    folder: (b) => dir(`${b}/collision`),
    during: ({ name }) => plant(name),
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
    cause: "the unnamed file's first bytes overwritten through the browser's own descriptor",
    fileName: "overwritten",
    folder: (b) => dir(`${b}/overwritten`),
    during: ({ pid, folder }) => overwriteUnnamed(pid, folder),
    expect: failed("file-replaced"),
  },
  {
    cause: "a foreign file written at the finished name while the link waits",
    fileName: "raced-finish",
    folder: (b) => dir(`${b}/raced-finish`),
    pause: {
      at: "before-link",
      act: ({ name }) => {
        plant(name);
        return () => lstat(name)?.isFile() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["raced-finish.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "a link to prefs.js put at the finished name while the link waits",
    fileName: "raced-link",
    folder: (b) => dir(`${b}/raced-link`),
    pause: {
      at: "before-link",
      act: ({ name, profile }) => {
        NodeFS.symlinkSync(`${profile}/prefs.js`, name);
        return () => lstat(name)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["raced-link.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "a FIFO put at the finished name while the link waits (never opened)",
    fileName: "raced-fifo",
    folder: (b) => dir(`${b}/raced-fifo`),
    pause: {
      at: "before-link",
      act: ({ name }) => {
        mkfifo(name);
        return isFifo(name);
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["raced-fifo.har"],
    expect: doneAs(" (2)"),
  },
  {
    cause: "a file put at the part's name while the link waits (never touched)",
    fileName: "raced-part",
    folder: (b) => dir(`${b}/raced-part`),
    pause: {
      at: "before-link",
      act: ({ part }) => {
        plant(part);
        return () => lstat(part)?.isFile() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["raced-part.har.part"],
    expect: doneAs(""),
  },
  {
    cause: "folder replaced by a link to the profile while the link waits",
    fileName: "link-folder",
    folder: (b) => dir(`${b}/link-folder`),
    pause: {
      at: "before-link",
      act: (at) => {
        folderToProfile(at, "link-folder-moved");
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failedKeeping("folder-refused"),
  },
  {
    cause:
      "folder replaced by a link to the profile while the link waits, files planted there at the part and finished names",
    fileName: "plant-folder",
    folder: (b) => dir(`${b}/plant-folder`),
    pause: {
      at: "before-link",
      act: (at) => {
        folderToProfile(at, "plant-folder-moved");
        plant(`${at.profile}/plant-folder.har.part`);
        plant(`${at.profile}/plant-folder.har`);
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["plant-folder.har.part", "plant-folder.har"],
    expect: failedKeeping("folder-refused"),
  },
  {
    cause: "folder replaced by a link to the profile and put back while the link waits",
    fileName: "plant-restore",
    folder: (b) => dir(`${b}/plant-restore`),
    pause: {
      at: "before-link",
      act: (at) => {
        folderSwappedAndBack(at, "plant-restore-moved");
        return () => lstat(at.folder)?.isDirectory() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    expect: doneAs(""),
  },
  {
    cause: "folder deleted while the link waits",
    fileName: "gone-folder",
    folder: (b) => dir(`${b}/gone-folder`),
    pause: {
      at: "before-link",
      act: ({ folder }) => {
        NodeFS.rmSync(folder, { recursive: true, force: true });
        return absent(folder);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failed("folder-missing"),
  },
  {
    cause: "cancel while the link waits",
    fileName: "cancel-link",
    folder: (b) => dir(`${b}/cancel-link`),
    pause: { at: "before-link", act: () => () => true, cancel: true, withinMs: PROMPTLY_MS },
    expect: cancelled,
  },
  {
    cause: "the link still waiting at the step limit",
    fileName: "late-link",
    folder: (b) => dir(`${b}/late-link`),
    pause: {
      at: "before-link",
      act: () => () => true,
      keep: true,
      withinMs: STEP_MS + PROMPTLY_MS,
    },
    expect: failed("timed-out"),
  },
  {
    cause: "the finished name removed after the link",
    fileName: "removed-finish",
    folder: (b) => dir(`${b}/removed-finish`),
    pause: {
      at: "after-link",
      act: ({ name }) => {
        NodeFS.rmSync(name);
        return absent(name);
      },
      withinMs: PROMPTLY_MS,
    },
    expect: failedKeeping("file-replaced"),
  },
  {
    cause: "a foreign file renamed over the finished name after the link",
    fileName: "replaced-finish",
    folder: (b) => dir(`${b}/replaced-finish`),
    pause: {
      at: "after-link",
      act: ({ base, name }) => {
        plant(`${base}/replaced-finish.tmp`);
        NodeFS.renameSync(`${base}/replaced-finish.tmp`, name);
        return () => lstat(name)?.size === THEIRS.length;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["replaced-finish.har"],
    expect: failedKeeping("file-replaced"),
  },
  {
    cause:
      "folder replaced by a link to the profile after the link, a file planted there at the finished name",
    fileName: "after-folder",
    folder: (b) => dir(`${b}/after-folder`),
    pause: {
      at: "after-link",
      act: (at) => {
        folderToProfile(at, "after-folder-moved");
        plant(`${at.profile}/after-folder.har`);
        return () => lstat(at.folder)?.isSymbolicLink() === true;
      },
      withinMs: PROMPTLY_MS,
    },
    theirs: ["after-folder.har"],
    expect: failedKeeping("folder-refused"),
  },
  {
    cause: "a name of 255 bytes with .har (the part suffix no longer counts)",
    fileName: "n".repeat(251),
    folder: (b) => dir(`${b}/longest`),
    expect: doneAs(""),
  },
  {
    cause: "name too long",
    fileName: "n".repeat(300),
    folder: (b) => dir(`${b}/long`),
    expect: failed("name-too-long"),
  },
];

const ROWS: readonly Row[] = [
  ...UNNAMED_ROWS,
  ...NAMED_ROWS.map((row) => ({ ...row, named: true as const, cause: `named part: ${row.cause}` })),
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

/** The browser keeps writing its profile while a row is judged: a file gone between the listing and the read is absent. */
const contents = (path: string): Buffer | null => {
  try {
    return NodeFS.readFileSync(path);
  } catch {
    return null;
  }
};

const sha256 = (path: string): string => {
  const bytes = contents(path);
  return bytes === null ? "absent" : NodeCrypto.createHash("sha256").update(bytes).digest("hex");
};

/** Every export file opens with this, the document's start and its random id. */
const EXPORT_OPENING = '{"log":{"_harExportId"';

/**
 * Whether a file holds any of an export's bytes. The browser rewrites prefs.js itself during a long row, so prefs.js is
 * judged by this rather than by its hash: no export byte may reach it.
 */
const exportBytesIn = (path: string): string => {
  const bytes = contents(path);
  if (bytes === null) return "absent";
  return bytes.includes(EXPORT_OPENING) ? "holds export bytes" : "no export bytes";
};

/** What is at a path, never following a link there: a file by its hash, a link by its target. */
const fingerprint = (path: string): string => {
  const stat = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return "absent";
  if (stat.isSymbolicLink()) return `link to ${NodeFS.readlinkSync(path)}`;
  if (stat.isFIFO()) return "fifo";
  if (stat.isDirectory()) return "folder";
  return stat.isFile() ? `file ${sha256(path)}` : "other";
};

/**
 * Files under `root` (the row's whole tree: the profile, the archive and every folder around the export's) that are
 * new or changed since `before`, outside the folder the export holds, and whether each holds an export's bytes. The
 * browser rewrites its own files during a row; none of them may take an export byte. The journal holds the head only
 * as escaped JSON text, so it is judged by its lines, not here.
 */
const changedOutside = (
  root: string,
  before: ReadonlyMap<string, string>,
  theirs: ReadonlySet<string>,
  folderInode: number | null,
): RowObservation["outside"] => {
  const changed: { path: string; exportBytes: boolean }[] = [];
  for (const [path, print] of filesUnder(root, [])) {
    if (before.get(path) === print || theirs.has(path)) continue;
    if (folderInode !== null && lstat(NodePath.dirname(path))?.ino === folderInode) continue;
    changed.push({ path, exportBytes: exportBytesIn(path) === "holds export bytes" });
  }
  return changed;
};

/** Every non-folder entry under `root`, by path, except in the folders the browser itself owns. */
const filesUnder = (root: string, skip: readonly string[]): Map<string, string> => {
  const found = new Map<string, string>();
  const walk = (folder: string): void => {
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
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
  /** The real paths of the row's own files once it acted: a file it planted outside the folder is judged as its. */
  const theirsReal = new Set<string>();
  const keepTheirs = (): void => {
    for (const path of theirs) {
      if (!kept.has(path)) kept.set(path, fingerprint(path));
      if (lstat(path) === undefined) continue;
      // The folder's real path, so a file planted through a link is found where it is; a dangling link stays as named.
      theirsReal.add(
        NodePath.join(NodeFS.realpathSync(NodePath.dirname(path)), NodePath.basename(path)),
      );
    }
  };
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
      ...(row.named === true ? { extraPrefs: [{ name: NAMED_PARTS_PREF, value: true }] } : {}),
    });
    const page = await openExtensionPage(session, extensionPath);
    const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
    await session.evaluate(tab, "window.__harnessReady");
    const tabId = await newestPageTab(page);
    const before = exportBytesIn(prefs);
    const outsideBefore = filesUnder(base, []);
    /** The folder the export holds, by inode, wherever a row moves it; read again at the end if the export made it. */
    let folderInode = lstat(folder)?.isDirectory() === true ? (lstat(folder)?.ino ?? null) : null;
    if (holdDir !== null) NodeFS.writeFileSync(NodePath.join(holdDir, "arm"), "");
    if (row.pause !== undefined)
      await callHook(session, { kind: "export-pause", point: row.pause.at, action: "arm" });
    try {
      const job = await startExport(page, {
        selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
        bodies: "include",
        redaction: "standard",
        packaging: "har",
        fileName: row.fileName,
      });
      const name = `${folder}/${row.fileName}.har`;
      const at: During = { ...place, part: `${name}.part`, name, pid: session.browserPid };
      if (row.during !== undefined) {
        const writing = await waitForJob(
          page,
          job.id,
          (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= MIB),
        );
        if (writing.state.kind === "writing") row.during(at);
      }
      if (row.pause !== undefined) {
        const paused = await pauseAndAct(session, page, job.id, row.pause, at, keepTheirs);
        timing = paused.timing;
        state = paused.state;
        holdProblems.push(...paused.problems);
      }
      if (row.hold !== undefined && holdDir !== null) {
        const held = await holdAndAct(page, job.id, holdDir, row.hold, at, keepTheirs);
        timing = held.timing;
        state = held.state;
        holdProblems.push(...held.problems);
      }
      keepTheirs();
      // A held row's export that never ended is judged as it is, so the next rows still run.
      if (state === undefined || ended({ state } as Parameters<typeof ended>[0]))
        state = (await waitForJob(page, job.id, ended)).state;
      journal = await journalSettled(NodePath.join(workspace.root(), "exports.jsonl"));
    } finally {
      if (holdDir !== null) NodeFS.writeFileSync(NodePath.join(holdDir, "go"), "");
      if (row.pause !== undefined)
        await callHook(session, { kind: "export-pause", point: row.pause.at, action: "release" });
      wakeFifoReaders(base);
      row.after?.(place);
    }
    folderInode ??= lstat(folder)?.isDirectory() === true ? (lstat(folder)?.ino ?? null) : null;
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
        (name) => name.startsWith(row.fileName) && !(row.theirs ?? []).includes(name),
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
      outside: changedOutside(base, outsideBefore, theirsReal, folderInode),
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

/**
 * Waits for the export's held call, armed before the export started so it cannot be missed. Only a held rename is
 * acted on; the row's change must be in place before the call is let go. Times how long the export then takes to end.
 */
async function holdAndAct(
  page: Parameters<typeof waitForJob>[0],
  id: string,
  holdDir: string,
  hold: Hold,
  at: During,
  acted: () => void,
): Promise<{
  readonly timing: RowObservation["timing"];
  readonly problems: readonly string[];
  readonly state: unknown;
}> {
  const reached = NodePath.join(holdDir, "at");
  const go = (): void => NodeFS.writeFileSync(NodePath.join(holdDir, "go"), "");
  /** The held call's kind once the shim has written its whole line. */
  const heldCall = (): string | null => {
    const line = NodeFS.existsSync(reached) ? NodeFS.readFileSync(reached, "utf8") : "";
    return line.endsWith("\n") ? (line.split(" ")[0] ?? "") : null;
  };
  const reachBy = Date.now() + 120_000;
  let held = heldCall();
  while (held === null) {
    const job = await waitForJob(page, id, () => true);
    if (ended(job) || Date.now() > reachBy) {
      go();
      return {
        timing: null,
        problems: [`the held call was never reached: ${JSON.stringify(job.state)}`],
        state: job.state,
      };
    }
    await sleep(20);
    held = heldCall();
  }
  if (held !== "rename") {
    go();
    return {
      timing: null,
      problems: [`the held call was ${held}, not the rename`],
      state: undefined,
    };
  }
  const inPlace = hold.act(at);
  const observeBy = Date.now() + 10_000;
  while (!inPlace() && Date.now() < observeBy) await sleep(20);
  const problems = inPlace() ? [] : ["the row's change was not in place before the release"];
  acted();
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
  return { timing, problems, state: job.state };
}

/**
 * Waits for the export at its pause, armed through the harness topic before the export started, acts, and lets it go
 * once the row's change is in place: or cancels, or keeps it held until the export has ended. Times the end.
 */
async function pauseAndAct(
  session: Parameters<typeof callHook>[0],
  page: Parameters<typeof waitForJob>[0],
  id: string,
  pause: NonNullable<Row["pause"]>,
  at: During,
  acted: () => void,
): Promise<{
  readonly timing: RowObservation["timing"];
  readonly problems: readonly string[];
  readonly state: unknown;
}> {
  const hook = (action: "reached" | "release") =>
    callHook(session, { kind: "export-pause", point: pause.at, action });
  const reachBy = Date.now() + 120_000;
  while ((await hook("reached")) !== true) {
    const job = await waitForJob(page, id, () => true);
    if (ended(job) || Date.now() > reachBy)
      return {
        timing: null,
        problems: [`the ${pause.at} pause was never reached: ${JSON.stringify(job.state)}`],
        state: job.state,
      };
    await sleep(20);
  }
  const inPlace = pause.act(at);
  const observeBy = Date.now() + 10_000;
  while (!inPlace() && Date.now() < observeBy) await sleep(20);
  const problems = inPlace() ? [] : ["the row's change was not in place before the release"];
  acted();
  if (pause.cancel === true)
    await value(page, `browser.oneClickHar.cancelExport(${JSON.stringify(id)}).then(String)`);
  else if (pause.keep !== true) await hook("release");
  const from = Date.now();
  const endBy = from + pause.withinMs + 30_000;
  let job = await waitForJob(page, id, () => true);
  while (!ended(job) && Date.now() < endBy) {
    await sleep(50);
    job = await waitForJob(page, id, () => true);
  }
  const timing = { tookMs: Date.now() - from, withinMs: pause.withinMs };
  await hook("release");
  // What a held export does once let go after its job ended: it must name nothing.
  await sleep(500);
  return { timing, problems, state: job.state };
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
      outside: [{ path: "/w/profile/x.har", exportBytes: true }],
    });
    if (planted.length < 7)
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
