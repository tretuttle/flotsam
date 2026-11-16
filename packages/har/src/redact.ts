import { OWNED_FIELDS, pickCustomFields, safeDecodeQueryComponent } from "./internal.ts";
import {
  HAR_REDACTION_PLACES,
  toHarUrl,
  toIsoDateTime,
  toPageId,
  type ChromeInitiator,
  type ChromeInitiatorStack,
  type ChromeWebSocketMessage,
  type HarCache,
  type HarCacheEntry,
  type HarContent,
  type HarCookie,
  type HarCreator,
  type HarDocument,
  type HarEntry,
  type HarLogRedactionExtension,
  type HarModelStringField,
  type HarNameValue,
  type HarPage,
  type HarPlaceCoverage,
  type HarPostData,
  type HarPostDataParam,
  type HarRedactionPlace,
  type HarRedactionRecord,
  type HarRedactionTarget,
  type HarTimings,
  type HarUrl,
  type IsoDateTime,
  type PageId,
  type PlaceExamStatus,
  type PlaceReportDetail,
  type RedactionLevel,
  type RedactionLevelInput,
} from "./model.ts";

export interface HarRedactionRule {
  readonly id: string;
  readonly target: HarRedactionTarget;
  readonly names: readonly string[];
  readonly matchAll?: boolean | undefined;
}

export interface HarPlaceRule {
  readonly place: HarRedactionPlace;
  readonly standard: "removed" | "kept-not-examined";
  readonly shareable: "removed" | "kept-by-allowlist";
  readonly description: string;
}

export interface HarModelFieldRow<F extends HarModelStringField = HarModelStringField> {
  readonly field: F;
  readonly places: readonly [HarRedactionPlace, ...(readonly HarRedactionPlace[])];
}

export interface RedactHarOptions {
  readonly rules?: readonly HarRedactionRule[] | undefined;
  readonly extraRules?: readonly HarRedactionRule[] | undefined;
  readonly replacement?: string | undefined;
  readonly level?: RedactionLevelInput | undefined;
  readonly placeTable?: Readonly<Record<HarRedactionPlace, HarPlaceRule>> | undefined;
}

export interface RedactHarResult {
  readonly document: HarDocument;
  readonly report: HarLogRedactionExtension;
}

export interface RedactHarEntryResult {
  readonly entry: HarEntry;
  readonly url: HarUrl;
  readonly touched: boolean;
  readonly records: readonly HarRedactionRecord[];
  readonly covered: readonly HarRedactionPlace[];
  readonly places: readonly HarPlaceCoverage[];
}

export interface RedactUrlResult {
  readonly url: string;
  readonly touched: boolean;
  readonly records: readonly HarRedactionRecord[];
}

export interface RedactionLevelSpec {
  readonly id: RedactionLevel;
  readonly guarantee: string;
  readonly remainingRisk: string;
}

export const REDACTION_LEVEL_TABLE: Readonly<Record<RedactionLevel, RedactionLevelSpec>> = {
  standard: {
    id: "standard",
    guarantee:
      "Removes Cookie, Set-Cookie, Authorization, Proxy-Authorization, and listed secret header and parameter names, cookie values, and URL userinfo, and leaves every other field byte-for-byte intact.",
    remainingRisk:
      "Every place marked kept-not-examined was not examined and may contain secrets, including request and response bodies, unlisted headers and parameters, URL paths and fragments, redirects, comments, cache metadata, initiators, WebSocket messages, and custom fields.",
  },
  shareable: {
    id: "shareable",
    guarantee:
      "Keeps only allowlisted structural fields (methods, status codes, timings, sizes, MIME types, host names, URL paths, header names, and allowlisted non-secret header values) and removes all bodies, query values, fragments, cookies, unlisted header values, redirects, page titles, comments, cache metadata, initiators, WebSocket messages, and custom fields.",
    remainingRisk:
      "Host names and URL paths are kept by the allowlist and can themselves be sensitive.",
  },
};

export const HAR_PLACE_TABLE: {
  readonly [P in HarRedactionPlace]: HarPlaceRule & { readonly place: P };
} = {
  "request-url-userinfo": {
    place: "request-url-userinfo",
    standard: "removed",
    shareable: "removed",
    description: "Credentials in the userinfo section of a request URL or page title URL.",
  },
  "request-url-host": {
    place: "request-url-host",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    description: "Scheme, host name, and port of a request URL.",
  },
  "request-url-path": {
    place: "request-url-path",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    description: "Path segments of a request URL.",
  },
  "request-url-query-secret": {
    place: "request-url-query-secret",
    standard: "removed",
    shareable: "removed",
    description: "Values of listed secret query parameters in a request URL or page title URL.",
  },
  "request-url-query": {
    place: "request-url-query",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Query parameter names and unlisted query values in a request URL.",
  },
  "request-url-fragment": {
    place: "request-url-fragment",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Fragment identifier of a request URL.",
  },
  "header-name": {
    place: "header-name",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    description: "HTTP request and response header names.",
  },
  "header-value-secret": {
    place: "header-value-secret",
    standard: "removed",
    shareable: "removed",
    description:
      "Values of Cookie, Set-Cookie, Authorization, Proxy-Authorization, and listed secret headers.",
  },
  "header-value-allowlisted": {
    place: "header-value-allowlisted",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    description:
      "Values of allowlisted non-secret headers such as Content-Type and Content-Length.",
  },
  "named-header": {
    place: "named-header",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Values of headers not on the secret list or non-secret allowlist.",
  },
  "url-header": {
    place: "url-header",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Values of URL-carrying headers such as Location, Referer, Link, and :path.",
  },
  cookie: {
    place: "cookie",
    standard: "removed",
    shareable: "removed",
    description: "Cookie values in request.cookies and response.cookies.",
  },
  "cookie-metadata": {
    place: "cookie-metadata",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Cookie name, path, domain, and expires attributes.",
  },
  "query-string-secret": {
    place: "query-string-secret",
    standard: "removed",
    shareable: "removed",
    description: "Values of listed secret parameters in request.queryString.",
  },
  "query-string": {
    place: "query-string",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Parameter names and unlisted parameter values in request.queryString.",
  },
  "body-param-secret": {
    place: "body-param-secret",
    standard: "removed",
    shareable: "removed",
    description: "Values of listed secret parameters in request.postData.params.",
  },
  "body-param": {
    place: "body-param",
    standard: "kept-not-examined",
    shareable: "removed",
    description:
      "Parameter names, unlisted values, fileName, and contentType in request.postData.params.",
  },
  "body-json": {
    place: "body-json",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "JSON request body text in request.postData.text.",
  },
  "body-form": {
    place: "body-form",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Form-urlencoded request body text in request.postData.text.",
  },
  "body-multipart": {
    place: "body-multipart",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Multipart request body text in request.postData.text.",
  },
  "request-body-other": {
    place: "request-body-other",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Non-JSON, non-form, non-multipart request body text in request.postData.text.",
  },
  "redirect-url": {
    place: "redirect-url",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Redirect target URL in response.redirectURL.",
  },
  "response-body-json": {
    place: "response-body-json",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "JSON response body text in response.content.text.",
  },
  "response-body-base64": {
    place: "response-body-base64",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Base64-encoded response body text in response.content.text.",
  },
  "response-body-other": {
    place: "response-body-other",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "HTML, JavaScript, CSS, or plain text in response.content.text.",
  },
  "page-title": {
    place: "page-title",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Page title in log.pages[].title.",
  },
  initiator: {
    place: "initiator",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Request initiator metadata and call stack in entry._initiator.",
  },
  websocket: {
    place: "websocket",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "WebSocket frame payloads in entry._webSocketMessages.",
  },
  cache: {
    place: "cache",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Cache state fields in entry.cache.beforeRequest and afterRequest.",
  },
  comment: {
    place: "comment",
    standard: "kept-not-examined",
    shareable: "removed",
    description: "Free-form comment fields at any HAR object level.",
  },
  "other-custom-field": {
    place: "other-custom-field",
    standard: "kept-not-examined",
    shareable: "removed",
    description:
      "Custom and unknown fields at any HAR object level, plus serverIPAddress and connection.",
  },
  "protocol-metadata": {
    place: "protocol-metadata",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    description:
      "Structural protocol metadata (version, creator, page ids, timestamps, HTTP methods, statusText, httpVersion, MIME types, and content encoding).",
  },
};

