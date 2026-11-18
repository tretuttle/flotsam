import * as NodeURL from "node:url";
import type { ExtraCheckResult } from "./archive-oracle.ts";
import type { Judged } from "./judge.ts";
import { expandExpectedRows, type Position } from "./probe-table.ts";

// The one resource:// name the product may register, and the four rules it is held to. A ChromeWorker starts only
// from a chrome:// or resource:// URL, so the export's file worker needs one; docs/internals/browser-harness.md has
// the decision. Anything wider than this one name into the add-on's own packed code fails a row.

/** The only resource:// host the product may register. */
export const WORKER_HOST = "one-click-har";

/** The probe that loads every enumerated resource:// name from every unprivileged position. */
const REACH_PROBE = "resource-all";

export type Substitution = {
  readonly name: string;
  readonly resolved: string;
  /** Whether the resource handler lets content load it; null when that could not be read. */
  readonly contentAccess: boolean | null;
};

/** A call in a packed script that registers a scheme name, or removes one (`setSubstitution(name, null)`). */
export type Registration = {
  readonly file: string;
  readonly call: string;
  readonly removes: boolean;
};

export type SubstitutionEvidence = {
  /** The product's root as the browser installed it: `jar:file:///…/<id>.xpi!/`, or a `file:` folder unpacked. */
  readonly addonRoot: string;
  readonly packedFiles: readonly string[];
  /** Paths the packed scripts build after `resource://<host>/`: the files the name is there to serve. */
  readonly servedPaths: readonly string[];
  readonly profileDir: string;
  readonly dataHome: string;
  /** Every substitution the product run enumerated before the probes and after them. */
  readonly start: readonly Substitution[];
  readonly end: readonly Substitution[];
  /** `name -> resolved` for every substitution the control runs enumerated with the same candidate names. */
  readonly control: readonly string[];
  readonly registrations: readonly Registration[];
  /** In a second profile, the candidate names registered while the add-on ran, and once it was disabled. */
  readonly shutdown:
    | { readonly before: readonly string[]; readonly after: readonly string[] }
    | { readonly missing: string };
};

/** How the row of `probe` judged one URL from one position. */
export type ReachVerdict = (probe: string, url: string, position: Position) => Judged;

export const substitutionLine = (s: Pick<Substitution, "name" | "resolved">): string =>
  `resource://${s.name}/ -> ${s.resolved}`;

