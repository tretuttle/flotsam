declare const IsoDateTimeBrand: unique symbol;
declare const HarUrlBrand: unique symbol;
declare const PageIdBrand: unique symbol;
declare const MimeTypeBrand: unique symbol;

export type IsoDateTime = string & { readonly [IsoDateTimeBrand]: true };
export type HarUrl = string & { readonly [HarUrlBrand]: true };
export type PageId = string & { readonly [PageIdBrand]: true };
export type MimeType = string & { readonly [MimeTypeBrand]: true };

export type CustomHarFields = {
  readonly [key: string]: unknown;
};

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/u;

const URL_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/u;
const AUTHORITY_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp"]);
const CONTROL_OR_SPACE_PATTERN = /[\u0000-\u0020\u007f]/u;
const MIME_TYPE_PATTERN =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:\s*;.*)?$/u;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function isIsoDateTime(value: string): value is IsoDateTime {
  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  if (day > maxDay) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function toIsoDateTime(value: string): IsoDateTime | null {
  return isIsoDateTime(value) ? value : null;
}

export function isoDateTimeFromEpochMs(epochMs: number): IsoDateTime {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`Expected finite epoch milliseconds, got ${String(epochMs)}`);
  }
  const iso = new Date(epochMs).toISOString();
  if (!isIsoDateTime(iso)) {
    throw new RangeError(`Epoch milliseconds out of ISO 8601 range: ${String(epochMs)}`);
  }
  return iso;
}

