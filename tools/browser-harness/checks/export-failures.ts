import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { judgeFailure, type FailureObservation } from "../src/export-judge.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  value,
  waitForJob,
  type Job,
} from "../src/export-session.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import { recordingWorkspace, type RecordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "export-failures";
const MIB = 1_048_576;

type Row = {
  readonly name: string;
  readonly fileName: string;
  readonly expect: "access-denied" | "folder-missing";
  readonly before?: (folder: string) => void;
  /** Done once the export has written its first MiB. */
  readonly during?: (folder: string, part: string) => void;
  readonly after?: (folder: string) => void;
};

/** One row per way the export folder refuses. Each runs against the fixtures page's two 50 MB bodies. */
const ROWS: readonly Row[] = [
  {
    name: "read-only export folder",
    fileName: "read-only-folder",
    expect: "access-denied",
    before: (folder) => NodeFS.chmodSync(folder, 0o500),
    after: (folder) => NodeFS.chmodSync(folder, 0o700),
  },
  {
    name: "part made read-only mid-export",
    fileName: "read-only-part",
    expect: "access-denied",
    during: (_folder, part) => NodeFS.chmodSync(part, 0o400),
  },
  {
    name: "export folder deleted mid-export",
    fileName: "deleted-folder",
    expect: "folder-missing",
    during: (folder) => NodeFS.rmSync(folder, { recursive: true, force: true }),
    after: (folder) => NodeFS.mkdirSync(folder, { recursive: true, mode: 0o700 }),
  },
];

const leftIn = (folder: string, fileName: string): readonly string[] =>
  NodeFS.existsSync(folder) ? NodeFS.readdirSync(folder).filter((n) => n.startsWith(fileName)) : [];

const privatePaths = (workspace: RecordingWorkspace): readonly string[] => [
  workspace.profileDir,
  workspace.downloads,
  workspace.dataHome,
];

/**
 * A read-only export folder, a part made read-only while it is written, and a folder deleted while it is written each
 * end write-failed with their named kind, leave no file, and put no path in anything the API returns to the page.
 * Planted: the old `{ kind: "other", detail: String(error) }` with a path in it must fail the same judge.
 */
const check: HarnessCheck = {
  name: NAME,
  description: "refused export folders give named failure kinds with no path reaching the page",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null)
      return { name: NAME, ok: false, durationMs: 0, detail: "needs --extension" };
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("export-failures");
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
    const folder = workspace.downloads;
    const problems: string[] = [];
    const seen: string[] = [];
    for (const row of ROWS) {
      row.before?.(folder);
      let final: Job;
      try {
        const job = await startExport(page, {
          selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
          bodies: "include",
          redaction: "standard",
          packaging: "har",
          fileName: row.fileName,
        });
        if (row.during !== undefined) {
          const writing = await waitForJob(
            page,
            job.id,
            (j) => ended(j) || (j.state.kind === "writing" && j.state.bytes >= MIB),
          );
          if (writing.state.kind !== "writing")
            problems.push(`${row.name}: ended before the refusal`);
          else row.during(folder, NodePath.join(folder, `${row.fileName}.har.part`));
        }
        final = await waitForJob(page, job.id, ended);
      } finally {
        row.after?.(folder);
      }
      const served = JSON.stringify({
        job: final,
        list: await value(page, "browser.oneClickHar.listExports()"),
        popup: await value(page, `browser.oneClickHar.getPopup({ tabId: ${String(tabId)} })`),
      });
      const observation: FailureObservation = {
        expect: row.expect,
        state: final.state,
        served,
        paths: privatePaths(workspace),
        left: leftIn(folder, row.fileName),
      };
      problems.push(...judgeFailure(observation).map((p) => `${row.name}: ${p}`));
      seen.push(`${row.name} ${JSON.stringify(final.state)}`);
    }
    const leak: FailureObservation = {
      expect: "access-denied",
      state: {
        kind: "write-failed",
        failure: { kind: "other", detail: `NotAllowedError: ${folder}/x.har.part` },
      },
      served: `{"failure":{"kind":"other","detail":"NotAllowedError: ${folder}/x.har.part"}}`,
      paths: privatePaths(workspace),
      left: [],
    };
    const caught = judgeFailure(leak);
    if (caught.length < 3)
      problems.push(`planted detail with a path caught only as ${JSON.stringify(caught)}`);
    return {
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `${seen.join("; ")}; no path in anything served; nothing left; planted detail with a path caught (${String(caught.length)} problems)`
          : problems.join("; "),
      data: seen,
    };
  },
};

/** @discovered-check */
export default check;
