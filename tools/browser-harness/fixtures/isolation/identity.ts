import * as NodePath from "node:path";
import { PROBE_TABLE, type ProbeSpec, type TargetRole } from "./probe-table.ts";
import { checkKey, type PlanInput, type WitnessCheck } from "./targets.ts";

// What each probe's targets must be, resolved from the product's own inventory and manifest, apart from the plan.
// targets.ts says how to reach a target (a file: URL, view-source:, a redirect, a ../ walk); this says what the
// target is. The witness runs every planned check, and a planned unit counts only when the role's own check is
// among its checks and held, so a plan pointed at an existing but wrong file is NO-RESULT, never BLOCKED.

/**
 * How a probe's planned units must prove its role, by the witness check keys each unit carries:
 * `one`, the single unit (or a pair's existing unit) carries the check; `every`, each unit reaches the same target by
 * its own route and carries it; `list`, the units are exactly the role's targets, one check each.
 */
export type Identity =
  | { readonly role: TargetRole; readonly kind: "one" | "every"; readonly check: string }
  | { readonly role: TargetRole; readonly kind: "list"; readonly checks: readonly string[] };

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
    "moz-src": input.mozSrc === null ? [] : load(input.mozSrc),
    "planted-log": load(input.plantedResource.hit, marker),
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
    return { role: spec.target, kind: "list", checks: target.map(checkKey) };
  const check = checkKey(target as WitnessCheck);
  return { role: spec.target, kind: spec.shape === "each" ? "every" : "one", check };
}

/** Every probe's identity, by probe id. */
export function identities(input: PlanInput): Readonly<Record<string, Identity>> {
  const targets = roleTargets(input);
  return Object.fromEntries(
    PROBE_TABLE.map((spec) => [spec.id, identityOf(spec, targets[spec.target])]),
  );
}
