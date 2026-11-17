import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// The isolation check's disk rule: snapshot the throwaway workspace (the browser's HOME, its profile, the data
// home and Downloads) before the browser starts and after it quits, with lstat so a link is seen as a link and never
// followed. Every new or changed path must be one the browser owns, one the harness wrote, the key file, or inside
// the random key folder or an export in Downloads. Anything else is the product writing where it should not.

export type DiskKind = "file" | "directory" | "symlink" | "other";

export type DiskEntry = {
  readonly kind: DiskKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  /** A symlink's target text, as stored; never resolved. */
  readonly link: string | null;
};

export type DiskSnapshot = Readonly<Record<string, DiskEntry>>;

export type DiskChange = {
  readonly path: string;
  readonly change: "new" | "changed";
  readonly entry: DiskEntry;
};

const kindOf = (stat: NodeFS.Stats): DiskKind =>
  stat.isSymbolicLink()
    ? "symlink"
    : stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : "other";

/** Every path under `root`, relative and `/`-separated, read with lstat. Links are recorded, not followed. */
export function snapshotTree(root: string): DiskSnapshot {
  const out: Record<string, DiskEntry> = {};
  const walk = (dir: string): void => {
    for (const name of NodeFS.readdirSync(dir).sort()) {
      const full = NodePath.join(dir, name);
      let stat: NodeFS.Stats;
      try {
        stat = NodeFS.lstatSync(full);
      } catch {
        continue; // Removed between readdir and lstat: a browser file that came and went.
      }
      const kind = kindOf(stat);
      out[NodePath.relative(root, full).split(NodePath.sep).join("/")] = {
        kind,
        size: kind === "directory" ? 0 : stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode & 0o7777,
        link: kind === "symlink" ? NodeFS.readlinkSync(full) : null,
      };
      if (kind === "directory") walk(full);
    }
  };
  walk(root);
  return out;
}

/**
 * New paths, and paths whose kind, size, mode, link target or modification time changed. A directory that already
 * existed is never "changed": its own time moves whenever a child is added, and the child is reported itself.
 */
export function diffSnapshots(before: DiskSnapshot, after: DiskSnapshot): readonly DiskChange[] {
  return Object.entries(after).flatMap(([path, entry]): DiskChange[] => {
    const old = before[path];
    if (old === undefined) return [{ path, change: "new", entry }];
    if (old.kind === "directory" && entry.kind === "directory") return [];
    const same =
      old.kind === entry.kind &&
      old.size === entry.size &&
      old.mode === entry.mode &&
      old.link === entry.link &&
      old.mtimeMs === entry.mtimeMs;
    return same ? [] : [{ path, change: "changed", entry }];
  });
}

/**
 * One allowed kind of write: where (relative to the workspace) and what kind of entry. `product` marks the product's
 * own writes, which the probes must fail to read; the rest are the browser's or the harness's.
 */
export type DiskRule = {
  readonly path: RegExp;
  readonly kinds: readonly DiskKind[];
  readonly product?: true;
};

const FILE: readonly DiskKind[] = ["file"];
const DIR: readonly DiskKind[] = ["directory"];
const TREE: readonly DiskKind[] = ["file", "directory"];
const VENDORS = "(zen|mozilla)";

// Gecko's own profile entries, each one written in a recorded baseline or regression run of Zen Twilight 1.25t,
// Firefox Developer Edition 161.0 or Zen 1.24.2b. A browser that writes a name not listed here fails the check,
// and the name is added with the run that showed it.
const PROFILE_FILES = [
  "prefs\\.js",
  "times\\.json",
  "compatibility\\.ini",
  "extensions\\.json",
  "addons\\.json",
  "addonStartup\\.json\\.lz4",
  "extension-preferences\\.json",
  "xulstore\\.json",
  "containers\\.json",
  "handlers\\.json",
  "search\\.json\\.mozlz4",
  "sessionstore\\.jsonlz4",
  "sessionCheckpoints\\.json",
  "Telemetry\\.ShutdownTime\\.txt",
  "SiteSecurityServiceState\\.bin",
  "cert9\\.db",
  "key4\\.db",
  "pkcs11\\.txt",
  "logins\\.db",
  "broadcast-listeners\\.json",
  "breach-alerts\\.db",
  "\\.parentlock",
  "\\.startup-incomplete",
  "activity-stream\\.[a-z_]+\\.json",
  "zen-[a-z-]+\\.json(lz4)?",
  "(places|favicons|cookies|permissions|content-prefs|formhistory|storage|bounce-tracking-protection|protections)\\.sqlite(-wal)?",
  "domain_to_categories\\.sqlite(-journal)?",
  // Gecko names one database after a hash; its name changes per run.
  "[0-9a-f]{8}\\.sqlite(-wal|-shm)?",
].join("|");