export const HAR_MODEL_FIELD_TABLE: {
  readonly [F in HarModelStringField]: HarModelFieldRow<F>;
} = {
  "log.version": { field: "log.version", places: ["protocol-metadata"] },
  "log.comment": { field: "log.comment", places: ["comment"] },
  "log.<custom>": { field: "log.<custom>", places: ["other-custom-field"] },
  "log.creator.name": { field: "log.creator.name", places: ["protocol-metadata"] },
  "log.creator.version": { field: "log.creator.version", places: ["protocol-metadata"] },
  "log.creator.comment": { field: "log.creator.comment", places: ["comment"] },
  "log.creator.<custom>": { field: "log.creator.<custom>", places: ["other-custom-field"] },
  "log.browser.name": { field: "log.browser.name", places: ["protocol-metadata"] },
  "log.browser.version": { field: "log.browser.version", places: ["protocol-metadata"] },
  "log.browser.comment": { field: "log.browser.comment", places: ["comment"] },
  "log.browser.<custom>": { field: "log.browser.<custom>", places: ["other-custom-field"] },
  "log.pages[].startedDateTime": {
    field: "log.pages[].startedDateTime",
    places: ["protocol-metadata"],
  },
  "log.pages[].id": { field: "log.pages[].id", places: ["protocol-metadata"] },
  "log.pages[].title": {
    field: "log.pages[].title",
    places: ["request-url-userinfo", "request-url-query-secret", "page-title"],
  },
  "log.pages[].comment": { field: "log.pages[].comment", places: ["comment"] },
  "log.pages[].<custom>": { field: "log.pages[].<custom>", places: ["other-custom-field"] },
  "log.pages[].pageTimings.comment": {
    field: "log.pages[].pageTimings.comment",
    places: ["comment"],
  },
  "log.pages[].pageTimings.<custom>": {
    field: "log.pages[].pageTimings.<custom>",
    places: ["other-custom-field"],
  },
  "entry.pageref": { field: "entry.pageref", places: ["protocol-metadata"] },
  "entry.startedDateTime": { field: "entry.startedDateTime", places: ["protocol-metadata"] },
  "entry.serverIPAddress": { field: "entry.serverIPAddress", places: ["other-custom-field"] },
  "entry.connection": { field: "entry.connection", places: ["other-custom-field"] },
  "entry.comment": { field: "entry.comment", places: ["comment"] },
  "entry._securityState": { field: "entry._securityState", places: ["other-custom-field"] },
  "entry._priority": { field: "entry._priority", places: ["other-custom-field"] },
  "entry._resourceType": { field: "entry._resourceType", places: ["other-custom-field"] },
  "entry._fromCache": { field: "entry._fromCache", places: ["other-custom-field"] },
  "entry._connectionId": { field: "entry._connectionId", places: ["other-custom-field"] },
  "entry.<custom>": { field: "entry.<custom>", places: ["other-custom-field"] },
  "entry._initiator.type": { field: "entry._initiator.type", places: ["initiator"] },
  "entry._initiator.url": { field: "entry._initiator.url", places: ["initiator"] },
  "entry._initiator.requestId": { field: "entry._initiator.requestId", places: ["initiator"] },
  "entry._initiator.stack.callFrames[].functionName": {
    field: "entry._initiator.stack.callFrames[].functionName",
    places: ["initiator"],
  },
  "entry._initiator.stack.callFrames[].scriptId": {
    field: "entry._initiator.stack.callFrames[].scriptId",
    places: ["initiator"],
  },
  "entry._initiator.stack.callFrames[].url": {
    field: "entry._initiator.stack.callFrames[].url",
    places: ["initiator"],
  },
  "entry._webSocketMessages[].type": {
    field: "entry._webSocketMessages[].type",
    places: ["websocket"],
  },
  "entry._webSocketMessages[].data": {
    field: "entry._webSocketMessages[].data",
    places: ["websocket"],
  },
  "request.method": { field: "request.method", places: ["protocol-metadata"] },
  "request.url": {
    field: "request.url",
    places: [
      "request-url-userinfo",
      "request-url-host",
      "request-url-path",
      "request-url-query-secret",
      "request-url-query",
      "request-url-fragment",
    ],
  },
  "request.httpVersion": { field: "request.httpVersion", places: ["protocol-metadata"] },
  "request.comment": { field: "request.comment", places: ["comment"] },
  "request.<custom>": { field: "request.<custom>", places: ["other-custom-field"] },
  "request.cookies[].name": { field: "request.cookies[].name", places: ["cookie-metadata"] },
  "request.cookies[].value": { field: "request.cookies[].value", places: ["cookie"] },
  "request.cookies[].path": { field: "request.cookies[].path", places: ["cookie-metadata"] },
  "request.cookies[].domain": { field: "request.cookies[].domain", places: ["cookie-metadata"] },
  "request.cookies[].expires": { field: "request.cookies[].expires", places: ["cookie-metadata"] },
  "request.cookies[].comment": { field: "request.cookies[].comment", places: ["comment"] },
  "request.cookies[].<custom>": {
    field: "request.cookies[].<custom>",
    places: ["other-custom-field"],
  },
  "request.headers[].name": { field: "request.headers[].name", places: ["header-name"] },
  "request.headers[].value": {
    field: "request.headers[].value",
    places: ["header-value-secret", "header-value-allowlisted", "url-header", "named-header"],
  },
  "request.headers[].comment": { field: "request.headers[].comment", places: ["comment"] },
  "request.headers[].<custom>": {
    field: "request.headers[].<custom>",
    places: ["other-custom-field"],
  },
  "request.queryString[].name": { field: "request.queryString[].name", places: ["query-string"] },
  "request.queryString[].value": {
    field: "request.queryString[].value",
    places: ["query-string-secret", "query-string"],
  },
  "request.queryString[].comment": { field: "request.queryString[].comment", places: ["comment"] },
  "request.queryString[].<custom>": {
    field: "request.queryString[].<custom>",
    places: ["other-custom-field"],
  },
  "request.postData.mimeType": {
    field: "request.postData.mimeType",
    places: ["protocol-metadata"],
  },
  "request.postData.text": {
    field: "request.postData.text",
    places: ["body-json", "body-form", "body-multipart", "request-body-other"],
  },
  "request.postData.comment": { field: "request.postData.comment", places: ["comment"] },
  "request.postData.<custom>": {
    field: "request.postData.<custom>",
    places: ["other-custom-field"],
  },
  "request.postData.params[].name": {
    field: "request.postData.params[].name",
    places: ["body-param"],
  },
  "request.postData.params[].value": {
    field: "request.postData.params[].value",
    places: ["body-param-secret", "body-param"],
  },
  "request.postData.params[].fileName": {
    field: "request.postData.params[].fileName",
    places: ["body-param"],
  },
  "request.postData.params[].contentType": {
    field: "request.postData.params[].contentType",
    places: ["body-param"],
  },
  "request.postData.params[].comment": {
    field: "request.postData.params[].comment",
    places: ["comment"],
  },
  "request.postData.params[].<custom>": {
    field: "request.postData.params[].<custom>",
    places: ["other-custom-field"],
  },
  "response.statusText": { field: "response.statusText", places: ["protocol-metadata"] },
  "response.httpVersion": { field: "response.httpVersion", places: ["protocol-metadata"] },
  "response.redirectURL": { field: "response.redirectURL", places: ["redirect-url"] },
  "response.comment": { field: "response.comment", places: ["comment"] },
  "response._error": { field: "response._error", places: ["other-custom-field"] },
  "response.<custom>": { field: "response.<custom>", places: ["other-custom-field"] },
  "response.cookies[].name": { field: "response.cookies[].name", places: ["cookie-metadata"] },
  "response.cookies[].value": { field: "response.cookies[].value", places: ["cookie"] },
  "response.cookies[].path": { field: "response.cookies[].path", places: ["cookie-metadata"] },
  "response.cookies[].domain": { field: "response.cookies[].domain", places: ["cookie-metadata"] },
  "response.cookies[].expires": {
    field: "response.cookies[].expires",
    places: ["cookie-metadata"],
  },
  "response.cookies[].comment": { field: "response.cookies[].comment", places: ["comment"] },
  "response.cookies[].<custom>": {
    field: "response.cookies[].<custom>",
    places: ["other-custom-field"],
  },
  "response.headers[].name": { field: "response.headers[].name", places: ["header-name"] },
  "response.headers[].value": {
    field: "response.headers[].value",
    places: ["header-value-secret", "header-value-allowlisted", "url-header", "named-header"],
  },
  "response.headers[].comment": { field: "response.headers[].comment", places: ["comment"] },
  "response.headers[].<custom>": {
    field: "response.headers[].<custom>",
    places: ["other-custom-field"],
  },
  "response.content.mimeType": {
    field: "response.content.mimeType",
    places: ["protocol-metadata"],
  },
  "response.content.text": {
    field: "response.content.text",
    places: ["response-body-json", "response-body-base64", "response-body-other"],
  },
  "response.content.encoding": {
    field: "response.content.encoding",
    places: ["protocol-metadata"],
  },
  "response.content.comment": { field: "response.content.comment", places: ["comment"] },
  "response.content.<custom>": {
    field: "response.content.<custom>",
    places: ["other-custom-field"],
  },
  "cache.comment": { field: "cache.comment", places: ["comment"] },
  "cache.<custom>": { field: "cache.<custom>", places: ["other-custom-field"] },
  "cache.beforeRequest.expires": { field: "cache.beforeRequest.expires", places: ["cache"] },
  "cache.beforeRequest.lastAccess": { field: "cache.beforeRequest.lastAccess", places: ["cache"] },
  "cache.beforeRequest.lastFetched": {
    field: "cache.beforeRequest.lastFetched",
    places: ["cache"],
  },
  "cache.beforeRequest.eTag": { field: "cache.beforeRequest.eTag", places: ["cache"] },
  "cache.beforeRequest.fetchCount": { field: "cache.beforeRequest.fetchCount", places: ["cache"] },
  "cache.beforeRequest.comment": { field: "cache.beforeRequest.comment", places: ["comment"] },
  "cache.beforeRequest._dataSize": { field: "cache.beforeRequest._dataSize", places: ["cache"] },
  "cache.beforeRequest._lastModified": {
    field: "cache.beforeRequest._lastModified",
    places: ["cache"],
  },
  "cache.beforeRequest._device": { field: "cache.beforeRequest._device", places: ["cache"] },
  "cache.beforeRequest.<custom>": {
    field: "cache.beforeRequest.<custom>",
    places: ["other-custom-field"],
  },
  "cache.afterRequest.expires": { field: "cache.afterRequest.expires", places: ["cache"] },
  "cache.afterRequest.lastAccess": { field: "cache.afterRequest.lastAccess", places: ["cache"] },
  "cache.afterRequest.lastFetched": { field: "cache.afterRequest.lastFetched", places: ["cache"] },
  "cache.afterRequest.eTag": { field: "cache.afterRequest.eTag", places: ["cache"] },
  "cache.afterRequest.fetchCount": { field: "cache.afterRequest.fetchCount", places: ["cache"] },
  "cache.afterRequest.comment": { field: "cache.afterRequest.comment", places: ["comment"] },
  "cache.afterRequest._dataSize": { field: "cache.afterRequest._dataSize", places: ["cache"] },
  "cache.afterRequest._lastModified": {
    field: "cache.afterRequest._lastModified",
    places: ["cache"],
  },
  "cache.afterRequest._device": { field: "cache.afterRequest._device", places: ["cache"] },
  "cache.afterRequest.<custom>": {
    field: "cache.afterRequest.<custom>",
    places: ["other-custom-field"],
  },
  "timings.comment": { field: "timings.comment", places: ["comment"] },
  "timings.<custom>": { field: "timings.<custom>", places: ["other-custom-field"] },
};

