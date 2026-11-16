// What the export did, counted as it streams. Shown in the popup result, written into log.comment and log._harExport.report.

import type { ByteCount } from "@one-click-har/recording/ids";
import { FIELD_GROUPS, type MergedEntry } from "./merge.ts";
import { MISSING_REASONS, type MissingReason } from "./missing.ts";
import type { WrittenPlace } from "./written.ts";

export interface ExportReport {
  readonly requests: number;
  readonly sources: {
    readonly both: number;
    readonly recordingOnly: number;
    readonly devtoolsOnly: number;
  };
  /** Items that had no key and so could not be paired. Each appears once per source. */
  readonly unpaired: number;
  /** Requests the recorder still held, written with their head and marked in progress. */
  readonly inProgress: number;
  /** data:, blob:, about: and other rows that are not network requests, by scheme. Not written as entries. */
  readonly notNetwork: { readonly [scheme: string]: number };
  readonly bodies: {
    readonly included: number;
    /** Bodies that came from a different source than the headers, such as one DevTools had discarded. */
    readonly filledIn: number;
    /** Bodies stored with only the tee's own count behind them (BodyCheck sink-only). */
    readonly unchecked: number;
    readonly cutShort: number;
    readonly missing: { readonly [R in MissingReason]?: number };
  };
  readonly secrets:
    | {
        readonly mode: "remove";
        readonly entriesWithValuesRemoved: number;
        readonly covered: readonly WrittenPlace[];
        readonly notScanned: readonly string[];
      }
    | {
        readonly mode: "keep";
        readonly entriesWithValuesKept: number;
        readonly entriesNeverStored: number;
      };
  readonly fileBytes: ByteCount;
}

export function emptyReport(
  secrets: "remove" | "keep",
  unpaired: number,
  notNetwork: { readonly [scheme: string]: number },
): ExportReport {
  return {
    requests: 0,
    sources: { both: 0, recordingOnly: 0, devtoolsOnly: 0 },
    unpaired,
    inProgress: 0,
    notNetwork: { ...notNetwork },
    bodies: {
      included: 0,
      filledIn: 0,
      unchecked: 0,
      cutShort: 0,
      missing: {},
    },
    secrets:
      secrets === "remove"
        ? { mode: "remove", entriesWithValuesRemoved: 0, covered: [], notScanned: [] }
        : { mode: "keep", entriesWithValuesKept: 0, entriesNeverStored: 0 },
    fileBytes: 0 as ByteCount,
  };
}

function isFilledIn(
  sources: MergedEntry["sources"],
  bodyFrom: "stored" | "devtools" | null,
): boolean {
  if (sources !== "both" || bodyFrom === null) return false;
  const headSource = FIELD_GROUPS["response-head"].order[0];
  const bodySource = bodyFrom === "stored" ? "recording" : "devtools";
  return headSource !== bodySource;
}

/** Called once per written entry with what was actually written, after the body was resolved at write time. */
export function tally(
  report: ExportReport,
  merged: MergedEntry,
  written: {
    readonly body:
      | "included"
      | "empty"
      | { readonly cutShort: MissingReason }
      | { readonly missing: MissingReason };
    readonly bodyFrom: "stored" | "devtools" | null;
    readonly unchecked: boolean;
    readonly secretsTouched: boolean;
    readonly neverStored: boolean;
  },
): ExportReport {
  const sources = {
    both: report.sources.both + (merged.sources === "both" ? 1 : 0),
    recordingOnly: report.sources.recordingOnly + (merged.sources === "recording-only" ? 1 : 0),
    devtoolsOnly: report.sources.devtoolsOnly + (merged.sources === "devtools-only" ? 1 : 0),
  };

  let included = report.bodies.included;
  let filledIn = report.bodies.filledIn;
  let unchecked = report.bodies.unchecked;
  let cutShort = report.bodies.cutShort;
  const missing: { [R in MissingReason]?: number } = { ...report.bodies.missing };

  if (written.body === "included") {
    included += 1;
    if (isFilledIn(merged.sources, written.bodyFrom)) filledIn += 1;
    if (written.unchecked) unchecked += 1;
  } else if (typeof written.body === "object") {
    if ("cutShort" in written.body) {
      cutShort += 1;
    } else {
      const reason = written.body.missing;
      missing[reason] = (missing[reason] ?? 0) + 1;
    }
  }

  const secrets =
    report.secrets.mode === "remove"
      ? {
          ...report.secrets,
          entriesWithValuesRemoved:
            report.secrets.entriesWithValuesRemoved + (written.secretsTouched ? 1 : 0),
        }
      : {
          ...report.secrets,
          entriesWithValuesKept:
            report.secrets.entriesWithValuesKept + (written.neverStored ? 0 : 1),
          entriesNeverStored: report.secrets.entriesNeverStored + (written.neverStored ? 1 : 0),
        };

  return {
    ...report,
    requests: report.requests + 1,
    sources,
    inProgress: report.inProgress + (merged.inProgress ? 1 : 0),
    bodies: { included, filledIn, unchecked, cutShort, missing },
    secrets,
  };
}

/** Plain sentences built from MISSING_REASONS labels, such as "22 bodies not available: 14 removed by storage limits." */
export function reportComment(report: ExportReport): string {
  const sentences: string[] = [
    `Exported ${String(report.requests)} ${report.requests === 1 ? "request" : "requests"}.`,
  ];

  const missingEntries = (
    Object.entries(report.bodies.missing) as [MissingReason, number][]
  ).filter(([, count]) => count > 0);
  if (missingEntries.length > 0) {
    const totalMissing = missingEntries.reduce((sum, [, count]) => sum + count, 0);
    const details = missingEntries.map(
      ([reason, count]) => `${String(count)} ${MISSING_REASONS[reason].reportLabel}`,
    );
    sentences.push(
      `${String(totalMissing)} ${totalMissing === 1 ? "body" : "bodies"} not available: ${details.join(", ")}.`,
    );
  }

  if (report.bodies.cutShort > 0) {
    sentences.push(
      `${String(report.bodies.cutShort)} ${report.bodies.cutShort === 1 ? "body" : "bodies"} cut short.`,
    );
  }

  if (report.inProgress > 0) {
    sentences.push(
      `${String(report.inProgress)} ${report.inProgress === 1 ? "request" : "requests"} still in progress.`,
    );
  }

  const nonNetworkEntries = Object.entries(report.notNetwork).filter(([, count]) => count > 0);
  if (nonNetworkEntries.length > 0) {
    const totalLeftOut = nonNetworkEntries.reduce((sum, [, count]) => sum + count, 0);
    const schemes = nonNetworkEntries.map(([scheme, count]) => `${String(count)} ${scheme}`);
    sentences.push(
      `Left out ${String(totalLeftOut)} non-network ${totalLeftOut === 1 ? "row" : "rows"} (${schemes.join(", ")}).`,
    );
  }

  return sentences.join(" ");
}
