// The archive root, its key and its settings, resolved synchronously in onStartup: the first request of the run
// already has a place to go, and an excluded site is excluded from the first channel. Each read or write here is one
// small file. Paths are built with PathUtils; nothing assumes a separator.

import {
  ARCHIVE_KEY_FILE,
  ARCHIVE_ROOTS,
  archiveKeyFromBytes,
  guardFolder,
  KNOWN_SUBSTITUTIONS,
  LAYOUT,
  parseArchiveKey,
  rootSegments,
  type FolderRefusal,
  type ForbiddenRoots,
  type Platform,
  type SafeFolder,
} from "@one-click-har/recording/layout";
import {
  DEFAULT_USER_SETTINGS,
  parseStoredSettings,
  type StoredSettings,
} from "@one-click-har/recording/settings";
import { localFile, openOutput, randomBytes, type Modes } from "./gecko-io.ts";

const PLATFORMS: { readonly [os: string]: Platform } = { WINNT: "win", Darwin: "macosx" };
const DIRECTORY_TYPE = 1;
const ARCHIVE_KEY_BYTES = 16;

export const platform = (): Platform => PLATFORMS[Services.appinfo.OS] ?? "linux";

const dirPath = (key: string): string => Services.dirsvc.get(key, Ci.nsIFile).path;

/** A substitution's target as a local path: the folder of a `file:` target, the archive of a `jar:` one. */
const localPathOf = (spec: string): string | null => {
  const outer = spec.startsWith("jar:") ? spec.slice(4, spec.indexOf("!/")) : spec;
  if (!outer.startsWith("file:")) return null;
  return Services.io.newURI(outer).QueryInterface(Ci.nsIFileURL).file.path;
};

const substitutionRoots = (): string[] => {
  const roots: string[] = [];
  const add = (resolve: () => string): void => {
    try {
      const path = localPathOf(resolve());
      if (path !== null) roots.push(path);
    } catch {
      // A scheme or name this build does not have.
    }
  };
  const resource = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsISubstitutingProtocolHandler);
  for (const name of KNOWN_SUBSTITUTIONS) {
    add(() => (resource.hasSubstitution(name) ? resource.getSubstitution(name).spec : ""));
  }
  // moz-src:/// maps to sources inside omni.ja, like resource:// and chrome:// (issue 13).
  add(() =>
    Services.io
      .getProtocolHandler("moz-src")
      .QueryInterface(Ci.nsISubstitutingProtocolHandler)
      .resolveURI(Services.io.newURI("moz-src:///")),
  );
  return roots;
};

/** The profile, GRE and application directories, and every known substitution that resolves to a local path. */
export const forbiddenRoots = (): ForbiddenRoots => ({
  profile: dirPath("ProfD"),
  greDir: dirPath("GreD"),
  appDir: dirPath("XCurProcD"),
  substitutions: substitutionRoots(),
});

const ensureDirectory = (path: string, modes: Modes): void => {
  const dir = localFile(path);
  if (!dir.exists()) dir.create(DIRECTORY_TYPE, modes.dir ?? 0o755);
  if (modes.dir !== null) dir.permissions = modes.dir;
};

const readTextSync = (path: string): string | null => {
  const file = localFile(path);
  if (!file.exists()) return null;
  const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream,
  );
  stream.init(file, -1, 0, 0);
  try {
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    return NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
  } finally {
    stream.close();
  }
};

/** ASCII only. Written beside the target and renamed over it, created with its final mode. */
const writeAsciiSync = (path: string, text: string, modes: Modes): void => {
  const tmp = `${path}${LAYOUT.tmpSuffix}`;
  const out = openOutput(tmp, false, modes);
  try {
    out.write(text, text.length);
  } finally {
    out.close();
  }
  localFile(tmp).moveTo(null, PathUtils.filename(path));
};

/**
 * The archive key lives in the profile. A missing or unreadable key file gets a new key, which starts a new, empty
 * archive: the old archive is left on disk untouched, because nothing can tell which profile it belonged to.
 */
const archiveKey = (profile: string): { readonly key: string; readonly created: boolean } => {
  const path = PathUtils.join(profile, ARCHIVE_KEY_FILE);
  const existing = parseArchiveKey(readTextSync(path) ?? "");
  if (existing !== null) return { key: existing, created: false };
  const key = archiveKeyFromBytes(randomBytes(ARCHIVE_KEY_BYTES));
  writeAsciiSync(path, `${key}\n`, { dir: null, file: 0o600 });
  return { key, created: true };
};

export type RootProblem =
  | { readonly kind: "archive-refused"; readonly refusal: FolderRefusal }
  | { readonly kind: "archive-unwritable"; readonly detail: string };

export interface Archive {
  readonly root: SafeFolder;
  readonly platform: Platform;
  readonly modes: Modes;
  readonly keyCreated: boolean;
}

/**
 * ARCHIVE_ROOTS[platform] through rootSegments, then the key, then guardFolder. Creates the app folder, the archive
 * and `incoming/` with the row's mode. A refusal or a failed create is a problem, not a throw: recording stops and
 * DevTools-only export keeps working.
 */
export const openArchive = ():
  | { readonly ok: true; readonly archive: Archive }
  | { readonly ok: false; readonly problem: RootProblem } => {
  const os = platform();
  const row = ARCHIVE_ROOTS[os];
  const modes: Modes = { dir: row.dirMode, file: row.fileMode };
  try {
    const segments = rootSegments(
      row,
      (name) => (Services.env.exists(name) ? Services.env.get(name) : null),
      dirPath,
    );
    const appFolder = PathUtils.join(...segments);
    const forbidden = forbiddenRoots();
    const guardedApp = guardFolder(appFolder, forbidden, os);
    if (!guardedApp.ok)
      return { ok: false, problem: { kind: "archive-refused", refusal: guardedApp.refusal } };
    const { key, created } = archiveKey(forbidden.profile);
    const guarded = guardFolder(PathUtils.join(appFolder, key), forbidden, os);
    if (!guarded.ok)
      return { ok: false, problem: { kind: "archive-refused", refusal: guarded.refusal } };
    ensureDirectory(appFolder, modes);
    ensureDirectory(guarded.folder, modes);
    ensureDirectory(PathUtils.join(guarded.folder, LAYOUT.incomingDir), modes);
    return {
      ok: true,
      archive: { root: guarded.folder, platform: os, modes, keyCreated: created },
    };
  } catch (error) {
    return { ok: false, problem: { kind: "archive-unwritable", detail: String(error) } };
  }
};

/**
 * settings.json, read once at startup. Missing gives the defaults. A file that does not parse is renamed aside, to a
 * name recovery never touches, and the defaults load (crash row 11): one bad excluded site rejects the whole file.
 */
export const loadSettings = (
  root: SafeFolder,
): { readonly settings: StoredSettings; readonly rejected: boolean } => {
  const path = PathUtils.join(root, LAYOUT.settings);
  const defaults: StoredSettings = {
    user: DEFAULT_USER_SETTINGS,
    exportFolder: { kind: "downloads" },
  };
  const text = readTextSync(path);
  if (text === null) return { settings: defaults, rejected: false };
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const parsed = parseStoredSettings(raw);
  if (parsed !== null) return { settings: parsed, rejected: false };
  localFile(path).moveTo(null, `${LAYOUT.settings}.rejected`);
  return { settings: defaults, rejected: true };
};
