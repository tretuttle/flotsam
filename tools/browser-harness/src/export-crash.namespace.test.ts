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
 * Crash row 13 on a real browser: killed while an export writes, the browser leaves the .har.part and no .har, and the
 * next start deletes the part because the journal named it. Planted: the journal removed before the next start, so
 * the part must be reported as left behind.
 */
describe.runIf(binary !== "" && NodeFS.existsSync(binary) && xpi !== null)(
  "an export killed mid-write on a real browser",
  () => {
    const extensionPath = NodePath.join(distDir, xpi ?? "");

    it.each([
      { planted: false, caught: false },
      { planted: true, caught: true },
    ])(
      "journal removed before restart: $planted; leftover reported: $caught",
      async ({ planted, caught }) => {
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
          await using session = await workspace.launch({ ...base, extensionPath });
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
        expect(named()).toEqual(["killed.har.part"]);
        if (planted) NodeFS.rmSync(NodePath.join(workspace.root(), "exports.jsonl"));
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
          const problems = judgeAfterCrash({ steps: steps.map((s) => s.kind), left: named() });
          expect(problems.length > 0).toBe(caught);
        }
      },
    );
  },
);
