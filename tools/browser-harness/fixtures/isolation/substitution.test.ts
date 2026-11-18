import { describe, expect, it } from "vite-plus/test";
import type { Judged } from "./judge.ts";
import type { Position } from "./probe-table.ts";
import {
  isWorkerSubstitution,
  judgeSubstitutions,
  productSubstitutions,
  substitutionLine,
  type ReachVerdict,
  type Substitution,
  type SubstitutionEvidence,
} from "./substitution.ts";

// What Zen Twilight 1.25t read in the baseline run on the merged product (PR 17's file worker), paths shortened.
const ROOT = "jar:file:///w/profile/extensions/one-click-har@tretuttle.github.io.xpi!/";
const GRE: Substitution = {
  name: "gre",
  resolved: "jar:file:///opt/zen/omni.ja!/",
  contentAccess: false,
};
const WORKER: Substitution = { name: "one-click-har", resolved: ROOT, contentAccess: false };
const BASELINE: SubstitutionEvidence = {
  addonRoot: ROOT,
  packedFiles: [
    "action/index.html",
    "experiment/file-worker.js",
    "experiment/parent.js",
    "manifest.json",
  ],
  servedPaths: ["experiment/file-worker.js"],
  profileDir: "/w/profile",
  dataHome: "/w/data",
  start: [GRE, WORKER],
  end: [GRE, WORKER],
  control: [substitutionLine(GRE)],
  registrations: [
    { file: "experiment/parent.js", call: "setSubstitution", removes: false },
    { file: "experiment/parent.js", call: "setSubstitution", removes: true },
  ],
  shutdown: { before: ["one-click-har"], after: [] },
};

const blocked: ReachVerdict = (_probe, url) => ({
  verdict: "BLOCKED",
  line: `${url} -> network error`,
});
const readFrom =
  (from: Position): ReachVerdict =>
  (probe, url, position): Judged =>
    position === from
      ? { verdict: "READ", line: `${url} -> fetch ok` }
      : blocked(probe, url, position);

const rows = (e: SubstitutionEvidence, verdictOf: ReachVerdict = blocked) =>
  Object.fromEntries(judgeSubstitutions(e, verdictOf, false).map((r) => [r.id, r]));
const failing = (e: SubstitutionEvidence, verdictOf: ReachVerdict = blocked): string[] =>
  judgeSubstitutions(e, verdictOf, false)
    .filter((r) => !r.ok)
    .map((r) => r.id);
const both = (...subs: Substitution[]) => ({ start: subs, end: subs });

describe("the product's own substitutions", () => {
  it("are the ones neither control run had", () => {
    expect(productSubstitutions(BASELINE)).toEqual([WORKER]);
    expect(productSubstitutions({ ...BASELINE, control: [] })).toEqual([GRE, WORKER]);
  });

  it("include a browser name the product points elsewhere", () => {
    const gre = { ...GRE, resolved: "file:///w/data/" };
    expect(productSubstitutions({ ...BASELINE, ...both(gre, WORKER) })).toEqual([gre, WORKER]);
  });

  it("let only the worker name into the add-on's own root past the scheme rule", () => {
    expect(isWorkerSubstitution(WORKER, ROOT)).toBe(true);
    expect(isWorkerSubstitution({ ...WORKER, name: "one-click-har-extra" }, ROOT)).toBe(false);
    expect(isWorkerSubstitution({ ...WORKER, resolved: "file:///w/profile/" }, ROOT)).toBe(false);
    expect(isWorkerSubstitution(WORKER, "")).toBe(false);
  });
});

