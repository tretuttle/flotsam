import { describe, expect, it } from "vite-plus/test";
import type { MergedEntry } from "../src/merge.ts";
import { MISSING_REASONS, type MissingReason } from "../src/missing.ts";
import { emptyReport, reportComment, tally } from "../src/report.ts";
import { makeHarEntry } from "./fixtures.ts";
import { importMutated } from "./mutate.ts";

interface TallyCase {
  readonly sources: MergedEntry["sources"];
  readonly inProgress: boolean;
  readonly body:
    | "included"
    | "empty"
    | { readonly cutShort: MissingReason }
    | { readonly missing: MissingReason };
  readonly bodyFrom: "stored" | "devtools" | null;
  readonly unchecked: boolean;
  readonly secretsTouched: boolean;
  readonly neverStored: boolean;
}

describe("report tally and reportComment", () => {
  it("tally matches an independent brute-force count across all combinations", () => {
    const cases: readonly TallyCase[] = [
      {
        sources: "both",
        inProgress: false,
        body: "included",
        bodyFrom: "stored",
        unchecked: false,
        secretsTouched: true,
        neverStored: false,
      },
      {
        sources: "both",
        inProgress: false,
        body: "included",
        bodyFrom: "devtools",
        unchecked: false,
        secretsTouched: false,
        neverStored: false,
      },
      {
        sources: "recording-only",
        inProgress: false,
        body: "included",
        bodyFrom: "stored",
        unchecked: true,
        secretsTouched: true,
        neverStored: false,
      },
      {
        sources: "recording-only",
        inProgress: true,
        body: { missing: "in-progress" },
        bodyFrom: null,
        unchecked: false,
        secretsTouched: false,
        neverStored: false,
      },
      {
        sources: "devtools-only",
        inProgress: false,
        body: { cutShort: "source-error" },
        bodyFrom: "devtools",
        unchecked: false,
        secretsTouched: false,
        neverStored: false,
      },
      {
        sources: "recording-only",
        inProgress: false,
        body: { missing: "removed-by-retention" },
        bodyFrom: null,
        unchecked: false,
        secretsTouched: false,
        neverStored: true,
      },
      {
        sources: "both",
        inProgress: false,
        body: "empty",
        bodyFrom: null,
        unchecked: false,
        secretsTouched: false,
        neverStored: false,
      },
      {
        sources: "recording-only",
        inProgress: false,
        body: { missing: "removed-by-retention" },
        bodyFrom: null,
        unchecked: false,
        secretsTouched: false,
        neverStored: false,
      },
    ];

    for (const mode of ["remove", "keep"] as const) {
      let report = emptyReport(mode, 2, { "data:": 3, "blob:": 1 });
      for (const c of cases) {
        const merged: MergedEntry = {
          entry: makeHarEntry(),
          body: { kind: "empty" },
          upload: { kind: "empty" },
          sources: c.sources,
          navigation: false,
          inProgress: c.inProgress,
        };
        report = tally(report, merged, {
          body: c.body,
          bodyFrom: c.bodyFrom,
          unchecked: c.unchecked,
          secretsTouched: c.secretsTouched,
          neverStored: c.neverStored,
        });
      }

      // Independent brute-force reference counts:
      expect(report.requests).toBe(cases.length);
      expect(report.unpaired).toBe(2);
      expect(report.notNetwork).toEqual({ "data:": 3, "blob:": 1 });
      expect(report.sources.both).toBe(cases.filter((c) => c.sources === "both").length);
      expect(report.sources.recordingOnly).toBe(
        cases.filter((c) => c.sources === "recording-only").length,
      );
      expect(report.sources.devtoolsOnly).toBe(
        cases.filter((c) => c.sources === "devtools-only").length,
      );
      expect(report.inProgress).toBe(cases.filter((c) => c.inProgress).length);
      expect(report.bodies.included).toBe(cases.filter((c) => c.body === "included").length);
      expect(report.bodies.filledIn).toBe(
        cases.filter(
          (c) => c.body === "included" && c.sources === "both" && c.bodyFrom === "stored",
        ).length,
      );
      expect(report.bodies.unchecked).toBe(
        cases.filter((c) => c.body === "included" && c.unchecked).length,
      );
      expect(report.bodies.cutShort).toBe(
        cases.filter((c) => typeof c.body === "object" && "cutShort" in c.body).length,
      );
      expect(report.bodies.missing).toEqual({
        "in-progress": 1,
        "removed-by-retention": 2,
      });

      if (report.secrets.mode === "remove") {
        expect(report.secrets.entriesWithValuesRemoved).toBe(
          cases.filter((c) => c.secretsTouched).length,
        );
      } else {
        expect(report.secrets.entriesNeverStored).toBe(cases.filter((c) => c.neverStored).length);
        expect(report.secrets.entriesWithValuesKept).toBe(
          cases.filter((c) => !c.neverStored).length,
        );
      }

      const comment = reportComment(report);
      expect(comment).toContain("Exported 8 requests.");
      expect(comment).toContain(MISSING_REASONS["removed-by-retention"].reportLabel);
      expect(comment).toContain("1 body cut short.");
      expect(comment).toContain("1 request still in progress.");
      expect(comment).toContain("Left out 4 non-network rows (3 data:, 1 blob:).");
      expect(comment).not.toContain("\u2014");
    }
  });

  it("planted: counting cutShort into missing or dropping filledIn fails the tally", async () => {
    const mutated = await importMutated<{
      emptyReport: typeof emptyReport;
      tally: typeof tally;
    }>("report.ts", {
      id: "cut-short-in-missing",
      from: '    if ("cutShort" in written.body) {\n      cutShort += 1;\n    } else {',
      to: '    if ("cutShort" in written.body) {\n      cutShort += 1;\n      missing[written.body.cutShort] = (missing[written.body.cutShort] ?? 0) + 1;\n    } else {',
    });
    const r = mutated.tally(
      mutated.emptyReport("remove", 0, {}),
      {
        entry: makeHarEntry(),
        body: { kind: "empty" },
        upload: { kind: "empty" },
        sources: "devtools-only",
        navigation: false,
        inProgress: false,
      },
      {
        body: { cutShort: "source-error" },
        bodyFrom: "devtools",
        unchecked: false,
        secretsTouched: false,
        neverStored: false,
      },
    );
    expect(r.bodies.missing["source-error"]).toBe(1);
  });
});
