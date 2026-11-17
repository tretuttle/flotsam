import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { applyMutant, generateMutants, type Mutant } from "../../mutation/operators.ts";
import type * as OracleModule from "./archive-oracle.ts";
import type { ArchiveEvidence, ExtraCheckResult } from "./archive-oracle.ts";
import type * as DiskModule from "./disk.ts";
import type { DiskEvidence } from "./disk.ts";
import type * as ExposureModule from "./exposure.ts";
import type { ExposureEvidence } from "./exposure.ts";
import type * as IdentityModule from "./identity.ts";
import type * as JudgeModule from "./judge.ts";
import type { IsolationRunInput } from "./judge.ts";
import { PLANTS, recordedIsolation } from "./regressions.ts";
import type * as TargetsModule from "./targets.ts";
import type { ExtraCheckId } from "./probe-table.ts";
import type { CheckOutcome, PlanInput } from "./targets.ts";

// Every operator mutant of the isolation judges (the row judge, the archive oracle, the probe table, the target plan
// and witness, the target identities, the disk rules and the exposure rules) must be killed, or be listed in equivalent-mutants.json with
// its reason. A mutant is killed when it changes anything the judges print for a recorded real run: a verdict, an
// ok, a count, a mismatch line, an extra check's detail, a disk or exposure problem. Or when a unit test fails.

const HERE = import.meta.dirname;
const PACKAGE_DIR = NodePath.resolve(HERE, "..", "..");
const REPO_ROOT = NodePath.resolve(PACKAGE_DIR, "..", "..");
const MODULES = [
  "judge.ts",
  "archive-oracle.ts",
  "probe-table.ts",
  "targets.ts",
  "identity.ts",
  "disk.ts",
  "exposure.ts",
] as const;
const EQUIVALENT_FILE = NodePath.join(HERE, "equivalent-mutants.json");

type Recorded = {
  readonly name: string;
  /** What the check printed when it ran; the unmutated judges must reproduce it exactly. */
  readonly judgment: unknown;
  readonly input: IsolationRunInput;
  readonly evidence: ArchiveEvidence;
  readonly exposure: ExposureEvidence;
  readonly disk: DiskEvidence;
  readonly planInput: PlanInput;
  readonly witnessResults: readonly (readonly [string, CheckOutcome])[];
};

type Judges = {
  readonly judge: typeof JudgeModule;
  readonly oracle: typeof OracleModule;
  readonly targets: typeof TargetsModule;
  readonly identity: typeof IdentityModule;
  readonly disk: typeof DiskModule;
  readonly exposure: typeof ExposureModule;
};

function loadRecorded(runsDirs: readonly string[]): readonly Recorded[] {
  const recorded: Recorded[] = [];
  for (const dir of runsDirs) {
    for (const name of NodeFS.readdirSync(dir).sort()) {
      const file = NodePath.join(dir, name, "check-results.json");
      if (!NodeFS.existsSync(file)) continue;
      // A plant that edited one of the judges was judged by that edited judge, so it cannot be judged again here.
      const plant = PLANTS.find((p) => p.id === name);
      if (plant?.edits.some((e) => MODULES.some((m) => e.file.endsWith(`/isolation/${m}`)))) {
        process.stdout.write(`skipping ${name}: its plant edits a judge\n`);
        continue;
      }
      const data = recordedIsolation(JSON.parse(NodeFS.readFileSync(file, "utf8")))?.data;
      if (data === null || data === undefined) throw new Error(`${file} holds no isolation data`);
      recorded.push({
        name: `${NodePath.basename(dir)}/${name}`,
        judgment: data["judgment"],
        input: data["input"] as IsolationRunInput,
        evidence: data["archiveEvidence"] as ArchiveEvidence,
        exposure: data["exposureEvidence"] as ExposureEvidence,
        disk: data["diskEvidence"] as DiskEvidence,
        planInput: data["planInput"] as PlanInput,
        witnessResults: data["witnessResults"] as Recorded["witnessResults"],
      });
    }
  }
  return recorded;
}

