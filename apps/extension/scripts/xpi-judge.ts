// Judges the files of a packed XPI and writes one JSON line per event to stdout. check-xpi.ts runs it as a child
// process, so a native parser or minifier that crashes ends only this process and check-xpi names the file it was on.
// Usage: node scripts/xpi-judge.ts <xpi> <index of the last file already judged, or -1>
import * as NodeFS from "node:fs";
import { unzipSync } from "fflate";
import { CANNOT_JUDGE } from "./check-xpi.ts";
import { PRODUCERS, RULES, carriedUnits, kindOf, readUnit, type Unit } from "./xpi-rules.ts";

export interface Violation {
  readonly path: string;
  readonly rule: string;
  readonly detail: string;
}

export interface Measurement {
  readonly bytes: number;
  readonly saved: number;
  readonly margin: number;
}

export type JudgeEvent =
  | { readonly event: "start"; readonly index: number; readonly path: string }
  | {
      readonly event: "done";
      readonly index: number;
      readonly path: string;
      readonly violations: readonly Violation[];
      readonly measurement: Measurement | undefined;
    }
  | { readonly event: "end" };

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

const violation = (unit: Unit, rule: string, detail: string): Violation => ({
  path: unit.path,
  rule,
  detail: (unit.where === undefined ? detail : `${unit.where}: ${detail}`).replaceAll(/\s+/g, " "),
});

/** Every rule on the file and on each body it carries. A rule that throws has not judged the unit, so it fails. */
const judgeFile = (file: Unit): Extract<JudgeEvent, { event: "done" }> => {
  const violations: Violation[] = [];
  let measurement: Measurement | undefined;
  const pending: Unit[] = [file];
  for (let unit = pending.shift(); unit !== undefined; unit = pending.shift()) {
    const read = readUnit(unit);
    pending.push(...carriedUnits(read));
    for (const rule of RULES) {
      if (rule.inspects === "path" && unit.where !== undefined) continue;
      try {
        const detail = rule.check(read);
        if (detail !== undefined) violations.push(violation(unit, rule.id, detail));
      } catch (error) {
        violations.push(
          violation(
            unit,
            CANNOT_JUDGE,
            `the ${rule.id} rule could not judge it: ${messageOf(error)}`,
          ),
        );
      }
    }
    const minifier = PRODUCERS[unit.kind ?? "source"].minifier;
    if (unit === file && minifier !== undefined && "facts" in read && "saved" in read.facts)
      measurement = { bytes: unit.bytes.length, saved: read.facts.saved, margin: minifier.margin };
  }
  return { event: "done", index: -1, path: file.path, violations, measurement };
};

/** Entries in archive order by path, each with how many entries share its path. */
const readXpi = (xpi: Uint8Array): readonly Unit[] => {
  const entries = new Map<string, number>();
  const files = unzipSync(xpi, {
    filter: ({ name }) => {
      entries.set(name, (entries.get(name) ?? 0) + 1);
      return true;
    },
  });
  return Object.entries(files)
    .filter(([path]) => !path.endsWith("/"))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => ({
      path,
      where: undefined,
      kind: kindOf(path),
      bytes,
      entries: entries.get(path) ?? 1,
    }));
};

// A synchronous write reaches the pipe before a native crash can end the process.
const emit = (event: JudgeEvent): void => {
  NodeFS.writeSync(1, `${JSON.stringify(event)}\n`);
};

if (import.meta.main) {
  const [xpi, after] = process.argv.slice(2);
  if (xpi === undefined)
    throw new Error("Usage: node scripts/xpi-judge.ts <xpi> <last judged index>");
  const files = readXpi(NodeFS.readFileSync(xpi));
  for (let index = Number(after ?? -1) + 1; index < files.length; index++) {
    const file = files[index];
    if (file === undefined) break;
    emit({ event: "start", index, path: file.path });
    // Lets a test prove the crash backstop without depending on where a native stack runs out.
    if (process.env.XPI_JUDGE_ABORT_ON === file.path) process.abort();
    let done: Extract<JudgeEvent, { event: "done" }>;
    try {
      done = { ...judgeFile(file), index };
    } catch (error) {
      done = {
        event: "done",
        index,
        path: file.path,
        violations: [violation(file, CANNOT_JUDGE, `judging it threw: ${messageOf(error)}`)],
        measurement: undefined,
      };
    }
    emit(done);
  }
  emit({ event: "end" });
}
