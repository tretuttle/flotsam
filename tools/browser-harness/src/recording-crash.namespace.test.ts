import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { ReconcileStep } from "@one-click-har/recording/reconcile";
import { readStoredBytes } from "./archive.ts";
import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "./browser.ts";
import { requireIsolatedPidNamespace } from "./namespace-isolation.ts";
import { judgeStoredBodies, pathOf } from "./recording-judge.ts";
import {
  callHook,
  recordingWorkspace,
  type HookRequest,
  type RecordingWorkspace,
} from "./recording-session.ts";
import { expectedFromServer } from "./recording-truth.ts";
import { startFixtureServer, type FixtureServer } from "./server.ts";

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
const SITE = "127.0.0.1";
const DEADLINE_MS = 20_000;

type Row = {
  readonly row: number;
  readonly diedDuring: string;
  readonly plan: readonly ReconcileStep["kind"][];
  /** Brings the browser to the crash point. The browser is killed when it resolves. */
  readonly reach: (run: RunContext) => Promise<void>;
  /** How the archive reads after the next start's recovery; [] when it reads as the table says. */
  readonly reads: (after: AfterContext) => readonly string[];
};

type RunContext = {
  readonly session: BrowserSession;
  readonly server: FixtureServer;
  readonly workspace: RecordingWorkspace;
  readonly tab: string;
};
type AfterContext = { readonly workspace: RecordingWorkspace; readonly server: FixtureServer };

