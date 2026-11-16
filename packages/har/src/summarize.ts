import { extractUrlHost, utf8ByteLength } from "./internal.ts";
import {
  isoDateTimeFromEpochMs,
  type HarBodyState,
  type HarDocument,
  type HarEntry,
  type HarLogRedactionExtension,
  type HarMissingBodyReason,
  type IsoDateTime,
} from "./model.ts";

export interface HarByteTotals {
  readonly requestHeaders: number;
  readonly requestBody: number;
  readonly responseHeaders: number;
  readonly responseBodyWire: number;
  readonly responseBodyDecoded: number;
  readonly includedResponseTextBytes: number;
}

export interface HarBodySummary {
  readonly withBody: number;
  readonly withoutBody: number;
  readonly empty: number;
  readonly missing: number;
  readonly missingByReason: Record<HarMissingBodyReason, number>;
}

export interface HarStatusBuckets {
  readonly failed: number;
  readonly informational: number;
  readonly success: number;
  readonly redirect: number;
  readonly clientError: number;
  readonly serverError: number;
}

export interface HarTimeRange {
  readonly start: IsoDateTime;
  readonly end: IsoDateTime;
}

export interface HarRedactionSummary {
  readonly applied: boolean;
  readonly totalRemoved: number;
  readonly entriesAffected: number;
}

export interface HarSummary {
  readonly pageCount: number;
  readonly entryCount: number;
  readonly hosts: readonly string[];
  readonly timeRange: HarTimeRange | null;
  readonly wallSpanMs: number;
  readonly sumEntryTimeMs: number;
  readonly bytes: HarByteTotals;
  readonly bodies: HarBodySummary;
  readonly statusBuckets: HarStatusBuckets;
  readonly redaction: HarRedactionSummary;
}

export interface SummarizeEntriesOptions {
  readonly pageCount?: number | undefined;
  readonly redaction?: HarLogRedactionExtension | undefined;
}

const MISSING_REASONS: readonly HarMissingBodyReason[] = [
  "not-included",
  "evicted",
  "discarded",
  "aborted",
  "media-skipped",
  "size-limit",
  "unavailable",
  "unknown",
];

function createEmptyMissingByReason(): Record<HarMissingBodyReason, number> {
  return {
    "not-included": 0,
    evicted: 0,
    discarded: 0,
    aborted: 0,
    "media-skipped": 0,
    "size-limit": 0,
    unavailable: 0,
    unknown: 0,
  };
}