describe("the worker substitution allowance", () => {
  it("holds for the merged product, one row per condition", () => {
    expect(judgeSubstitutions(BASELINE, blocked, false)).toEqual([
      { id: "substitution-name", ok: true, detail: `only resource://one-click-har/ -> ${ROOT}` },
      {
        id: "substitution-target",
        ok: true,
        detail: `resource://one-click-har/ -> ${ROOT}: inside the add-on's own packed files, serving experiment/file-worker.js`,
      },
      {
        id: "substitution-reach",
        ok: true,
        detail: `resource://one-click-har/ -> ${ROOT}: no content access, resource-all BLOCKED from web, file, ext-bg, ext-page, cs-web, ext-devtools`,
      },
      {
        id: "substitution-lifetime",
        ok: true,
        detail: `resource://one-click-har/ -> ${ROOT}: one register and one remove call, the same before and after the probes, gone once the add-on shut down`,
      },
    ]);
  });

  it("holds for a product that registers nothing", () => {
    const none = {
      ...BASELINE,
      ...both(GRE),
      registrations: [],
      shutdown: { before: [], after: [] },
    };
    expect(failing(none)).toEqual([]);
    expect(rows(none)["substitution-name"]?.detail).toBe("the product registers no substitution");
  });

  it("name: fails a second host, and a browser name the product took over", () => {
    const extra = { ...WORKER, name: "one-click-har-extra" };
    expect(rows({ ...BASELINE, ...both(GRE, WORKER, extra) })["substitution-name"]).toMatchObject({
      ok: false,
      detail:
        "resource://one-click-har-extra/ is registered by the product; only resource://one-click-har/ is allowed",
    });
    const gre = { ...GRE, resolved: ROOT };
    expect(failing({ ...BASELINE, ...both(gre, WORKER) })).toContain("substitution-name");
  });

  it("target: fails the data home, the profile root, a folder above the profile, and anything outside the add-on", () => {
    const at = (resolved: string) => {
      const sub = { ...WORKER, resolved };
      return rows({ ...BASELINE, ...both(GRE, sub) })["substitution-target"]!;
    };
    expect(at("file:///w/data/one-click-har/").detail).toContain(
      "the data home, which holds the archive",
    );
    expect(at("file:///w/data/").detail).toContain("the data home");
    expect(at("file:///w/").detail).toContain("the data home");
    expect(at("file:///w/").detail).toContain("a folder that holds the profile");
    expect(at("file:///w/profile/").detail).toContain(": the profile root");
    expect(at("file:///opt/zen/").detail).toContain("outside the add-on's own root");
    expect(at("jar:file:///w/other.xpi!/").ok).toBe(false);
    expect(at("data:text/plain,x").detail).toContain("not a local file or archive");
  });

  it("target: fails when the URL the packed scripts build is not a packed file through it, or nothing is built", () => {
    const sub = { ...WORKER, resolved: `${ROOT}experiment/` };
    expect(rows({ ...BASELINE, ...both(GRE, sub) })["substitution-target"]?.detail).toContain(
      "experiment/file-worker.js is not a packed file through it",
    );
    expect(rows({ ...BASELINE, servedPaths: [] })["substitution-target"]?.detail).toContain(
      "no packed script builds a URL under it",
    );
    expect(failing({ ...BASELINE, ...both(GRE, sub), servedPaths: ["file-worker.js"] })).toEqual(
      [],
    );
  });

  it("reach: fails a content-access flag, an unread flag, and any position that loads it", () => {
    const flagged = { ...WORKER, contentAccess: true };
    expect(rows({ ...BASELINE, ...both(GRE, flagged) })["substitution-reach"]?.detail).toBe(
      "resource://one-click-har/: flagged for content access",
    );
    const unread = { ...WORKER, contentAccess: null };
    expect(failing({ ...BASELINE, ...both(GRE, unread) })).toEqual(["substitution-reach"]);
    for (const position of ["web", "file", "ext-bg", "ext-page", "cs-web", "ext-devtools"] as const)
      expect(rows(BASELINE, readFrom(position))["substitution-reach"]?.detail).toBe(
        `resource://one-click-har/ from ${position}: READ resource://one-click-har/ -> fetch ok`,
      );
    const noResult: ReachVerdict = () => ({ verdict: "NO-RESULT", line: "no row" });
    expect(failing(BASELINE, noResult)).toEqual(["substitution-reach"]);
  });

  it("lifetime: fails another call, a missing or extra register or remove, a late or changed name, and one left behind", () => {
    const [register, remove] = BASELINE.registrations;
    const life = (e: Partial<SubstitutionEvidence>) =>
      rows({ ...BASELINE, ...e })["substitution-lifetime"]!;
    expect(
      life({
        registrations: [
          register!,
          remove!,
          { file: "experiment/parent.js", call: "setSubstitutionWithFlags", removes: false },
        ],
      }).detail,
    ).toBe("experiment/parent.js: setSubstitutionWithFlags");
    expect(life({ registrations: [register!] }).detail).toBe(
      "0 setSubstitution calls remove a name, expected one",
    );
    expect(life({ registrations: [register!, register!, remove!] }).detail).toBe(
      "2 setSubstitution calls register a name, expected one",
    );
    expect(life({ start: [GRE] }).detail).toContain("registered after the probes started");
    expect(life({ end: [GRE, { ...WORKER, resolved: `${ROOT}experiment/` }] }).ok).toBe(false);
    expect(life({ shutdown: { before: ["one-click-har"], after: ["one-click-har"] } }).detail).toBe(
      "resource://one-click-har/ is still registered after the add-on shut down",
    );
    expect(life({ shutdown: { before: [], after: [] } }).detail).toBe(
      "resource://one-click-har/ was not registered in a second profile",
    );
    expect(life({ shutdown: { missing: "timed out" } }).detail).toBe(
      "shutdown not observed: timed out",
    );
  });

  it("reach: asks cs-file only when a content script ran in a file page", () => {
    const asked: string[] = [];
    const record: ReachVerdict = (probe, url, position) => {
      asked.push(position);
      return blocked(probe, url, position);
    };
    judgeSubstitutions(BASELINE, record, false);
    expect(asked).not.toContain("cs-file");
    expect(asked).toHaveLength(6);
    asked.length = 0;
    judgeSubstitutions(BASELINE, record, true);
    expect(asked).toContain("cs-file");
    expect(rows(BASELINE, readFrom("cs-file"))["substitution-reach"]?.ok).toBe(true);
    expect(
      judgeSubstitutions(BASELINE, readFrom("cs-file"), true).find(
        (r) => r.id === "substitution-reach",
      )?.ok,
    ).toBe(false);
  });
});
