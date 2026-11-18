import * as NodeURL from "node:url";
import type { ExtraCheckResult } from "./archive-oracle.ts";
import type { Judged } from "./judge.ts";
import { expandExpectedRows, type Position } from "./probe-table.ts";

// The one resource:// name the product may register, and the four rules it is held to. A ChromeWorker starts only
// from a chrome:// or resource:// URL, so the export's file worker needs one; docs/internals/browser-harness.md has
// the decision. Gecko lists no substitutions, so the names come from what the product did while a watcher wrapped its
// way to the resource handler, and from the table asked for every name the run knows, before and after.

/** The only resource:// host the product may register. */
export const WORKER_HOST = "one-click-har";

/** nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS. */
const ALLOW_CONTENT_ACCESS = 1;

/** The probe that loads each name's root from every unprivileged position. */
const ROOT_PROBE = "resource-all";
/** The probe that loads every packed file through each of the product's names, by fetch, XHR, link and script. */
export const FILES_PROBE = "resource-product-files";

export type Substitution = {
  readonly name: string;
  readonly resolved: string;
  /** Whether the resource handler lets content load it; null when that could not be read. */
  readonly contentAccess: boolean | null;
};

/** One registration call the watcher saw, and the table's entry for the name right after it. */
export type WatchedCall = {
  /** What the run was doing: the watcher's phase when the call came. */
  readonly phase: string;
  readonly method: string;
  readonly name: string;
  /** The URL passed; null removes the name. */
  readonly target: string | null;
  readonly flags: number | null;
  /** Whether a script of the add-on was on the caller's stack. */
  readonly product: boolean;
  readonly after: Substitution | null;
  readonly error: string | null;
};

export type Watch = {
  readonly calls: readonly WatchedCall[];
  /** URLs the add-on started a ChromeWorker from. */
  readonly workers: readonly {
    readonly phase: string;
    readonly url: string;
    readonly product: boolean;
  }[];
  /** Each extension global the watcher wrapped: one present when it attached, or one made after. */
  readonly globals: readonly { readonly phase: string; readonly how: "existing" | "created" }[];
  readonly problems: readonly string[];
};

/** Where one profile keeps the add-on, the profile and the data home. */
export type Place = {
  /** The product's root as the browser installed it: `jar:file:///…/<id>.xpi!/`, or a `file:` folder unpacked. */
  readonly addonRoot: string;
  readonly profileDir: string;
  readonly dataHome: string;
};

/**
 * A second profile that watched the add-on from its first line: disabled, enabled again under the watcher, run
 * through an export, and disabled. The table holds every name that profile knows, at each stop.
 */
export type Lifecycle =
  | {
      readonly place: Place;
      readonly watch: Watch;
      readonly stopped: readonly Substitution[];
      readonly running: readonly Substitution[];
      readonly after: readonly Substitution[];
    }
  | { readonly missing: string };

export type SubstitutionEvidence = {
  readonly place: Place;
  readonly packedFiles: readonly string[];
  /** Every substitution the product run enumerated before the probes and after them. */
  readonly start: readonly Substitution[];
  readonly end: readonly Substitution[];
  /** `substitutionLine` of every substitution the control runs enumerated with the same candidate names. */
  readonly control: readonly string[];
  /** The product run's watcher, attached once the browser was up. */
  readonly run: Watch;
  readonly lifecycle: Lifecycle;
};

/** How the row of `probe` judged one URL from one position. */
export type ReachVerdict = (probe: string, url: string, position: Position) => Judged;

/** One table entry as a comparable line; its content access is part of it, so a flag flipped later is a change. */
export const substitutionLine = (s: Substitution): string =>
  `resource://${s.name}/ -> ${s.resolved}${s.contentAccess === false ? "" : `, content access ${String(s.contentAccess)}`}`;

/** The substitutions the product run had that neither control run had. */
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

/** Why a target is not inside the add-on's own files, empty when it is. */
function placeProblems(target: string, place: Place): readonly string[] {
  const path = localPath(target);
  return [
    ...(place.addonRoot.length === 0 || !target.startsWith(place.addonRoot)
      ? [`outside the add-on's own root ${place.addonRoot}`]
      : []),
    ...(path === null
      ? ["not a local file or archive"]
      : [
          ...(path === place.profileDir ? ["the profile root"] : []),
          ...(within(place.profileDir, path) && path !== place.profileDir
            ? ["a folder that holds the profile"]
            : []),
          ...(within(path, place.dataHome) || within(place.dataHome, path)
            ? ["the data home, which holds the archive"]
            : []),
        ]),
  ];
}

