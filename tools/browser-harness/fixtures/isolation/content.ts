import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

// What a file holds, in a form two runs can compare: a digest of its bytes, and for a file whose format can be read
// (SQLite, prefs, JSON, mozlz4 JSON) its entries. Each run's own names (add-on uuids, the workspace folder, a store
// id, browser pids) are replaced by their role first, so the same write in two runs reads the same.

/**
 * Text that differs between runs only because each made its own: every add-on's moz-extension uuid, the workspace
 * folder, the profiles store id and each browser's pid. Each is replaced by its role.
 */
export type RunNames = readonly (readonly [text: string, role: string])[];

export const withRoles = (text: string, names: RunNames): string =>
  names.reduce((out, [from, role]) => out.replaceAll(from, role), text);

const digest = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "latin1").digest("hex");

/** A file's bytes, its run names replaced by their roles, as a sha256. */
export const contentDigest = (bytes: Buffer, names: RunNames): string =>
  digest(withRoles(bytes.toString("latin1"), names));

/**
 * A file's content in any order: its length and its printable runs, sorted, with every run of digits read as one
 * number. Two files holding the same records in another order (a hash map serialized in random order), or with other
 * timestamps, share it; added or changed text does not.
 */
export function orderFreeDigest(bytes: Buffer, names: RunNames): string {
  // Digits by kind, as everywhere else: a timestamp or counter inside a record is the browser's.
  const text = withRoles(bytes.toString("latin1"), names).replaceAll(/\d+/gu, "#");
  return digest(
    `${String(text.length)}\n${(text.match(/[\x20-\x7e]{4,}/gu) ?? []).sort().join("\n")}`,
  );
}

/**
 * A structured file's entries: groups (a table, a pref, a JSON leaf), each a list of records, each record its fields
 * as short digests. Two runs compare group by group, so an entry the product added shows up in a file both runs wrote.
 */
export type Entries = Readonly<Record<string, Group>>;

/** One group's records, compactly: its field names once, then each record's field digests in that order. */
export type Group = {
  readonly fields: readonly string[];
  readonly rows: readonly (readonly string[])[];
};

/** What a structured file holds: its entries, and for a database the bytes its header does not account for. */
export type Structured = {
  readonly format: "sqlite" | "prefs" | "json";
  readonly entries: Entries;
  /** Bytes past the last page a SQLite header counts; anything there is invisible to SQLite. */
  readonly unaccounted: number;
};

const short = (text: string): string => digest(text).slice(0, 10);

/**
 * A value as it is compared: text by a digest of itself with every run of digits read as one number, and a number
 * or a flag by its kind alone. The browser's own numbers and flags (counters, ids, timestamps, etags, settings an
 * idle task flips) shift with when a run did what; recorded data is text, so it still shows.
 */
const NUMBER = /^-?#(\.#)?(e[-+]?#)?$/iu;
/** The kinds a value is compared by when it is not text: a number, a flag, nothing, or an opaque blob. */
const KINDS = new Set(["#", "flag", "null", "blob"]);
const valueDigest = (text: string): string => {
  const shape = text.replaceAll(/\d+/gu, "#");
  if (NUMBER.test(shape)) return "#";
  if (shape === "true" || shape === "false") return "flag";
  return shape === "null" ? "null" : short(shape);
};
/** Whether a record holds text: recorded data is text, and a record of numbers, flags and blobs is bookkeeping. */
const holdsText = (row: readonly string[]): boolean => row.some((cell) => !KINDS.has(cell));

const single = (value: string): Group => ({ fields: ["value"], rows: [[valueDigest(value)]] });

const SQLITE_MAGIC = "SQLite format 3\0";
const MOZLZ4_MAGIC = "mozLz40\0";

/** Decodes one LZ4 block, the format Firefox's mozlz4 files wrap. */
export function lz4Block(src: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size);
  let i = 0;
  let o = 0;
  const length = (start: number): number => {
    let n = start;
    if (start === 15) {
      let b = 255;
      while (b === 255) {
        b = src[i] ?? 0;
        i += 1;
        n += b;
      }
    }
    return n;
  };
  while (i < src.length) {
    const token = src[i] ?? 0;
    i += 1;
    const literals = length(token >> 4);
    src.copy(out, o, i, i + literals);
    i += literals;
    o += literals;
    if (i >= src.length) break;
    const offset = (src[i] ?? 0) | ((src[i + 1] ?? 0) << 8);
    i += 2;
    const match = length(token & 15) + 4;
    for (let k = 0; k < match; k += 1) out[o + k] = out[o - offset + k] ?? 0;
    o += match;
  }
  return out.subarray(0, o);
}

