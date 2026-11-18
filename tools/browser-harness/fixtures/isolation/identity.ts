import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Unit } from "./judge.ts";
import { PROBE_TABLE, type ProbeSpec, type TargetRole } from "./probe-table.ts";
import { checkKey, type PlanInput, type WitnessCheck } from "./targets.ts";

// What each probe's targets must be, resolved from the product's own inventory and manifest, apart from the plan.
// targets.ts says how to reach a target (a file: URL, view-source:, a redirect, a ../ walk); this says what the
// target is. A planned unit counts only when the URL it probes leads to the role's place, and the witness ran the
// role's own check on it and that check held; a plan aimed at an existing but wrong file is NO-RESULT, never BLOCKED.

/**
 * How a probe's planned units must prove its role, by the witness check keys each unit carries:
 * `one`, the single unit (or a pair's existing unit) carries the check; `every`, each unit reaches the same target by
 * its own route and carries it; `list`, the units are exactly the role's targets, one check each.
 */
export type Identity =
  | {
      readonly role: TargetRole;
      readonly kind: "one" | "every";
      readonly check: string;
      readonly place: string;
    }
  | {
      readonly role: TargetRole;
      readonly kind: "list";
      readonly checks: readonly string[];
      readonly places: readonly string[];
    };

/** What a witness check proves exists, as a place: a file by path, a URL, a scheme name, add-on, tab, service or fact. */
export function placeOfCheck(check: WitnessCheck): string {
  switch (check.kind) {
    case "file":
      return `file:${check.path}`;
    case "load":
      return `load:${check.url}`;
    case "resource":
      return `resource:${check.name}`;
    case "chrome":
      return `chrome:${check.pkg}`;
    case "addon":
      return `addon:${check.id}`;
    case "tab":
      return `tab:${check.url}`;
    case "service":
      return `service:${check.name}`;
    case "fact":
      return `fact:${check.name}`;
    case "redirect":
      return `redirect:${check.url}`;
  }
}

/** A scheme's base folder and what follows it: a `../` walk from there, or nothing for the base itself. */
const SCHEME_BASE =
  /^(?:resource:\/\/([^/]+)\/|chrome:\/\/([^/]+)\/content\/|moz-src:\/\/\/)(.*)$/su;

/**
 * Where a planned unit's URL leads, as a place, read from the URL alone: the file a file:, view-source: or jar: URL
 * names, or a redirect sends to; the file a `../` walk from a scheme's base folder reaches from the browser's own
 * folder; the log the probe add-on's webRequest redirect sends to; or the URL, add-on, tab, service or fact itself.
 */
export function placeOfUrl(url: string, input: PlanInput): string {
  const wrapped = /^view-source:(.+)$/su.exec(url)?.[1] ?? /^jar:(.+)!\/$/su.exec(url)?.[1];
  if (wrapped !== undefined) return placeOfUrl(wrapped, input);
  if (url.startsWith("file:"))
    return `file:${NodeURL.fileURLToPath(url.replace(/(.)\/$/su, "$1"))}`;
  if (url.startsWith(`${input.wrRedirect}?`)) return `file:${input.file.log}`;
  const to = URL.parse(url)?.searchParams.get("to");
  if (url.startsWith("http:") && to !== undefined && to !== null) return placeOfUrl(to, input);
  const walk = SCHEME_BASE.exec(url);
  if (walk !== null) {
    const rest = decodeURIComponent(walk[3] ?? "").replaceAll("\\", "/");
    if (rest.split("/").includes("..")) return `file:${NodePath.resolve(input.binDir, rest)}`;
    if (rest === "" && walk[1] !== undefined) return `resource:${walk[1]}`;
    if (rest === "" && walk[2] !== undefined) return `chrome:${walk[2]}`;
  }
  return /^(?:addon|tab|fact|service):/u.test(url) ? url : `load:${url}`;
}

