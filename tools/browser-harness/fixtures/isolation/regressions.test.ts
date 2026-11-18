import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { EXTRA_CHECKS, PROBE_TABLE } from "./probe-table.ts";
import { PLANTS } from "./regressions.ts";

// A plant whose anchor moved never runs: the suite stops on it at pack time, hours in. Hold every anchor to the
// source as it is now, so a product change that moves one fails here instead.

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..", "..", "..", "..");
const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe("planted regressions", () => {
  it("each edit's anchor occurs exactly once in the file it edits", () => {
    const off = PLANTS.flatMap((plant) =>
      plant.edits.flatMap((edit) => {
        const count = occurrences(
          NodeFS.readFileSync(NodePath.join(REPO_ROOT, edit.file), "utf8"),
          edit.from,
        );
        return count === 1
          ? []
          : [`${plant.id}: ${edit.file} holds its anchor ${String(count)} times`];
      }),
    );
    expect(off).toEqual([]);
  });

  it("each names only rows and extra checks the check reports", () => {
    const probes = new Set(PROBE_TABLE.map((p) => p.id));
    const unknown = PLANTS.flatMap((plant) =>
      plant.mustFail.filter((id) => {
        const probe = /^([^@]+)@[^=]+(=.+)?$/u.exec(id)?.[1];
        return probe === undefined ? !(id in EXTRA_CHECKS) : !probes.has(probe);
      }),
    );
    expect(unknown).toEqual([]);
    expect(new Set(PLANTS.map((p) => p.id)).size).toBe(PLANTS.length);
  });
});
