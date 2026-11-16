import { describe, expect, it } from "vite-plus/test";

import type { ByteCount, RunId, Site } from "../src/ids.ts";
import {
  LAYOUT,
  logSegmentPath,
  logSummaryPath,
  parseArchiveName,
  siteDirName,
} from "../src/layout.ts";
import { decodeSummary } from "../src/log.ts";
import * as reconcile from "../src/reconcile.ts";
import {
  Crash,
  emptyDisk,
  emptyTruth,
  excludedOn,
  execute,
  Run,
  snapshotOf,
  Steps,
  wholeLines,
  type Disk,
  type Truth,
} from "./archive-model.ts";
import { CRASH_ROWS } from "./crash-rows.ts";
import { importMutated, type SourceMutation } from "./mutate.ts";
import { random } from "./random.ts";

type Planner = Pick<typeof reconcile, "planReconcile" | "applyPlan">;

const crashRowsFailing = (planner: Planner): readonly number[] =>
  CRASH_ROWS.filter((row) => {
    const plan = planner.planReconcile(row.snapshot);
    const again = planner.planReconcile(planner.applyPlan(row.snapshot, plan));
    return JSON.stringify(plan.map((s) => s.kind)) !== JSON.stringify(row.plan) || again.length > 0;
  }).map((row) => row.n);

// The sketch's seven mutations of the rules (checks/crash-table.mjs), against this file's formatting.
const SKETCH_MUTATIONS: readonly SourceMutation[] = [
  {
    id: "no-invalid-summary-step",
    from: "if (!s.valid && (seg === undefined || alive(seg.site)))",
    to: "if (false)",
  },
  {
    id: "summary-presence-means-summarized",
    from: "snapshot.summaries.filter((s) => s.valid)",
    to: "snapshot.summaries",
  },
  {
    id: "summarize-before-truncate",
    from: "  for (const s of oldUnsummarized) {\n    if (s.validBytes < s.bytes)",
    to: '  for (const s of oldUnsummarized) steps.push({ kind: "summarize-log", segment: s.segment });\n  for (const s of oldUnsummarized) {\n    if (s.validBytes < s.bytes)',
  },
  {
    id: "deletes-current-run-parts",
    from: 'if (f.kind === "part" && isOld(snapshot, f.run))',
    to: 'if (f.kind === "part")',
  },
  {
    id: "keeps-tmp-files",
    from: 'if (f.kind === "tmp" && alive(f.site) && isOld(snapshot, f.run))',
    to: "if (false)",
  },
  {
    id: "seal-pack-step-back",
    from: "  for (const path of snapshot.unfinishedExports)",
    to: '  for (const f of snapshot.files) if (f.kind === "pack" && isOld(snapshot, f.run)) steps.push({ kind: "seal-pack", path: f.path } as never);\n  for (const path of snapshot.unfinishedExports)',
  },
  {
    id: "orphan-check-ignores-exclusion",
    from: 'f.kind === "body" &&\n      alive(f.site) &&',
    to: 'f.kind === "body" &&',
  },
];