function base64DecodedLength(encoded: string): number {
  const clean = encoded.replace(/\s+/gu, "");
  if (clean.length === 0) {
    return 0;
  }
  let padding = 0;
  if (clean.endsWith("==")) {
    padding = 2;
  } else if (clean.endsWith("=")) {
    padding = 1;
  }
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function classifyEntryBodyState(entry: HarEntry): HarBodyState {
  const { content, status, bodySize } = entry.response;
  if (content.text !== undefined) {
    return "present";
  }

  const annotated = entry._harExport?.bodyState;
  if (annotated !== undefined && annotated !== "present") {
    return annotated;
  }

  if (status === 204 || status === 304) {
    return "empty";
  }
  if (status === 0) {
    return "aborted";
  }

  if (content.size === 0 || (content.size === -1 && bodySize === 0)) {
    return "empty";
  }

  return "unknown";
}

function addNonNegative(current: number, value: number): number {
  return value >= 0 ? current + value : current;
}

function isMissingReason(state: HarBodyState): state is HarMissingBodyReason {
  return MISSING_REASONS.includes(state as HarMissingBodyReason);
}

export function summarizeEntries(
  entries: readonly HarEntry[],
  options?: SummarizeEntriesOptions,
): HarSummary {
  const hosts = new Set<string>();
  const missingByReason = createEmptyMissingByReason();

  let requestHeaders = 0;
  let requestBody = 0;
  let responseHeaders = 0;
  let responseBodyWire = 0;
  let responseBodyDecoded = 0;
  let includedResponseTextBytes = 0;

  let withBody = 0;
  let withoutBody = 0;
  let empty = 0;
  let missing = 0;

  let sumEntryTimeMs = 0;
  let minStartMs = Number.POSITIVE_INFINITY;
  let maxEndMs = Number.NEGATIVE_INFINITY;

  let failed = 0;
  let informational = 0;
  let success = 0;
  let redirect = 0;
  let clientError = 0;
  let serverError = 0;

  for (const entry of entries) {
    const host = extractUrlHost(entry.request.url);
    if (host !== null) {
      hosts.add(host);
    }

    const startMs = Date.parse(entry.startedDateTime);
    if (Number.isFinite(startMs)) {
      if (startMs < minStartMs) {
        minStartMs = startMs;
      }
      const endMs = startMs + Math.max(0, entry.time);
      if (endMs > maxEndMs) {
        maxEndMs = endMs;
      }
    }

    sumEntryTimeMs += Math.max(0, entry.time);
    requestHeaders = addNonNegative(requestHeaders, entry.request.headersSize);
    requestBody = addNonNegative(requestBody, entry.request.bodySize);
    responseHeaders = addNonNegative(responseHeaders, entry.response.headersSize);
    responseBodyWire = addNonNegative(responseBodyWire, entry.response.bodySize);
    responseBodyDecoded = addNonNegative(responseBodyDecoded, entry.response.content.size);

    const state = classifyEntryBodyState(entry);
    if (state === "present") {
      withBody += 1;
      const text = entry.response.content.text ?? "";
      includedResponseTextBytes +=
        entry.response.content.encoding === "base64"
          ? base64DecodedLength(text)
          : utf8ByteLength(text);
    } else {
      withoutBody += 1;
      if (state === "empty") {
        empty += 1;
      } else if (isMissingReason(state)) {
        missing += 1;
        missingByReason[state] += 1;
      }
    }

    const status = entry.response.status;
    if (status === 0) {
      failed += 1;
    } else if (status >= 100 && status < 200) {
      informational += 1;
    } else if (status >= 200 && status < 300) {
      success += 1;
    } else if (status >= 300 && status < 400) {
      redirect += 1;
    } else if (status >= 400 && status < 500) {
      clientError += 1;
    } else if (status >= 500) {
      serverError += 1;
    }
  }

  const timeRange: HarTimeRange | null =
    Number.isFinite(minStartMs) && Number.isFinite(maxEndMs)
      ? {
          start: isoDateTimeFromEpochMs(minStartMs),
          end: isoDateTimeFromEpochMs(maxEndMs),
        }
      : null;

  const wallSpanMs =
    Number.isFinite(minStartMs) && Number.isFinite(maxEndMs)
      ? Math.max(0, maxEndMs - minStartMs)
      : 0;

  return {
    pageCount: options?.pageCount ?? 0,
    entryCount: entries.length,
    hosts: [...hosts].sort(),
    timeRange,
    wallSpanMs,
    sumEntryTimeMs,
    bytes: {
      requestHeaders,
      requestBody,
      responseHeaders,
      responseBodyWire,
      responseBodyDecoded,
      includedResponseTextBytes,
    },
    bodies: {
      withBody,
      withoutBody,
      empty,
      missing,
      missingByReason,
    },
    statusBuckets: {
      failed,
      informational,
      success,
      redirect,
      clientError,
      serverError,
    },
    redaction: {
      applied: options?.redaction?.applied ?? false,
      totalRemoved: options?.redaction?.totalRemoved ?? 0,
      entriesAffected: options?.redaction?.entriesAffected ?? 0,
    },
  };
}

export function summarizeHar(document: HarDocument): HarSummary {
  return summarizeEntries(document.log.entries, {
    pageCount: document.log.pages?.length ?? 0,
    redaction: document.log._harExport?.redaction,
  });
}