type MappedPlaces = (typeof HAR_MODEL_FIELD_TABLE)[HarModelStringField]["places"][number];
type UnmappedPlaces = Exclude<HarRedactionPlace, MappedPlaces>;
const _assertEveryPlaceMappedToModelField: UnmappedPlaces extends never ? true : never = true;
void _assertEveryPlaceMappedToModelField;

export const ALLOWLISTED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "vary",
  "upgrade",
]);

export const URL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "location",
  "referer",
  "referrer",
  ":path",
  "link",
  "refresh",
  "origin",
  "content-location",
]);

export const DEFAULT_REDACTION_RULES: readonly HarRedactionRule[] = [
  { id: "header:cookie", target: "header", names: ["cookie"] },
  { id: "header:set-cookie", target: "header", names: ["set-cookie"] },
  { id: "header:authorization", target: "header", names: ["authorization"] },
  { id: "header:proxy-authorization", target: "header", names: ["proxy-authorization"] },
  { id: "cookie:all", target: "cookie", names: [], matchAll: true },
  {
    id: "query:secrets",
    target: "query",
    names: [
      "access_token",
      "refresh_token",
      "id_token",
      "token",
      "api_key",
      "apikey",
      "key",
      "client_secret",
      "secret",
      "password",
      "auth",
      "code",
      "sig",
      "signature",
      "x-amz-signature",
      "x-amz-security-token",
    ],
  },
  {
    id: "body:secrets",
    target: "body",
    names: [
      "access_token",
      "refresh_token",
      "id_token",
      "token",
      "api_key",
      "apikey",
      "key",
      "client_secret",
      "secret",
      "password",
      "auth",
      "code",
      "sig",
      "signature",
      "x-amz-signature",
      "x-amz-security-token",
    ],
  },
  {
    id: "header:x-api-key",
    target: "header",
    names: ["x-api-key", "api-key", "x-api-token", "x-auth-token", "x-amz-security-token"],
  },
  {
    id: "header:x-csrf-token",
    target: "header",
    names: ["x-csrf-token", "x-xsrf-token", "csrf-token"],
  },
  { id: "url:userinfo", target: "url-userinfo", names: ["userinfo"], matchAll: true },
];

const DEFAULT_REPLACEMENT = "[REDACTED]";

function resolveLevel(input: RedactionLevelInput | undefined): RedactionLevel {
  if (input === "shareable" || input === "strict") {
    return "shareable";
  }
  return "standard";
}

function foldKey(name: string): string {
  return name.replace(/[_-]/gu, "").toLowerCase();
}

function appendComment(existing: string | undefined, note: string): string {
  if (!existing || existing.length === 0) {
    return note;
  }
  return existing.includes(note) ? existing : `${existing}; ${note}`;
}

function findMatchingRule(
  rules: readonly HarRedactionRule[],
  target: HarRedactionTarget,
  fieldName: string,
): HarRedactionRule | undefined {
  const lower = fieldName.toLowerCase();
  for (const rule of rules) {
    if (rule.target !== target) {
      continue;
    }
    if (rule.matchAll === true) {
      return rule;
    }
    for (const candidate of rule.names) {
      if (candidate.toLowerCase() === lower) {
        return rule;
      }
    }
  }
  return undefined;
}

function findBodyRule(
  rules: readonly HarRedactionRule[],
  fieldName: string,
): HarRedactionRule | undefined {
  const direct = findMatchingRule(rules, "body", fieldName);
  if (direct) {
    return direct;
  }
  const folded = foldKey(fieldName);
  for (const rule of rules) {
    if (rule.target !== "body" || rule.matchAll === true) {
      continue;
    }
    for (const candidate of rule.names) {
      if (foldKey(candidate) === folded) {
        return rule;
      }
    }
  }
  return undefined;
}

function rulesCover(place: HarRedactionPlace, rules: readonly HarRedactionRule[]): boolean {
  if (place === "request-url-userinfo") {
    return findMatchingRule(rules, "url-userinfo", "userinfo") !== undefined;
  }
  if (place === "cookie") {
    return rules.some((rule) => rule.target === "cookie" && rule.matchAll === true);
  }
  if (place === "header-value-secret") {
    return rules.some(
      (rule) => rule.target === "header" && (rule.matchAll === true || rule.names.length > 0),
    );
  }
  if (place === "request-url-query-secret" || place === "query-string-secret") {
    return rules.some(
      (rule) => rule.target === "query" && (rule.matchAll === true || rule.names.length > 0),
    );
  }
  if (place === "body-param-secret") {
    return rules.some(
      (rule) => rule.target === "body" && (rule.matchAll === true || rule.names.length > 0),
    );
  }
  return true;
}

function effectivePlaceStatus(
  place: HarRedactionPlace,
  level: RedactionLevel,
  rules: readonly HarRedactionRule[],
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): PlaceExamStatus {
  const configured = table[place][level];
  if (configured === "removed" && level === "standard" && !rulesCover(place, rules)) {
    return "kept-not-examined";
  }
  return configured;
}

function detailForStatus(status: PlaceExamStatus): PlaceReportDetail {
  if (status === "removed") {
    return "removed";
  }
  if (status === "kept-by-allowlist") {
    return "kept by allowlist";
  }
  return "not examined: may contain secrets";
}

function canStillHoldForStatus(status: PlaceExamStatus): string {
  if (status === "removed") {
    return "Removed.";
  }
  if (status === "kept-by-allowlist") {
    return "Kept by allowlist. Any secret in a host name or URL path can remain.";
  }
  return "Not examined: may contain secrets. Any secret can remain.";
}

