import { asyncFunction, integer, returns, type ApiFunctions } from "./gecko-schema.ts";

/** The experiment namespace: `browser.oneClickHar` in extension pages, `experiment_apis.oneClickHar` in the manifest. */
export const namespace = "oneClickHar";

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

export const oneClickHarApi = {
  getEnvironment: asyncFunction([integer("tabId", { minimum: 0 })], returns<Environment>()),
};

export type OneClickHarApi = ApiFunctions<typeof oneClickHarApi>;

/**
 * The result's key sets at run time. Types are erased, so the contract test compares the handler's actual keys
 * with this table; a value held in a variable is not checked for excess properties by the type checker.
 */
export const environmentKeys = {
  result: ["browser", "toolbox"],
  browser: ["name", "version", "buildId"],
  toolboxOpen: ["host", "open"],
  toolboxClosed: ["open", "reason"],
} as const satisfies {
  result: ReadonlyArray<keyof Environment>;
  browser: ReadonlyArray<keyof Environment["browser"]>;
  toolboxOpen: ReadonlyArray<keyof Extract<ToolboxState, { open: true }>>;
  toolboxClosed: ReadonlyArray<keyof Extract<ToolboxState, { open: false }>>;
};
