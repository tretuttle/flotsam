// The request, preview, popup and job shapes extension pages see. None carries a file path, a body byte or HAR text.

import type { ByteCount, EpochMs, Minute, Site, TabId } from "@one-click-har/recording/ids";
import { isPlainRecord } from "./internal.ts";
import { REDACTION_CHOICES, type RedactionChoice } from "./redaction.ts";
import type { ExportReport } from "./report.ts";
import { parseSelection, type PresetId, type Selection } from "./selection.ts";

/** Packaging rows ship only when their measurement row is observed (E1, E3). Until then only "har" parses. */
export type Packaging = "har" | "har.zip" | "har.gz";

export interface ExportRequest {
  readonly selection: Selection;
  readonly bodies: "include" | "omit";
  /** A @one-click-har/har redaction level by name, applied to every entry and the log as the last step, or none. */
  readonly redaction: RedactionChoice;
  readonly packaging: Packaging;
  /** null: built by @one-click-har/har/filename from site, date and range. A given name is sanitized the same way. */
  readonly fileName: string | null;
}

/** Problems the recording reports instead of failing silently. */
export type RecordingProblem =
  | { readonly kind: "observers-missing" }
  | { readonly kind: "disk-full"; readonly freeBytes: ByteCount }
  | { readonly kind: "write-failing"; readonly since: EpochMs }
  | { readonly kind: "reconcile-failed"; readonly detail: string }
  | { readonly kind: "archive-unavailable"; readonly detail: string }
  | { readonly kind: "over-cap-while-exporting"; readonly overBy: ByteCount };

export type DevtoolsState = "open" | "closed" | "not-started";

export interface Preview {
  readonly requests: number;
  readonly sources: {
    readonly both: number;
    readonly recordingOnly: number;
    readonly devtoolsOnly: number;
  };
  /** Shown as "up to": retention may have removed some since they were recorded. */
  readonly bodyBytesAtMost: ByteCount;
  readonly first: Minute | null;
  readonly gate: "private-window" | "excluded-site" | null;
  readonly inProgress: number;
}

export interface PresetRow {
  readonly id: PresetId;
  readonly preview: Preview | null;
}

/** What the popup's tab resolved to. Never a throw: tab 0, a closed tab and a private tab are states (argon 12). */
export type PopupTab =
  | { readonly kind: "tab"; readonly tabId: TabId }
  | { readonly kind: "no-tab" }
  | { readonly kind: "no-such-tab"; readonly tabId: TabId };

/** Everything the popup's first paint needs, in one call. */
export interface PopupState {
  readonly tab: PopupTab;
  readonly site: Site | null;
  readonly devtools: DevtoolsState;
  readonly gate: "private-window" | "excluded-site" | null;
  readonly rows: readonly PresetRow[];
  readonly problems: readonly RecordingProblem[];
  readonly running: ExportJob | null;
  readonly last: ExportJob | null;
  readonly defaults: { readonly bodies: "include" | "omit"; readonly redaction: RedactionChoice };
}

export type ExportId = string & { readonly __exportId: unique symbol };

/**
 * Why an export file could not be written: a closed set of kinds and numbers. No field holds text, because a platform
 * error's text names the export folder and the profile, and a failure crosses to extension pages.
 */
export type WriteFailure =
  | { readonly kind: "disk-full"; readonly needBytes: ByteCount; readonly freeBytes: ByteCount }
  | { readonly kind: "access-denied" }
  | { readonly kind: "read-only" }
  | { readonly kind: "not-a-folder" }
  | { readonly kind: "folder-missing" }
  /** The folder is a link, or resolves inside the profile, the archive or the browser's own folders. */
  | { readonly kind: "folder-refused" }
  /** Something other than the file this export created stood at its name when it finished. */
  | { readonly kind: "file-replaced" }
  | { readonly kind: "name-too-long" }
  | { readonly kind: "name-taken" }
  /** A file call was still running after the export's time limit for one call. */
  | { readonly kind: "timed-out" }
  /** An error the table does not name. */
  | { readonly kind: "other" };

export type ExportState =
  | {
      readonly kind: "writing";
      readonly done: number;
      readonly total: number;
      readonly bytes: ByteCount;
    }
  | {
      readonly kind: "done";
      readonly fileName: string;
      readonly folderLabel: string;
      readonly report: ExportReport;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "write-failed"; readonly failure: WriteFailure };

export interface ExportJob {
  readonly id: ExportId;
  readonly request: ExportRequest;
  readonly fileName: string;
  readonly startedAt: EpochMs;
  readonly state: ExportState;
}

const EXPORT_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/u;
const ACCEPTED_PACKAGING: { readonly [P in Packaging]: boolean } = {
  har: true,
  "har.zip": false,
  "har.gz": false,
};

function parseFileName(
  raw: unknown,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (
    trimmed === "" ||
    trimmed === "." ||
    trimmed === ".." ||
    /[/\\:\u0000-\u001f]/u.test(trimmed)
  ) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

/** The one parser for startExport input. */
export function parseExportRequest(raw: unknown): ExportRequest | null {
  if (!isPlainRecord(raw)) return null;
  const selection = parseSelection(raw["selection"]);
  if (selection === null) return null;
  const bodies = raw["bodies"];
  if (bodies !== "include" && bodies !== "omit") return null;
  const redaction = REDACTION_CHOICES.find((choice) => choice === raw["redaction"]);
  if (redaction === undefined) return null;
  const packaging = raw["packaging"];
  if (
    typeof packaging !== "string" ||
    !Object.hasOwn(ACCEPTED_PACKAGING, packaging) ||
    !ACCEPTED_PACKAGING[packaging as Packaging]
  ) {
    return null;
  }
  const fileName = parseFileName(raw["fileName"]);
  if (!fileName.ok) return null;
  return {
    selection,
    bodies,
    redaction,
    packaging: packaging as Packaging,
    fileName: fileName.value,
  };
}

export function parseExportId(raw: unknown): ExportId | null {
  return typeof raw === "string" && EXPORT_ID_PATTERN.test(raw) ? (raw as ExportId) : null;
}
