// Installs the packed XPI into a fresh profile, pins the toolbar button to the navigation bar, switches the browser
// between its light and dark appearance, and saves a screenshot of the real toolbar for each.
// Usage: pnpm run screenshot:toolbar --out <folder> [--binary <path to zen.exe>] [--xpi <path>] [--visible]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";
import { startZen } from "./zen-session.ts";

const builtManifest = readManifest(NodePath.join(buildDir, "manifest.json"));
const { values: options } = NodeUtil.parseArgs({
  options: {
    binary: {
      type: "string",
      default: process.env.ZEN_BINARY ?? "C:\\Program Files\\Zen Twilight\\zen.exe",
    },
    xpi: { type: "string", default: xpiPath(builtManifest.version) },
    out: { type: "string" },
    visible: { type: "boolean", default: false },
  },
});
if (options.out === undefined) throw new Error("Pass --out <folder> for the screenshots");

// `ui.systemUsesDarkTheme` is the switch the browser's own light and dark appearance follows, in Zen and in Firefox.
const APPEARANCES = [
  { name: "light", systemUsesDarkTheme: 0 },
  { name: "dark", systemUsesDarkTheme: 1 },
] as const;

const session = await startZen(NodePath.resolve(options.binary), { headless: !options.visible });
const { marionette } = session;
const outDir = NodePath.resolve(options.out);
NodeFS.mkdirSync(outDir, { recursive: true });

try {
  const { value: addonId } = await marionette.command<{ value: string }>("Addon:Install", {
    path: NodePath.resolve(options.xpi),
    temporary: false,
  });
  console.log(`installed ${options.xpi} as ${addonId}`);

  const widget = await marionette.script<{ widgetId: string; placement: string | null }>(
    "chrome",
    `const done = arguments[arguments.length - 1];
     const { CustomizableUI } = window;
     const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
     const widgetId = ExtensionCommon.makeWidgetId(arguments[0]) + "-browser-action";
     CustomizableUI.addWidgetToArea(widgetId, CustomizableUI.AREA_NAVBAR);
     done({ widgetId, placement: CustomizableUI.getPlacementOfWidget(widgetId)?.area ?? null });`,
    [addonId],
  );
  console.log(`toolbar button ${widget.widgetId} placed in ${widget.placement}`);

  for (const { name, systemUsesDarkTheme } of APPEARANCES) {
    const state = await marionette.script<{
      icon: string;
      toolbarText: string;
      toolbarSelector: string;
    }>(
      "chrome",
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
    );
    console.log(`${name}: toolbar text ${state.toolbarText}, button icon ${state.icon}`);

    await marionette.command("Marionette:SetContext", { value: "chrome" });
    for (const [label, selector] of [
      ["window", null],
      ["toolbar", state.toolbarSelector],
    ] as const) {
      const params =
        selector === null
          ? { full: false, hash: false }
          : {
              id: Object.values(
                (
                  await marionette.command<{ value: Record<string, string> }>(
                    "WebDriver:FindElement",
                    { using: "css selector", value: selector },
                  )
                ).value,
              )[0],
              hash: false,
            };
      const { value } = await marionette.command<{ value: string }>(
        "WebDriver:TakeScreenshot",
        params,
      );
      const file = NodePath.join(outDir, `${label}-${name}.png`);
      NodeFS.writeFileSync(file, Buffer.from(value, "base64"));
      console.log(`saved ${file}`);
    }
  }
} finally {
  await session.stop();
}