/** Something the run saw of one name: its target and content access, where it was seen, and in which profile. */
type Sighting = {
  readonly name: string;
  readonly target: string | null;
  readonly contentAccess: boolean | null;
  readonly flags: number | null;
  readonly where: string;
  readonly place: Place;
};

const lifecycleOf = (e: SubstitutionEvidence) => ("missing" in e.lifecycle ? null : e.lifecycle);

const productCalls = (watch: Watch): readonly WatchedCall[] => watch.calls.filter((c) => c.product);

function sightings(e: SubstitutionEvidence): readonly Sighting[] {
  const life = lifecycleOf(e);
  const fromCalls = (watch: Watch, place: Place, profile: string): readonly Sighting[] =>
    productCalls(watch).map((c) => ({
      name: c.name,
      target: c.after?.resolved ?? c.target,
      contentAccess: c.after?.contentAccess ?? (c.target === null ? false : null),
      flags: c.flags,
      where: `${c.method} in the ${profile} (${c.phase})`,
      place,
    }));
  const fromTable = (subs: readonly Substitution[], place: Place, where: string) =>
    subs.map((s) => ({
      name: s.name,
      target: s.resolved,
      contentAccess: s.contentAccess,
      flags: null,
      where,
      place,
    }));
  const run = fromCalls(e.run, e.place, "product run");
  const table = fromTable(productSubstitutions(e), e.place, "the product run's table");
  if (life === null) return [...run, ...table];
  const names = new Set(productCalls(life.watch).map((c) => c.name));
  return [
    ...run,
    ...table,
    ...fromCalls(life.watch, life.place, "watched start"),
    ...fromTable(
      life.running.filter((s) => names.has(s.name)),
      life.place,
      "the watched start's table after the export",
    ),
  ];
}

/** A target in the add-on's own files, the profile, a folder holding it, or the data home: none is the browser's. */
function productPlace(target: string, place: Place): boolean {
  const path = localPath(target);
  return (
    (place.addonRoot.length > 0 && target.startsWith(place.addonRoot)) ||
    (path !== null &&
      [place.profileDir, place.dataHome].some((dir) => within(path, dir) || within(dir, path)))
  );
}

/** Table entries in a product place that changed while watched, with no product call the watcher saw for the name. */
function unexplained(e: SubstitutionEvidence): readonly string[] {
  const explained = (watch: Watch, s: Substitution) =>
    productCalls(watch).some((c) => c.name === s.name);
  const runStart = new Set([...e.start.map(substitutionLine), ...e.control]);
  const runChanged = e.end
    .filter(
      (s) =>
        !runStart.has(substitutionLine(s)) &&
        !explained(e.run, s) &&
        productPlace(s.resolved, e.place),
    )
    .map(
      (s) => `${substitutionLine(s)} changed during the product run with no call the watcher saw`,
    );
  const life = lifecycleOf(e);
  if (life === null) return runChanged;
  const stopped = new Set(life.stopped.map(substitutionLine));
  const lifeAppeared = [...life.running, ...life.after]
    .filter(
      (s) =>
        !stopped.has(substitutionLine(s)) &&
        !explained(life.watch, s) &&
        productPlace(s.resolved, life.place),
    )
    .map(
      (s) => `${substitutionLine(s)} appeared in the watched start with no call the watcher saw`,
    );
  return [...new Set([...runChanged, ...lifeAppeared])];
}

/** Why the watchers' evidence cannot be trusted: one never reached the add-on's global, or failed to install. */
function watchProblems(e: SubstitutionEvidence): readonly string[] {
  const life = lifecycleOf(e);
  return [
    ...e.run.problems.map((p) => `product run watcher: ${p}`),
    ...(e.run.globals.some((g) => g.how === "existing")
      ? []
      : ["the product run's watcher found no add-on global to wrap"]),
    ...(life === null
      ? [
          `the add-on's watched start and shutdown were not observed: ${String((e.lifecycle as { missing: string }).missing)}`,
        ]
      : [
          ...life.watch.problems.map((p) => `watched start: ${p}`),
          ...(life.watch.globals.some((g) => g.how === "created" && g.phase === "start")
            ? []
            : ["the watched start wrapped no global made when the add-on started"]),
        ]),
  ];
}

