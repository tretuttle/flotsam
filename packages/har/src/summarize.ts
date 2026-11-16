import {
  isoDateTimeFromEpochMs,
  type HarBodyState,
  type HarDocument,
  type HarEntry,
  type HarLogRedactionExtension,
  type HarMissingBodyReason,
  type HarUrl,
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
  };
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
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

function extractHost(url: HarUrl): string | null {
  const schemeEnd = url.indexOf(":");
  if (schemeEnd === -1) {
    return null;
  }
  const rest = url.slice(schemeEnd + 1);
  if (!rest.startsWith("//")) {
    return null;
  }
  const afterSlashes = rest.slice(2);
  const authorityEnd = afterSlashes.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? afterSlashes : afterSlashes.slice(0, authorityEnd);
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  if (hostPort.startsWith("[")) {
    const closeBracket = hostPort.indexOf("]");
    return closeBracket > 1 ? hostPort.slice(0, closeBracket + 1).toLowerCase() : null;
  }
  const colonIndex = hostPort.indexOf(":");
  const host = colonIndex === -1 ? hostPort : hostPort.slice(0, colonIndex);
  return host.length > 0 ? host.toLowerCase() : null;
}

export function classifyEntryBodyState(entry: HarEntry): HarBodyState {
  const { content, status, bodySize } = entry.response;
  if (content.text !== undefined) {
    return "present";
  }

  const annotated = entry._harAnytime?.bodyState;
  if (annotated !== undefined && annotated !== "present") {
    return annotated;
  }

  if (status === 204 || status === 304) {
    return "empty";
  }
  if (status === 0) {
    return "aborted";
  }

  const commentLower = content.comment?.toLowerCase() ?? "";
  if (commentLower.includes("discarded")) {
    return "discarded";
  }
  if (commentLower.includes("not included")) {
    return "not-included";
  }

  if (content.size === 0 || (content.size === -1 && bodySize === 0)) {
    return "empty";
  }

  return "unavailable";
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
    const host = extractHost(entry.request.url);
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
    redaction: document.log._harAnytime?.redaction,
  });
}
