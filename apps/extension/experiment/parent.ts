import { namespace, type HarAnytimeApi, type ToolboxState } from "./contract.ts";

const nativeTab = (context: ExtensionContext, tabId: number): NativeTab | undefined => {
  try {
    return context.extension.tabManager.get(tabId).nativeTab;
  } catch {
    return undefined;
  }
};

const toolboxState = (context: ExtensionContext, tabId: number): ToolboxState => {
  const tab = nativeTab(context, tabId);
  if (tab === undefined) return { open: false, reason: "no-such-tab" };
  // Loading the DevTools client framework is expensive. Until DevTools starts, no toolbox can exist.
  const { DevToolsShim } = ChromeUtils.importESModule(
    "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
  );
  if (!DevToolsShim.isInitialized()) return { open: false, reason: "devtools-not-started" };
  const devtoolsLoader = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs",
  );
  const { gDevTools } = devtoolsLoader.require("resource://devtools/client/framework/devtools.js");
  const toolbox = gDevTools.getToolboxForTab(tab);
  return toolbox === undefined
    ? { open: false, reason: "no-toolbox-for-tab" }
    : { open: true, host: toolbox.hostType };
};

class HarAnytimeParent extends ExtensionAPI {
  override getAPI(context: ExtensionContext) {
    const api = {
      getEnvironment: async (tabId) => ({
        browser: {
          name: Services.appinfo.name,
          version: Services.appinfo.version,
          buildId: Services.appinfo.appBuildID,
        },
        toolbox: toolboxState(context, tabId),
      }),
    } satisfies HarAnytimeApi;
    return { [namespace]: api };
  }
}

// ExtensionCommon.sys.mjs reads the API class from this script's global under the namespace name.
Object.assign(globalThis, { [namespace]: HarAnytimeParent });
