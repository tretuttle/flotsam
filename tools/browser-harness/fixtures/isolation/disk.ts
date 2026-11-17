import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// The isolation check's disk rule. The same workspace and actions run twice, with the product and with an inert
// stand-in under its id, each read with lstat (links never followed). What the product run wrote beyond the control
// run is the product's: it must be the key file, in the key folder or an export, at mode 600 (folders 700), with one
// link. A hard link anywhere fails.

export type DiskKind = "file" | "directory" | "symlink" | "other";

export type DiskEntry = {
  readonly kind: DiskKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  /** How many names the inode has; a file with more than one shares its bytes with another path. */
  readonly nlink: number;
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
        nlink: stat.nlink,
        link: kind === "symlink" ? NodeFS.readlinkSync(full) : null,
      };
      if (kind === "directory") walk(full);
    }
  };
  walk(root);
  return out;
}

/**
 * New paths, and paths whose kind, size, mode, link count, link target or modification time changed. A directory
 * that already existed is never "changed": its own time moves whenever a child is added, and the child is reported.
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
      old.nlink === entry.nlink &&
      old.link === entry.link &&
      old.mtimeMs === entry.mtimeMs;
    return same ? [] : [{ path, change: "changed", entry }];
  });
}

/**
 * Text that differs between the two runs only because each made its own: every add-on's moz-extension uuid and the
 * workspace folder. Each is replaced by its role, so the same browser write in both runs reads the same.
 */
export type RunNames = readonly (readonly [text: string, role: string])[];

/**
 * One run's changes once its last browser quit, and its own run names. The end state, not a moment mid-run: in the
 * middle of a run the browser's own background writes (a database journal, a temporary file) come and go by timing.
 */
export type RunChanges = {
  readonly final: readonly DiskChange[];
  readonly names: RunNames;
};

const withRoles = (text: string, names: RunNames): string =>
  names.reduce((out, [from, role]) => out.replaceAll(from, role), text);

/** Where, what kind, what mode and what a link points to: what must match for a write to be the control run's too. */
const signature = (change: DiskChange, names: RunNames): string =>
  JSON.stringify([
    withRoles(change.path, names),
    change.entry.kind,
    change.entry.mode,
    change.entry.link === null ? null : withRoles(change.entry.link, names),
  ]);

/** Every write the product run left that the control run did not leave at the same place, kind, mode and link. */
export function beyondControl(product: RunChanges, control: RunChanges): readonly DiskChange[] {
  const made = new Set(control.final.map((c) => signature(c, control.names)));
  return product.final.filter((change) => !made.has(signature(change, product.names)));
}

/** The product's own places, known only once the run has read its key. */
export type ProductArea = { readonly archiveKey: string; readonly keyFileName: string };

type Place = { readonly path: RegExp; readonly kind: "file" | "directory" };

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The app folder, the random key folder and everything in it, the key file in the profile, and an export. */
function placesOf(area: ProductArea): readonly Place[] {
  const keyFolder = `data/one-click-har/${escape(area.archiveKey)}`;
  return [
    { path: /^data\/one-click-har$/u, kind: "directory" },
    { path: new RegExp(`^${keyFolder}(/.+)?$`, "u"), kind: "directory" },
    { path: new RegExp(`^${keyFolder}/.+$`, "u"), kind: "file" },
    { path: new RegExp(`^profile/${escape(area.keyFileName)}$`, "u"), kind: "file" },
    { path: /^downloads\/[^/]+\.har$/u, kind: "file" },
  ];
}

/** The only modes a product write may have: readable by the user's own account and nobody else. */
export const PRODUCT_MODES = { file: 0o600, directory: 0o700 } as const;

/** Every path the product may write: in one of its places, of that place's kind. */
export const inProductArea = (
  change: Pick<DiskChange, "path" | "entry">,
  area: ProductArea,
): boolean => placesOf(area).some((p) => p.kind === change.entry.kind && p.path.test(change.path));

const describe = (c: DiskChange): string =>
  `${c.change} ${c.entry.kind} ${c.path}${c.entry.link === null ? "" : ` -> ${c.entry.link}`}`;

/**
 * Every product write that is not in the product's places at its exact mode with a single link, as one line each.
 * Empty when the product wrote only its key file, its key folder and exports, each private to the user.
 */
export function productWriteProblems(
  writes: readonly DiskChange[],
  area: ProductArea,
): readonly string[] {
  return writes.flatMap((c): string[] => {
    if (!inProductArea(c, area))
      return [`${describe(c)}: outside the key folder, the key file and the export folder`];
    const kind = c.entry.kind as keyof typeof PRODUCT_MODES;
    return [
      ...(c.entry.mode === PRODUCT_MODES[kind]
        ? []
        : [
            `${describe(c)}: mode ${c.entry.mode.toString(8)}, not ${PRODUCT_MODES[kind].toString(8)}`,
          ]),
      ...(kind === "file" && c.entry.nlink !== 1
        ? [`${describe(c)}: ${String(c.entry.nlink)} links`]
        : []),
    ];
  });
}

/**
 * Every file or link whose inode has another name: a second path to the same bytes. The workspace starts empty but
 * for the add-ons the harness installs, so every path that could have one is among a run's changes.
 */
export function hardLinks(changes: readonly DiskChange[]): readonly string[] {
  return changes
    .filter((c) => c.entry.kind !== "directory" && c.entry.nlink > 1)
    .map((c) => `${c.path} has ${String(c.entry.nlink)} links`);
}

/** What the disk rule reads: both runs, the product's places, and the paths the plan's inventory probed. */
export type DiskEvidence = {
  readonly product: RunChanges;
  readonly control: RunChanges;
  readonly area: ProductArea;
  /** Workspace-relative paths of the plan's inventory, each a probe target. */
  readonly probed: readonly string[];
};

/**
 * Everything wrong on disk: a product write outside its places, at another mode or with another link; a hard link
 * anywhere; and a key file or export the product wrote after the plan, which no probe could target. Writes in the
 * key folder after the plan are the archive oracle's to cover.
 */
export function diskProblems(evidence: DiskEvidence): readonly string[] {
  const written = beyondControl(evidence.product, evidence.control);
  const probed = new Set(evidence.probed);
  return [
    ...productWriteProblems(written, evidence.area),
    ...hardLinks(evidence.product.final),
    ...written
      .filter(
        (c) =>
          inProductArea(c, evidence.area) && !c.path.startsWith("data/") && !probed.has(c.path),
      )
      .map((c) => `${describe(c)}: written after the plan, so never probed`),
  ];
}
