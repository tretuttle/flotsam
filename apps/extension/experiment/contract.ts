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

/**
 * Why the background recording is off or at risk. No path, site or byte crosses to an extension page; the page turns
 * each kind into plain words.
 */
export type RecordingProblem =
  /** security.fileuri.strict_origin_policy is false, so a local file:// page can read the archive (issue 13). */
  | "file-pages-can-read-files"
  /** The archive folder is inside the profile, the browser's own folders, or a resource:// or moz-src:// target. */
  | "archive-refused"
  | "archive-unwritable"
  /** settings.json did not parse; it was set aside and the defaults are in use. */
  | "settings-unreadable"
  | "write-failed"
  /** More requests were in flight at once than the recorder tracks; the extra ones were not recorded. */
  | "too-many-live-requests";

export interface RecordingStatus {
  readonly recording: boolean;
  readonly problems: readonly RecordingProblem[];
}

export const oneClickHarApi = {
  getEnvironment: asyncFunction([integer("tabId", { minimum: 0 })], returns<Environment>()),
  getRecordingStatus: asyncFunction([], returns<RecordingStatus>()),
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
  recordingStatus: ["problems", "recording"],
} as const satisfies {
  result: ReadonlyArray<keyof Environment>;
  browser: ReadonlyArray<keyof Environment["browser"]>;
  toolboxOpen: ReadonlyArray<keyof Extract<ToolboxState, { open: true }>>;
  toolboxClosed: ReadonlyArray<keyof Extract<ToolboxState, { open: false }>>;
  recordingStatus: ReadonlyArray<keyof RecordingStatus>;
};