const REJUDGED = new Set(["disk-writes-allowed", "exposure-allowed"]);

const rejudged = (
  run: Recorded,
  id: ExtraCheckId,
  problems: readonly string[],
): ExtraCheckResult => ({
  id,
  ok: problems.length === 0,
  detail:
    problems.length === 0
      ? (run.input.extraChecks.find((c) => c.id === id)?.detail ?? "")
      : problems.join("; "),
});

/**
 * Judges a recorded run again from what it recorded: the plan and witness from the plan input and the witness's
 * per-check results, the archive, disk and exposure rules from their evidence, and the rows from the browser's
 * reports. The result is everything a person reads, as JSON.
 */
function replay(j: Judges, run: Recorded): string {
  const plan = j.targets.planTargets(run.planInput);
  const witness = j.targets.combineWitness(plan, new Map(run.witnessResults));
  const archiveChecks = j.oracle.judgeArchive(run.evidence);
  const archiveIds = new Set(archiveChecks.map((c) => c.id));
  const disk = j.disk.diskProblems(run.disk);
  const exposure = j.exposure.exposureProblems(run.exposure);
  const judgment = j.judge.judgeIsolationRun({
    ...run.input,
    targets: plan.targets,
    witness,
    identity: j.identity.identities(run.planInput),
    // In the order the check records them; a check that holds keeps the summary the check wrote for it.
    extraChecks: [
      ...run.input.extraChecks.filter((c) => !archiveIds.has(c.id) && !REJUDGED.has(c.id)),
      rejudged(run, "disk-writes-allowed", disk),
      rejudged(run, "exposure-allowed", exposure),
      ...archiveChecks,
    ],
  });
  return JSON.stringify({ judgment, disk, exposure });
}

async function loadJudges(dir: string): Promise<Judges> {
  const load = (name: string): Promise<unknown> =>
    import(NodeURL.pathToFileURL(NodePath.join(dir, name)).href);
  return {
    judge: (await load("judge.ts")) as typeof JudgeModule,
    oracle: (await load("archive-oracle.ts")) as typeof OracleModule,
    targets: (await load("targets.ts")) as typeof TargetsModule,
    identity: (await load("identity.ts")) as typeof IdentityModule,
    disk: (await load("disk.ts")) as typeof DiskModule,
    exposure: (await load("exposure.ts")) as typeof ExposureModule,
  };
}

function writeModules(dir: string, mutant: Mutant | null): void {
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const name of MODULES) {
    const source = NodeFS.readFileSync(NodePath.join(HERE, name), "utf8");
    NodeFS.writeFileSync(
      NodePath.join(dir, name),
      mutant !== null && mutant.file === name ? applyMutant(source, mutant) : source,
    );
  }
}

/** A copy of the package whose fixtures/isolation the unit phase mutates; dependencies are shared by symlink. */
function unitCopy(work: string): string {
  const copy = NodePath.join(work, "unit");
  NodeFS.rmSync(copy, { recursive: true, force: true });
  for (const file of [
    "package.json",
    "pnpm-workspace.yaml",
    "vite.config.ts",
    "tsconfig.base.json",
  ]) {
    NodeFS.cpSync(NodePath.join(REPO_ROOT, file), NodePath.join(copy, file));
  }
  const pkg = NodePath.join(copy, "tools", "browser-harness");
  NodeFS.cpSync(PACKAGE_DIR, pkg, {
    recursive: true,
    filter: (source) => !source.split(NodePath.sep).includes("node_modules"),
  });
  NodeFS.symlinkSync(NodePath.join(REPO_ROOT, "node_modules"), NodePath.join(copy, "node_modules"));
  NodeFS.symlinkSync(
    NodePath.join(PACKAGE_DIR, "node_modules"),
    NodePath.join(pkg, "node_modules"),
  );
  return pkg;
}

