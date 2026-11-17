// DevTools as a source. A later pull request reads the Network panel; until then the source lists nothing, so an
// export is the background recording alone. Nothing here loads a DevTools module before DevTools has started.

import type { ExchangeSource } from "@one-click-har/export/source";
import type { ToolboxState } from "./contract.ts";

export const devtoolsSource: ExchangeSource = {
  name: "devtools",
  list: async () => ({ items: [], notNetwork: {} }),
  load: async () => {
    throw new Error("the DevTools source lists nothing");
  },
};

/** Loading the DevTools client framework is expensive. Until DevTools starts, no toolbox can exist. */
export const toolboxOf = (tab: NativeTab): ToolboxState => {
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
