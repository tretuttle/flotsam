// The only user-editable state. No field turns recording off.

import { isFields } from "./fields.ts";
import { parseSite, type ByteCount, type Site } from "./ids.ts";

export interface UserSettings {
  readonly version: 1;
  readonly retention: {
    /** Packs plus body files across all sites, open files included. Oldest first, never past a pinned file. */
    readonly maxBodyBytes: ByteCount;
    /** Log segments and summaries, open ones included. Request details outlive bodies. */
    readonly maxDetailBytes: ByteCount;
    readonly maxAgeDays: number;
  };
  readonly excludedSites: readonly Site[];
  readonly media: "details-only" | "keep-bodies";
  /** "never-store" drops Cookie, Set-Cookie, Authorization and other secret header values, and request bodies, at capture. */
  readonly secretStorage: "store" | "never-store";
  readonly exportDefaults: {
    readonly bodies: "include" | "omit";
    readonly secrets: "remove" | "keep";
  };
}

/** Where exports are written. The parent keeps the path; extension pages see only `label`. The path passed guardFolder. */
export type ExportFolder =
  | { readonly kind: "downloads" }
  | { readonly kind: "chosen"; readonly path: string; readonly label: string };

/** settings.json. Only the parent reads and writes it, always through settings.json.tmp and a rename. */
export interface StoredSettings {
  readonly user: UserSettings;
  readonly exportFolder: ExportFolder;
}

const MiB = 1_048_576;

/** Coordinator decision (DECISIONS.md): 5 GiB of bodies, 1 GiB of request details, 14 days. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  version: 1,
  retention: {
    maxBodyBytes: (5 * 1024 * MiB) as ByteCount,
    maxDetailBytes: (1024 * MiB) as ByteCount,
    maxAgeDays: 14,
  },
  excludedSites: [],
  media: "details-only",
  secretStorage: "store",
  exportDefaults: { bodies: "include", secrets: "remove" },
};

/** The smallest values a parser accepts: a lower value is raised to these, so a typo cannot empty the archive. */
const SETTINGS_FLOORS = {
  maxBodyBytes: 64 * MiB,
  maxDetailBytes: 16 * MiB,
  maxAgeDays: 1,
} as const;

/**
 * What setSettings accepts. The site list is not in it: excludeSite and includeSite own that list, because excluding
 * also deletes the site's data (coordinator decision), and one task gets one way.
 */
export type EditableSettings = Omit<UserSettings, "excludedSites">;

const oneOf = <T extends string>(raw: unknown, values: readonly T[]): T | null =>
  values.find((v) => v === raw) ?? null;
const atLeast = (raw: unknown, floor: number): number | null =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? Math.max(raw, floor) : null;

/** The one parser for setSettings input. Raises values below SETTINGS_FLOORS; rejects unknown versions and wrong types. */
export function parseEditableSettings(raw: unknown): EditableSettings | null {
  if (!isFields(raw) || raw["version"] !== 1) return null;
  const { retention, exportDefaults } = raw;
  if (!isFields(retention) || !isFields(exportDefaults)) return null;
  const maxBodyBytes = atLeast(retention["maxBodyBytes"], SETTINGS_FLOORS.maxBodyBytes);
  const maxDetailBytes = atLeast(retention["maxDetailBytes"], SETTINGS_FLOORS.maxDetailBytes);
  const maxAgeDays = atLeast(retention["maxAgeDays"], SETTINGS_FLOORS.maxAgeDays);
  const media = oneOf(raw["media"], ["details-only", "keep-bodies"] as const);
  const secretStorage = oneOf(raw["secretStorage"], ["store", "never-store"] as const);
  const bodies = oneOf(exportDefaults["bodies"], ["include", "omit"] as const);
  const secrets = oneOf(exportDefaults["secrets"], ["remove", "keep"] as const);
  if (maxBodyBytes === null || maxDetailBytes === null || maxAgeDays === null) return null;
  if (media === null || secretStorage === null || bodies === null || secrets === null) return null;
  return {
    version: 1,
    retention: {
      maxBodyBytes: maxBodyBytes as ByteCount,
      maxDetailBytes: maxDetailBytes as ByteCount,
      maxAgeDays,
    },
    media,
    secretStorage,
    exportDefaults: { bodies, secrets },
  };
}

function parseExportFolder(raw: unknown): ExportFolder | null {
  if (!isFields(raw)) return null;
  if (raw["kind"] === "downloads") return { kind: "downloads" };
  const { path, label } = raw;
  return raw["kind"] === "chosen" &&
    typeof path === "string" &&
    path !== "" &&
    typeof label === "string"
    ? { kind: "chosen", path, label }
    : null;
}

/**
 * The one parser for settings.json. One excluded site that does not parse rejects the whole file: dropping it would
 * start recording a site the user excluded. The host renames a rejected file aside and loads defaults (crash row 11).
 */
export function parseStoredSettings(raw: unknown): StoredSettings | null {
  if (!isFields(raw) || !isFields(raw["user"])) return null;
  const editable = parseEditableSettings(raw["user"]);
  const excludedRaw = raw["user"]["excludedSites"];
  const exportFolder = parseExportFolder(raw["exportFolder"]);
  if (editable === null || exportFolder === null || !Array.isArray(excludedRaw)) return null;
  const excludedSites = new Set<Site>();
  for (const entry of excludedRaw) {
    const site = parseSite(entry);
    if (site === null) return null;
    excludedSites.add(site);
  }
  return { user: { ...editable, excludedSites: [...excludedSites] }, exportFolder };
}