interface RemovalKey {
  readonly target: HarRedactionTarget;
  readonly field: string;
  readonly ruleId: string;
  readonly place: HarRedactionPlace;
}

class RedactionTracker {
  readonly #entryIndex: number;
  readonly #removals = new Map<string, RemovalKey & { count: number }>();
  readonly #fields = new Set<string>();
  readonly placeCounts = new Map<HarRedactionPlace, number>();

  constructor(entryIndex: number) {
    this.#entryIndex = entryIndex;
  }

  noteCount(place: HarRedactionPlace, amount = 1): void {
    if (amount <= 0) {
      return;
    }
    this.placeCounts.set(place, (this.placeCounts.get(place) ?? 0) + amount);
  }

  markRemoved(
    place: HarRedactionPlace,
    target: HarRedactionTarget,
    field: string,
    ruleId: string,
    amount = 1,
  ): void {
    this.noteCount(place, amount);
    this.#fields.add(`${target}:${field}`);
    const key = `${place}\0${target}\0${field.toLowerCase()}\0${ruleId}`;
    const prior = this.#removals.get(key);
    if (prior) {
      prior.count += amount;
    } else {
      this.#removals.set(key, { place, target, field, ruleId, count: amount });
    }
  }

  records(url: HarUrl): readonly HarRedactionRecord[] {
    return [...this.#removals.values()].map((item) => ({
      entryIndex: this.#entryIndex,
      url,
      place: item.place,
      target: item.target,
      field: item.field,
      ruleId: item.ruleId,
      count: item.count,
    }));
  }

  get fields(): readonly string[] {
    return [...this.#fields];
  }
}

interface RedactContext {
  readonly level: RedactionLevel;
  readonly rules: readonly HarRedactionRule[];
  readonly replacement: string;
  readonly table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>;
  readonly tracker: RedactionTracker;
  status(place: HarRedactionPlace): PlaceExamStatus;
  isRemoved(place: HarRedactionPlace): boolean;
}

function createContext(
  entryIndex: number,
  level: RedactionLevel,
  rules: readonly HarRedactionRule[],
  replacement: string,
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): RedactContext {
  const tracker = new RedactionTracker(entryIndex);
  return {
    level,
    rules,
    replacement,
    table,
    tracker,
    status(place) {
      return effectivePlaceStatus(place, level, rules, table);
    },
    isRemoved(place) {
      return effectivePlaceStatus(place, level, rules, table) === "removed";
    },
  };
}

function redactProtocolString(value: string, fieldName: string, ctx: RedactContext): string {
  if (ctx.isRemoved("protocol-metadata")) {
    if (value.length > 0) {
      ctx.tracker.markRemoved(
        "protocol-metadata",
        "body",
        fieldName,
        `${ctx.level}:protocol-metadata`,
      );
    }
    return "";
  }
  if (value.length > 0) {
    ctx.tracker.noteCount("protocol-metadata");
  }
  return value;
}

function redactProtocolIso(value: IsoDateTime, fieldName: string, ctx: RedactContext): IsoDateTime {
  if (ctx.isRemoved("protocol-metadata")) {
    ctx.tracker.markRemoved(
      "protocol-metadata",
      "body",
      fieldName,
      `${ctx.level}:protocol-metadata`,
    );
    return toIsoDateTime("1970-01-01T00:00:00.000Z")!;
  }
  ctx.tracker.noteCount("protocol-metadata");
  return value;
}

function redactProtocolPageId(value: PageId, fieldName: string, ctx: RedactContext): PageId {
  if (ctx.isRemoved("protocol-metadata")) {
    ctx.tracker.markRemoved(
      "protocol-metadata",
      "page",
      fieldName,
      `${ctx.level}:protocol-metadata`,
    );
    return toPageId("page_redacted")!;
  }
  ctx.tracker.noteCount("protocol-metadata");
  return value;
}

function redactComment(
  comment: string | undefined,
  fieldName: string,
  ctx: RedactContext,
): string | undefined {
  if (comment === undefined) {
    return undefined;
  }
  if (ctx.isRemoved("comment")) {
    ctx.tracker.markRemoved("comment", "body", fieldName, `${ctx.level}:comment`);
    return undefined;
  }
  ctx.tracker.noteCount("comment");
  return comment;
}

function countStringsInUnknown(value: unknown): number {
  if (typeof value === "string") {
    return 1;
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      total += countStringsInUnknown(item);
    }
    return total;
  }
  if (typeof value === "object" && value !== null) {
    let total = 0;
    for (const field of Object.values(value)) {
      total += countStringsInUnknown(field);
    }
    return total;
  }
  return 0;
}

function redactCustomFields(
  source: object,
  owned: ReadonlySet<string>,
  ctx: RedactContext,
  extraOwned?: ReadonlySet<string>,
): Record<string, unknown> {
  const custom = pickCustomFields(source, owned);
  const keys = Object.keys(custom).filter(
    (key) => key !== "_harExport" && !(extraOwned?.has(key) ?? false),
  );
  if (keys.length === 0) {
    return {};
  }
  let stringCount = 0;
  for (const key of keys) {
    stringCount += countStringsInUnknown(custom[key]);
  }
  const amount = Math.max(1, stringCount);
  if (ctx.isRemoved("other-custom-field")) {
    ctx.tracker.markRemoved(
      "other-custom-field",
      "body",
      keys[0] ?? "custom",
      `${ctx.level}:custom`,
      amount,
    );
    return {};
  }
  ctx.tracker.noteCount("other-custom-field", amount);
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    kept[key] = custom[key];
  }
  return kept;
}

function redactStructuredUrl(
  raw: string,
  ctx: RedactContext,
  mode: "request-url" | "page-title",
): string {
  const isPage = mode === "page-title";
  const queryTarget: HarRedactionTarget = isPage ? "page" : "query";
  const encodedReplacement = encodeURIComponent(ctx.replacement);

  const hashIndex = raw.indexOf("#");
  const beforeHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : raw.slice(hashIndex + 1);

  const queryIndex = beforeHash.indexOf("?");
  const beforeQuery = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? null : beforeHash.slice(queryIndex + 1);

  let head = beforeQuery;
  const authorityMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)(.*)$/u.exec(beforeQuery);
  if (authorityMatch) {
    const schemePrefix = authorityMatch[1] ?? "";
    const authority = authorityMatch[2] ?? "";
    const pathPart = authorityMatch[3] ?? "";
    const atIndex = authority.lastIndexOf("@");
    const userinfo = atIndex === -1 ? null : authority.slice(0, atIndex);
    let hostPort = atIndex === -1 ? authority : authority.slice(atIndex + 1);

    let nextUserinfoPrefix = "";
    if (userinfo !== null) {
      const userinfoRule = findMatchingRule(ctx.rules, "url-userinfo", "userinfo");
      if (ctx.isRemoved("request-url-userinfo") && (ctx.level === "shareable" || userinfoRule)) {
        ctx.tracker.markRemoved(
          "request-url-userinfo",
          isPage ? "page" : "url-userinfo",
          "userinfo",
          userinfoRule?.id ?? `${ctx.level}:userinfo`,
        );
        nextUserinfoPrefix = ctx.level === "shareable" ? "" : `${encodedReplacement}@`;
      } else {
        ctx.tracker.noteCount("request-url-userinfo");
        nextUserinfoPrefix = `${userinfo}@`;
      }
    }

    if (!isPage) {
      if (ctx.isRemoved("request-url-host")) {
        ctx.tracker.markRemoved("request-url-host", "query", "host", `${ctx.level}:host`);
        hostPort = "redacted.invalid";
      } else if (hostPort.length > 0) {
        ctx.tracker.noteCount("request-url-host");
      }
    }

    let nextPath = pathPart;
    if (!isPage && pathPart.length > 0) {
      if (ctx.isRemoved("request-url-path")) {
        ctx.tracker.markRemoved("request-url-path", "query", "path", `${ctx.level}:path`);
        nextPath = "/";
      } else {
        ctx.tracker.noteCount("request-url-path");
      }
    }

    head = `${schemePrefix}${nextUserinfoPrefix}${hostPort}${nextPath}`;
  }

  let nextQuery: string | null = null;
  if (query !== null) {
    if (query.length === 0) {
      nextQuery = ctx.isRemoved("request-url-query") ? null : "";
    } else {
      const keptSegments: string[] = [];
      for (const segment of query.split("&")) {
        if (segment.length === 0) {
          if (!ctx.isRemoved("request-url-query")) {
            keptSegments.push(segment);
          }
          continue;
        }
        const eqIndex = segment.indexOf("=");
        const rawName = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
        const decodedName = safeDecodeQueryComponent(rawName);
        const secretRule = findMatchingRule(ctx.rules, "query", decodedName);
        if (secretRule) {
          if (ctx.isRemoved("request-url-query-secret")) {
            ctx.tracker.markRemoved(
              "request-url-query-secret",
              queryTarget,
              decodedName,
              secretRule.id,
            );
            if (!ctx.isRemoved("request-url-query")) {
              keptSegments.push(`${rawName}=${encodedReplacement}`);
            }
          } else {
            ctx.tracker.noteCount("request-url-query-secret");
            keptSegments.push(segment);
          }
        } else if (!isPage) {
          if (ctx.isRemoved("request-url-query")) {
            ctx.tracker.markRemoved(
              "request-url-query",
              queryTarget,
              decodedName || "query",
              `${ctx.level}:query`,
            );
          } else {
            ctx.tracker.noteCount("request-url-query");
            keptSegments.push(segment);
          }
        } else {
          keptSegments.push(segment);
        }
      }
      if (keptSegments.length > 0) {
        nextQuery = keptSegments.join("&");
      } else if (!ctx.isRemoved("request-url-query")) {
        nextQuery = "";
      }
    }
  }

  let nextFragment: string | null = null;
  if (fragment !== null) {
    if (!isPage) {
      if (ctx.isRemoved("request-url-fragment")) {
        if (fragment.length > 0) {
          ctx.tracker.markRemoved(
            "request-url-fragment",
            "query",
            "fragment",
            `${ctx.level}:fragment`,
          );
        }
      } else {
        if (fragment.length > 0) {
          ctx.tracker.noteCount("request-url-fragment");
        }
        nextFragment = fragment;
      }
    } else {
      nextFragment = fragment;
    }
  }

  const queryPart = nextQuery !== null ? `?${nextQuery}` : "";
  const fragmentPart = nextFragment !== null ? `#${nextFragment}` : "";
  return `${head}${queryPart}${fragmentPart}`;
}

