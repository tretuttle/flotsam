import { describe, expect, it } from "vite-plus/test";
import type { Judged } from "./judge.ts";
import type { Position } from "./probe-table.ts";
import {
  filesThrough,
  isWorkerSubstitution,
  judgeSubstitutions,
  productSubstitutions,
  substitutionLine,
  type Lifecycle,
  type ReachVerdict,
  type Substitution,
  type SubstitutionEvidence,
  type Watch,
  type WatchedCall,
} from "./substitution.ts";

// What Zen Twilight 1.25t recorded for the merged product (PR 17's file worker), paths shortened: the product run's
// watcher saw no call (the add-on registered its name at startup), and the watched start saw one register, the
// export's worker, and one remove.
const ROOT = "jar:file:///w/profile/extensions/one-click-har@tretuttle.github.io.xpi!/";
const ROOT2 = "jar:file:///v/profile/extensions/one-click-har@tretuttle.github.io.xpi!/";
const WORKER_URL = "resource://one-click-har/experiment/file-worker.js";
const PACKED = [
  "action/index.html",
  "experiment/file-worker.js",
  "experiment/parent.js",
  "manifest.json",
];
const GRE: Substitution = {
  name: "gre",
  resolved: "jar:file:///opt/zen/omni.ja!/",
  contentAccess: false,
};
const WORKER: Substitution = { name: "one-click-har", resolved: ROOT, contentAccess: false };
const WORKER2: Substitution = { ...WORKER, resolved: ROOT2 };

const call = (over: Partial<WatchedCall>): WatchedCall => ({
  phase: "start",
  method: "setSubstitution",
  name: "one-click-har",
  target: ROOT2,
  flags: null,
  product: true,
  after: WORKER2,
  error: null,
  ...over,
});
const REGISTER = call({});
const REMOVE = call({ phase: "disable", target: null, after: null });
const watch = (over: Partial<Watch> = {}): Watch => ({
  calls: [],
  workers: [],
  globals: [{ phase: "setup", how: "existing" }],
  problems: [],
  ...over,
});
const LIFECYCLE: Exclude<Lifecycle, { missing: string }> = {
  place: { addonRoot: ROOT2, profileDir: "/v/profile", dataHome: "/v/data" },
  watch: watch({
    calls: [call({ phase: "stop", target: null, after: null }), REGISTER, REMOVE],
    workers: [{ phase: "export", url: WORKER_URL, product: true }],
    globals: [
      { phase: "stop", how: "existing" },
      { phase: "start", how: "created" },
    ],
  }),
  stopped: [GRE],
  running: [GRE, WORKER2],
  after: [GRE],
};
const BASELINE: SubstitutionEvidence = {
  place: { addonRoot: ROOT, profileDir: "/w/profile", dataHome: "/w/data" },
  packedFiles: PACKED,
  start: [GRE, WORKER],
  end: [GRE, WORKER],
  control: [substitutionLine(GRE)],
  run: watch(),
  lifecycle: LIFECYCLE,
};

const blocked: ReachVerdict = (_probe, url) => ({
  verdict: "BLOCKED",
  line: `${url} -> network error`,
});
const readFrom =
  (from: Position, probe = "resource-all"): ReachVerdict =>
  (p, url, position): Judged =>
    position === from && p === probe
      ? { verdict: "LEAKS-EXISTENCE", line: `${url} -> script load` }
      : blocked(p, url, position);

const rows = (e: SubstitutionEvidence, verdictOf: ReachVerdict = blocked) =>
  Object.fromEntries(judgeSubstitutions(e, verdictOf, false).map((r) => [r.id, r]));
const failing = (e: SubstitutionEvidence, verdictOf: ReachVerdict = blocked): string[] =>
  judgeSubstitutions(e, verdictOf, false)
    .filter((r) => !r.ok)
    .map((r) => r.id);
const detail = (e: SubstitutionEvidence, id: string, verdictOf?: ReachVerdict): string =>
  rows(e, verdictOf)[id]?.detail ?? "";
const both = (...subs: Substitution[]) => ({ start: subs, end: subs });
const life = (over: Partial<Exclude<Lifecycle, { missing: string }>>): SubstitutionEvidence => ({
  ...BASELINE,
  lifecycle: { ...LIFECYCLE, ...over },
});
const lifeCalls = (...calls: WatchedCall[]) => life({ watch: { ...LIFECYCLE.watch, calls } });

