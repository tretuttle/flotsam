import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CRASH_ROWS, runCrashRow, runRow17bPlanted, runRow17Planted } from "./kill-at-point.ts";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";

requireIsolatedPidNamespace();

const binary = process.env.BROWSER_HARNESS_BINARY ?? "";
const distDir = NodePath.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "apps",
  "extension",
  "dist",
);
const xpi = NodeFS.existsSync(distDir)
  ? (NodeFS.readdirSync(distDir).find((name) => /^one-click-har-.*\.xpi$/.test(name)) ?? null)
  : null;

describe.runIf(binary !== "" && NodeFS.existsSync(binary) && xpi !== null)(
  "crash table on a real browser",
  () => {
    const extensionPath = NodePath.join(distDir, xpi ?? "");

    it.each(CRASH_ROWS)(
      "row $row: killed during $diedDuring, the next start plans and reads as the table says",
      async (row) => {
        const result = await runCrashRow(row, {
          binaryPath: binary,
          extensionPath,
          display: "headless",
          signal: new AbortController().signal,
        });
        expect(result.steps).toEqual(row.plan);
        expect(result.problems).toEqual([]);
      },
    );

    it("row 17: an unreadable summary planted on disk is deleted and re-summarized", async () => {
      const result = await runRow17Planted({
        binaryPath: binary,
        extensionPath,
        display: "headless",
        signal: new AbortController().signal,
      });
      expect(result.steps).toEqual(["delete-invalid-summary", "summarize-log"]);
      expect(result.problems).toEqual([]);
    });

    it("row 17b: a valid summary older than a whole appended line is deleted and re-summarized", async () => {
      const result = await runRow17bPlanted({
        binaryPath: binary,
        extensionPath,
        display: "headless",
        signal: new AbortController().signal,
      });
      expect(result.steps).toEqual(["delete-invalid-summary", "summarize-log"]);
      expect(result.problems).toEqual([]);
    });
  },
);