/** Every name the product registered, by any account: a call the watcher saw, or the table against the controls. */
const productNames = (seen: readonly Sighting[]): readonly string[] =>
  [...new Set(seen.map((s) => s.name))].sort();

function nameProblems(e: SubstitutionEvidence, names: readonly string[]): readonly string[] {
  return [
    ...names
      .filter((name) => name !== WORKER_HOST)
      .map(
        (name) =>
          `resource://${name}/ is registered by the product; only resource://${WORKER_HOST}/ is allowed`,
      ),
    ...unexplained(e),
    ...watchProblems(e),
  ];
}

/** The packed files a name serves, as URLs through it: only for a name into the add-on's own root. */
export function filesThrough(
  name: string,
  resolved: string,
  addonRoot: string,
  packedFiles: readonly string[],
): readonly string[] {
  if (addonRoot.length === 0 || !resolved.startsWith(addonRoot)) return [];
  const inner = resolved.slice(addonRoot.length);
  return packedFiles
    .filter((f) => f.startsWith(inner) && f.length > inner.length)
    .map((f) => `resource://${name}/${f.slice(inner.length)}`);
}

function targetProblems(
  e: SubstitutionEvidence,
  seen: readonly Sighting[],
  names: readonly string[],
): readonly string[] {
  const life = lifecycleOf(e);
  const workers = [
    ...e.run.workers.filter((w) => w.product),
    ...(life?.watch.workers.filter((w) => w.product) ?? []),
  ];
  const placed = seen.flatMap((s) =>
    s.target === null
      ? []
      : placeProblems(s.target, s.place).map(
          (p) => `resource://${s.name}/ -> ${s.target ?? ""} (${s.where}): ${p}`,
        ),
  );
  // The name is there to serve the worker; each URL a worker started from must be a packed file through it.
  const served = names.flatMap((name) => {
    const prefix = `resource://${name}/`;
    const urls = [...new Set(workers.map((w) => w.url).filter((u) => u.startsWith(prefix)))];
    const into = seen.filter((s) => s.name === name && s.target !== null);
    if (urls.length === 0)
      return [`the product started no worker from ${prefix} in the watched start and export`];
    return urls.flatMap((url) =>
      into
        .filter(
          (s) =>
            !filesThrough(name, s.target ?? "", s.place.addonRoot, e.packedFiles).includes(url),
        )
        .map(
          (s) => `${url} is not a packed file through ${prefix} -> ${s.target ?? ""} (${s.where})`,
        ),
    );
  });
  return [...new Set([...placed, ...served])];
}

/** Every position the run has rows of the reach probes for: cs-file only when a content script ran in a file page. */
const reachPositions = (csFileInjected: boolean): readonly Position[] =>
  expandExpectedRows(csFileInjected)
    .filter((r) => r.id === ROOT_PROBE)
    .map((r) => r.position);

function reachProblems(
  e: SubstitutionEvidence,
  seen: readonly Sighting[],
  names: readonly string[],
  verdictOf: ReachVerdict,
  positions: readonly Position[],
): readonly string[] {
  if (names.length > 0 && positions.length === 0) return [`no ${ROOT_PROBE} positions`];
  const flags = seen.flatMap((s) => [
    ...(s.flags !== null && (s.flags & ALLOW_CONTENT_ACCESS) !== 0
      ? [`resource://${s.name}/: registered with content access (${s.where})`]
      : []),
    ...(s.contentAccess === true
      ? [`resource://${s.name}/: flagged for content access (${s.where})`]
      : []),
    ...(s.contentAccess === null && s.target !== null
      ? [`resource://${s.name}/: content access could not be read (${s.where})`]
      : []),
  ]);
  const blocked = (probe: string, url: string): readonly string[] =>
    positions.flatMap((position) => {
      const { verdict, line } = verdictOf(probe, url, position);
      return verdict === "BLOCKED" ? [] : [`${url} from ${position}: ${verdict} ${line}`];
    });
  const loads = names.flatMap((name) => {
    const inRun = [...e.start, ...e.end].filter((s) => s.name === name);
    const files = [
      ...new Set(
        inRun.flatMap((s) => filesThrough(name, s.resolved, e.place.addonRoot, e.packedFiles)),
      ),
    ];
    return [
      ...blocked(ROOT_PROBE, `resource://${name}/`),
      ...(inRun.length === 0
        ? [`resource://${name}/ was not registered while the probes ran, so no position tried it`]
        : files.length === 0
          ? [`no packed file was probed through resource://${name}/`]
          : files.flatMap((url) => blocked(FILES_PROBE, url))),
    ];
  });
  return [...new Set([...flags, ...loads])];
}