describe("the product's own substitutions", () => {
  it("are the ones neither control run had, with content access part of each line", () => {
    expect(productSubstitutions(BASELINE)).toEqual([WORKER]);
    const flipped = { ...WORKER, contentAccess: true };
    expect(productSubstitutions({ ...BASELINE, end: [GRE, flipped] })).toEqual([WORKER, flipped]);
    expect(substitutionLine(flipped)).toBe(
      `resource://one-click-har/ -> ${ROOT}, content access true`,
    );
  });

  it("let only the worker name into the add-on's own root past the scheme rule", () => {
    expect(isWorkerSubstitution(WORKER, ROOT)).toBe(true);
    expect(isWorkerSubstitution({ ...WORKER, name: "one-click-har-extra" }, ROOT)).toBe(false);
    expect(isWorkerSubstitution({ ...WORKER, resolved: "file:///w/profile/" }, ROOT)).toBe(false);
    expect(isWorkerSubstitution(WORKER, "")).toBe(false);
  });

  it("serve, as URLs through the name, only the packed files under where it points", () => {
    expect(filesThrough("one-click-har", ROOT, ROOT, PACKED)).toEqual(
      PACKED.map((f) => `resource://one-click-har/${f}`),
    );
    expect(filesThrough("x", `${ROOT}experiment/`, ROOT, PACKED)).toEqual([
      "resource://x/file-worker.js",
      "resource://x/parent.js",
    ]);
    expect(filesThrough("x", "file:///w/data/", ROOT, PACKED)).toEqual([]);
    expect(filesThrough("x", "jar:file:///w/", ROOT, PACKED)).toEqual([]);
  });
});