const PROFILE_DIRS = [
  "bookmarkbackups",
  "cache2",
  "chrome",
  "crashes",
  "datareporting",
  "extension-store",
  "minidumps",
  "safebrowsing",
  "saved-telemetry-pings",
  "security_state",
  "sessionstore-backups",
  "settings",
  "startupCache",
  "storage",
  "thumbnails",
  "zen-sessions-backup",
].join("|");

/**
 * The fixed part of the allowed set. The key folder, the key file and the harness's own files are added per run by
 * `diskRules`, because their names are only known then.
 */
const BASE_RULES: readonly DiskRule[] = [
  // Files and folders Gecko keeps in every profile, and what it puts in those folders.
  { path: new RegExp(`^profile/(${PROFILE_FILES})$`, "u"), kinds: FILE },
  { path: new RegExp(`^profile/(${PROFILE_DIRS})(/.*)?$`, "u"), kinds: TREE },
  // Gecko's profile lock on Linux, a symlink naming the host and pid, while the browser runs.
  { path: /^profile\/lock$/u, kinds: ["symlink"] },
  // Marionette, which the harness drives, writes its port while the browser runs.
  { path: /^profile\/MarionetteActivePort$/u, kinds: FILE },
  // The launcher writes the harness prefs and installs the recorder and the probe add-ons.
  { path: /^profile\/user\.js$/u, kinds: FILE },
  { path: /^profile\/extensions(\/[^/]+\.xpi)?$/u, kinds: TREE },
  // The browser's XDG folders under its HOME: folders only, never files.
  { path: /^home\/(\.cache|\.config)$/u, kinds: DIR },
  { path: new RegExp(`^home/(\\.cache|\\.config)/${VENDORS}(/.*)?$`, "u"), kinds: DIR },
  // The crash reporter's own client id and pending pings.
  { path: new RegExp(`^home/\\.config/${VENDORS}/[a-z]+/Crash Reports(/.*)?$`, "u"), kinds: TREE },
  // fontconfig's cache, and its links between cache versions.
  { path: /^home\/\.cache\/fontconfig(\/CACHEDIR\.TAG)?$/u, kinds: TREE },
  {
    path: /^home\/\.cache\/fontconfig\/[0-9a-f]{32}-[a-z0-9]+\.cache-\d+$/u,
    kinds: ["file", "symlink"],
  },
  // The app folder that holds the key folder, and an export in the export folder.
  { path: /^data\/one-click-har$/u, kinds: DIR, product: true },
  { path: /^downloads\/[^/]+\.har$/u, kinds: FILE, product: true },
];

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The allowed set for one run: the fixed rules, the key folder and key file, and the files the harness wrote. */
export function diskRules(options: {
  readonly archiveKey: string;
  readonly keyFileName: string;
  readonly harnessFiles: readonly string[];
}): readonly DiskRule[] {
  return [
    ...BASE_RULES,
    {
      path: new RegExp(`^data/one-click-har/${escape(options.archiveKey)}(/.*)?$`, "u"),
      kinds: TREE,
      product: true,
    },
    {
      path: new RegExp(`^profile/${escape(options.keyFileName)}$`, "u"),
      kinds: FILE,
      product: true,
    },
    ...options.harnessFiles.map((file): DiskRule => ({
      path: new RegExp(`^${escape(file)}$`, "u"),
      kinds: FILE,
    })),
  ];
}

const ruleFor = (
  rules: readonly DiskRule[],
  change: Pick<DiskChange, "path" | "entry">,
): DiskRule | undefined =>
  rules.find((rule) => rule.kinds.includes(change.entry.kind) && rule.path.test(change.path));

/** Every change no rule allows, as `<new|changed> <kind> <path>`, with a link's target. */
export function unallowedWrites(
  changes: readonly DiskChange[],
  rules: readonly DiskRule[],
): readonly string[] {
  return changes
    .filter((change) => ruleFor(rules, change) === undefined)
    .map(
      (c) =>
        `${c.change} ${c.entry.kind} ${c.path}${c.entry.link === null ? "" : ` -> ${c.entry.link}`}`,
    );
}

/** Paths the product wrote, by the rules: the inventory every probe position must fail to read. */
export function productWrites(
  changes: readonly DiskChange[],
  rules: readonly DiskRule[],
): readonly DiskChange[] {
  return changes.filter((change) => {
    const rule = ruleFor(rules, change);
    return rule === undefined || rule.product === true;
  });
}