/** Every leaf of a JSON value, keyed by its path. */
/** A JSON value as it is compared: numbers by kind, keys in order, arrays as sets. Used to order array items. */
const canonical = (value: unknown): string =>
  typeof value === "number"
    ? "#"
    : Array.isArray(value)
      ? `[${value.map(canonical).sort().join(",")}]`
      : typeof value === "object" && value !== null
        ? `{${Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
            .join(",")}}`
        : JSON.stringify(value);

/**
 * Every leaf of a JSON value, keyed by its path. An array is a set: its items are taken in the order of their content,
 * so a list the browser writes in a different order each run (its add-ons, its tabs' entries) reads the same.
 */
function jsonEntries(value: unknown, path = "$", out: Record<string, Group> = {}): Entries {
  if (Array.isArray(value))
    value
      .map((item) => [canonical(item), item] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .forEach(([, item], i) => jsonEntries(item, `${path}[${String(i)}]`, out));
  else if (typeof value === "object" && value !== null)
    for (const [key, item] of Object.entries(value)) jsonEntries(item, `${path}.${key}`, out);
  else out[path] = single(JSON.stringify(value));
  return out;
}

const PREF_LINE = /^user_pref\("((?:[^"\\]|\\.)*)",\s*(.*)\);\s*$/u;

/** One group per pref a prefs.js-style file sets, or null when the text sets none. */
function prefEntries(text: string): Entries | null {
  const out: Record<string, Group> = {};
  for (const line of text.split("\n")) {
    const m = PREF_LINE.exec(line);
    if (m !== null) out[`pref ${m[1] ?? ""}`] = single(m[2] ?? "");
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Every row of every table, read from a copy so the browser's journal and write-ahead log are applied and the run's
 * own files stay untouched; each cell is a short digest of its value with run names replaced. Then the copy is fully
 * checkpointed, so its header counts every page, and the bytes past its last page are counted.
 */
function sqliteRead(path: string, names: RunNames): Pick<Structured, "entries" | "unaccounted"> {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-sqlite-"));
  try {
    const copy = NodePath.join(dir, "db");
    NodeFS.copyFileSync(path, copy);
    for (const suffix of ["-wal", "-journal"]) {
      if (NodeFS.existsSync(path + suffix)) NodeFS.copyFileSync(path + suffix, copy + suffix);
    }
    const db = new NodeSqlite.DatabaseSync(copy);
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[];
      // A blob (a compressed structured clone, a key) is opaque, so it is compared by its kind like a number.
      const cell = (value: unknown): string =>
        typeof value === "number" || typeof value === "bigint"
          ? "#"
          : value instanceof Uint8Array
            ? "blob"
            : value === null || value === undefined
              ? "null"
              : valueDigest(withRoles(String(value), names));
      const entries = Object.fromEntries(
        tables.map(({ name }) => {
          const quoted = `"${name.replaceAll('"', '""')}"`;
          const fields = (
            db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string }[]
          ).map((c) => c.name);
          const rows = db.prepare(`SELECT * FROM ${quoted}`).all() as Record<string, unknown>[];
          return [
            `table ${name}`,
            { fields, rows: rows.map((row) => fields.map((f) => cell(row[f]))) },
          ];
        }),
      );
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      // SQLite's own page count, which it reads from the header only when the header is current.
      const { page_count: pages } = db.prepare("PRAGMA page_count").get() as { page_count: number };
      const { page_size: size } = db.prepare("PRAGMA page_size").get() as { page_size: number };
      db.close();
      return { entries, unaccounted: Math.max(0, NodeFS.statSync(copy).size - pages * size) };
    } finally {
      if (db.isOpen) db.close();
    }
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

/** A file's text: a mozlz4 file's decompressed JSON, any other file's bytes as UTF-8. */
export function contentText(bytes: Buffer): string {
  return bytes.subarray(0, 8).toString("latin1") === MOZLZ4_MAGIC && bytes.length >= 12
    ? lz4Block(bytes.subarray(12), bytes.readUInt32LE(8)).toString("utf8")
    : bytes.toString("utf8");
}

/**
 * Reads a file's entries by its format, found from its bytes, never its name: a SQLite database, a mozlz4 JSON
 * file, a JSON file, or a file of prefs. Null for any other file, which is compared by digest alone.
 */
export function readStructured(path: string, bytes: Buffer, names: RunNames): Structured | null {
  const head = bytes.subarray(0, 16).toString("latin1");
  if (head === SQLITE_MAGIC && bytes.length >= 100) {
    try {
      return { format: "sqlite", ...sqliteRead(path, names) };
    } catch {
      return null;
    }
  }
  const named = withRoles(contentText(bytes), names);
  if (/^\s*[[{]/u.test(named)) {
    try {
      return { format: "json", entries: jsonEntries(JSON.parse(named)), unaccounted: 0 };
    } catch {
      // Not JSON after all; it may still set prefs.
    }
  }
  const prefs = prefEntries(named);
  return prefs === null ? null : { format: "prefs", entries: prefs, unaccounted: 0 };
}

/** A group's path, segment by segment: a JSON leaf by its keys and indexes, any other group as one segment. */
const segments = (group: string): readonly string[] =>
  group.startsWith("$") ? (group.slice(1).match(/\.[^.[]+|\[\d+\]/gu) ?? []) : [group];

/** For every container path, the names of its children, across a file's groups. */
function children(entries: Entries): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const group of Object.keys(entries)) {
    const parts = segments(group);
    parts.forEach((part, i) => {
      const parent = parts.slice(0, i).join("");
      out.set(parent, (out.get(parent) ?? new Set()).add(part));
    });
  }
  return out;
}

/**
 * Whether a group neither control run has is the browser's: true when the nearest container both control runs hold
 * has children that differ between them (the browser names them at random), and the product run holds no more of
 * them than either control run does.
 */
function noisyNewGroup(
  group: string,
  product: Entries,
  controls: readonly [Entries, Entries],
): boolean {
  const [a, b, p] = [children(controls[0]), children(controls[1]), children(product)];
  const parts = segments(group);
  for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
    const parent = parts.slice(0, depth).join("");
    const [ca, cb] = [a.get(parent), b.get(parent)];
    if (ca === undefined || cb === undefined) continue;
    const same = ca.size === cb.size && [...ca].every((c) => cb.has(c));
    return !same && (p.get(parent)?.size ?? 0) <= Math.max(ca.size, cb.size);
  }
  return false;
}

/**
 * Every record the product run holds beyond both control runs, as `<group>: <n> records` lines. A field whose values
 * differ between the two control runs is the browser's noise and is left out of the comparison; a record the product
 * run holds more often than either control run is the product's.
 */
export function entriesBeyond(
  product: Entries,
  controls: readonly [Entries, Entries],
): readonly string[] {
  const [first, second] = controls;
  return Object.entries(product).flatMap(([group, records]): string[] => {
    const a = first[group];
    const b = second[group];
    if (a === undefined && b === undefined)
      // A new entry holding only numbers and flags is the browser's own bookkeeping: recorded data is text.
      return noisyNewGroup(group, product, controls) || !records.rows.some(holdsText)
        ? []
        : [`${group}: in neither control run`];
    if (a === undefined || b === undefined) return [];
    const fields = [...new Set([...a.fields, ...b.fields, ...records.fields])].sort();
    const column = (g: Group, f: string): readonly string[] => {
      const i = g.fields.indexOf(f);
      return g.rows.map((row) => row[i] ?? "");
    };
    const values = (g: Group, f: string): string => [...column(g, f)].sort().join(",");
    const stable = fields.filter((f) => values(a, f) === values(b, f));
    // Every control record counts; of the product's, only those holding text can be the product's data.
    const counts = (g: Group, textOnly: boolean): Map<string, number> => {
      const columns = stable.map((f) => column(g, f));
      const m = new Map<string, number>();
      g.rows.forEach((row, r) => {
        if (textOnly && !holdsText(row)) return;
        const key = columns.map((c) => c[r]).join("|");
        m.set(key, (m.get(key) ?? 0) + 1);
      });
      return m;
    };
    const [ca, cb, cp] = [counts(a, false), counts(b, false), counts(records, true)];
    const extra = [...cp].reduce(
      (sum, [key, n]) => sum + Math.max(0, n - Math.max(ca.get(key) ?? 0, cb.get(key) ?? 0)),
      0,
    );
    return extra > 0 ? [`${group}: ${String(extra)} records in neither control run`] : [];
  });
}
