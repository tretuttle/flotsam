import * as NodeCrypto from "node:crypto";
import type { ExtraCheckId } from "./probe-table.ts";

/** One run of an extra check: its id, whether it held, and what was seen. */
export type ExtraCheckResult = {
  readonly id: ExtraCheckId;
  readonly ok: boolean;
  readonly detail: string;
};

/** What an attacker can know or guess about a profile without the key file. */
export type KeySources = {
  readonly profileDir: string;
  readonly userName: string;
  readonly hostName: string;
  readonly dataHome: string;
  readonly addonId: string;
  readonly addonUuid: string;
};

export type KeyGuess = { readonly from: string; readonly key: string };

const HASHES = ["md5", "sha1", "sha256", "sha384", "sha512"] as const;
const KEY_HEX = /^[0-9a-f]{32}$/u;

/**
 * Every 32-hex name a product could plausibly derive from what a page or another extension can learn: each source,
 * its last path segment, and each hash of them, first and last 32 digits. The key oracle and the guessed-path
 * probes both read this list, so a derived key is caught twice: by name here and by existence in the browser.
 */
export function keyDerivations(sources: KeySources): readonly KeyGuess[] {
  const named: [string, string][] = [];
  for (const [label, value] of Object.entries(sources)) {
    named.push([label, value], [`${label} name`, value.split(/[\\/]/u).findLast(Boolean) ?? value]);
  }
  const guesses = new Map<string, string>();
  const add = (from: string, hex: string): void => {
    for (const key of [hex.slice(0, 32), hex.slice(-32)]) {
      if (KEY_HEX.test(key) && !guesses.has(key)) guesses.set(key, from);
    }
  };
  for (const [label, value] of named) {
    add(`${label} as hex`, Buffer.from(value, "utf8").toString("hex"));
    add(`${label} without dashes`, value.toLowerCase().replaceAll("-", ""));
    for (const hash of HASHES) {
      add(`${hash}(${label})`, NodeCrypto.createHash(hash).update(value).digest("hex"));
    }
  }
  return [...guesses].map(([key, from]) => ({ key, from }));
}

/** The key file's text: 32 lowercase hex digits, one trailing newline allowed. */
function parseKeyFileText(text: string): string | null {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return KEY_HEX.test(body) ? body : null;
}

export type KeyEvidence = {
  readonly keyFileText: string;
  readonly keyFileMode: number;
  /** Names directly under the app folder. */
  readonly appFolderNames: readonly string[];
  readonly sources: KeySources;
  /** The key a second fresh profile got, with what that profile exposes, or why there is none. */
  readonly second:
    | { readonly keyFileText: string; readonly sources: KeySources }
    | { readonly missing: string };
};

/** The independent key oracle: format, mode, the folder it names, uniqueness across profiles, and no derivation. */
function judgeArchiveKey(evidence: KeyEvidence): readonly ExtraCheckResult[] {
  const key = parseKeyFileText(evidence.keyFileText);
  const second = "missing" in evidence.second ? null : evidence.second;
  const secondKey = second === null ? null : parseKeyFileText(second.keyFileText);
  const derivedFrom = (candidate: string | null, sources: KeySources): string | null =>
    keyDerivations(sources).find((guess) => guess.key === candidate)?.from ?? null;
  const firstDerived = derivedFrom(key, evidence.sources);
  const secondDerived = second === null ? null : derivedFrom(secondKey, second.sources);
  return [
    {
      id: "key-file-format",
      ok: key !== null,
      detail: `key file text ${JSON.stringify(evidence.keyFileText.slice(0, 80))}`,
    },
    {
      id: "key-file-mode",
      ok: evidence.keyFileMode === 0o600,
      detail: `key file mode ${evidence.keyFileMode.toString(8)}`,
    },
    {
      id: "key-names-the-archive",
      ok: evidence.appFolderNames.length === 1 && evidence.appFolderNames[0] === key,
      detail: `app folder holds ${JSON.stringify(evidence.appFolderNames)}, key file names ${String(key)}`,
    },
    {
      id: "key-differs-across-profiles",
      ok: key !== null && secondKey !== null && key !== secondKey,
      detail:
        "missing" in evidence.second
          ? `no second key: ${evidence.second.missing}`
          : `first ${String(key)}, second ${String(secondKey)}`,
    },
    {
      id: "key-not-derived",
      ok: key !== null && secondKey !== null && firstDerived === null && secondDerived === null,
      detail:
        firstDerived !== null || secondDerived !== null
          ? `key equals ${String(firstDerived ?? secondDerived)}`
          : `checked against ${String(keyDerivations(evidence.sources).length)} derivations per profile`,
    },
  ];
}

/** A path the product wrote, relative to the app folder; "." is the app folder itself. */
export type WrittenEntry = { readonly path: string; readonly kind: "directory" | "file" };

const insideKey = (path: string, key: string): boolean =>
  path === key || path.startsWith(`${key}/`);

/** Every written path whose name an attacker can guess: anything under the app folder outside the key folder. */
export function outsideKeyFolder(entries: readonly WrittenEntry[], key: string): readonly string[] {
  return entries.filter((e) => e.path !== "." && !insideKey(e.path, key)).map((e) => e.path);
}

/** Depth below the app folder, and `directory` or the file's last extension: `5 body`, `5 jsonl`, `2 json`. */
const kindOf = (entry: WrittenEntry): string =>
  `${String(entry.path.split("/").length)} ${entry.kind === "directory" ? "directory" : (/\.([^./]*)$/u.exec(entry.path)?.[1] ?? "(none)")}`;

/**
 * Paths present at the end of the run that no probe targeted. Traffic during the run adds lines, bodies and site
 * folders, which are covered when a planned target of the same kind sat inside the key folder. A new kind of file, or
 * anything new outside the key folder, was never probed and fails.
 */
function untargetedWrites(
  planned: readonly WrittenEntry[],
  final: readonly WrittenEntry[],
  key: string,
): readonly string[] {
  const targeted = new Set(planned.map((e) => e.path));
  const targetedKinds = new Set(
    planned.filter((e) => insideKey(e.path, key)).map((e) => kindOf(e)),
  );
  return final
    .filter((e) => !targeted.has(e.path))
    .filter((e) => !insideKey(e.path, key) || !targetedKinds.has(kindOf(e)))
    .map((e) => e.path);
}

/** Everything the archive rules read: the key evidence and the written paths at plan time and at the end. */
export type ArchiveEvidence = KeyEvidence & {
  readonly planned: readonly WrittenEntry[];
  readonly final: readonly WrittenEntry[];
};

/** The key oracle, the predictable-path rule, and coverage of every written path, as extra check results. */
export function judgeArchive(evidence: ArchiveEvidence): readonly ExtraCheckResult[] {
  const key = parseKeyFileText(evidence.keyFileText) ?? "";
  const outside = outsideKeyFolder([...evidence.planned, ...evidence.final], key);
  const untargeted = untargetedWrites(evidence.planned, evidence.final, key);
  return [
    ...judgeArchiveKey(evidence),
    {
      id: "nothing-outside-key-folder",
      ok: outside.length === 0,
      detail:
        outside.length === 0
          ? "only the key folder"
          : `outside the key folder: ${[...new Set(outside)].join(", ")}`,
    },
    {
      id: "written-paths-targeted",
      ok: untargeted.length === 0,
      detail:
        untargeted.length === 0
          ? `${String(evidence.planned.length)} planned entries cover ${String(evidence.final.length)} final entries`
          : `written but never probed: ${untargeted.join(", ")}`,
    },
  ];
}
