// Installs the packed XPI into a fresh profile, pins the toolbar button to the navigation bar, switches the browser
// between its light and dark appearance, and saves a screenshot of the real toolbar for each.
// Usage: pnpm run screenshot:toolbar --out <folder> [--binary <path>] [--xpi <path>] [--visible]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { launchBrowser, readExtensionId } from "../../../tools/browser-harness/src/browser.ts";
import { BINARY_ENV, GECKO_BINARY_ENV } from "../../../tools/browser-harness/src/cli.ts";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const builtManifest = readManifest(NodePath.join(buildDir, "manifest.json"));
const { values: options } = NodeUtil.parseArgs({
  args,
  strict: true,
  options: {
    binary: { type: "string" },
    xpi: { type: "string", default: xpiPath(builtManifest.version) },
    out: { type: "string" },
    visible: { type: "boolean", default: false },
  },
});
if (options.out === undefined) throw new Error("Pass --out <folder> for the screenshots");
const binary = options.binary ?? process.env[GECKO_BINARY_ENV] ?? process.env[BINARY_ENV];
if (binary === undefined || binary.length === 0) {
  throw new Error(`a browser binary is required: pass --binary <path> or set ${GECKO_BINARY_ENV}`);
}

// `ui.systemUsesDarkTheme` is the switch the browser's own light and dark appearance follows, in Zen and in Firefox.
const APPEARANCES = [
  { name: "light", systemUsesDarkTheme: 0 },
  { name: "dark", systemUsesDarkTheme: 1 },
] as const;

const xpi = NodePath.resolve(options.xpi);
const addonId = await readExtensionId(xpi);
const outDir = NodePath.resolve(options.out);
NodeFS.mkdirSync(outDir, { recursive: true });

await using session = await launchBrowser({
  binaryPath: NodePath.resolve(binary),
  extensionPath: xpi,
  display: options.visible ? "window" : "headless",
  protocol: "marionette",
  allowSystemAccess: true,
  signal: new AbortController().signal,
});
console.log(`installed ${xpi} as ${addonId}`);

const widget = (await session.evaluateChrome(
  `const done = arguments[arguments.length - 1];
   const { CustomizableUI } = window;
   const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
   const widgetId = ExtensionCommon.makeWidgetId(arguments[0]) + "-browser-action";
   CustomizableUI.addWidgetToArea(widgetId, CustomizableUI.AREA_NAVBAR);
   done({ widgetId, placement: CustomizableUI.getPlacementOfWidget(widgetId)?.area ?? null });`,
  [addonId],
)) as { widgetId: string; placement: string | null };
console.log(`toolbar button ${widget.widgetId} placed in ${widget.placement}`);

for (const { name, systemUsesDarkTheme } of APPEARANCES) {
  const state = (await session.evaluateChrome(
    `const done = arguments[arguments.length - 1];
     Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[1]);
     // Wait for the toolbar to repaint and re-pick its icon.
     const [widgetId] = arguments;
     setTimeout(() => {
       try {
         const button = document.getElementById(widgetId);
         // Zen lists extension buttons in #zen-overflow-extensions-list. Firefox puts them in a toolbar.
         const toolbar = button.closest("#zen-overflow-extensions-list, toolbar");
         done({
           icon: getComputedStyle(button.querySelector(".toolbarbutton-icon")).listStyleImage,
           toolbarText: getComputedStyle(toolbar).color,
           toolbarSelector: "#" + toolbar.id,
         });
       } catch (error) {
         done({ icon: "ERROR " + error, toolbarText: "", toolbarSelector: "" });
       }
     }, 1500);`,
    [widget.widgetId, systemUsesDarkTheme],
  )) as { icon: string; toolbarText: string; toolbarSelector: string };
  console.log(`${name}: toolbar text ${state.toolbarText}, button icon ${state.icon}`);

  for (const [label, selector] of [
    ["window", undefined],
    ["toolbar", state.toolbarSelector],
  ] as const) {
    const png = await session.takeChromeScreenshot(selector);
    const file = NodePath.join(outDir, `${label}-${name}.png`);
    NodeFS.writeFileSync(file, png);
    console.log(`saved ${file}`);
  }
}