function redactPageTitle(title: string, ctx: RedactContext): string {
  const afterUrl = redactStructuredUrl(title, ctx, "page-title");
  if (ctx.isRemoved("page-title")) {
    if (title.length > 0) {
      ctx.tracker.markRemoved("page-title", "page", "title", `${ctx.level}:page-title`);
    }
    return "";
  }
  if (afterUrl.length > 0) {
    ctx.tracker.noteCount("page-title");
  }
  return afterUrl;
}

function classifyHeaderValuePlace(
  headerName: string,
  rules: readonly HarRedactionRule[],
): { readonly place: HarRedactionPlace; readonly rule?: HarRedactionRule | undefined } {
  const rule = findMatchingRule(rules, "header", headerName);
  if (rule) {
    return { place: "header-value-secret", rule };
  }
  const lower = headerName.toLowerCase();
  if (ALLOWLISTED_HEADER_NAMES.has(lower)) {
    return { place: "header-value-allowlisted" };
  }
  if (URL_HEADER_NAMES.has(lower)) {
    return { place: "url-header" };
  }
  return { place: "named-header" };
}

function redactHeaders(
  headers: readonly HarNameValue[],
  ctx: RedactContext,
): readonly HarNameValue[] {
  return headers.map((header) => {
    const custom = redactCustomFields(header, OWNED_FIELDS.nameValue, ctx);
    let comment = redactComment(header.comment, "header.comment", ctx);

    let name = header.name;
    const nameRemoved = ctx.isRemoved("header-name");
    if (nameRemoved) {
      ctx.tracker.markRemoved("header-name", "header", "header", `${ctx.level}:header-name`);
      name = "";
    } else {
      ctx.tracker.noteCount("header-name");
    }

    const { place: valuePlace, rule } = classifyHeaderValuePlace(header.name, ctx.rules);
    let value = header.value;
    if (ctx.isRemoved(valuePlace)) {
      const ruleId = rule?.id ?? `${ctx.level}:${valuePlace}`;
      ctx.tracker.markRemoved(valuePlace, "header", nameRemoved ? "header" : header.name, ruleId);
      if (ctx.level === "shareable" && !rule) {
        value = "";
      } else {
        value = ctx.replacement;
        if (!ctx.isRemoved("comment")) {
          comment = appendComment(comment, `redacted by ${ruleId}`);
        }
      }
    } else {
      ctx.tracker.noteCount(valuePlace);
    }

    return {
      ...custom,
      name,
      value,
      ...(comment !== undefined ? { comment } : {}),
    };
  });
}

