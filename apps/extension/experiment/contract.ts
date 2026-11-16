import { asyncFunction, integer, returns, type ApiFunctions } from "./gecko-schema.ts";

/** The experiment namespace: `browser.harAnytime` in extension pages, `experiment_apis.harAnytime` in the manifest. */
export const namespace = "harAnytime";

export type ToolboxState =
  | { readonly open: true; readonly host: string }
  | { readonly open: false; readonly reason: ToolboxClosedReason };

/** Why no toolbox was found. `devtools-not-started` means DevTools was never opened since the browser started. */
export type ToolboxClosedReason = "no-such-tab" | "devtools-not-started" | "no-toolbox-for-tab";

export interface Environment {
  readonly browser: {
    readonly name: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly toolbox: ToolboxState;
}

export const harAnytimeApi = {
  getEnvironment: asyncFunction([integer("tabId", { minimum: 0 })], returns<Environment>()),
};

export type HarAnytimeApi = ApiFunctions<typeof harAnytimeApi>;
