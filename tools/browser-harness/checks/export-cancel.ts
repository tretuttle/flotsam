import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { judgeCancel, type CancelObservation } from "../src/export-judge.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  waitForJob,
} from "../src/export-session.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import { callHook, recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "export-cancel";
const MIB = 1_048_576;
/** Cancel once this much of the file is written: well inside the first 50 MB body, which streams in chunks. */
const CANCEL_AFTER_BYTES = 6 * MIB;

/**
 * The fixtures page (two 50 MB bodies) is exported and cancelled mid-body. The export must end cancelled, having
 * written at most one more body chunk after cancel was asked, and leave neither the .har nor its .har.part, with the
 * journal's start line ended. Planted: a stop two chunks after cancel, and an export that ended done, must fail.
 */
const check: HarnessCheck = {
  name: NAME,
  description: "cancel stops an export within one body chunk and leaves no file",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null)
      return { name: NAME, ok: false, durationMs: 0, detail: "needs --extension" };
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("export-cancel");
    await using session = await workspace.launch({
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
    });
    const page = await openExtensionPage(session, context.extensionPath);
    const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
    await session.evaluate(tab, "window.__harnessReady");
    const tabId = await newestPageTab(page);
    const job = await startExport(page, {
      selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName: "cancelled",
    });
    const writing = await waitForJob(
      page,
      job.id,
      (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= CANCEL_AFTER_BYTES),
    );
    await page.session.evaluate(
      page.tab,
      `browser.oneClickHar.cancelExport(${JSON.stringify(job.id)}).then(String)`,
    );
    const final = await waitForJob(page, job.id, ended);
    const audit = (await callHook(session, {
      kind: "export-audit",
      id: job.id,
    })) as CancelObservation["audit"];
    const journal = NodePath.join(workspace.root(), "exports.jsonl");
    const observation: CancelObservation = {
      state: final.state.kind,
      audit,
      left: NodeFS.readdirSync(workspace.downloads).filter((name) => name.startsWith("cancelled")),
      journal: NodeFS.existsSync(journal) ? NodeFS.readFileSync(journal, "utf8") : "",
    };
    const problems = [...judgeCancel(observation)];
    if (writing.state.kind !== "writing")
      problems.push(`ended before cancel: ${JSON.stringify(writing.state)}`);
    const planted = [
      { ...observation, audit: { bytesAtCancel: 0, bytesAtStop: 11 * MIB } },
      { ...observation, state: "done" },
    ].filter((p) => judgeCancel(p).length === 0);
    if (planted.length > 0)
      problems.push(`planted cancel failures passed: ${JSON.stringify(planted)}`);
    return {
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `cancelled at ${String(audit?.bytesAtCancel)} bytes, stopped at ${String(audit?.bytesAtStop)}; no file left; journal ended; planted late stop and finished export caught`
          : problems.join("; "),
      data: observation,
    };
  },
};

/** @discovered-check */
export default check;
