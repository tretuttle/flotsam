import type { IsoDateTime } from "./model.ts";

export type HarFileExtension = "har" | "harp" | "har.zip" | "har.gz";

export interface HarFilenameTimeRange {
  readonly start: IsoDateTime | number | Date;
  readonly end?: IsoDateTime | number | Date | undefined;
}

export interface HarFilenameOptions {
  readonly host?: string | null | undefined;
  readonly timeRange?: HarFilenameTimeRange | null | undefined;
  readonly scope?: "tab" | "site" | "all" | undefined;
  readonly includeBodies?: boolean | undefined;
  readonly redacted?: boolean | undefined;
  readonly extension?: HarFileExtension | undefined;
  readonly maxLength?: number | undefined;
}

const DEFAULT_MAX_LENGTH = 180;
const MIN_HOST_LENGTH = 8;

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toEpochMs(input: IsoDateTime | number | Date): number | null {
  if (input instanceof Date) {
    const ms = input.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? ms : null;
}

function formatSortableUtcStamp(input: IsoDateTime | number | Date): string | null {
  const epochMs = toEpochMs(input);
  if (epochMs === null) {
    return null;
  }
  const date = new Date(epochMs);
  return (
    `${String(date.getUTCFullYear()).padStart(4, "0")}` +
    `${pad2(date.getUTCMonth() + 1)}` +
    `${pad2(date.getUTCDate())}-` +
    `${pad2(date.getUTCHours())}` +
    `${pad2(date.getUTCMinutes())}` +
    `${pad2(date.getUTCSeconds())}Z`
  );
}

function sanitizeHostSegment(
  rawHost: string | null | undefined,
  scope: HarFilenameOptions["scope"],
): string {
  const fallback = scope === "all" ? "all-sites" : "capture";
  if (!rawHost) {
    return fallback;
  }

  let candidate = rawHost.trim().toLowerCase();
  const schemeIndex = candidate.indexOf("://");
  if (schemeIndex !== -1) {
    candidate = candidate.slice(schemeIndex + 3);
    const pathIndex = candidate.search(/[/?#]/u);
    if (pathIndex !== -1) {
      candidate = candidate.slice(0, pathIndex);
    }
  }

  candidate = candidate
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[<>:"/\\|?*[\]\s]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");

  if (candidate.length === 0 || candidate === "." || candidate === "..") {
    return fallback;
  }
  if (WINDOWS_RESERVED_NAMES.has(candidate)) {
    return `${candidate}-host`;
  }
  return candidate;
}

function formatTimeSegment(timeRange: HarFilenameTimeRange | null | undefined): string | null {
  if (!timeRange) {
    return null;
  }
  const startStamp = formatSortableUtcStamp(timeRange.start);
  if (!startStamp) {
    return null;
  }
  if (timeRange.end === undefined) {
    return startStamp;
  }
  const endStamp = formatSortableUtcStamp(timeRange.end);
  if (!endStamp || endStamp === startStamp) {
    return startStamp;
  }
  return `${startStamp}_to_${endStamp}`;
}

export function formatHarFilename(options: HarFilenameOptions): string {
  const extension = options.extension ?? "har";
  const maxLength = Math.max(32, options.maxLength ?? DEFAULT_MAX_LENGTH);

  let hostPart = sanitizeHostSegment(options.host, options.scope);
  const tailParts: string[] = [];

  const timeSegment = formatTimeSegment(options.timeRange);
  if (timeSegment) {
    tailParts.push(timeSegment);
  }
  if (options.scope === "tab") {
    tailParts.push("tab");
  }
  if (options.includeBodies === false) {
    tailParts.push("headers-only");
  }
  if (options.redacted === true) {
    tailParts.push("redacted");
  }

  const suffix = (tailParts.length > 0 ? `_${tailParts.join("_")}` : "") + `.${extension}`;
  const availableHostChars = Math.max(MIN_HOST_LENGTH, maxLength - suffix.length);
  if (hostPart.length > availableHostChars) {
    hostPart = hostPart.slice(0, availableHostChars).replace(/[.-]+$/gu, "");
    if (hostPart.length === 0) {
      hostPart = "capture";
    }
  }

  return `${hostPart}${suffix}`;
}
