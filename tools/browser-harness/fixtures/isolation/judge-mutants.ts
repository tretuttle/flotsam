import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { applyMutant, generateMutants, type Mutant } from "../../mutation/operators.ts";
import type { ArchiveEvidence, ExtraCheckResult } from "./archive-oracle.ts";
import type { IsolationRunInput } from "./judge.ts";
import { asRequired, PLANTS, recordedIsolation } from "./regressions.ts";

// Every operator mutant of the isolation judge, its archive oracle and its probe table must be killed, or be listed
// in equivalent-mutants.json with its reason. A mutant is killed when it changes the verdict of a recorded real run
// (the baseline goes red, or a planted regression stops turning its paired rows red), or when a unit test fails.

const HERE = import.meta.dirname;
const PACKAGE_DIR = NodePath.resolve(HERE, "..", "..");
const REPO_ROOT = NodePath.resolve(PACKAGE_DIR, "..", "..");
const MODULES = ["judge.ts", "archive-oracle.ts", "probe-table.ts"] as const;
const EQUIVALENT_FILE = NodePath.join(HERE, "equivalent-mutants.json");

type Recorded = {
  readonly name: string;
  readonly mustFail: readonly string[];
  readonly input: IsolationRunInput;
  readonly evidence: ArchiveEvidence;
};

type Judge = {
  readonly judgeIsolationRun: (input: IsolationRunInput) => Parameters<typeof asRequired>[1];
  readonly judgeArchive: (evidence: ArchiveEvidence) => readonly ExtraCheckResult[];
};

function loadRecorded(runsDirs: readonly string[]): readonly Recorded[] {
  const recorded: Recorded[] = [];
  for (const dir of runsDirs) {
    for (const name of NodeFS.readdirSync(dir).sort()) {
      const file = NodePath.join(dir, name, "check-results.json");
      if (!NodeFS.existsSync(file)) continue;
      const data = recordedIsolation(JSON.parse(NodeFS.readFileSync(file, "utf8")))?.data;
      if (data === null || data === undefined) throw new Error(`${file} holds no isolation data`);
      const plant = PLANTS.find((p) => p.id === name);
      if (plant === undefined && !name.startsWith("baseline"))
        throw new Error(`${name} is neither a plant nor a baseline`);
      recorded.push({
        name: `${NodePath.basename(dir)}/${name}`,
        mustFail: plant?.mustFail ?? [],
        input: data["input"] as IsolationRunInput,
        evidence: data["archiveEvidence"] as ArchiveEvidence,
      });
    }
  }
  return recorded;
}

/** Re-judges a recorded run as the check would: archive rules from the evidence, the rest from the input. */
function replay(judge: Judge, run: Recorded, archiveIds: ReadonlySet<string>): boolean {
  const extraChecks = [
    ...run.input.extraChecks.filter((c) => !archiveIds.has(c.id)),
    ...judge.judgeArchive(run.evidence),
  ];
  return asRequired(
    { id: run.name, mustFail: run.mustFail },
    judge.judgeIsolationRun({ ...run.input, extraChecks }),
  );
}

async function loadJudge(dir: string): Promise<Judge> {
  const judge = (await import(NodeURL.pathToFileURL(NodePath.join(dir, "judge.ts")).href)) as Pick<
    Judge,
    "judgeIsolationRun"
  >;
  const oracle = (await import(
    NodeURL.pathToFileURL(NodePath.join(dir, "archive-oracle.ts")).href
  )) as Pick<Judge, "judgeArchive">;
  return { judgeIsolationRun: judge.judgeIsolationRun, judgeArchive: oracle.judgeArchive };
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
  const judge = await loadJudge(original);
  const archiveIds = new Set(
    recorded.flatMap((r) => judge.judgeArchive(r.evidence).map((c) => c.id)),
  );
  const wrong = recorded.filter((run) => !replay(judge, run, archiveIds));
  if (wrong.length > 0)
    throw new Error(
      `the unmutated judge does not reproduce: ${wrong.map((r) => r.name).join(", ")}`,
    );
  if (!recorded.some((r) => r.mustFail.length === 0)) throw new Error("no baseline run to replay");

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
      const mutated = await loadJudge(dir);
      killed = recorded.some((run) => !replay(mutated, run, archiveIds));
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