describe("the crash table", () => {
  it.each(CRASH_ROWS)("row $n, $diedDuring: plans $plan and replans to []", (row) => {
    const plan = reconcile.planReconcile(row.snapshot);
    expect(plan.map((s) => s.kind)).toEqual(row.plan);
    expect(reconcile.planReconcile(reconcile.applyPlan(row.snapshot, plan))).toEqual([]);
  });

  it("a plan lists its steps in RECONCILE_STEPS order", () => {
    const order = Object.keys(reconcile.RECONCILE_STEPS);
    for (const row of CRASH_ROWS) {
      const positions = reconcile.planReconcile(row.snapshot).map((s) => order.indexOf(s.kind));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it.each(SKETCH_MUTATIONS)("planted $id fails at least one row", async (m) => {
    expect(crashRowsFailing(await importMutated<Planner>("reconcile.ts", m))).not.toEqual([]);
  });
});

const SITES = ["a.example", "b.example", "c.example"] as Site[];
const dirOf = (site: Site) => `${LAYOUT.sitesDir}/${siteDirName(site)}`;

/**
 * What recovery must leave, checked against the disk and the model's own record, never against the plan: nothing of
 * an excluded site, no old part, tmp file, orphan body or unfinished export; every old segment ends at a line and has
 * a valid summary; this run's files untouched; every committed line of a kept segment, and the body it names, kept.
 */
function broken(
  planner: Planner,
  disk: Disk,
  truth: Truth,
  current: RunId,
  currentPart: string | null,
): string | null {
  const replan = planner.planReconcile(snapshotOf(disk, current));
  if (replan.length > 0)
    return `the second plan is not empty: ${replan.map((s) => s.kind).join(", ")}`;
  const excluded = excludedOn(disk);
  const files = [...disk.files.keys()];
  for (const site of excluded) {
    if (disk.siteDirs.has(dirOf(site)) || files.some((p) => p.startsWith(`${dirOf(site)}/`)))
      return `${site} is excluded but still on disk`;
  }
  if (currentPart !== null && !disk.files.has(currentPart)) return "this run's part was deleted";
  const named = new Set<string>();
  for (const path of files) {
    const name = parseArchiveName(path.split("/"));
    if (name === null) continue;
    if (name.kind === "part" && name.run !== current) return `old part ${path} left`;
    if (name.kind === "tmp") return `tmp ${path} left`;
    if (name.kind === "log") {
      const text = disk.files.get(path) ?? "";
      if (text !== "" && !text.endsWith("\n")) return `${path} ends mid-line`;
      const summary = disk.files.get(logSummaryPath(name.segment).join("/"));
      if (summary === undefined || decodeSummary(summary, text.length as ByteCount) === null)
        return `${path} has no valid summary`;
      for (const line of wholeLines(text).decoded) {
        const { body } = line.exchange.kind === "answered" ? line.exchange : { body: null };
        if (body?.kind === "stored" && body.at.kind === "file")
          named.add(`${dirOf(body.at.site)}/bodies/${body.at.id}.body`);
      }
    }
    if (name.kind === "summary" && !disk.files.has(logSegmentPath(name.segment).join("/")))
      return `summary ${path} has no segment`;
  }
  for (const path of files)
    if (parseArchiveName(path.split("/"))?.kind === "body" && !named.has(path))
      return `orphan body ${path} left`;
  if (disk.journal.size > 0 || [...disk.exports].some((p) => p.endsWith(".part")))
    return "an unfinished export is left";
  const gone = (path: string) =>
    truth.retained.has(path) || excluded.some((site) => path.startsWith(`${dirOf(site)}/`));
  for (const [path, lines] of truth.lines) {
    if (!gone(path) && disk.files.get(path) !== lines.join(""))
      return `committed lines of ${path} changed`;
  }
  for (const [body, segment] of truth.namedBodies) {
    if (!gone(segment) && !gone(body) && !disk.files.has(body))
      return `body ${body} of a committed line was deleted`;
  }
  return null;
}

/** Recovery at the start of `current`, interrupted part way at random, then run again to the end. */
function recover(planner: Planner, disk: Disk, current: RunId, r: ReturnType<typeof random>): void {
  const first = planner.planReconcile(snapshotOf(disk, current));
  try {
    execute(
      disk,
      first,
      new Steps(
        r.chance(0.4) ? r.int(8) : Number.POSITIVE_INFINITY,
        r.chance(0.5) ? r.int(1000) / 1000 : null,
      ),
    );
    return;
  } catch (error) {
    if (!(error instanceof Crash)) throw error;
  }
  execute(
    disk,
    planner.planReconcile(snapshotOf(disk, current)),
    new Steps(Number.POSITIVE_INFINITY, null),
  );
}

function liveRun(run: Run, r: ReturnType<typeof random>, actions: number): void {
  for (let i = 0; i < actions; i++) {
    const live = SITES.filter((s) => !run.excluded.has(s));
    const site = r.pick(live);
    const roll = r.int(100);
    if (roll < 15) run.startTee(site, 1 + r.int(50));
    else if (roll < 30) run.finishTee(r);
    else if (roll < 50) run.memoryBody(site, 1 + r.int(40));
    else if (roll < 65) run.plainLine(site, r.pick(["answered", "unanswered"]));
    else if (roll < 75) run.seal(site);
    else if (roll < 79) run.touchSettings();
    else if (roll < 83 && live.length > 1) run.exclude(site);
    else if (roll < 90) run.exportFile();
    else run.retain(r);
  }
  run.quit(SITES);
}

/** Three runs, each ending in a crash at a random step (sometimes torn) or a clean quit, each followed by recovery. */
function generatedCase(planner: Planner, seed: number): string | null {
  const r = random(seed);
  const disk = emptyDisk();
  const truth = emptyTruth();
  for (let n = 1; n <= 3; n++) {
    const run = new Run(
      `r${n}` as RunId,
      disk,
      truth,
      new Steps(
        r.chance(0.8) ? r.int(120) : Number.POSITIVE_INFINITY,
        r.chance(0.5) ? r.int(1000) / 1000 : null,
      ),
    );
    try {
      liveRun(run, r, 5 + r.int(40));
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    }
    const summaries = [...disk.files.keys()].filter(
      (p) => parseArchiveName(p.split("/"))?.kind === "summary",
    );
    if (summaries.length > 0 && r.chance(0.25)) {
      const lost = r.pick(summaries);
      disk.files.set(lost, "\0".repeat(disk.files.get(lost)?.length ?? 0));
    }
    const next = `r${n + 1}` as RunId;
    const currentPart = r.chance(0.3) ? `${LAYOUT.incomingDir}/${next}.1.part` : null;
    if (currentPart !== null) disk.files.set(currentPart, "early");
    recover(planner, disk, next, r);
    const problem = broken(planner, disk, truth, next, currentPart);
    if (problem !== null) return `seed ${seed}, after run ${n}: ${problem}`;
    if (currentPart !== null) disk.files.delete(currentPart);
  }
  return null;
}

const SEEDS = Array.from({ length: 600 }, (_, i) => i + 1);
const firstFailure = (planner: Planner): string | null => {
  for (const seed of SEEDS) {
    const problem = generatedCase(planner, seed);
    if (problem !== null) return problem;
  }
  return null;
};

describe("recovery after generated crashes", () => {
  it("plan, apply, plan again is always empty, and no committed line or the body it names is lost", () => {
    expect(firstFailure(reconcile)).toBeNull();
  });

  it.each(Object.keys(reconcile.RECONCILE_STEPS))(
    "planted: without the %s rule a generated crash is left unrecovered",
    async (kind) => {
      const planner = await importMutated<Planner>("reconcile.ts", {
        id: `no-${kind}`,
        from: `steps.push({ kind: "${kind}"`,
        to: `void ({ kind: "${kind}"`,
      });
      expect(firstFailure(planner)).not.toBeNull();
    },
  );
});