/** Where each planned unit leads, keyed by the URL it probes (a pair by its existing side). */
export function unitPlaces(
  targets: Readonly<Record<string, readonly Unit[]>>,
  input: PlanInput,
): Readonly<Record<string, string>> {
  const urls = Object.values(targets).flatMap((units) =>
    units.map((u) => (typeof u === "string" ? u : u[0])),
  );
  return Object.fromEntries(urls.map((url) => [url, placeOfUrl(url, input)]));
}

const file = (path: string, mark?: string): WitnessCheck => ({ kind: "file", path, mark });
const load = (url: string, mark?: string): WitnessCheck => ({ kind: "load", url, mark });

/** Each role's target as a witness check, or the full list of its targets. */
function roleTargets(
  input: PlanInput,
): Readonly<Record<TargetRole, WitnessCheck | readonly WitnessCheck[]>> {
  const { rec, probe, marker } = input;
  const under = (folder: string, path: string): string =>
    NodePath.join(folder, NodePath.relative(input.file.keyFolder, path));
  return {
    "archive-log": file(input.file.log, marker),
    "archive-body": file(input.file.body, marker),
    export: file(input.file.export, marker),
    "app-folder": file(input.file.appFolder),
    inventory: input.inventory.map((w) => file(w.path)),
    "guessed-log": input.guessedKeyFolders.map((folder) => file(under(folder, input.file.log))),
    "guessed-site": input.guessedKeyFolders.map((folder) =>
      file(under(folder, input.file.siteDir)),
    ),
    "resource-names": input.resourceNames.map((name) => ({ kind: "resource", name })),
    "chrome-packages": input.chromePackages.map((pkg) => ({ kind: "chrome", pkg })),
    "moz-src": input.mozSrc === null ? [] : file(input.file.log, marker),
    "planted-log": load(input.plantedResource.hit, marker),
    "product-resource-files": input.productResourceFiles.map((url) => load(url)),
    "packed-files": rec.files.map((f) => load(rec.base + f)),
    "packed-manifest": load(`${rec.base}manifest.json`),
    "packed-parent": load(rec.base + rec.parentScript),
    "packed-schema": load(rec.base + rec.schema),
    "packed-popup": load(rec.base + rec.popupPath),
    "packed-popup-script": load(rec.base + rec.popupScriptPath),
    "probe-war-text": load(`${probe.base}war.txt`, probe.warMark),
    "probe-war-script": load(`${probe.base}war.js`, probe.warMark),
    "probe-secret": load(`${probe.base}secret.txt`, probe.secretMark),
    "recorder-api": { kind: "fact", name: "recorder-api" },
    "recorder-addon": { kind: "addon", id: rec.id },
    "recorder-tab": { kind: "tab", url: rec.base + rec.popupPath },
    downloads: { kind: "service", name: "downloads" },
    clipboard: { kind: "service", name: "clipboard" },
    notifications: { kind: "service", name: "notifications" },
    "recorder-storage": { kind: "fact", name: "recorder-storage" },
    "recorder-idb": { kind: "fact", name: "recorder-idb" },
    "bank-traffic": { kind: "fact", name: "bank-traffic" },
  };
}

function identityOf(spec: ProbeSpec, target: WitnessCheck | readonly WitnessCheck[]): Identity {
  if (Array.isArray(target))
    return {
      role: spec.target,
      kind: "list",
      checks: target.map(checkKey),
      places: target.map(placeOfCheck),
    };
  const one = target as WitnessCheck;
  return {
    role: spec.target,
    kind: spec.shape === "each" ? "every" : "one",
    check: checkKey(one),
    place: placeOfCheck(one),
  };
}

/** Every probe's identity, by probe id. */
export function identities(input: PlanInput): Readonly<Record<string, Identity>> {
  const targets = roleTargets(input);
  return Object.fromEntries(
    PROBE_TABLE.map((spec) => [spec.id, identityOf(spec, targets[spec.target])]),
  );
}
