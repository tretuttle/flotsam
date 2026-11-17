import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readExtensionId, readExtensionPopupPath, waitForActiveExtensionUrl } from "./browser.ts";
import { judgeAfterCrash } from "./export-judge.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  waitForJob,
} from "./export-session.ts";
import { FIXTURES_PAGE_PATH } from "./fixtures.ts";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";
import { callHook, recordingWorkspace } from "./recording-session.ts";
import { startFixtureServer } from "./server.ts";

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
const MIB = 1_048_576;

/**
 * Crash row 13 on a real browser, killed while an export writes. An unnamed file leaves nothing: no name was ever
 * given, and the journal has no line. A named part (the harness-only pref, as where no folder can be held) is left, and
 * the next start deletes it because the journal named it. Planted: a leftover named file after an unnamed export's
 * kill, and the journal removed before the next start, must each be reported as left behind.
 */
describe.runIf(binary !== "" && NodeFS.existsSync(binary) && xpi !== null)(
  "an export killed mid-write on a real browser",
  () => {
    const extensionPath = NodePath.join(distDir, xpi ?? "");

    it.each([
      { named: false, planted: false, caught: false },
      { named: false, planted: true, caught: true },
      { named: true, planted: false, caught: false },
      { named: true, planted: true, caught: true },
    ])(
      "named part: $named; planted: $planted; leftover reported: $caught",
      async ({ named: namedParts, planted, caught }) => {
        await using server = await startFixtureServer();
        await using workspace = recordingWorkspace(`export-crash-${String(planted)}`);
        const base = {
          binaryPath: binary,
          display: "headless" as const,
          protocol: "marionette" as const,
          signal: new AbortController().signal,
        };
        const named = () =>
          NodeFS.readdirSync(workspace.downloads).filter((n) => n.startsWith("killed"));
        {
          await using session = await workspace.launch({
            ...base,
            extensionPath,
            ...(namedParts
              ? {
                  extraPrefs: [{ name: "extensions.oneClickHar.harness.namedParts", value: true }],
                }
              : {}),
          });
          const page = await openExtensionPage(session, extensionPath);
          const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
          await session.evaluate(tab, "window.__harnessReady");
          const job = await startExport(page, {
            selection: {
              scope: "tab",
              tabId: await newestPageTab(page),
              range: { kind: "since-tab-opened" },
              include: "all",
            },
            bodies: "include",
            redaction: "standard",
            packaging: "har",
            fileName: "killed",
          });
          const writing = await waitForJob(
            page,
            job.id,
            (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= MIB),
          );
          expect(writing.state.kind).toBe("writing");
          await session.kill();
        }
        const journal = NodePath.join(workspace.root(), "exports.jsonl");
        expect(named()).toEqual(namedParts ? ["killed.har.part"] : []);
        if (!namedParts) expect(NodeFS.existsSync(journal)).toBe(false);
        if (planted && namedParts) NodeFS.rmSync(journal);
        if (planted && !namedParts)
          NodeFS.writeFileSync(NodePath.join(workspace.downloads, "killed.har"), "");
        {
          await using session = await workspace.launch({ ...base, extensionPath: null });
          await waitForActiveExtensionUrl(
            session,
            await readExtensionId(extensionPath),
            await readExtensionPopupPath(extensionPath),
          );
          const steps = (await callHook(session, { kind: "recovery" })) as readonly {
            kind: string;
          }[];
          const problems = judgeAfterCrash({
            steps: steps.map((s) => s.kind),
            left: named(),
            journaled: namedParts,
          });
          expect(problems.length > 0).toBe(caught);
        }
      },
    );
  },
);
