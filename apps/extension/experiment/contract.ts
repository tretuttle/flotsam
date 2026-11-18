import {
  parseExportId,
  parseExportRequest,
  type ExportId,
  type ExportJob,
  type PopupState,
  type Preview,
} from "@one-click-har/export/jobs";
import { parseSelection } from "@one-click-har/export/selection";
import { parseTabId, type TabId } from "@one-click-har/recording/ids";
import { any, asyncFunction, integer, returns, type ApiFunctions } from "./gecko-schema.ts";

/** The experiment namespace: `browser.oneClickHar` in extension pages, `experiment_apis.oneClickHar` in the manifest. */
export const namespace = "oneClickHar";

/** Where build-experiment.ts writes file-worker.ts in the package, and the path the parent script starts it from. */
export const FILE_WORKER = "experiment/file-worker.js";

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
  | "too-many-live-requests"
  /** A pinned export is holding the archive over its retention cap. */
  | "over-cap-while-exporting"
  /** Unreadable files or folders in the archive were skipped during startup scan. */
  | "archive-entries-unreadable";

export interface RecordingStatus {
  readonly recording: boolean;
  readonly problems: readonly RecordingProblem[];
}

/** The popup's tab. null when the active tab has no id (Zen's empty tab reports -1). */
export interface PopupTabArgument {
  readonly tabId: TabId | null;
}

/** Everything the popup's first paint needs. The recording problems are this API's own list. */
export type PopupView = Omit<PopupState, "problems"> & {
  readonly problems: readonly RecordingProblem[];
};

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);

const parsePopupTab = (raw: unknown): PopupTabArgument | null => {
  if (!isRecord(raw) || !Object.hasOwn(raw, "tabId")) return null;
  if (raw["tabId"] === null) return { tabId: null };
  const tabId = parseTabId(raw["tabId"]);
  return tabId === null ? null : { tabId };
};

/**
 * The one table of this API. Gecko's schema.json is written from it, pages get their client type from it, and every
 * host runs each parameter's parser before a handler sees the value. No row carries a file path, a body byte or HAR
 * text in either direction; `contract.test.ts` checks that over every row's types.
 */
export const oneClickHarApi = {
  getEnvironment: asyncFunction(
    [integer("tabId", parseTabId, { minimum: 0 })],
    returns<Environment>(),
  ),
  getRecordingStatus: asyncFunction([], returns<RecordingStatus>()),
  getPopup: asyncFunction([any("tab", parsePopupTab)], returns<PopupView>()),
  preview: asyncFunction([any("selection", parseSelection)], returns<Preview>()),
  startExport: asyncFunction([any("request", parseExportRequest)], returns<ExportJob>()),
  listExports: asyncFunction([], returns<readonly ExportJob[]>()),
  /** Stops a running export within one body chunk and deletes its .har.part. Idempotent. */
  cancelExport: asyncFunction([any("id", parseExportId)], returns<boolean>()),
  /** Shows a finished file in its folder. The path never leaves the host. False when the file is gone. */
  revealExport: asyncFunction([any("id", parseExportId)], returns<boolean>()),
  /** Puts a finished file's path on the clipboard from the host, so the page never holds it. */
  copyExportPath: asyncFunction([any("id", parseExportId)], returns<boolean>()),
};

export type OneClickHarApi = ApiFunctions<typeof oneClickHarApi>;
export type { ExportId };

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
