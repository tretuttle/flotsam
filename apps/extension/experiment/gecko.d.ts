// The globals Gecko's ExtensionCommon.sys.mjs puts in the sandbox that loads an experiment parent script.
// Only the members this parent script uses are declared.

declare const tabBrand: unique symbol;
/** A browser tab element in the parent process. Opaque here: it is only passed back to DevTools. */
interface NativeTab {
  readonly [tabBrand]: true;
}

interface ExtensionContext {
  readonly extension: {
    readonly tabManager: {
      /** Throws an `ExtensionError` when no tab has this ID. */
      get(tabId: number): { readonly nativeTab: NativeTab };
    };
  };
}

declare class ExtensionAPI {
  getAPI(context: ExtensionContext): Record<string, object>;
}

declare const Services: {
  readonly appinfo: {
    readonly name: string;
    readonly version: string;
    readonly appBuildID: string;
  };
};

interface DevToolsToolbox {
  readonly hostType: string;
}

interface GeckoModules {
  "chrome://devtools-startup/content/DevToolsShim.sys.mjs": {
    readonly DevToolsShim: { isInitialized(): boolean };
  };
  "resource://devtools/shared/loader/Loader.sys.mjs": {
    require(id: "resource://devtools/client/framework/devtools.js"): {
      readonly gDevTools: { getToolboxForTab(tab: NativeTab): DevToolsToolbox | undefined };
    };
  };
}

declare const ChromeUtils: {
  importESModule<Url extends keyof GeckoModules>(url: Url): GeckoModules[Url];
};