function redactCookies(cookies: readonly HarCookie[], ctx: RedactContext): readonly HarCookie[] {
  const valueRemoved = ctx.isRemoved("cookie");
  const metaRemoved = ctx.isRemoved("cookie-metadata");
  const result: HarCookie[] = [];

  for (const cookie of cookies) {
    const custom = redactCustomFields(cookie, OWNED_FIELDS.cookie, ctx);
    let comment = redactComment(cookie.comment, "cookie.comment", ctx);

    let name = cookie.name;
    let path = cookie.path;
    let domain = cookie.domain;
    let expires = cookie.expires;
    const metaCount =
      1 +
      (path !== undefined ? 1 : 0) +
      (domain !== undefined ? 1 : 0) +
      (typeof expires === "string" ? 1 : 0);

    if (metaRemoved) {
      ctx.tracker.markRemoved(
        "cookie-metadata",
        "cookie",
        "cookie",
        `${ctx.level}:cookie-metadata`,
        metaCount,
      );
      name = "";
      path = undefined;
      domain = undefined;
      expires = undefined;
    } else {
      ctx.tracker.noteCount("cookie-metadata", metaCount);
    }

    const rule = findMatchingRule(ctx.rules, "cookie", cookie.name);
    let value = cookie.value;
    let didRedactValue = false;
    if (valueRemoved || rule) {
      const ruleId = rule?.id ?? `${ctx.level}:cookie`;
      ctx.tracker.markRemoved("cookie", "cookie", metaRemoved ? "cookie" : cookie.name, ruleId);
      value = ctx.level === "shareable" ? "" : ctx.replacement;
      didRedactValue = true;
      if (rule && !ctx.isRemoved("comment")) {
        comment = appendComment(comment, `redacted by ${rule.id}`);
      }
    } else {
      ctx.tracker.noteCount("cookie");
    }

    if (
      metaRemoved &&
      didRedactValue &&
      comment === undefined &&
      Object.keys(custom).length === 0
    ) {
      continue;
    }

    result.push({
      ...custom,
      name,
      value,
      ...(path !== undefined ? { path } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
      ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
      ...(comment !== undefined ? { comment } : {}),
    });
  }

  return result;
}

function redactQueryString(
  queryString: readonly HarNameValue[],
  ctx: RedactContext,
): readonly HarNameValue[] {
  const otherRemoved = ctx.isRemoved("query-string");
  const secretRemoved = ctx.isRemoved("query-string-secret");
  const result: HarNameValue[] = [];

  for (const item of queryString) {
    const custom = redactCustomFields(item, OWNED_FIELDS.nameValue, ctx);
    let comment = redactComment(item.comment, "queryString.comment", ctx);

    let name = item.name;
    if (otherRemoved) {
      ctx.tracker.markRemoved("query-string", "query", "query", `${ctx.level}:query-name`);
      name = "";
    } else {
      ctx.tracker.noteCount("query-string");
    }

    const rule = findMatchingRule(ctx.rules, "query", item.name);
    const valuePlace: HarRedactionPlace = rule ? "query-string-secret" : "query-string";
    let value = item.value;
    let didRemoveValue = false;
    if (ctx.isRemoved(valuePlace)) {
      const ruleId = rule?.id ?? `${ctx.level}:query`;
      ctx.tracker.markRemoved(valuePlace, "query", otherRemoved ? "query" : item.name, ruleId);
      value = ctx.level === "shareable" ? "" : ctx.replacement;
      didRemoveValue = true;
      if (rule && !ctx.isRemoved("comment")) {
        comment = appendComment(comment, `redacted by ${rule.id}`);
      }
    } else {
      ctx.tracker.noteCount(valuePlace);
    }

    if (
      otherRemoved &&
      secretRemoved &&
      didRemoveValue &&
      comment === undefined &&
      Object.keys(custom).length === 0
    ) {
      continue;
    }

    result.push({
      ...custom,
      name,
      value,
      ...(comment !== undefined ? { comment } : {}),
    });
  }

  return result;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function classifyRequestBodyPlace(mimeType: string, text: string): HarRedactionPlace {
  const mime = mimeType.toLowerCase();
  if (mime.includes("json") || looksLikeJson(text)) {
    return "body-json";
  }
  if (mime.includes("x-www-form-urlencoded")) {
    return "body-form";
  }
  if (mime.includes("multipart/")) {
    return "body-multipart";
  }
  return "request-body-other";
}

function classifyResponseBodyPlace(
  mimeType: string,
  encoding: string | undefined,
  text: string,
): HarRedactionPlace {
  if (encoding?.toLowerCase() === "base64") {
    return "response-body-base64";
  }
  const mime = mimeType.toLowerCase();
  if (mime.includes("json") || looksLikeJson(text)) {
    return "response-body-json";
  }
  return "response-body-other";
}

function redactPostData(
  postData: HarPostData | undefined,
  ctx: RedactContext,
): HarPostData | undefined {
  if (!postData) {
    return undefined;
  }
  const custom = redactCustomFields(postData, OWNED_FIELDS.postData, ctx);
  const comment = redactComment(postData.comment, "postData.comment", ctx);
  const mimeType = redactProtocolString(postData.mimeType, "postData.mimeType", ctx);

  const paramMetaRemoved = ctx.isRemoved("body-param");
  const paramSecretRemoved = ctx.isRemoved("body-param-secret");
  const params: HarPostDataParam[] = [];
  for (const param of postData.params) {
    const paramCustom = redactCustomFields(param, OWNED_FIELDS.postParam, ctx);
    let paramComment = redactComment(param.comment, "postData.param.comment", ctx);

    let name = param.name;
    let fileName = param.fileName;
    let contentType = param.contentType;
    const metaCount = 1 + (fileName !== undefined ? 1 : 0) + (contentType !== undefined ? 1 : 0);

    if (paramMetaRemoved) {
      ctx.tracker.markRemoved("body-param", "body", "param", `${ctx.level}:body-param`, metaCount);
      name = "";
      fileName = undefined;
      contentType = undefined;
    } else {
      ctx.tracker.noteCount("body-param", metaCount);
    }

    const rule = findBodyRule(ctx.rules, param.name);
    const valuePlace: HarRedactionPlace = rule ? "body-param-secret" : "body-param";
    let value = param.value;
    let valueRemoved = false;
    if (value !== undefined) {
      if (ctx.isRemoved(valuePlace)) {
        const ruleId = rule?.id ?? `${ctx.level}:body-param`;
        ctx.tracker.markRemoved(
          valuePlace,
          "body",
          paramMetaRemoved ? "param" : param.name,
          ruleId,
        );
        value = ctx.level === "shareable" ? "" : ctx.replacement;
        valueRemoved = true;
        if (rule && !ctx.isRemoved("comment")) {
          paramComment = appendComment(paramComment, `redacted by ${rule.id}`);
        }
      } else {
        ctx.tracker.noteCount(valuePlace);
      }
    }

    if (
      paramMetaRemoved &&
      paramSecretRemoved &&
      (param.value === undefined || valueRemoved) &&
      paramComment === undefined &&
      Object.keys(paramCustom).length === 0
    ) {
      continue;
    }

    params.push({
      ...paramCustom,
      name,
      ...(value !== undefined ? { value } : {}),
      ...(fileName !== undefined ? { fileName } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      ...(paramComment !== undefined ? { comment: paramComment } : {}),
    });
  }

  let text = postData.text;
  if (typeof text === "string" && text.length > 0) {
    const bodyPlace = classifyRequestBodyPlace(postData.mimeType, text);
    if (ctx.isRemoved(bodyPlace)) {
      ctx.tracker.markRemoved(bodyPlace, "body", "postData.text", `${ctx.level}:${bodyPlace}`);
      text = "";
    } else {
      ctx.tracker.noteCount(bodyPlace);
    }
  }

  return {
    ...custom,
    mimeType,
    params,
    text,
    ...(comment !== undefined ? { comment } : {}),
  };
}

function redactContent(content: HarContent, ctx: RedactContext): HarContent {
  const custom = redactCustomFields(content, OWNED_FIELDS.content, ctx);
  const comment = redactComment(content.comment, "content.comment", ctx);
  const mimeType = redactProtocolString(content.mimeType, "content.mimeType", ctx);
  const encoding =
    content.encoding !== undefined
      ? redactProtocolString(content.encoding, "content.encoding", ctx)
      : undefined;

  let text = content.text;
  if (typeof text === "string" && text.length > 0) {
    const bodyPlace = classifyResponseBodyPlace(content.mimeType, content.encoding, text);
    if (ctx.isRemoved(bodyPlace)) {
      ctx.tracker.markRemoved(bodyPlace, "body", "content.text", `${ctx.level}:${bodyPlace}`);
      text = undefined;
    } else {
      ctx.tracker.noteCount(bodyPlace);
    }
  } else if (typeof text === "string" && text.length === 0 && ctx.level === "shareable") {
    text = undefined;
  }

  return {
    ...custom,
    size: content.size,
    ...(content.compression !== undefined ? { compression: content.compression } : {}),
    mimeType,
    ...(text !== undefined ? { text } : {}),
    ...(encoding !== undefined && encoding.length > 0 ? { encoding } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

const CACHE_ENTRY_STRING_KEYS = [
  "expires",
  "lastAccess",
  "lastFetched",
  "eTag",
  "fetchCount",
  "_dataSize",
  "_lastModified",
  "_device",
] as const;

const CACHE_ENTRY_ALL_OWNED = new Set<string>([
  ...OWNED_FIELDS.cacheEntry,
  "_dataSize",
  "_lastModified",
  "_device",
]);

function redactCacheEntry(
  entry: HarCacheEntry | null | undefined,
  slotName: string,
  ctx: RedactContext,
): HarCacheEntry | null | undefined {
  if (entry === undefined || entry === null) {
    return entry;
  }
  const custom = redactCustomFields(entry, CACHE_ENTRY_ALL_OWNED, ctx);
  const comment = redactComment(entry.comment, `${slotName}.comment`, ctx);

  let stringCount = 0;
  for (const key of CACHE_ENTRY_STRING_KEYS) {
    const val = entry[key];
    if (typeof val === "string" && val.length > 0) {
      stringCount += 1;
    }
  }

  if (ctx.isRemoved("cache")) {
    if (stringCount > 0 || entry.hitCount !== undefined || typeof entry.fetchCount === "number") {
      ctx.tracker.markRemoved(
        "cache",
        "body",
        slotName,
        `${ctx.level}:cache`,
        Math.max(1, stringCount),
      );
    }
    if (comment === undefined && Object.keys(custom).length === 0) {
      return undefined;
    }
    return {
      ...custom,
      ...(comment !== undefined ? { comment } : {}),
    };
  }

  if (stringCount > 0) {
    ctx.tracker.noteCount("cache", stringCount);
  }

  return {
    ...custom,
    ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
    ...(entry.lastAccess !== undefined ? { lastAccess: entry.lastAccess } : {}),
    ...(entry.lastFetched !== undefined ? { lastFetched: entry.lastFetched } : {}),
    ...(entry.eTag !== undefined ? { eTag: entry.eTag } : {}),
    ...(entry.hitCount !== undefined ? { hitCount: entry.hitCount } : {}),
    ...(entry.fetchCount !== undefined ? { fetchCount: entry.fetchCount } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(entry._dataSize !== undefined ? { _dataSize: entry._dataSize } : {}),
    ...(entry._lastModified !== undefined ? { _lastModified: entry._lastModified } : {}),
    ...(entry._device !== undefined ? { _device: entry._device } : {}),
  };
}

function redactCache(cache: HarCache, ctx: RedactContext): HarCache {
  const custom = redactCustomFields(cache, OWNED_FIELDS.cache, ctx);
  const comment = redactComment(cache.comment, "cache.comment", ctx);
  const beforeRequest = redactCacheEntry(cache.beforeRequest, "beforeRequest", ctx);
  const afterRequest = redactCacheEntry(cache.afterRequest, "afterRequest", ctx);

  return {
    ...custom,
    ...(beforeRequest !== undefined ? { beforeRequest } : {}),
    ...(afterRequest !== undefined ? { afterRequest } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

function redactTimings(timings: HarTimings, ctx: RedactContext): HarTimings {
  const custom = redactCustomFields(timings, OWNED_FIELDS.timings, ctx);
  const comment = redactComment(timings.comment, "timings.comment", ctx);

  return {
    ...custom,
    ...(timings.blocked !== undefined ? { blocked: timings.blocked } : {}),
    ...(timings.dns !== undefined ? { dns: timings.dns } : {}),
    ...(timings.connect !== undefined ? { connect: timings.connect } : {}),
    send: timings.send,
    wait: timings.wait,
    receive: timings.receive,
    ...(timings.ssl !== undefined ? { ssl: timings.ssl } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

function countInitiatorStackStrings(stack: ChromeInitiatorStack | undefined): number {
  if (!stack) {
    return 0;
  }
  let count = 0;
  for (const frame of stack.callFrames ?? []) {
    if (typeof frame.functionName === "string") {
      count += 1;
    }
    if (typeof frame.scriptId === "string") {
      count += 1;
    }
    if (typeof frame.url === "string") {
      count += 1;
    }
  }
  count += countInitiatorStackStrings(stack.parent);
  return count;
}

function redactInitiator(
  initiator: ChromeInitiator | undefined,
  ctx: RedactContext,
): ChromeInitiator | undefined {
  if (!initiator) {
    return undefined;
  }
  const stringCount =
    (typeof initiator.type === "string" ? 1 : 0) +
    (typeof initiator.url === "string" ? 1 : 0) +
    (typeof initiator.requestId === "string" ? 1 : 0) +
    countInitiatorStackStrings(initiator.stack);
  const amount = Math.max(1, stringCount);
  if (ctx.isRemoved("initiator")) {
    ctx.tracker.markRemoved(
      "initiator",
      "initiator",
      "_initiator",
      `${ctx.level}:initiator`,
      amount,
    );
    return undefined;
  }
  ctx.tracker.noteCount("initiator", amount);
  return initiator;
}

function redactWebSocketMessages(
  messages: readonly ChromeWebSocketMessage[] | undefined,
  ctx: RedactContext,
): readonly ChromeWebSocketMessage[] | undefined {
  if (!messages) {
    return undefined;
  }
  let stringCount = 0;
  for (const msg of messages) {
    if (typeof msg.type === "string") {
      stringCount += 1;
    }
    if (typeof msg.data === "string") {
      stringCount += 1;
    }
  }
  const amount = Math.max(1, stringCount);
  if (ctx.isRemoved("websocket")) {
    if (messages.length > 0) {
      ctx.tracker.markRemoved(
        "websocket",
        "body",
        "_webSocketMessages",
        `${ctx.level}:websocket`,
        amount,
      );
    }
    return undefined;
  }
  if (messages.length > 0) {
    ctx.tracker.noteCount("websocket", amount);
  }
  return messages;
}

function redactCustomStringField<T extends string>(
  value: T | undefined,
  fieldName: string,
  ctx: RedactContext,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (ctx.isRemoved("other-custom-field")) {
    ctx.tracker.markRemoved("other-custom-field", "body", fieldName, `${ctx.level}:${fieldName}`);
    return undefined;
  }
  ctx.tracker.noteCount("other-custom-field");
  return value;
}

const ENTRY_DECLARED_CUSTOM = new Set<string>([
  "_securityState",
  "_priority",
  "_initiator",
  "_resourceType",
  "_fromCache",
  "_connectionId",
  "_webSocketMessages",
  "_harExport",
]);

const RESPONSE_DECLARED_CUSTOM = new Set<string>(["_transferSize", "_error"]);

function redactEntryWithContext(
  entry: HarEntry,
  ctx: RedactContext,
): {
  readonly entry: HarEntry;
  readonly url: HarUrl;
  readonly records: readonly HarRedactionRecord[];
} {
  const startedDateTime = redactProtocolIso(entry.startedDateTime, "entry.startedDateTime", ctx);
  const pageref =
    entry.pageref !== undefined
      ? redactProtocolPageId(entry.pageref, "entry.pageref", ctx)
      : undefined;

  const requestMethod = redactProtocolString(entry.request.method, "request.method", ctx);
  const requestHttpVersion = redactProtocolString(
    entry.request.httpVersion,
    "request.httpVersion",
    ctx,
  );
  const requestHeaders = redactHeaders(entry.request.headers, ctx);
  const requestCookies = redactCookies(entry.request.cookies, ctx);
  const queryString = redactQueryString(entry.request.queryString, ctx);
  const urlText = redactStructuredUrl(entry.request.url, ctx, "request-url");
  const url = toHarUrl(urlText) ?? entry.request.url;
  const postData = redactPostData(entry.request.postData, ctx);
  const requestComment = redactComment(entry.request.comment, "request.comment", ctx);
  const requestCustom = redactCustomFields(entry.request, OWNED_FIELDS.request, ctx);

  const responseStatusText = redactProtocolString(
    entry.response.statusText,
    "response.statusText",
    ctx,
  );
  const responseHttpVersion = redactProtocolString(
    entry.response.httpVersion,
    "response.httpVersion",
    ctx,
  );
  const responseHeaders = redactHeaders(entry.response.headers, ctx);
  const responseCookies = redactCookies(entry.response.cookies, ctx);
  const content = redactContent(entry.response.content, ctx);

  let redirectURL = entry.response.redirectURL;
  if (redirectURL.length > 0) {
    if (ctx.isRemoved("redirect-url")) {
      ctx.tracker.markRemoved("redirect-url", "query", "redirectURL", `${ctx.level}:redirect-url`);
      redirectURL = "";
    } else {
      ctx.tracker.noteCount("redirect-url");
    }
  }

  const responseComment = redactComment(entry.response.comment, "response.comment", ctx);
  const responseError =
    entry.response._error !== undefined && entry.response._error !== null
      ? redactCustomStringField(entry.response._error, "response._error", ctx)
      : entry.response._error === null && !ctx.isRemoved("other-custom-field")
        ? null
        : undefined;
  const responseTransferSize =
    entry.response._transferSize !== undefined && !ctx.isRemoved("other-custom-field")
      ? entry.response._transferSize
      : undefined;
  const responseCustom = redactCustomFields(
    entry.response,
    OWNED_FIELDS.response,
    ctx,
    RESPONSE_DECLARED_CUSTOM,
  );

  const cache = redactCache(entry.cache, ctx);
  const timings = redactTimings(entry.timings, ctx);
  const serverIPAddress = redactCustomStringField(
    entry.serverIPAddress,
    "entry.serverIPAddress",
    ctx,
  );
  const connection = redactCustomStringField(entry.connection, "entry.connection", ctx);
  const entryComment = redactComment(entry.comment, "entry.comment", ctx);
  const securityState = redactCustomStringField(entry._securityState, "entry._securityState", ctx);
  const priority = redactCustomStringField(entry._priority, "entry._priority", ctx);
  const initiator = redactInitiator(entry._initiator, ctx);
  const resourceType = redactCustomStringField(entry._resourceType, "entry._resourceType", ctx);
  const fromCache = redactCustomStringField(entry._fromCache, "entry._fromCache", ctx);
  const connectionId = redactCustomStringField(entry._connectionId, "entry._connectionId", ctx);
  const webSocketMessages = redactWebSocketMessages(entry._webSocketMessages, ctx);
  const entryCustom = redactCustomFields(entry, OWNED_FIELDS.entry, ctx, ENTRY_DECLARED_CUSTOM);

  const records = ctx.tracker.records(url);
  const updated: HarEntry = {
    ...entryCustom,
    ...(pageref !== undefined ? { pageref } : {}),
    startedDateTime,
    time: entry.time,
    request: {
      ...requestCustom,
      method: requestMethod,
      url,
      httpVersion: requestHttpVersion,
      cookies: requestCookies,
      headers: requestHeaders,
      queryString,
      ...(postData !== undefined ? { postData } : {}),
      headersSize: entry.request.headersSize,
      bodySize: entry.request.bodySize,
      ...(requestComment !== undefined ? { comment: requestComment } : {}),
    },
    response: {
      ...responseCustom,
      status: entry.response.status,
      statusText: responseStatusText,
      httpVersion: responseHttpVersion,
      cookies: responseCookies,
      headers: responseHeaders,
      content,
      redirectURL,
      headersSize: entry.response.headersSize,
      bodySize: entry.response.bodySize,
      ...(responseComment !== undefined ? { comment: responseComment } : {}),
      ...(responseTransferSize !== undefined ? { _transferSize: responseTransferSize } : {}),
      ...(responseError !== undefined ? { _error: responseError } : {}),
    },
    cache,
    timings,
    ...(serverIPAddress !== undefined ? { serverIPAddress } : {}),
    ...(connection !== undefined ? { connection } : {}),
    ...(entryComment !== undefined ? { comment: entryComment } : {}),
    ...(securityState !== undefined ? { _securityState: securityState } : {}),
    ...(priority !== undefined ? { _priority: priority } : {}),
    ...(initiator !== undefined ? { _initiator: initiator } : {}),
    ...(resourceType !== undefined ? { _resourceType: resourceType } : {}),
    ...(fromCache !== undefined ? { _fromCache: fromCache } : {}),
    ...(connectionId !== undefined ? { _connectionId: connectionId } : {}),
    ...(webSocketMessages !== undefined ? { _webSocketMessages: webSocketMessages } : {}),
    ...(records.length > 0
      ? {
          _harExport: {
            ...entry._harExport,
            redactedFields: [
              ...new Set([...(entry._harExport?.redactedFields ?? []), ...ctx.tracker.fields]),
            ],
          },
        }
      : entry._harExport
        ? { _harExport: entry._harExport }
        : {}),
  };

  return { entry: updated, url, records };
}

function redactCreator(
  creator: HarCreator,
  prefix: "creator" | "browser",
  ctx: RedactContext,
): HarCreator {
  const custom = redactCustomFields(creator, OWNED_FIELDS.creator, ctx);
  const name = redactProtocolString(creator.name, `${prefix}.name`, ctx);
  const version = redactProtocolString(creator.version, `${prefix}.version`, ctx);
  const comment = redactComment(creator.comment, `${prefix}.comment`, ctx);
  return {
    ...custom,
    name,
    version,
    ...(comment !== undefined ? { comment } : {}),
  };
}

function redactPage(page: HarPage, ctx: RedactContext): HarPage {
  const pageCustom = redactCustomFields(page, OWNED_FIELDS.page, ctx);
  const timingCustom = redactCustomFields(page.pageTimings, OWNED_FIELDS.pageTimings, ctx);
  const startedDateTime = redactProtocolIso(page.startedDateTime, "page.startedDateTime", ctx);
  const id = redactProtocolPageId(page.id, "page.id", ctx);
  const title = redactPageTitle(page.title, ctx);
  const comment = redactComment(page.comment, "page.comment", ctx);
  const timingComment = redactComment(page.pageTimings.comment, "pageTimings.comment", ctx);

  return {
    ...pageCustom,
    startedDateTime,
    id,
    title,
    pageTimings: {
      ...timingCustom,
      ...(page.pageTimings.onContentLoad !== undefined
        ? { onContentLoad: page.pageTimings.onContentLoad }
        : {}),
      ...(page.pageTimings.onLoad !== undefined ? { onLoad: page.pageTimings.onLoad } : {}),
      ...(timingComment !== undefined ? { comment: timingComment } : {}),
    },
    ...(comment !== undefined ? { comment } : {}),
  };
}

function buildPlacesReport(
  level: RedactionLevel,
  rules: readonly HarRedactionRule[],
  counts: ReadonlyMap<HarRedactionPlace, number>,
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): readonly HarPlaceCoverage[] {
  return HAR_REDACTION_PLACES.map((place) => {
    const status = effectivePlaceStatus(place, level, rules, table);
    return {
      place,
      status,
      count: counts.get(place) ?? 0,
      detail: detailForStatus(status),
      canStillHold: canStillHoldForStatus(status),
    };
  });
}

function normalizeOptions(optionsOrRules?: RedactHarOptions | readonly HarRedactionRule[]): {
  readonly level: RedactionLevel;
  readonly rules: readonly HarRedactionRule[];
  readonly replacement: string;
  readonly table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>;
} {
  if (Array.isArray(optionsOrRules)) {
    return {
      level: "standard",
      rules: optionsOrRules,
      replacement: DEFAULT_REPLACEMENT,
      table: HAR_PLACE_TABLE,
    };
  }
  const options = optionsOrRules as RedactHarOptions | undefined;
  return {
    level: resolveLevel(options?.level),
    rules: [...(options?.rules ?? DEFAULT_REDACTION_RULES), ...(options?.extraRules ?? [])],
    replacement: options?.replacement ?? DEFAULT_REPLACEMENT,
    table: options?.placeTable ?? HAR_PLACE_TABLE,
  };
}

export function redactUrl(
  url: string,
  optionsOrRules?: RedactHarOptions | readonly HarRedactionRule[],
): RedactUrlResult {
  const { level, rules, replacement, table } = normalizeOptions(optionsOrRules);
  const ctx = createContext(-1, level, rules, replacement, table);
  const next = redactStructuredUrl(url, ctx, "request-url");
  const harUrl = toHarUrl(next) ?? toHarUrl("https://redacted.invalid/")!;
  const records = ctx.tracker.records(harUrl);
  return {
    url: next,
    touched: records.length > 0 || next !== url,
    records,
  };
}

export function redactHarEntry(
  entry: HarEntry,
  optionsOrRules?: RedactHarOptions | readonly HarRedactionRule[],
  entryIndex = 0,
): RedactHarEntryResult {
  const { level, rules, replacement, table } = normalizeOptions(optionsOrRules);
  const ctx = createContext(entryIndex, level, rules, replacement, table);
  const result = redactEntryWithContext(entry, ctx);
  const places = buildPlacesReport(level, rules, ctx.tracker.placeCounts, table);
  const covered = places
    .filter((place) => place.status !== "kept-not-examined")
    .map((place) => place.place);
  return {
    entry: result.entry,
    url: result.url,
    touched: result.records.length > 0,
    records: result.records,
    covered,
    places,
  };
}

export function redactHar(document: HarDocument, options?: RedactHarOptions): RedactHarResult {
  const { level, rules, replacement, table } = normalizeOptions(options);
  const levelSpec = REDACTION_LEVEL_TABLE[level];
  const allRecords: HarRedactionRecord[] = [];
  const appliedRules = new Set<string>();
  const totalCounts = new Map<HarRedactionPlace, number>();
  let entriesAffected = 0;

  const mergeContext = (ctx: RedactContext, records: readonly HarRedactionRecord[]): void => {
    for (const [place, count] of ctx.tracker.placeCounts.entries()) {
      totalCounts.set(place, (totalCounts.get(place) ?? 0) + count);
    }
    for (const record of records) {
      allRecords.push(record);
      appliedRules.add(record.ruleId);
    }
  };

  const pages = document.log.pages?.map((page) => {
    const ctx = createContext(-1, level, rules, replacement, table);
    const updatedPage = redactPage(page, ctx);
    const pageUrl = toHarUrl(updatedPage.title) ?? toHarUrl("https://redacted.invalid/")!;
    mergeContext(ctx, ctx.tracker.records(pageUrl));
    return updatedPage;
  });

  const entries = document.log.entries.map((entry, index) => {
    const ctx = createContext(index, level, rules, replacement, table);
    const result = redactEntryWithContext(entry, ctx);
    if (result.records.length > 0) {
      entriesAffected += 1;
    }
    mergeContext(ctx, result.records);
    return result.entry;
  });

  const docCtx = createContext(-1, level, rules, replacement, table);
  const logCustom = redactCustomFields(document.log, OWNED_FIELDS.log, docCtx);
  const version = redactProtocolString(document.log.version, "log.version", docCtx);
  const creator = redactCreator(document.log.creator, "creator", docCtx);
  const browser = document.log.browser
    ? redactCreator(document.log.browser, "browser", docCtx)
    : undefined;
  const logComment = redactComment(document.log.comment, "log.comment", docCtx);
  mergeContext(docCtx, docCtx.tracker.records(toHarUrl("https://redacted.invalid/")!));

  const places = buildPlacesReport(level, rules, totalCounts, table);
  const notExamined = places.filter((place) => place.status === "kept-not-examined");
  const totalRemoved = allRecords.reduce((sum, record) => sum + record.count, 0);
  const report: HarLogRedactionExtension = {
    applied: true,
    level: levelSpec.id,
    guarantee: levelSpec.guarantee,
    remainingRisk: levelSpec.remainingRisk,
    totalRemoved,
    entriesAffected,
    rules: [...appliedRules],
    records: allRecords,
    places,
    notExamined,
    notInspected: notExamined.map((place) => place.place),
  };

  const redactedDocument: HarDocument = {
    log: {
      ...logCustom,
      version: version.length > 0 ? version : "1.2",
      creator: {
        ...creator,
        name: creator.name.length > 0 ? creator.name : "redacted",
        version: creator.version.length > 0 ? creator.version : "0",
      },
      ...(browser
        ? {
            browser: {
              ...browser,
              name: browser.name.length > 0 ? browser.name : "redacted",
              version: browser.version.length > 0 ? browser.version : "0",
            },
          }
        : {}),
      ...(pages !== undefined ? { pages } : {}),
      entries,
      ...(logComment !== undefined ? { comment: logComment } : {}),
      _harExport: {
        ...document.log._harExport,
        redaction: report,
      },
    },
  };
  return { document: redactedDocument, report };
}
