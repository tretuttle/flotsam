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

export type DiskOwner = "browser" | "harness" | "product";

/** One allowed kind of write: where (relative to the workspace), what kind of entry, whose, and why it is allowed. */
export type DiskRule = {
  readonly path: RegExp;
  readonly kinds: readonly DiskKind[];
  readonly owner: DiskOwner;
  readonly why: string;
};

const FILE: readonly DiskKind[] = ["file"];
const DIR: readonly DiskKind[] = ["directory"];
const TREE: readonly DiskKind[] = ["file", "directory"];
const VENDORS = "(zen|mozilla)";

/** Gecko's own profile entries: written by the browser for every profile, whatever add-ons it runs. */
const PROFILE_FILES = [
  "prefs\\.js",
  "times\\.json",
  "compatibility\\.ini",
  "extensions\\.json",
  "addons\\.json",
  "addonStartup\\.json\\.lz4",
  "extension-preferences\\.json",
  "extension-settings\\.json",
  "xulstore\\.json",
  "containers\\.json",
  "handlers\\.json",
  "search\\.json\\.mozlz4",
  "sessionstore\\.jsonlz4",
  "sessionCheckpoints\\.json",
  "session-state\\.json",
  "Telemetry\\.ShutdownTime\\.txt",
  "SiteSecurityServiceState\\.(bin|txt)",
  "AlternateServices\\.(bin|txt)",
  "cert9\\.db",
  "key4\\.db",
  "pkcs11\\.txt",
  "logins\\.(db|json)",
  "logins-backup\\.json",
  "cert_override\\.txt",
  "serviceworker\\.txt",
  "broadcast-listeners\\.json",
  "notificationstore\\.json",
  "shield-preference-experiments\\.json",
  "enumerate_devices\\.txt",
  "ExperimentStoreData\\.json",
  "targeting\\.snapshot\\.json",
  "\\.parentlock",
  "\\.startup-incomplete",
  "activity-stream\\.[a-z_]+\\.json",
  "zen-[a-z-]+\\.json(lz4)?",
  "(places|favicons|cookies|permissions|content-prefs|formhistory|storage|webappsstore|bounce-tracking-protection|domain_to_categories|suggest|credentialstate|protections|storage-sync-v2|places-ml|[0-9a-f]{8})\\.sqlite(-wal|-shm|-journal)?",
].join("|");

const PROFILE_DIRS = [
  "bookmarkbackups",
  "cache2",
  "chrome",
  "crashes",
  "datareporting",
  "extension-store(-menus)?",
  "minidumps",
  "remote-settings",
  "safebrowsing(-updating)?",
  "saved-telemetry-pings",
  "security_state",
  "sessionstore-backups",
  "settings",
  "startupCache",
  "storage",
  "thumbnails",
  "zen-sessions-backup",
  "gmp-[a-z0-9-]+",
  "weave",
  "shader-cache",
  "browser-extension-data",
  "jumpListCache",
  "personality-provider",
  "mediacapabilities",
  "OfflineCache",
].join("|");

/**
 * The fixed part of the allowed set. The key folder, the key file and the harness's own files are added per run by
 * `diskRules`, because their names are only known then.
 */
const BASE_RULES: readonly DiskRule[] = [
  {
    path: new RegExp(`^profile/(${PROFILE_FILES})$`, "u"),
    kinds: FILE,
    owner: "browser",
    why: "a file Gecko keeps in every profile",
  },
  {
    path: new RegExp(`^profile/(${PROFILE_DIRS})(/.*)?$`, "u"),
    kinds: TREE,
    owner: "browser",
    why: "a folder Gecko keeps in every profile, and what it puts there",
  },
  {
    path: /^profile\/lock$/u,
    kinds: ["symlink"],
    owner: "browser",
    why: "Gecko's profile lock on Linux is a symlink naming the host and pid",
  },
  {
    path: /^profile\/MarionetteActivePort$/u,
    kinds: FILE,
    owner: "harness",
    why: "Marionette, which the harness drives, writes its port here",
  },
  {
    path: /^profile\/user\.js$/u,
    kinds: FILE,
    owner: "harness",
    why: "the launcher writes the harness prefs",
  },
  {
    path: /^profile\/extensions(\/[^/]+\.xpi)?$/u,
    kinds: TREE,
    owner: "harness",
    why: "the launcher installs the recorder and the probe add-ons",
  },
  {
    path: /^home\/(\.cache|\.config|\.local|\.local\/state)$/u,
    kinds: DIR,
    owner: "browser",
    why: "the XDG folders the browser creates under its HOME",
  },
  {
    path: new RegExp(`^home/(\\.cache|\\.config|\\.local/state)/${VENDORS}(/.*)?$`, "u"),
    kinds: DIR,
    owner: "browser",
    why: "the browser's own XDG folders; only folders, never files",
  },
  {
    path: /^home\/\.cache\/fontconfig(\/CACHEDIR\.TAG)?$/u,
    kinds: TREE,
    owner: "browser",
    why: "fontconfig's cache folder",
  },
  {
    path: /^home\/\.cache\/fontconfig\/[0-9a-f]{32}-[a-z0-9]+\.cache-\d+$/u,
    kinds: ["file", "symlink"],
    owner: "browser",
    why: "fontconfig cache files, and its links between cache versions",
  },
  {
    path: /^data\/one-click-har$/u,
    kinds: DIR,
    owner: "product",
    why: "the app folder that holds the key folder",
  },
  {
    path: /^downloads\/[^/]+\.har$/u,
    kinds: FILE,
    owner: "product",
    why: "an export in the export folder",
  },
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
      owner: "product",
      why: "inside the random key folder",
    },
    {
      path: new RegExp(`^profile/${escape(options.keyFileName)}$`, "u"),
      kinds: FILE,
      owner: "product",
      why: "the key file",
    },
    ...options.harnessFiles.map((file): DiskRule => ({
      path: new RegExp(`^${escape(file)}$`, "u"),
      kinds: FILE,
      owner: "harness",
      why: "a file the harness wrote itself",
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
    return rule === undefined || rule.owner === "product";
  });
}