const until = async (ready: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  const deadline = Date.now() + DEADLINE_MS;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Sends a request whose answer never comes, because it parks the write chain. */
const fire = (session: BrowserSession, request: HookRequest): Promise<unknown> =>
  session.evaluateChrome(
    `const done = arguments[arguments.length - 1];
     Services.obs.notifyObservers({ wrappedJSObject: { request: arguments[0], done: () => undefined } }, "one-click-har-harness");
     done(true);`,
    [request],
  );

const holdThen = async (
  run: RunContext,
  point: string,
  act: () => Promise<unknown>,
): Promise<void> => {
  await callHook(run.session, { kind: "arm", point });
  await act();
  await until(
    async () => (await callHook(run.session, { kind: "reached", point })) === true,
    `hold ${point}`,
  );
};

const fetchIn = (run: RunContext, path: string): Promise<string> =>
  run.session.evaluate(
    run.tab,
    `fetch(${JSON.stringify(path)}).then((r) => r.arrayBuffer()).then(() => "done")`,
  );

const streamPart = async (run: RunContext): Promise<void> => {
  await run.session.evaluate(
    run.tab,
    `(async () => { const reader = (await fetch("/id/endless")).body.getReader(); await reader.read(); window.__held = reader; return "streaming"; })()`,
  );
  const incoming = NodePath.join(run.workspace.root(), "incoming");
  await until(
    () =>
      NodeFS.readdirSync(incoming).some(
        (name) => NodeFS.statSync(NodePath.join(incoming, name)).size > 0,
      ),
    "a growing part",
  );
};

const incomingParts = (workspace: RecordingWorkspace): readonly string[] =>
  NodeFS.readdirSync(NodePath.join(workspace.root(), "incoming"));

/** The exchange the row interrupted has no line, nothing it wrote is left, and the earlier page reads byte-exact. */
const absent =
  (path: string) =>
  ({ workspace, server }: AfterContext): readonly string[] => {
    const lines = workspace.lines();
    const problems: string[] = [];
    if (lines.some((l) => pathOf(l.exchange) === path)) problems.push(`${path} has a line`);
    if (incomingParts(workspace).length > 0)
      problems.push(`parts left: ${incomingParts(workspace).join(", ")}`);
    const bodies = NodePath.join(workspace.root(), "sites", SITE, "bodies");
    if (NodeFS.existsSync(bodies) && NodeFS.readdirSync(bodies).length > 0)
      problems.push("a body file is left");
    problems.push(...available({ workspace, server }));
    return problems;
  };

const available = ({ workspace, server }: AfterContext): readonly string[] => {
  const earlier = workspace.lines().filter((l) => pathOf(l.exchange) === "/fixtures/range");
  const verdicts = judgeStoredBodies(earlier, expectedFromServer(server), (at) =>
    readStoredBytes(workspace.root(), at),
  );
  const summaries = NodeFS.readdirSync(
    NodePath.join(workspace.root(), "sites", SITE, "log"),
  ).filter((name) => name.endsWith(".summary.json"));
  return [
    ...(verdicts.length === 1 && verdicts[0]?.verdict === "exact"
      ? []
      : [`the earlier page reads as ${JSON.stringify(verdicts.map((v) => v.verdict))}`]),
    ...(summaries.length > 0 ? [] : ["the earlier segment has no summary"]),
  ];
};

const siteGone = ({ workspace }: AfterContext): readonly string[] => [
  ...(NodeFS.existsSync(NodePath.join(workspace.root(), "sites", SITE))
    ? [`sites/${SITE} still exists`]
    : []),
  ...(incomingParts(workspace).length > 0
    ? [`parts left: ${incomingParts(workspace).join(", ")}`]
    : []),
];

/** The crash table rows the plan names for a real browser (sketch/STORAGE.md, PLAN.md PR 6). */
const ROWS: readonly Row[] = [
  {
    row: 1,
    diedDuring: "a file tee, streaming",
    plan: ["delete-part", "summarize-log"],
    reach: streamPart,
    reads: absent("/id/endless"),
  },
  {
    row: 3,
    diedDuring: "after the rename, before the line flushed",
    plan: ["delete-orphan-body", "summarize-log"],
    reach: (run) => holdThen(run, "before-line-append", () => fetchIn(run, "/id/big?delayMs=0")),
    reads: absent("/id/big"),
  },
  {
    row: 6,
    diedDuring: "after the pack append, before the line append",
    plan: ["summarize-log"],
    reach: (run) => holdThen(run, "before-line-append", () => fetchIn(run, "/poll")),
    reads: absent("/poll"),
  },
  {
    row: 14,
    diedDuring: "an exclusion, after settings, during the directory delete",
    plan: ["delete-excluded-site"],
    reach: (run) =>
      holdThen(run, "exclusion-mid-delete", () =>
        fire(run.session, { kind: "exclude", site: SITE }),
      ),
    reads: siteGone,
  },
  {
    row: 16,
    diedDuring: "a summary write, during the .tmp write",
    plan: ["delete-tmp", "summarize-log"],
    reach: (run) => holdThen(run, "summary-tmp-written", () => fire(run.session, { kind: "seal" })),
    reads: available,
  },
  {
    row: 18,
    diedDuring: "an exclusion while a tee for that site streamed",
    plan: ["delete-excluded-site", "delete-part"],
    reach: async (run) => {
      await streamPart(run);
      await holdThen(run, "exclusion-mid-delete", () =>
        fire(run.session, { kind: "exclude", site: SITE }),
      );
    },
    reads: siteGone,
  },
];

describe.runIf(binary !== "" && NodeFS.existsSync(binary) && xpi !== null)(
  "crash table on a real browser",
  () => {
    const extensionPath = NodePath.join(distDir, xpi ?? "");

    it.each(ROWS)(
      "row $row: killed during $diedDuring, the next start plans and reads as the table says",
      async (row) => {
        await using server = await startFixtureServer();
        await using workspace = recordingWorkspace(`crash-${String(row.row)}`);
        const addonId = await readExtensionId(extensionPath);
        const popupPath = await readExtensionPopupPath(extensionPath);
        const base = {
          binaryPath: binary,
          display: "headless" as const,
          protocol: "marionette" as const,
          signal: new AbortController().signal,
        };
        {
          await using session = await workspace.launch({ ...base, extensionPath });
          await waitForActiveExtensionUrl(session, addonId, popupPath);
          const tab = await session.openTab(`${server.origin}/id/download.html`);
          await session.evaluate(
            tab,
            `fetch("/fixtures/range", { headers: { Range: "bytes=1000-1999" } }).then((r) => r.arrayBuffer()).then(() => "done")`,
          );
          await callHook(session, { kind: "flush" });
          await row.reach({ session, server, workspace, tab });
          await session.kill();
        }
        {
          await using session = await workspace.launch({ ...base, extensionPath: null });
          await waitForActiveExtensionUrl(session, addonId, popupPath);
          const steps = (await callHook(session, { kind: "recovery" })) as readonly ReconcileStep[];
          expect(steps.map((step) => step.kind)).toEqual(row.plan);
        }
        expect(row.reads({ workspace, server })).toEqual([]);
      },
    );
  },
);