function lifetimeProblems(e: SubstitutionEvidence, names: readonly string[]): readonly string[] {
  const life = lifecycleOf(e);
  const runCalls = productCalls(e.run);
  const startLines = new Set(e.start.map(substitutionLine));
  const endLines = new Set(e.end.map(substitutionLine));
  const count = (calls: readonly WatchedCall[], name: string, removes: boolean) =>
    calls.filter(
      (c) => c.name === name && c.method === "setSubstitution" && (c.target === null) === removes,
    ).length;
  const run = [
    ...runCalls
      .filter((c) => c.method !== "setSubstitution")
      .map((c) => `${c.method}(${c.name}) in the product run (${c.phase})`),
    ...runCalls
      .filter((c) => c.method === "setSubstitution" && c.target === null)
      .map((c) => `the product removed resource://${c.name}/ while it ran (${c.phase})`),
    ...names.flatMap((name) => {
      const registers = count(runCalls, name, false);
      return registers > 1
        ? [`${String(registers)} calls registered resource://${name}/ in the product run`]
        : [];
    }),
    ...[...e.start, ...e.end]
      .filter((s) => names.includes(s.name))
      .flatMap((s) => {
        const line = substitutionLine(s);
        if (!startLines.has(line))
          return [`${line}: registered or changed after the probes started`];
        if (!endLines.has(line)) return [`${line}: gone or changed by the end of the probes`];
        return [];
      }),
  ];
  if (life === null) return [...new Set([...run, ...watchProblems(e)])];
  const lifeCalls = productCalls(life.watch).filter((c) => c.phase !== "stop");
  const started = lifeCalls.filter((c) => c.phase !== "disable");
  const stopped = lifeCalls.filter((c) => c.phase === "disable");
  const watched = [
    ...lifeCalls
      .filter((c) => c.method !== "setSubstitution")
      .map((c) => `${c.method}(${c.name}) in the watched start (${c.phase})`),
    ...names.flatMap((name) => {
      const registers = count(started, name, false);
      const removes = count(stopped, name, true);
      const early = count(started, name, true);
      return [
        ...(registers === 1
          ? []
          : [
              `${String(registers)} calls registered resource://${name}/ in the watched start, expected one`,
            ]),
        ...(early === 0 ? [] : [`resource://${name}/ was removed before the add-on shut down`]),
        ...(removes === 1
          ? []
          : [
              `${String(removes)} calls removed resource://${name}/ when the add-on shut down, expected one`,
            ]),
        ...(life.running.some((s) => s.name === name)
          ? []
          : [`resource://${name}/ was not registered after the watched start and export`]),
        ...(life.after.some((s) => s.name === name)
          ? [`resource://${name}/ is still registered after the add-on shut down`]
          : []),
      ];
    }),
  ];
  return [...new Set([...run, ...watched, ...watchProblems(e)])];
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
  const seen = sightings(e);
  const names = productNames(seen);
  const positions = reachPositions(csFileInjected);
  const shown = names.map((n) => `resource://${n}/`).join(", ") || "none";
  const workers = [
    ...new Set(
      [...e.run.workers, ...(lifecycleOf(e)?.watch.workers ?? [])]
        .filter((w) => w.product)
        .map((w) => w.url),
    ),
  ];
  return [
    row(
      "substitution-name",
      nameProblems(e, names),
      names.length === 0 ? "the product registers no substitution" : `only ${shown}`,
    ),
    row(
      "substitution-target",
      targetProblems(e, seen, names),
      `${shown}: inside the add-on's own packed files, serving ${workers.join(", ") || "nothing"}`,
    ),
    row(
      "substitution-reach",
      reachProblems(e, seen, names, verdictOf, positions),
      `${shown}: no content access at any sample, ${ROOT_PROBE} and ${FILES_PROBE} BLOCKED from ${positions.join(", ")}`,
    ),
    row(
      "substitution-lifetime",
      lifetimeProblems(e, names),
      `${shown}: registered once in the watched start, removed once at shutdown, unchanged through the probes`,
    ),
  ];
}