export function isHarUrl(value: string): value is HarUrl {
  if (value.length === 0 || CONTROL_OR_SPACE_PATTERN.test(value)) {
    return false;
  }
  const match = URL_SCHEME_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const scheme = match[1]?.toLowerCase() ?? "";
  const rest = match[2] ?? "";
  if (AUTHORITY_SCHEMES.has(scheme)) {
    if (!rest.startsWith("//")) {
      return false;
    }
    const afterSlashes = rest.slice(2);
    const authorityEnd = afterSlashes.search(/[/?#]/u);
    const authority = authorityEnd === -1 ? afterSlashes : afterSlashes.slice(0, authorityEnd);
    const hostPort = authority.includes("@")
      ? authority.slice(authority.lastIndexOf("@") + 1)
      : authority;
    if (hostPort.startsWith("[")) {
      const closeBracket = hostPort.indexOf("]");
      return closeBracket > 1;
    }
    const host = hostPort.includes(":") ? hostPort.slice(0, hostPort.indexOf(":")) : hostPort;
    return host.length > 0;
  }
  return rest.length > 0;
}

export function toHarUrl(value: string): HarUrl | null {
  return isHarUrl(value) ? value : null;
}

export function isPageId(value: string): value is PageId {
  return value.length > 0;
}

export function toPageId(value: string): PageId | null {
  return isPageId(value) ? value : null;
}

export function isMimeType(value: string): value is MimeType {
  return MIME_TYPE_PATTERN.test(value.trim());
}

export function toMimeType(value: string): MimeType | null {
  return isMimeType(value) ? value : null;
}

export type HarMissingBodyReason =
  | "not-included"
  | "evicted"
  | "discarded"
  | "aborted"
  | "media-skipped"
  | "size-limit"
  | "unavailable"
  | "unknown";

export type HarBodyState = "present" | "empty" | HarMissingBodyReason;

export interface HarEntryExtension {
  readonly source?: "both" | "recording-only" | "devtools-only" | (string & {}) | undefined;
  readonly bodyState?: HarBodyState | undefined;
  readonly bodyMissing?: string | undefined;
  readonly bodyIncomplete?: boolean | undefined;
  readonly bodyCheck?: string | undefined;
  readonly lossyText?: number | undefined;
  readonly inProgress?: boolean | undefined;
  readonly redactedFields?: readonly string[] | undefined;
}

export type HarRedactionTarget =
  | "header"
  | "header-url"
  | "cookie"
  | "query"
  | "body"
  | "url-userinfo"
  | "initiator"
  | "page";

export const HAR_REDACTION_PLACES = [
  "request-url-userinfo",
  "request-url-host",
  "request-url-path",
  "request-url-query-secret",
  "request-url-query",
  "request-url-fragment",
  "header-name",
  "header-value-secret",
  "header-value-allowlisted",
  "named-header",
  "url-header",
  "cookie",
  "cookie-metadata",
  "query-string-secret",
  "query-string",
  "body-param-secret",
  "body-param",
  "body-json",
  "body-form",
  "body-multipart",
  "request-body-other",
  "redirect-url",
  "response-body-json",
  "response-body-base64",
  "response-body-other",
  "page-title",
  "initiator",
  "websocket",
  "cache",
  "comment",
  "other-custom-field",
  "protocol-metadata",
] as const;

export type HarRedactionPlace = (typeof HAR_REDACTION_PLACES)[number];

export const REDACTION_LEVELS = ["standard", "shareable"] as const;

export type RedactionLevel = (typeof REDACTION_LEVELS)[number];

export type RedactionLevelInput = RedactionLevel | "default" | "strict";

export type PlaceExamStatus = "removed" | "kept-not-examined" | "kept-by-allowlist";

export type PlaceReportDetail =
  | "removed"
  | "not examined: may contain secrets"
  | "kept by allowlist";

export interface HarPlaceCoverage {
  readonly place: HarRedactionPlace;
  readonly status: PlaceExamStatus;
  readonly count: number;
  readonly detail: PlaceReportDetail;
  readonly canStillHold: string;
}

export interface HarRedactionRecord {
  readonly entryIndex: number;
  readonly url: HarUrl;
  readonly place: HarRedactionPlace;
  readonly target: HarRedactionTarget;
  readonly field: string;
  readonly ruleId: string;
  readonly count: number;
}

export interface HarLogRedactionExtension {
  readonly applied: true;
  readonly level: RedactionLevel;
  readonly guarantee: string;
  readonly remainingRisk: string;
  readonly totalRemoved: number;
  readonly entriesAffected: number;
  readonly rules: readonly string[];
  readonly records: readonly HarRedactionRecord[];
  readonly places: readonly HarPlaceCoverage[];
  readonly notExamined: readonly HarPlaceCoverage[];
  readonly notInspected: readonly HarRedactionPlace[];
}

export interface HarLogExtension {
  readonly redaction?: HarLogRedactionExtension | undefined;
}

export interface ChromeInitiatorCallFrame {
  readonly functionName: string;
  readonly scriptId: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface ChromeInitiatorStack {
  readonly callFrames: readonly ChromeInitiatorCallFrame[];
  readonly parent?: ChromeInitiatorStack | undefined;
}

export interface ChromeInitiator {
  readonly type: string;
  readonly url?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly columnNumber?: number | undefined;
  readonly requestId?: string | undefined;
  readonly stack?: ChromeInitiatorStack | undefined;
}

export interface ChromeWebSocketMessage {
  readonly type: "send" | "receive";
  readonly time: number;
  readonly opcode: number;
  readonly data: string;
}

export type FirefoxSecurityState = "secure" | "insecure" | "broken" | "weak" | (string & {});

export interface HarCreator extends CustomHarFields {
  readonly name: string;
  readonly version: string;
  readonly comment?: string | undefined;
}

export interface HarPageTimings extends CustomHarFields {
  readonly onContentLoad?: number | undefined;
  readonly onLoad?: number | undefined;
  readonly comment?: string | undefined;
}

export interface HarPage extends CustomHarFields {
  readonly startedDateTime: IsoDateTime;
  readonly id: PageId;
  readonly title: string;
  readonly pageTimings: HarPageTimings;
  readonly comment?: string | undefined;
}

export interface HarNameValue extends CustomHarFields {
  readonly name: string;
  readonly value: string;
  readonly comment?: string | undefined;
}

export interface HarCookie extends CustomHarFields {
  readonly name: string;
  readonly value: string;
  readonly path?: string | undefined;
  readonly domain?: string | undefined;
  readonly expires?: string | null | undefined;
  readonly httpOnly?: boolean | undefined;
  readonly secure?: boolean | undefined;
  readonly comment?: string | undefined;
}

export interface HarPostDataParam extends CustomHarFields {
  readonly name: string;
  readonly value?: string | undefined;
  readonly fileName?: string | undefined;
  readonly contentType?: MimeType | string | undefined;
  readonly comment?: string | undefined;
}

export interface HarPostData extends CustomHarFields {
  readonly mimeType: string;
  readonly params: readonly HarPostDataParam[];
  readonly text: string | null;
  readonly comment?: string | undefined;
}

export interface HarRequest extends CustomHarFields {
  readonly method: string;
  readonly url: HarUrl;
  readonly httpVersion: string;
  readonly cookies: readonly HarCookie[];
  readonly headers: readonly HarNameValue[];
  readonly queryString: readonly HarNameValue[];
  readonly postData?: HarPostData | undefined;
  readonly headersSize: number;
  readonly bodySize: number;
  readonly comment?: string | undefined;
}

export interface HarContent extends CustomHarFields {
  readonly size: number;
  readonly compression?: number | undefined;
  readonly mimeType: string;
  readonly text?: string | undefined;
  readonly encoding?: "base64" | (string & {}) | undefined;
  readonly comment?: string | undefined;
}

export interface HarResponse extends CustomHarFields {
  readonly status: number;
  readonly statusText: string;
  readonly httpVersion: string;
  readonly cookies: readonly HarCookie[];
  readonly headers: readonly HarNameValue[];
  readonly content: HarContent;
  readonly redirectURL: string;
  readonly headersSize: number;
  readonly bodySize: number;
  readonly comment?: string | undefined;
  readonly _transferSize?: number | undefined;
  readonly _error?: string | null | undefined;
}

export interface HarCacheEntry extends CustomHarFields {
  readonly expires?: string | undefined;
  readonly lastAccess?: string | undefined;
  // Firefox har-builder.js writes lastFetched and fetchCount instead of lastAccess and hitCount.
  readonly lastFetched?: string | undefined;
  readonly eTag?: string | undefined;
  readonly hitCount?: number | undefined;
  readonly fetchCount?: string | number | undefined;
  readonly comment?: string | undefined;
  readonly _dataSize?: string | undefined;
  readonly _lastModified?: string | undefined;
  readonly _device?: string | undefined;
}

export interface HarCache extends CustomHarFields {
  readonly beforeRequest?: HarCacheEntry | null | undefined;
  readonly afterRequest?: HarCacheEntry | null | undefined;
  readonly comment?: string | undefined;
}

export interface HarTimings extends CustomHarFields {
  readonly blocked?: number | undefined;
  readonly dns?: number | undefined;
  readonly connect?: number | undefined;
  readonly send: number;
  readonly wait: number;
  readonly receive: number;
  readonly ssl?: number | undefined;
  readonly comment?: string | undefined;
  readonly _blocked_queueing?: number | undefined;
  readonly _blocked_proxy?: number | undefined;
  readonly _workerStart?: number | undefined;
  readonly _workerReady?: number | undefined;
  readonly _workerFetchStart?: number | undefined;
  readonly _workerRespondWithSettled?: number | undefined;
}

export interface HarEntry extends CustomHarFields {
  readonly pageref?: PageId | undefined;
  readonly startedDateTime: IsoDateTime;
  readonly time: number;
  readonly request: HarRequest;
  readonly response: HarResponse;
  readonly cache: HarCache;
  readonly timings: HarTimings;
  readonly serverIPAddress?: string | undefined;
  readonly connection?: string | undefined;
  readonly comment?: string | undefined;
  readonly _securityState?: FirefoxSecurityState | undefined;
  readonly _priority?: string | undefined;
  readonly _initiator?: ChromeInitiator | undefined;
  readonly _resourceType?: string | undefined;
  readonly _fromCache?: "disk" | "memory" | (string & {}) | undefined;
  readonly _connectionId?: string | undefined;
  readonly _webSocketMessages?: readonly ChromeWebSocketMessage[] | undefined;
  readonly _harExport?: HarEntryExtension | undefined;
}

export interface HarLog extends CustomHarFields {
  readonly version: string;
  readonly creator: HarCreator;
  readonly browser?: HarCreator | undefined;
  readonly pages?: readonly HarPage[] | undefined;
  readonly entries: readonly HarEntry[];
  readonly comment?: string | undefined;
  readonly _harExport?: HarLogExtension | undefined;
}

export interface HarDocument {
  readonly log: HarLog;
}

type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]-?: T[K];
} &
  string;

type HoldsString<T> = [Extract<NonNullable<T>, string>] extends [never] ? false : true;

type IsPureNumberOrBoolean<T> = [NonNullable<T>] extends [number | boolean] ? true : false;

type StringOrUnhandledKey<T, Containers extends string = never> = {
  [K in Exclude<DeclaredKeys<T>, Containers>]: HoldsString<T[K]> extends true
    ? K
    : IsPureNumberOrBoolean<T[K]> extends true
      ? never
      : K;
}[Exclude<DeclaredKeys<T>, Containers>];

type PrefixField<Prefix extends string, K extends string> = `${Prefix}.${K}`;
type CustomFieldKey<T, Prefix extends string> = string extends keyof T
  ? `${Prefix}.<custom>`
  : never;

export type HarModelStringField =
  | PrefixField<
      "log",
      StringOrUnhandledKey<HarLog, "creator" | "browser" | "pages" | "entries" | "_harExport">
    >
  | CustomFieldKey<HarLog, "log">
  | PrefixField<"log.creator", StringOrUnhandledKey<HarCreator>>
  | CustomFieldKey<HarCreator, "log.creator">
  | PrefixField<"log.browser", StringOrUnhandledKey<HarCreator>>
  | CustomFieldKey<HarCreator, "log.browser">
  | PrefixField<"log.pages[]", StringOrUnhandledKey<HarPage, "pageTimings">>
  | CustomFieldKey<HarPage, "log.pages[]">
  | PrefixField<"log.pages[].pageTimings", StringOrUnhandledKey<HarPageTimings>>
  | CustomFieldKey<HarPageTimings, "log.pages[].pageTimings">
  | PrefixField<
      "entry",
      StringOrUnhandledKey<
        HarEntry,
        | "request"
        | "response"
        | "cache"
        | "timings"
        | "_initiator"
        | "_webSocketMessages"
        | "_harExport"
      >
    >
  | CustomFieldKey<HarEntry, "entry">
  | PrefixField<"entry._initiator", StringOrUnhandledKey<ChromeInitiator, "stack">>
  | PrefixField<
      "entry._initiator.stack",
      StringOrUnhandledKey<ChromeInitiatorStack, "callFrames" | "parent">
    >
  | PrefixField<
      "entry._initiator.stack.callFrames[]",
      StringOrUnhandledKey<ChromeInitiatorCallFrame>
    >
  | PrefixField<"entry._webSocketMessages[]", StringOrUnhandledKey<ChromeWebSocketMessage>>
  | PrefixField<
      "request",
      StringOrUnhandledKey<HarRequest, "cookies" | "headers" | "queryString" | "postData">
    >
  | CustomFieldKey<HarRequest, "request">
  | PrefixField<"request.cookies[]", StringOrUnhandledKey<HarCookie>>
  | CustomFieldKey<HarCookie, "request.cookies[]">
  | PrefixField<"request.headers[]", StringOrUnhandledKey<HarNameValue>>
  | CustomFieldKey<HarNameValue, "request.headers[]">
  | PrefixField<"request.queryString[]", StringOrUnhandledKey<HarNameValue>>
  | CustomFieldKey<HarNameValue, "request.queryString[]">
  | PrefixField<"request.postData", StringOrUnhandledKey<HarPostData, "params">>
  | CustomFieldKey<HarPostData, "request.postData">
  | PrefixField<"request.postData.params[]", StringOrUnhandledKey<HarPostDataParam>>
  | CustomFieldKey<HarPostDataParam, "request.postData.params[]">
  | PrefixField<"response", StringOrUnhandledKey<HarResponse, "cookies" | "headers" | "content">>
  | CustomFieldKey<HarResponse, "response">
  | PrefixField<"response.cookies[]", StringOrUnhandledKey<HarCookie>>
  | CustomFieldKey<HarCookie, "response.cookies[]">
  | PrefixField<"response.headers[]", StringOrUnhandledKey<HarNameValue>>
  | CustomFieldKey<HarNameValue, "response.headers[]">
  | PrefixField<"response.content", StringOrUnhandledKey<HarContent>>
  | CustomFieldKey<HarContent, "response.content">
  | PrefixField<"cache", StringOrUnhandledKey<HarCache, "beforeRequest" | "afterRequest">>
  | CustomFieldKey<HarCache, "cache">
  | PrefixField<"cache.beforeRequest", StringOrUnhandledKey<HarCacheEntry>>
  | CustomFieldKey<HarCacheEntry, "cache.beforeRequest">
  | PrefixField<"cache.afterRequest", StringOrUnhandledKey<HarCacheEntry>>
  | CustomFieldKey<HarCacheEntry, "cache.afterRequest">
  | PrefixField<"timings", StringOrUnhandledKey<HarTimings>>
  | CustomFieldKey<HarTimings, "timings">;
