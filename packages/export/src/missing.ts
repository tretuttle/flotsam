// Every reason a body can be absent from an export, with the words the file, the popup and the report use.

import type { HarMissingBodyReason } from "@one-click-har/har/model";
import type { MissingBodyReason } from "@one-click-har/recording/exchange";

export type MissingReason =
  | MissingBodyReason
  | "over-body-cap"
  | "no-response"
  | "in-progress"
  | "devtools-discarded"
  | "devtools-truncated"
  | "not-recorded"
  | "omitted-by-choice"
  | "source-error"
  | "upload-too-large"
  | "upload-not-rewindable"
  | "upload-never-stored";

export interface MissingRow {
  readonly part: "response" | "request" | "both";
  readonly comment: string;
  readonly reportLabel: string;
  readonly settings: "storage" | "media" | "secrets" | null;
  readonly harState: HarMissingBodyReason;
}

export const MISSING_REASONS: { readonly [R in MissingReason]: MissingRow } = {
  "media-setting": {
    part: "response",
    comment: "Body not kept: audio and video bodies are off in settings.",
    reportLabel: "audio and video, off in settings",
    settings: "media",
    harState: "media-skipped",
  },
  "streaming-response": {
    part: "response",
    comment: "Body not kept: this response streams without an end.",
    reportLabel: "streaming responses",
    settings: null,
    harState: "not-included",
  },
  "not-recordable-here": {
    part: "response",
    comment: "Body not kept: this browser does not let extensions read this body.",
    reportLabel: "not readable in this browser",
    settings: null,
    harState: "unavailable",
  },
  "network-aborted": {
    part: "response",
    comment: "Body incomplete: the request did not finish.",
    reportLabel: "request did not finish",
    settings: null,
    harState: "aborted",
  },
  "write-failed": {
    part: "both",
    comment: "Body not saved: writing it to disk failed.",
    reportLabel: "disk write failed",
    settings: null,
    harState: "unavailable",
  },
  "over-body-cap": {
    part: "response",
    comment:
      "Body not saved: it passed the largest size kept for one body, a quarter of the storage limit in settings.",
    reportLabel: "larger than one body may be",
    settings: "storage",
    harState: "size-limit",
  },
  "browser-closed": {
    part: "response",
    comment: "Body incomplete: the browser closed while it was downloading.",
    reportLabel: "browser closed during download",
    settings: null,
    harState: "aborted",
  },
  "recording-stopped": {
    part: "response",
    comment:
      "Body incomplete: One-Click HAR was turned off, removed or updated while it was downloading.",
    reportLabel: "extension stopped during download",
    settings: null,
    harState: "aborted",
  },
  "removed-by-retention": {
    part: "both",
    comment: "Body removed by the storage limits in settings.",
    reportLabel: "removed by storage limits",
    settings: "storage",
    harState: "evicted",
  },
  "interrupted-by-crash": {
    part: "both",
    comment: "Body lost: the browser stopped before it was saved.",
    reportLabel: "lost when the browser stopped",
    settings: null,
    harState: "unavailable",
  },
  "no-response": {
    part: "response",
    comment: "No response: the request failed before a response arrived.",
    reportLabel: "no response",
    settings: null,
    harState: "unavailable",
  },
  "in-progress": {
    part: "both",
    comment: "Body not included: the response was still arriving when this file was saved.",
    reportLabel: "still arriving",
    settings: null,
    harState: "not-included",
  },
  "devtools-discarded": {
    part: "both",
    comment: "DevTools no longer had this body, and the background recording did not have it.",
    reportLabel: "no longer in DevTools",
    settings: null,
    harState: "discarded",
  },
  "devtools-truncated": {
    part: "response",
    comment:
      "DevTools kept only the first part of this body, and the background recording did not have it.",
    reportLabel: "cut off by DevTools",
    settings: null,
    harState: "size-limit",
  },
  "not-recorded": {
    part: "both",
    comment:
      "The background recording does not cover this request, and DevTools had no body for it.",
    reportLabel: "not in the background recording",
    settings: null,
    harState: "unavailable",
  },
  "omitted-by-choice": {
    part: "both",
    comment: "Bodies were left out of this export.",
    reportLabel: "left out by choice",
    settings: null,
    harState: "not-included",
  },
  "source-error": {
    part: "both",
    comment: "Body not available: reading it failed. The request details are complete.",
    reportLabel: "could not be read",
    settings: null,
    harState: "unavailable",
  },
  "upload-too-large": {
    part: "request",
    comment: "Request body not kept: it was larger than 1 MB.",
    reportLabel: "request bodies over 1 MB",
    settings: null,
    harState: "size-limit",
  },
  "upload-not-rewindable": {
    part: "request",
    comment: "Request body not kept: the browser did not allow it to be read again.",
    reportLabel: "request body not readable",
    settings: null,
    harState: "unavailable",
  },
  "upload-never-stored": {
    part: "request",
    comment: "Request body not stored: settings say never to store secrets and request bodies.",
    reportLabel: "never stored (settings)",
    settings: "secrets",
    harState: "not-included",
  },
};
