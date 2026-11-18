import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { runExportCrashCase } from "./export-crash-case.ts";
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
  "an export killed mid-write on a real browser (unnamed)",
  () => {
    const extensionPath = NodePath.join(distDir, xpi ?? "");

    it.each([
      { planted: false, caught: false },
      { planted: true, caught: true },
    ])(
      "named part: false; planted: $planted; leftover reported: $caught",
      async ({ planted, caught }) => {
        const result = await runExportCrashCase({
          binaryPath: binary,
          extensionPath,
          namedParts: false,
          planted,
        });
        expect(result.writingKind).toBe("writing");
        expect(result.beforeRestartNamed).toEqual([]);
        expect(result.journalExists).toBe(false);
        expect(result.leftoverProblems.length > 0).toBe(caught);
      },
    );
  },
);
