// Installs the packed XPI into a fresh profile of a Gecko browser, opens the popup page in a tab, and reads
// getEnvironment() three times: before DevTools starts, with a toolbox open on that tab, and after it closes.
// Each reading is checked against the browser's application.ini and the toolbox state this script set.
// Usage: pnpm run verify:zen [--binary <path to zen.exe or firefox.exe>] [--xpi <path>]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { Environment, ToolboxState } from "../experiment/contract.ts";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";
import { startZen, type Marionette } from "./zen-session.ts";

const builtManifest = readManifest(NodePath.join(buildDir, "manifest.json"));
const { values: options } = NodeUtil.parseArgs({
  options: {
    binary: {
      type: "string",
      default: process.env.ZEN_BINARY ?? "C:\\Program Files\\Zen Twilight\\zen.exe",
    },
    xpi: {
      type: "string",
      default: xpiPath(builtManifest.version),
    },
  },
});

const applicationIni = (binary: string): Record<string, string> =>
  Object.fromEntries(
    NodeFS.readFileSync(NodePath.join(NodePath.dirname(binary), "application.ini"), "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^(\w+)=(.*)$/.exec(line);
        return match?.[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]]];
      }),
  );

const DEVTOOLS = `
  const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
  const { gDevTools } = require("resource://devtools/client/framework/devtools.js");
  const tab = window.gBrowser.selectedTab;
  const done = arguments[arguments.length - 1];
`;

// The first step must not touch DevTools: loading its framework starts it.
const STEPS: ReadonlyArray<{
  step: string;
  act?: string;
  toolbox: (host: string) => ToolboxState;
  text: (host: string) => string;
}> = [
  {
    step: "before DevTools starts",
    toolbox: () => ({ open: false, reason: "devtools-not-started" }),
    text: () => "Not opened since the browser started",
  },
  {
    step: "toolbox open on the tab",
    act: `gDevTools.showToolboxForTab(tab, { toolId: "netmonitor" }).then((toolbox) => done(toolbox.hostType));`,
    toolbox: (host) => ({ open: true, host }),
    text: (host) => `Open on this tab (${host})`,
  },
  {
    step: "toolbox closed again",
    act: `gDevTools.closeToolboxForTab(tab).then(() => done(null));`,
    toolbox: () => ({ open: false, reason: "no-toolbox-for-tab" }),
    text: () => "Not open on this tab",
  },
];

/** Calls the API from the popup page in the current tab, for the active tab or for the given tab ID. */
const getEnvironment = (marionette: Marionette, tabId: number | null = null) =>
  marionette.script<Environment | { error: string }>(
    "content",
    `const [tabId, done] = arguments;
     const tab = tabId === null ? browser.tabs.query({ active: true, currentWindow: true }).then(([active]) => active.id) : Promise.resolve(tabId);
     tab.then((id) => browser.harAnytime.getEnvironment(id))
       .then((environment) => done(JSON.parse(JSON.stringify(environment))), (error) => done({ error: String(error) }));`,
    [tabId],
  );

const readPopup = async (marionette: Marionette) => {
  await marionette.command("Marionette:SetContext", { value: "content" });
  await marionette.command("WebDriver:Refresh");
  const facts = await marionette.command<{ value: Record<string, string> }>(
    "WebDriver:FindElement",
    {
      using: "css selector",
      value: "dl.facts, p.facts",
    },
  );
  const { value: popupText } = await marionette.command<{ value: string }>(
    "WebDriver:GetElementText",
    {
      id: Object.values(facts.value)[0],
    },
  );
  const environment = await getEnvironment(marionette);
  return { popupText, environment };
};

const binary = NodePath.resolve(options.binary);
const xpi = NodePath.resolve(options.xpi);
const ini = applicationIni(binary);
const session = await startZen(binary, { headless: true });
const { marionette } = session;

const failures: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = NodeUtil.isDeepStrictEqual(actual, expected);
  if (!pass) failures.push(label);
  console.log(
    `${pass ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${pass ? "" : ` expected ${JSON.stringify(expected)}`}`,
  );
};

try {
  const { value: addonId } = await marionette.command<{ value: string }>("Addon:Install", {
    path: xpi,
    temporary: false,
  });
  console.log(`installed ${xpi} (${NodeFS.statSync(xpi).size} bytes) as ${addonId}`);

  const popupUrl = await marionette.script<string>(
    "chrome",
    `const done = arguments[arguments.length - 1];
     const policy = WebExtensionPolicy.getByID(arguments[0]);
     done(policy.getURL(arguments[1]));`,
    [addonId, builtManifest.action.default_popup],
  );
  // Zen hides its initial empty tab from extensions (ext-browser.js, `zen-empty-tab`), so use a new tab.
  await marionette.command("Marionette:SetContext", { value: "content" });
  const { handle } = await marionette.command<{ handle: string }>("WebDriver:NewWindow", {
    type: "tab",
    focus: true,
  });
  await marionette.command("WebDriver:SwitchToWindow", { handle, focus: true });
  await marionette.command("WebDriver:Navigate", { url: popupUrl });

  const expectedBrowser = { name: ini.Name, version: ini.Version, buildId: ini.BuildID };
  const unknownTab = await getEnvironment(marionette, 2_147_483_647);
  console.log(`
unknown tab ID
getEnvironment(2147483647) -> ${JSON.stringify(unknownTab)}`);
  check("unknown tab ID: toolbox", "toolbox" in unknownTab ? unknownTab.toolbox : unknownTab, {
    open: false,
    reason: "no-such-tab",
  });

  let host = "";
  for (const { step, act, toolbox, text } of STEPS) {
    if (act !== undefined)
      host = (await marionette.script<string | null>("chrome", DEVTOOLS + act)) ?? host;
    const { popupText, environment } = await readPopup(marionette);
    console.log(
      `\n${step}\ngetEnvironment() -> ${JSON.stringify(environment, null, 2)}\npopup:\n${popupText}`,
    );
    check(
      `${step}: browser`,
      "browser" in environment ? environment.browser : environment,
      expectedBrowser,
    );
    check(
      `${step}: toolbox`,
      "toolbox" in environment ? environment.toolbox : environment,
      toolbox(host),
    );
    check(`${step}: popup DevTools line`, popupText.split("\n").at(-1), text(host));
  }
} finally {
  await session.stop();
}

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} checks failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