/** The substitutions the product run had that neither control run had: the product's own. */
export function productSubstitutions(e: SubstitutionEvidence): readonly Substitution[] {
  const control = new Set(e.control);
  const seen = new Set<string>();
  return [...e.start, ...e.end].filter((s) => {
    const line = substitutionLine(s);
    if (control.has(line) || seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

/** The allowed name, resolving into the add-on's own root. Every other line stays under the scheme rules. */
export const isWorkerSubstitution = (
  s: Pick<Substitution, "name" | "resolved">,
  addonRoot: string,
): boolean => s.name === WORKER_HOST && addonRoot.length > 0 && s.resolved.startsWith(addonRoot);

/** The local file or folder a resolved URL reads: the archive of a `jar:` URL, the path of a `file:` one. */
function localPath(resolved: string): string | null {
  const jar = /^jar:(file:[^!]+)!/u.exec(resolved);
  const url = jar?.[1] ?? (resolved.startsWith("file:") ? resolved : null);
  if (url === null) return null;
  try {
    return NodeURL.fileURLToPath(url).replace(/(.)\/$/u, "$1");
  } catch {
    return null;
  }
}

const within = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);

function nameProblems(product: readonly Substitution[]): readonly string[] {
  return [...new Set(product.map((s) => s.name))]
    .filter((name) => name !== WORKER_HOST)
    .map(
      (name) =>
        `resource://${name}/ is registered by the product; only resource://${WORKER_HOST}/ is allowed`,
    );
}

function targetProblems(
  e: SubstitutionEvidence,
  product: readonly Substitution[],
): readonly string[] {
  return product.flatMap((s) => {
    const line = substitutionLine(s);
    const path = localPath(s.resolved);
    const problems: string[] = [];
    if (e.addonRoot.length === 0 || !s.resolved.startsWith(e.addonRoot))
      problems.push(`${line}: outside the add-on's own root ${e.addonRoot}`);
    if (path === null) problems.push(`${line}: not a local file or archive`);
    else {
      if (path === e.profileDir) problems.push(`${line}: the profile root`);
      if (within(e.profileDir, path) && path !== e.profileDir)
        problems.push(`${line}: a folder that holds the profile`);
      if (within(path, e.dataHome) || within(e.dataHome, path))
        problems.push(`${line}: the data home, which holds the archive`);
    }
    // The name is there to serve the files the packed scripts build URLs for; each must be a packed file through it.
    const inner = s.resolved.slice(e.addonRoot.length);
    if (e.servedPaths.length === 0)
      problems.push(`${line}: no packed script builds a URL under it`);
    for (const served of e.servedPaths)
      if (!e.packedFiles.includes(`${inner}${served}`))
        problems.push(`${line}: ${served} is not a packed file through it`);
    return problems;
  });
}

/** Every position the run has a resource-all row for: cs-file only when a content script ran in a file page. */
const reachPositions = (csFileInjected: boolean): readonly Position[] =>
  expandExpectedRows(csFileInjected)
    .filter((r) => r.id === REACH_PROBE)
    .map((r) => r.position);

function reachProblems(
  product: readonly Substitution[],
  verdictOf: ReachVerdict,
  positions: readonly Position[],
): readonly string[] {
  if (product.length > 0 && positions.length === 0) return [`no ${REACH_PROBE} positions`];
  return product.flatMap((s) => {
    const url = `resource://${s.name}/`;
    return [
      ...(s.contentAccess === true ? [`${url}: flagged for content access`] : []),
      ...(s.contentAccess === null ? [`${url}: content access could not be read`] : []),
      ...positions.flatMap((position) => {
        const { verdict, line } = verdictOf(REACH_PROBE, url, position);
        return verdict === "BLOCKED" ? [] : [`${url} from ${position}: ${verdict} ${line}`];
      }),
    ];
  });
}

function lifetimeProblems(
  e: SubstitutionEvidence,
  product: readonly Substitution[],
): readonly string[] {
  const other = e.registrations.filter((r) => r.call !== "setSubstitution");
  const registers = e.registrations.filter((r) => r.call === "setSubstitution" && !r.removes);
  const removes = e.registrations.filter((r) => r.call === "setSubstitution" && r.removes);
  const startLines = new Set(e.start.map(substitutionLine));
  const endLines = new Set(e.end.map(substitutionLine));
  const names = [...new Set(product.map((s) => s.name))];
  const shutdown = e.shutdown;
  return [
    ...other.map((r) => `${r.file}: ${r.call}`),
    ...(product.length > 0 && registers.length !== 1
      ? [`${String(registers.length)} setSubstitution calls register a name, expected one`]
      : []),
    ...(product.length > 0 && removes.length !== 1
      ? [`${String(removes.length)} setSubstitution calls remove a name, expected one`]
      : []),
    ...product.flatMap((s) => {
      const line = substitutionLine(s);
      if (!startLines.has(line)) return [`${line}: registered after the probes started`];
      if (!endLines.has(line)) return [`${line}: gone or changed by the end of the probes`];
      return [];
    }),
    ...("missing" in shutdown
      ? names.length > 0
        ? [`shutdown not observed: ${shutdown.missing}`]
        : []
      : names.flatMap((name) => [
          ...(shutdown.before.includes(name)
            ? []
            : [`resource://${name}/ was not registered in a second profile`]),
          ...(shutdown.after.includes(name)
            ? [`resource://${name}/ is still registered after the add-on shut down`]
            : []),
        ])),
  ];
}

const row = (
  id: ExtraCheckResult["id"],
  problems: readonly string[],
  fine: string,
): ExtraCheckResult => ({
  id,
  ok: problems.length === 0,
  detail: problems.length === 0 ? fine : problems.join("; "),
});

/** The allowance, one row per condition: name, target, reach and lifetime. */
export function judgeSubstitutions(
  e: SubstitutionEvidence,
  verdictOf: ReachVerdict,
  csFileInjected: boolean,
): readonly ExtraCheckResult[] {
  const product = productSubstitutions(e);
  const positions = reachPositions(csFileInjected);
  const shown = product.map(substitutionLine).join(", ") || "none";
  return [
    row(
      "substitution-name",
      nameProblems(product),
      product.length === 0 ? "the product registers no substitution" : `only ${shown}`,
    ),
    row(
      "substitution-target",
      targetProblems(e, product),
      `${shown}: inside the add-on's own packed files, serving ${e.servedPaths.join(", ") || "nothing"}`,
    ),
    row(
      "substitution-reach",
      reachProblems(product, verdictOf, positions),
      `${shown}: no content access, ${REACH_PROBE} BLOCKED from ${positions.join(", ")}`,
    ),
    row(
      "substitution-lifetime",
      lifetimeProblems(e, product),
      `${shown}: one register and one remove call, the same before and after the probes, gone once the add-on shut down`,
    ),
  ];
}