describe("the worker substitution allowance", () => {
  it("holds for the merged product, one row per condition", () => {
    expect(judgeSubstitutions(BASELINE, blocked, false)).toEqual([
      { id: "substitution-name", ok: true, detail: "only resource://one-click-har/" },
      {
        id: "substitution-target",
        ok: true,
        detail: `resource://one-click-har/: inside the add-on's own packed files, serving ${WORKER_URL}`,
      },
      {
        id: "substitution-reach",
        ok: true,
        detail:
          "resource://one-click-har/: no content access at any sample, resource-all and resource-product-files BLOCKED from web, file, ext-bg, ext-page, cs-web, ext-devtools",
      },
      {
        id: "substitution-lifetime",
        ok: true,
        detail:
          "resource://one-click-har/: registered once in the watched start, removed once at shutdown, unchanged through the probes",
      },
    ]);
  });

  it("holds for a product that registers nothing", () => {
    const none: SubstitutionEvidence = {
      ...BASELINE,
      ...both(GRE),
      lifecycle: {
        ...LIFECYCLE,
        watch: { ...LIFECYCLE.watch, calls: [], workers: [] },
        running: [GRE],
      },
    };
    expect(failing(none)).toEqual([]);
    expect(detail(none, "substitution-name")).toBe("the product registers no substitution");
  });

  it("name: fails a second host seen only in a call, a browser name taken over, and a change no call explains", () => {
    // r6-second-host-template-loop: one call site in a loop, the second name built from a template.
    const extra = call({
      name: "one-click-har-extra",
      after: { ...WORKER2, name: "one-click-har-extra" },
    });
    expect(detail(lifeCalls(REGISTER, extra, REMOVE), "substitution-name")).toBe(
      "resource://one-click-har-extra/ is registered by the product; only resource://one-click-har/ is allowed",
    );
    expect(failing({ ...BASELINE, ...both({ ...GRE, resolved: ROOT }, WORKER) })).toContain(
      "substitution-name",
    );
    // A product-place entry that changed with no call the watcher saw: a way past the wrapped globals.
    const hidden = { ...WORKER, name: "och-hidden", resolved: `${ROOT}experiment/` };
    expect(detail({ ...BASELINE, end: [GRE, WORKER, hidden] }, "substitution-name")).toContain(
      "changed during the product run with no call the watcher saw",
    );
    expect(
      detail(
        life({ running: [GRE, WORKER2, { ...hidden, resolved: ROOT2 }] }),
        "substitution-name",
      ),
    ).toContain("appeared in the watched start with no call the watcher saw");
    // A name that changed outside the product's places, with no call, is not an unexplained product change.
    expect(
      detail(
        { ...BASELINE, end: [GRE, WORKER, { ...GRE, name: "och-other" }] },
        "substitution-name",
      ),
    ).not.toContain("no call the watcher saw");
  });

  it("name and lifetime: fail when a watcher never reached the add-on, or the watched start is missing", () => {
    expect(detail({ ...BASELINE, run: watch({ globals: [] }) }, "substitution-name")).toContain(
      "found no add-on global to wrap",
    );
    const unwatched = life({
      watch: { ...LIFECYCLE.watch, globals: [{ phase: "stop", how: "existing" }] },
    });
    expect(failing(unwatched)).toEqual(["substitution-name", "substitution-lifetime"]);
    const missing = { ...BASELINE, lifecycle: { missing: "export failed: timed out" } };
    expect(detail(missing, "substitution-lifetime")).toContain(
      "the add-on's watched start and shutdown were not observed: export failed: timed out",
    );
  });

  it("target: fails every target outside the add-on's own files, in either profile", () => {
    const at = (resolved: string) =>
      detail({ ...BASELINE, ...both(GRE, { ...WORKER, resolved }) }, "substitution-target");
    expect(at("file:///w/data/one-click-har/")).toContain("the data home, which holds the archive");
    expect(at("file:///w/")).toContain("a folder that holds the profile");
    expect(at("file:///w/profile/")).toContain(": the profile root");
    expect(at("file:///opt/zen/")).toContain("outside the add-on's own root");
    expect(at("data:text/plain,x")).toContain("not a local file or archive");
    // r6-lazy-wider-no-remove: registered into the profile only once an export starts, so only the watched start saw it.
    const lazy = call({
      phase: "export",
      target: "file:///v/profile/",
      after: { ...WORKER2, resolved: "file:///v/profile/" },
    });
    expect(detail({ ...lifeCalls(lazy, REMOVE), ...both(GRE) }, "substitution-target")).toContain(
      "resource://one-click-har/ -> file:///v/profile/ (setSubstitution in the watched start (export)): the profile root",
    );
    // r6-wider-archive-second-host: the second name points at the data home.
    const data = call({
      name: "one-click-har-data",
      target: "file:///v/data/one-click-har/",
      after: null,
    });
    expect(detail(lifeCalls(REGISTER, data, REMOVE), "substitution-target")).toContain(
      "the data home, which holds the archive",
    );
  });

  it("target: fails a worker URL that is not a packed file through the name, and a name no worker started from", () => {
    const narrow = { ...WORKER, resolved: `${ROOT}experiment/` };
    expect(detail({ ...BASELINE, ...both(GRE, narrow) }, "substitution-target")).toContain(
      `${WORKER_URL} is not a packed file through resource://one-click-har/ -> ${ROOT}experiment/`,
    );
    // The guarded slice: a target shorter than the root serves nothing, rather than the root's own files.
    const short = { ...WORKER, resolved: "jar:file:///w/x.xpi!/" };
    expect(detail({ ...BASELINE, ...both(GRE, short) }, "substitution-target")).toContain(
      `${WORKER_URL} is not a packed file through resource://one-click-har/ -> jar:file:///w/x.xpi!/`,
    );
    expect(
      detail(life({ watch: { ...LIFECYCLE.watch, workers: [] } }), "substitution-target"),
    ).toBe(
      "the product started no worker from resource://one-click-har/ in the watched start and export",
    );
  });

  it("reach: fails content access set by a call, flipped after the start, unread, and any position that loads", () => {
    const flags = call({
      method: "setSubstitutionWithFlags",
      flags: 1,
      after: { ...WORKER2, contentAccess: true },
    });
    expect(detail(lifeCalls(flags, REMOVE), "substitution-reach")).toContain(
      "resource://one-click-har/: registered with content access (setSubstitutionWithFlags in the watched start (start))",
    );
    // r6-content-reachable-worker-host: false at the start, true from the probes on.
    const flipped = { ...WORKER, contentAccess: true };
    expect(detail({ ...BASELINE, end: [GRE, flipped] }, "substitution-reach")).toContain(
      "resource://one-click-har/: flagged for content access (the product run's table)",
    );
    expect(failing({ ...BASELINE, ...both(GRE, { ...WORKER, contentAccess: null }) })).toEqual([
      "substitution-reach",
    ]);
    for (const position of [
      "web",
      "file",
      "ext-bg",
      "ext-page",
      "cs-web",
      "ext-devtools",
    ] as const) {
      expect(detail(BASELINE, "substitution-reach", readFrom(position))).toBe(
        `resource://one-click-har/ from ${position}: LEAKS-EXISTENCE resource://one-click-har/ -> script load`,
      );
      // r6-reach-gap-load-packed-file: a packed file through the name loads, though the root does not.
      expect(
        detail(BASELINE, "substitution-reach", readFrom(position, "resource-product-files")),
      ).toContain(`${WORKER_URL} from ${position}: LEAKS-EXISTENCE`);
    }
    const noResult: ReachVerdict = () => ({ verdict: "NO-RESULT", line: "no row" });
    expect(failing(BASELINE, noResult)).toEqual(["substitution-reach"]);
  });

  it("reach: fails a name the probes never tried", () => {
    expect(detail({ ...BASELINE, ...both(GRE) }, "substitution-reach")).toBe(
      "resource://one-click-har/ was not registered while the probes ran, so no position tried it",
    );
  });

  it("lifetime: fails another method, a missing or extra register or remove, a change in the run, and one left behind", () => {
    const flags = call({ method: "setSubstitutionWithFlags", flags: 0 });
    expect(detail(lifeCalls(REGISTER, flags, REMOVE), "substitution-lifetime")).toBe(
      "setSubstitutionWithFlags(one-click-har) in the watched start (start)",
    );
    // worker-left-registered and r6-lazy-wider-no-remove: no remove call, and the name outlives the add-on.
    expect(
      detail(
        life({ watch: { ...LIFECYCLE.watch, calls: [REGISTER] }, after: [GRE, WORKER2] }),
        "substitution-lifetime",
      ),
    ).toBe(
      "0 calls removed resource://one-click-har/ when the add-on shut down, expected one; resource://one-click-har/ is still registered after the add-on shut down",
    );
    expect(detail(lifeCalls(REGISTER, REGISTER, REMOVE), "substitution-lifetime")).toBe(
      "2 calls registered resource://one-click-har/ in the watched start, expected one",
    );
    expect(detail(lifeCalls(REMOVE), "substitution-lifetime")).toContain(
      "0 calls registered resource://one-click-har/ in the watched start, expected one",
    );
    expect(
      detail(
        lifeCalls(REGISTER, call({ target: null, after: null }), REMOVE),
        "substitution-lifetime",
      ),
    ).toBe("resource://one-click-har/ was removed before the add-on shut down");
    // In the product run: any call, a late registration, a change by the end.
    const late = call({
      phase: "probes",
      method: "setSubstitutionWithFlags",
      flags: 1,
      target: ROOT,
      after: { ...WORKER, contentAccess: true },
    });
    expect(
      detail({ ...BASELINE, run: watch({ calls: [late] }) }, "substitution-lifetime"),
    ).toContain("setSubstitutionWithFlags(one-click-har) in the product run (probes)");
    expect(detail({ ...BASELINE, start: [GRE] }, "substitution-lifetime")).toContain(
      "registered or changed after the probes started",
    );
    expect(
      detail(
        { ...BASELINE, end: [GRE, { ...WORKER, resolved: `${ROOT}experiment/` }] },
        "substitution-lifetime",
      ),
    ).toContain("gone or changed by the end of the probes");
    // A call from code that is not the add-on's counts for nothing.
    expect(
      failing(lifeCalls(REGISTER, call({ name: "harness-own", product: false }), REMOVE)),
    ).toEqual([]);
  });

  it("reach: asks cs-file only when a content script ran in a file page", () => {
    const asked: string[] = [];
    const record: ReachVerdict = (probe, url, position) => {
      asked.push(`${probe}@${position}`);
      return blocked(probe, url, position);
    };
    judgeSubstitutions(BASELINE, record, false);
    expect(asked.filter((a) => a.endsWith("@cs-file"))).toEqual([]);
    expect(new Set(asked.map((a) => a.split("@")[1])).size).toBe(6);
    expect(asked.filter((a) => a.startsWith("resource-product-files@"))).toHaveLength(
      PACKED.length * 6,
    );
    asked.length = 0;
    judgeSubstitutions(BASELINE, record, true);
    expect(asked).toContain("resource-all@cs-file");
    expect(rows(BASELINE, readFrom("cs-file"))["substitution-reach"]?.ok).toBe(true);
    expect(
      judgeSubstitutions(BASELINE, readFrom("cs-file"), true).find(
        (r) => r.id === "substitution-reach",
      )?.ok,
    ).toBe(false);
  });
});
