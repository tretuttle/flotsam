import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  contentDigest,
  contentText,
  orderFreeDigest,
  entriesBeyond,
  readStructured,
  withRoles,
  type RunNames,
  type Structured,
} from "./content.ts";

// The isolation check's disk rule. The same workspace and actions run three times: with the product, and twice with
// an inert stand-in under its id. A file the two control runs leave differently is the browser's noise. Whatever the
// product run writes beyond them, by path, by bytes or by entry, is the product's, and must sit in its own places.

export type DiskKind = "file" | "directory" | "symlink" | "other";

export type DiskEntry = {
  readonly kind: DiskKind;
  readonly size: number;
  readonly mode: number;
  /** How many names the inode has; a file with more than one shares its bytes with another path. */
  readonly nlink: number;
  /** A symlink's target text, as stored; never resolved. */
  readonly link: string | null;
  /** A file's bytes as a digest, with the run's names replaced by their roles; null for anything else. */
  readonly digest: string | null;
  /** The same, blind to the order the file holds its content in; null when `digest` is. */
  readonly orderFree: string | null;
  /** Whether a file's text holds the recorded marker; null when the snapshot did not look. */
  readonly marked: boolean | null;
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

const relative = (root: string, full: string): string =>
  NodePath.relative(root, full).split(NodePath.sep).join("/");

/**
 * Every path under `root`, read with lstat; links are recorded, not followed. With the run's names, each file's
 * bytes are digested; with the recorded marker, each file's text is searched for it.
 */
export function snapshotTree(
  root: string,
  read: { readonly names?: RunNames; readonly marker?: string } = {},
): DiskSnapshot {
  const { names, marker } = read;
  const out: Record<string, DiskEntry> = {};
  const walk = (dir: string): void => {
    for (const name of NodeFS.readdirSync(dir).sort()) {
      const full = NodePath.join(dir, name);
      let stat: NodeFS.Stats;
      let bytes: Buffer | null = null;
      try {
        stat = NodeFS.lstatSync(full);
        if ((names !== undefined || marker !== undefined) && stat.isFile())
          bytes = NodeFS.readFileSync(full);
      } catch {
        continue; // Removed between readdir and lstat: a browser file that came and went.
      }
      const kind = kindOf(stat);
      out[relative(root, full)] = {
        kind,
        size: kind === "directory" ? 0 : stat.size,
        mode: stat.mode & 0o7777,
        nlink: stat.nlink,
        link: kind === "symlink" ? NodeFS.readlinkSync(full) : null,
        digest: bytes === null || names === undefined ? null : contentDigest(bytes, names),
        orderFree: bytes === null || names === undefined ? null : orderFreeDigest(bytes, names),
        marked: bytes === null || marker === undefined ? null : contentText(bytes).includes(marker),
      };
      if (kind === "directory") walk(full);
    }
  };
  walk(root);
  return out;
}

/** The entries of every changed file whose format can be read, keyed by its workspace path. */
export function readChangedStructured(
  root: string,
  changes: readonly DiskChange[],
  names: RunNames,
): Readonly<Record<string, Structured>> {
  return Object.fromEntries(
    changes
      .filter((c) => c.entry.kind === "file")
      .flatMap((c) => {
        const full = NodePath.join(root, ...c.path.split("/"));
        const read = readStructured(full, NodeFS.readFileSync(full), names);
        return read === null ? [] : [[c.path, read] as const];
      }),
  );
}

/**
 * New paths, and paths whose kind, size, mode, link count, link target or bytes changed. A directory that already
 * existed is never "changed": a child added to it is reported itself.
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
      old.digest === entry.digest;
    return same ? [] : [{ path, change: "changed", entry }];
  });
}

/** One run's disk: what it changed at plan time, after the probes and at the end, and what it read from each file. */
export type RunDisk = {
  readonly plan: readonly DiskChange[];
  readonly probes: readonly DiskChange[];
  /** Read once the run's last browser quit, with each file's digest. */
  readonly final: readonly DiskChange[];
  readonly structured: Readonly<Record<string, Structured>>;
  readonly names: RunNames;
  /** Every file the harness itself wrote into the workspace, and the digest of what it wrote. */
  readonly harness: Readonly<Record<string, string>>;
};

/** The product's own places, known only once the run has read its key. */
export type ProductArea = { readonly archiveKey: string; readonly keyFileName: string };

type Place = { readonly path: RegExp; readonly kind: "file" | "directory" };

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * The app folder, the random key folder and everything in it, the key file in the profile, and an export. The key is
 * 32 lowercase hex digits (`locateArchive` reads no other), so it needs no escaping.
 */
function placesOf(area: ProductArea): readonly Place[] {
  const keyFolder = `data/one-click-har/${area.archiveKey}`;
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

/** A write in the product's places: mode 600 or 700, one link, and a key file or export the plan probed. */
function placeProblems(c: DiskChange, probed: ReadonlySet<string>): readonly string[] {
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
    ...(!c.path.startsWith("data/") && !probed.has(c.path)
      ? [`${describe(c)}: written after the plan, so never probed`]
      : []),
  ];
}

const SQLITE_COMPANIONS = ["-wal", "-shm", "-journal"] as const;

/** The database a SQLite journal, write-ahead log or shared-memory file belongs to, or null. */
const databaseOf = (path: string): string | null => {
  const suffix = SQLITE_COMPANIONS.find((s) => path.endsWith(s));
  return suffix === undefined ? null : path.slice(0, -suffix.length);
};

type Seen = { readonly change: DiskChange; readonly run: RunDisk };

/**
 * One product write outside its places, against what the two control runs left at the same place: the same shape,
 * and the same bytes as either, or for a readable file no entry beyond both. A file the two control runs left
 * differently and whose format cannot be read is the browser's noise.
 */
function outsideProblems(
  c: DiskChange,
  product: RunDisk,
  controls: readonly [Seen | undefined, Seen | undefined],
): readonly string[] {
  const seen = controls.filter((s): s is Seen => s !== undefined);
  if (seen.length === 0)
    return [`${describe(c)}: outside the product's places, and neither control run wrote it`];
  const link = (s: DiskChange, run: RunDisk): string | null =>
    s.entry.link === null ? null : withRoles(s.entry.link, run.names);
  const alike = seen.filter(
    (s) =>
      s.change.entry.kind === c.entry.kind &&
      s.change.entry.mode === c.entry.mode &&
      link(s.change, s.run) === link(c, product),
  );
  if (alike.length === 0)
    return [`${describe(c)}: unlike what either control run left there in kind, mode or link`];
  // The same bytes as either control run, or the same content in another order.
  const sameContent = (s: Seen): boolean =>
    s.change.entry.digest === c.entry.digest || s.change.entry.orderFree === c.entry.orderFree;
  if (c.entry.kind !== "file" || seen.some(sameContent)) return [];
  const [first, second] = controls;
  const mine = product.structured[c.path];
  const theirs = [first, second].map((s) =>
    s === undefined ? undefined : s.run.structured[s.change.path],
  );
  if (mine !== undefined && theirs[0] !== undefined && theirs[1] !== undefined) {
    const [a, b] = theirs as [Structured, Structured];
    return [
      ...entriesBeyond(mine.entries, [a.entries, b.entries]).map((line) => `${c.path}: ${line}`),
      ...(mine.unaccounted > Math.max(a.unaccounted, b.unaccounted)
        ? [`${c.path}: ${String(mine.unaccounted)} bytes past its last page`]
        : []),
    ];
  }
  // An unreadable file the browser keeps for itself (a script cache, a store) differs whenever the product is
  // installed; what may not land there is recorded data, which carries the marker.
  const leaked = c.entry.marked === true && seen.every((s) => s.change.entry.marked !== true);
  return leaked
    ? [`${describe(c)}: holds the recorded marker, which neither control run's copy holds`]
    : [];
}

/**
 * The runs with entries kept only for the files whose bytes differ from both control runs: the only files the rule
 * compares entry by entry. Everything else the entries held is already settled by digest.
 */
export function pruneStructured(
  product: RunDisk,
  controls: readonly [RunDisk, RunDisk],
): readonly [RunDisk, RunDisk, RunDisk] {
  const key = (path: string, run: RunDisk): string => withRoles(path, run.names);
  const digests = controls.map(
    (run) => new Map(run.final.map((c) => [key(c.path, run), c.entry.digest])),
  );
  const needed = new Set(
    product.final
      .filter((c) => {
        const k = key(c.path, product);
        return digests.every((d) => d.get(k) !== c.entry.digest);
      })
      .map((c) => key(c.path, product)),
  );
  const keep = (run: RunDisk): RunDisk => ({
    ...run,
    structured: Object.fromEntries(
      Object.entries(run.structured).filter(([path]) => needed.has(key(path, run))),
    ),
  });
  return [keep(product), keep(controls[0]), keep(controls[1])];
}

/** What the disk rule reads: the product run, the two control runs, the product's places, and the probed paths. */
export type DiskEvidence = {
  readonly product: RunDisk;
  readonly controls: readonly [RunDisk, RunDisk];
  readonly area: ProductArea;
  /** Workspace-relative paths of the plan's inventory, each a probe target. */
  readonly probed: readonly string[];
};

/**
 * Everything wrong on disk: a product write outside its places that the control runs do not account for, by path,
 * bytes or entry; a write in its places at another mode, with another link or never probed; a harness file whose
 * bytes changed; a hard link anywhere; and a file that came and went during the product run that no control run made.
 */
export function diskProblems(evidence: DiskEvidence): readonly string[] {
  const { product, controls, area } = evidence;
  const probed = new Set(evidence.probed);
  const key = (path: string, run: RunDisk): string => withRoles(path, run.names);
  const lastly = controls.map(
    (run) => new Map(run.final.map((change) => [key(change.path, run), { change, run }])),
  );
  const structuredDb = (path: string): boolean => product.structured[path]?.format === "sqlite";
  const finals = product.final.flatMap((c): string[] => {
    const wrote = product.harness[c.path];
    if (wrote !== undefined)
      return c.entry.digest === wrote
        ? []
        : [`${describe(c)}: the harness wrote it, and its bytes changed`];
    if (inProductArea(c, area)) return [...placeProblems(c, probed)];
    const db = databaseOf(c.path);
    if (db !== null && structuredDb(db)) return [];
    const k = key(c.path, product);
    return [...outsideProblems(c, product, [lastly[0]?.get(k), lastly[1]?.get(k)])];
  });
  const everMade = new Set(
    controls.flatMap((run) =>
      [...run.plan, ...run.probes, ...run.final].map((c) => key(c.path, run)),
    ),
  );
  // Files that held recorded data and came and went: in the product run those no control run made at the same path.
  const gone = (run: RunDisk, unknown: (k: string) => boolean): readonly DiskChange[] => {
    const ended = new Set(run.final.map((c) => key(c.path, run)));
    return [...run.plan, ...run.probes].filter((c, i, all) => {
      const k = key(c.path, run);
      const db = databaseOf(k);
      return (
        c.entry.marked === true &&
        !inProductArea(c, area) &&
        !ended.has(k) &&
        unknown(k) &&
        !(db !== null && (everMade.has(db) || ended.has(db))) &&
        all.findIndex((other) => other.path === c.path) === i
      );
    });
  };
  // The browser too can briefly hold recorded data under a random name (a download's .part file): a folder where a
  // control run had such files allows the product run as many, and no more.
  const folder = (c: DiskChange, run: RunDisk): string => NodePath.posix.dirname(key(c.path, run));
  const perFolder = (changes: readonly DiskChange[], run: RunDisk): Map<string, number> => {
    const m = new Map<string, number>();
    for (const c of changes) m.set(folder(c, run), (m.get(folder(c, run)) ?? 0) + 1);
    return m;
  };
  const allowed = controls.map((run) =>
    perFolder(
      gone(run, () => true),
      run,
    ),
  );
  const mine = gone(product, (k) => !everMade.has(k));
  const counts = perFolder(mine, product);
  const transient = mine.filter((c) => {
    const f = folder(c, product);
    return (counts.get(f) ?? 0) > Math.max(...allowed.map((m) => m.get(f) ?? 0));
  });
  return [
    ...finals,
    ...hardLinks([...product.final, ...product.plan, ...product.probes]),
    ...transient.map(
      (c) =>
        `${describe(c)}: held recorded data and came and went during the run, more such files in its folder than either control run made`,
    ),
  ];
}

/** Every file or link whose inode has another name: a second path to the same bytes. Each path is named once. */
export function hardLinks(changes: readonly DiskChange[]): readonly string[] {
  return [
    ...new Set(
      changes
        .filter((c) => c.entry.kind !== "directory" && c.entry.nlink > 1)
        .map((c) => `${c.path} has ${String(c.entry.nlink)} links`),
    ),
  ];
}
