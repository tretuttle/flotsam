import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { judgeTabCases, type TabCase, type TabObservation } from "../src/export-judge.ts";
import { call, newestPageTab, openExtensionPage } from "../src/export-session.ts";
import { recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "export-tabs";

/** Opens a private window in chrome and returns its tab's extension id, which no page of this add-on can list. */
const PRIVATE_TAB_SCRIPT = `const done = arguments[arguments.length - 1];
(async () => {
  const win = OpenBrowserWindow({ private: true });
  await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
  await win.delayedStartupPromise;
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
  done({ id: ExtensionParent.apiManager.global.tabTracker.getId(win.gBrowser.selectedTab), private: PrivateBrowsingUtils.isWindowPrivate(win) });
})().catch((error) => done({ error: String(error) }));`;

const toolbox = (value: unknown) => (value as { toolbox: unknown }).toolbox;
const popupTab = (value: unknown) => (value as { tab: unknown }).tab;

/**
 * Tab 0, tab 999999, a closed tab, a private tab this add-on may not see, and no tab at all come back as states from
 * getEnvironment and getPopup, never as errors (argon 12). A negative id is refused: by Gecko's schema for the integer
 * parameter, and by the parser for the `any` ones, which is the only check the standard host has. Planted: the same
 * judge given a state case that threw must fail.
 */
const check: HarnessCheck = {
  name: NAME,
  description: "missing, closed and private tabs are states; a negative tab id is refused",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    if (context.extensionPath === null)
      return { name: NAME, ok: false, durationMs: 0, detail: "needs --extension" };
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("export-tabs");
    await using session = await workspace.launch({
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
    });
    const page = await openExtensionPage(session, context.extensionPath);
    const closing = await session.openTab(`${server.origin}/`);
    const closedId = await newestPageTab(page);
    await session.closeTab(closing);
    const opened = (await session.evaluateChrome(PRIVATE_TAB_SCRIPT)) as
      | { readonly id: number; readonly private: boolean }
      | { readonly error: string };
    if ("error" in opened || !opened.private)
      return {
        name: NAME,
        ok: false,
        durationMs: Date.now() - started,
        detail: `private window: ${JSON.stringify(opened)}`,
      };

    const noTab = (id: number) => ({ open: false, reason: "no-such-tab", id });
    const cases: readonly (TabCase & { readonly expression: string })[] = [
      ...[0, 999999, closedId, opened.id].flatMap((id): (TabCase & { expression: string })[] => [
        {
          name: `getEnvironment(${String(id)})`,
          expression: `browser.oneClickHar.getEnvironment(${String(id)})`,
          expect: "state",
          state: { read: (v) => ({ ...(toolbox(v) as object), id }), equals: noTab(id) },
        },
        {
          name: `getPopup({ tabId: ${String(id)} })`,
          expression: `browser.oneClickHar.getPopup({ tabId: ${String(id)} })`,
          expect: "state",
          state: { read: popupTab, equals: { kind: "no-such-tab", tabId: id } },
        },
      ]),
      {
        name: "getPopup({ tabId: null })",
        expression: "browser.oneClickHar.getPopup({ tabId: null })",
        expect: "state",
        state: { read: popupTab, equals: { kind: "no-tab" } },
      },
      {
        name: "getEnvironment(-1), schema",
        expression: "browser.oneClickHar.getEnvironment(-1)",
        expect: "refused",
      },
      {
        name: "getPopup({ tabId: -1 }), parser",
        expression: "browser.oneClickHar.getPopup({ tabId: -1 })",
        expect: "refused",
      },
      {
        name: "getPopup({ tabId: 1.5 }), parser",
        expression: "browser.oneClickHar.getPopup({ tabId: 1.5 })",
        expect: "refused",
      },
      {
        name: "preview of tab -1, parser",
        expression: `browser.oneClickHar.preview({ scope: "tab", tabId: -1, range: { kind: "everything" }, include: "all" })`,
        expect: "refused",
      },
    ];
    const observations: TabObservation[] = [];
    for (const c of cases) observations.push({ case: c, called: await call(page, c.expression) });
    const problems = [...judgeTabCases(observations)];
    const stateCase = cases[0]!;
    const planted = judgeTabCases([
      { case: stateCase, called: { ok: false, error: "Error: An unexpected error occurred" } },
    ]);
    if (planted.length === 0) problems.push("planted: a state case that threw was not caught");
    return {
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail:
        problems.length === 0
          ? `${String(observations.length)} calls: ${observations.map((o) => `${o.case.name} ${o.called.ok ? "state" : `refused (${o.called.error})`}`).join("; ")}; planted thrown state caught`
          : problems.join("; "),
      data: observations.map((o) => ({ name: o.case.name, called: o.called })),
    };
  },
};

/** @discovered-check */
export default check;