function unitTestsPass(pkg: string, work: string): boolean {
  const result = NodeChildProcess.spawnSync(
    NodePath.join(REPO_ROOT, "node_modules", ".bin", "vp"),
    [
      "test",
      "run",
      "--config",
      NodePath.join(pkg, "..", "..", "vite.config.ts"),
      "fixtures/isolation/",
    ],
    { cwd: pkg, encoding: "utf8", env: { ...process.env, TMPDIR: work }, timeout: 120_000 },
  );
  return result.status === 0;
}

async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: { runs: { type: "string", multiple: true }, work: { type: "string" } },
  });
  if (values.runs === undefined || values.work === undefined) {
    throw new Error(
      "usage: judge-mutants.ts --work <empty folder> --runs <regressions runs folder> [--runs <folder>...]",
    );
  }
  const work = NodePath.resolve(values.work);
  const recorded = loadRecorded(values.runs);
  const equivalent = JSON.parse(NodeFS.readFileSync(EQUIVALENT_FILE, "utf8")) as Record<
    string,
    string
  >;

  const original = NodePath.join(work, "original");
  writeModules(original, null);
  const judges = await loadJudges(original);
  const expected = new Map(recorded.map((run) => [run.name, replay(judges, run)]));
  const wrong = recorded.filter(
    (run) =>
      JSON.stringify((JSON.parse(expected.get(run.name)!) as { judgment: unknown }).judgment) !==
      JSON.stringify(run.judgment),
  );
  if (wrong.length > 0)
    throw new Error(
      `the unmutated judges do not reproduce: ${wrong.map((r) => r.name).join(", ")}`,
    );

  const mutants = MODULES.flatMap((file) =>
    generateMutants({ file, names: "all" }, NodeFS.readFileSync(NodePath.join(HERE, file), "utf8")),
  );
  process.stdout.write(
    `${String(mutants.length)} mutants, ${String(recorded.length)} recorded runs\n`,
  );

  const survivors: Mutant[] = [];
  let byReplay = 0;
  for (const [index, mutant] of mutants.entries()) {
    const dir = NodePath.join(work, "m", String(index));
    writeModules(dir, mutant);
    let killed: boolean;
    try {
      const mutated = await loadJudges(dir);
      killed = recorded.some((run) => replay(mutated, run) !== expected.get(run.name));
    } catch {
      killed = true;
    }
    NodeFS.rmSync(dir, { recursive: true, force: true });
    if (killed) byReplay += 1;
    else survivors.push(mutant);
  }

  const pkg = unitCopy(work);
  if (!unitTestsPass(pkg, work))
    throw new Error("the unmutated unit tests do not pass in the copy");
  const fixtures = NodePath.join(pkg, "fixtures", "isolation");
  const remaining: Mutant[] = [];
  let byUnit = 0;
  for (const mutant of survivors) {
    const file = NodePath.join(fixtures, mutant.file);
    const source = NodeFS.readFileSync(file, "utf8");
    NodeFS.writeFileSync(file, applyMutant(source, mutant));
    const killed = !unitTestsPass(pkg, work);
    NodeFS.writeFileSync(file, source);
    if (killed) byUnit += 1;
    else remaining.push(mutant);
  }

  const unexplained = remaining.filter((m) => equivalent[m.key] === undefined);
  const stale = Object.keys(equivalent).filter((key) => !remaining.some((m) => m.key === key));
  process.stdout.write(
    `${String(byReplay)} killed by replaying real runs, ${String(byUnit)} by unit tests, ${String(remaining.length)} survive (${String(remaining.length - unexplained.length)} listed as equivalent)\n`,
  );
  for (const m of remaining) {
    process.stdout.write(
      `${equivalent[m.key] === undefined ? "SURVIVED" : "equivalent"} ${m.key}\n`,
    );
  }
  for (const key of stale)
    process.stdout.write(`STALE equivalent entry, now killed or gone: ${key}\n`);
  NodeFS.rmSync(NodePath.join(work, "unit"), { recursive: true, force: true });
  if (unexplained.length > 0 || stale.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
