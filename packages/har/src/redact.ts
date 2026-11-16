import { OWNED_FIELDS, safeDecodeQueryComponent } from "./internal.ts";
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
  type HarEntryExtension,
  type HarLogRedactionExtension,
  type HarModelNumberField,
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
  readonly label: string;
  // Under `standard` a selected place is removed only while a rule of this target is in force, and its
  // label names what those rules select.
  readonly selectedBy?:
    | { readonly target: HarRedactionTarget; readonly byName: boolean }
    | undefined;
  readonly listedNames?: ReadonlySet<string> | undefined;
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

const SECRET_PARAMETER_NAMES = [
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
] as const;

// A header is listed when its value is a credential or a proof bound to one request. `Digest`,
// `Content-Digest` and `Repr-Digest` hold a hash of the body, which proves nothing about the sender,
// so they are not listed.
export const DEFAULT_REDACTION_RULES: readonly HarRedactionRule[] = [
  { id: "header:cookie", target: "header", names: ["cookie"] },
  { id: "header:set-cookie", target: "header", names: ["set-cookie"] },
  { id: "header:authorization", target: "header", names: ["authorization"] },
  { id: "header:proxy-authorization", target: "header", names: ["proxy-authorization"] },
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
  // RFC 9449 DPoP proofs and RFC 9421 HTTP message signatures, each signed for one request.
  { id: "header:request-proof", target: "header", names: ["dpop", "signature"] },
  { id: "cookie:all", target: "cookie", names: [], matchAll: true },
  { id: "query:secrets", target: "query", names: SECRET_PARAMETER_NAMES },
  { id: "body:secrets", target: "body", names: SECRET_PARAMETER_NAMES },
  { id: "url:userinfo", target: "url-userinfo", names: [], matchAll: true },
];

export const HAR_PLACE_TABLE: {
  readonly [P in HarRedactionPlace]: HarPlaceRule & { readonly place: P };
} = {
  "request-url-userinfo": {
    place: "request-url-userinfo",
    standard: "removed",
    shareable: "removed",
    label: "the userinfo part of request URLs and URL page titles",
    selectedBy: { target: "url-userinfo", byName: false },
  },
  "request-url-host": {
    place: "request-url-host",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "the scheme, host and port of request URLs",
  },
  "request-url-path": {
    place: "request-url-path",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "the path of request URLs",
  },
  "request-url-query-secret": {
    place: "request-url-query-secret",
    standard: "removed",
    shareable: "removed",
    label: "values of query parameters in request URLs and URL page titles",
    selectedBy: { target: "query", byName: true },
  },
  "request-url-query": {
    place: "request-url-query",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "query parameter names and every other query value in request URLs",
  },
  "request-url-fragment": {
    place: "request-url-fragment",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "the fragment of request URLs",
  },
  "header-name": {
    place: "header-name",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "header names",
  },
  "header-value-secret": {
    place: "header-value-secret",
    standard: "removed",
    shareable: "removed",
    label: "values of request and response headers",
    selectedBy: { target: "header", byName: true },
  },
  "header-value-allowlisted": {
    place: "header-value-allowlisted",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label: "values of headers",
    listedNames: ALLOWLISTED_HEADER_NAMES,
  },
  "named-header": {
    place: "named-header",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "values of every header not named in another place",
  },
  "url-header": {
    place: "url-header",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "values of headers",
    listedNames: URL_HEADER_NAMES,
  },
  cookie: {
    place: "cookie",
    standard: "removed",
    shareable: "removed",
    label: "cookie values",
    selectedBy: { target: "cookie", byName: false },
  },
  "cookie-metadata": {
    place: "cookie-metadata",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "cookie names, paths, domains and expiry dates",
  },
  "query-string-secret": {
    place: "query-string-secret",
    standard: "removed",
    shareable: "removed",
    label: "values of queryString items",
    selectedBy: { target: "query", byName: true },
  },
  "query-string": {
    place: "query-string",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "queryString item names and every other queryString value",
  },
  "body-param-secret": {
    place: "body-param-secret",
    standard: "removed",
    shareable: "removed",
    label: "values of postData params",
    selectedBy: { target: "body", byName: true },
  },
  "body-param": {
    place: "body-param",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "postData param names, file names, content types and every other param value",
  },
  "body-json": {
    place: "body-json",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "JSON request bodies",
  },
  "body-form": {
    place: "body-form",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "form-encoded request bodies",
  },
  "body-multipart": {
    place: "body-multipart",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "multipart request bodies",
  },
  "request-body-other": {
    place: "request-body-other",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "every other request body",
  },
  "redirect-url": {
    place: "redirect-url",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "redirect URLs",
  },
  "response-body-json": {
    place: "response-body-json",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "JSON response bodies",
  },
  "response-body-base64": {
    place: "response-body-base64",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "base64 response bodies",
  },
  "response-body-other": {
    place: "response-body-other",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "every other response body",
  },
  "page-title": {
    place: "page-title",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "page titles",
  },
  initiator: {
    place: "initiator",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "request initiators and their call stacks",
  },
  websocket: {
    place: "websocket",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "WebSocket messages",
  },
  cache: {
    place: "cache",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "cache entry text fields",
  },
  comment: {
    place: "comment",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "comments",
  },
  "other-custom-field": {
    place: "other-custom-field",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "custom and unknown fields from any tool, server IP addresses and connection ids",
  },
  "protocol-metadata": {
    place: "protocol-metadata",
    standard: "kept-not-examined",
    shareable: "kept-by-allowlist",
    label:
      "the HAR version, creator and browser names and versions, page ids, start times, page references, methods, HTTP versions, status text, MIME types and content encodings",
  },
  "export-annotation": {
    place: "export-annotation",
    standard: "kept-not-examined",
    shareable: "removed",
    label: "body state, body source and missing-body notes written by the export",
  },
  "redaction-record": {
    place: "redaction-record",
    standard: "removed",
    shareable: "removed",
    label: "redaction records from an earlier run, replaced by this run's records",
  },
  "malformed-number": {
    place: "malformed-number",
    standard: "removed",
    shareable: "removed",
    label:
      "values that are not numbers or booleans in fields HAR 1.2 defines as numbers or booleans",
  },
};

export const HAR_MODEL_FIELD_TABLE = {
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
  "log._harExport.redaction": { field: "log._harExport.redaction", places: ["redaction-record"] },
  "log._harExport.<custom>": { field: "log._harExport.<custom>", places: ["other-custom-field"] },
  "entry._harExport.source": { field: "entry._harExport.source", places: ["export-annotation"] },
  "entry._harExport.bodyState": {
    field: "entry._harExport.bodyState",
    places: ["export-annotation"],
  },
  "entry._harExport.bodyMissing": {
    field: "entry._harExport.bodyMissing",
    places: ["export-annotation"],
  },
  "entry._harExport.bodyCheck": {
    field: "entry._harExport.bodyCheck",
    places: ["export-annotation"],
  },
  "entry._harExport.redactedFields": {
    field: "entry._harExport.redactedFields",
    places: ["redaction-record"],
  },
  "entry._harExport.<custom>": {
    field: "entry._harExport.<custom>",
    places: ["other-custom-field"],
  },
  "entry._initiator.<custom>": { field: "entry._initiator.<custom>", places: ["initiator"] },
  "entry._initiator.stack.<custom>": {
    field: "entry._initiator.stack.<custom>",
    places: ["initiator"],
  },
  "entry._initiator.stack.callFrames[].<custom>": {
    field: "entry._initiator.stack.callFrames[].<custom>",
    places: ["initiator"],
  },
  "entry._webSocketMessages[].<custom>": {
    field: "entry._webSocketMessages[].<custom>",
    places: ["websocket"],
  },
} as const satisfies { readonly [F in HarModelStringField]: HarModelFieldRow<F> };

export interface HarModelNumberRow {
  readonly type: "number" | "boolean";
  // What a required field holds once its malformed value is removed; an optional field is deleted.
  readonly whenRemoved?: number | undefined;
}

export const HAR_MODEL_NUMBER_FIELD_TABLE: {
  readonly [F in HarModelNumberField]: HarModelNumberRow;
} = {
  "log.pages[].pageTimings.onContentLoad": { type: "number" },
  "log.pages[].pageTimings.onLoad": { type: "number" },
  "entry.time": { type: "number", whenRemoved: 0 },
  "request.headersSize": { type: "number", whenRemoved: -1 },
  "request.bodySize": { type: "number", whenRemoved: -1 },
  "request.cookies[].httpOnly": { type: "boolean" },
  "request.cookies[].secure": { type: "boolean" },
  "response.status": { type: "number", whenRemoved: 0 },
  "response.headersSize": { type: "number", whenRemoved: -1 },
  "response.bodySize": { type: "number", whenRemoved: -1 },
  "response.cookies[].httpOnly": { type: "boolean" },
  "response.cookies[].secure": { type: "boolean" },
  "response.content.size": { type: "number", whenRemoved: -1 },
  "response.content.compression": { type: "number" },
  "cache.beforeRequest.hitCount": { type: "number" },
  "cache.afterRequest.hitCount": { type: "number" },
  "timings.blocked": { type: "number" },
  "timings.dns": { type: "number" },
  "timings.connect": { type: "number" },
  "timings.send": { type: "number", whenRemoved: 0 },
  "timings.wait": { type: "number", whenRemoved: 0 },
  "timings.receive": { type: "number", whenRemoved: 0 },
  "timings.ssl": { type: "number" },
};

type MappedPlaces =
  | (typeof HAR_MODEL_FIELD_TABLE)[HarModelStringField]["places"][number]
  | "malformed-number";
type UnmappedPlaces = Exclude<HarRedactionPlace, MappedPlaces>;
const _assertEveryPlaceMappedToModelField: UnmappedPlaces extends never ? true : never = true;
void _assertEveryPlaceMappedToModelField;

type PlaceOf<F extends HarModelStringField> = (typeof HAR_MODEL_FIELD_TABLE)[F]["places"][number];
type FieldIn<P extends HarRedactionPlace> = {
  [F in HarModelStringField]: P extends PlaceOf<F> ? F : never;
}[HarModelStringField];

const FIELDS_BY_PLACE: ReadonlyMap<
  HarRedactionPlace,
  readonly (HarModelStringField | HarModelNumberField)[]
> = (() => {
  const map = new Map<HarRedactionPlace, (HarModelStringField | HarModelNumberField)[]>();
  for (const row of Object.values(HAR_MODEL_FIELD_TABLE) as HarModelFieldRow[]) {
    for (const place of row.places) {
      map.set(place, [...(map.get(place) ?? []), row.field]);
    }
  }
  map.set("malformed-number", Object.keys(HAR_MODEL_NUMBER_FIELD_TABLE) as HarModelNumberField[]);
  return map;
})();

const DEFAULT_REPLACEMENT = "[REDACTED]";

function resolveLevel(input: RedactionLevelInput | undefined): RedactionLevel {
  if (input === undefined || input === "standard" || input === "default") {
    return "standard";
  }
  if (input === "shareable" || input === "strict") {
    return "shareable";
  }
  throw new RangeError(`Unknown redaction level: ${String(input)}`);
}

function foldKey(name: string): string {
  return name.replace(/[_-]/gu, "").toLowerCase();
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

function rulesSelecting(
  rule: HarPlaceRule,
  rules: readonly HarRedactionRule[],
): readonly HarRedactionRule[] {
  const selector = rule.selectedBy;
  if (!selector) {
    return [];
  }
  return rules.filter(
    (candidate) =>
      candidate.target === selector.target &&
      (!selector.byName || candidate.matchAll === true || candidate.names.length > 0),
  );
}

function effectivePlaceStatus(
  place: HarRedactionPlace,
  level: RedactionLevel,
  rules: readonly HarRedactionRule[],
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): PlaceExamStatus {
  const row = table[place];
  const configured = row[level];
  if (
    configured === "removed" &&
    level === "standard" &&
    row.selectedBy !== undefined &&
    rulesSelecting(row, rules).length === 0
  ) {
    return "kept-not-examined";
  }
  return configured;
}

function placeLabel(
  place: HarRedactionPlace,
  rules: readonly HarRedactionRule[],
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): string {
  const row = table[place];
  let names: readonly string[] | "any" | undefined = row.listedNames
    ? [...row.listedNames]
    : undefined;
  if (row.selectedBy?.byName === true) {
    const selecting = rulesSelecting(row, rules);
    names = selecting.some((rule) => rule.matchAll === true)
      ? "any"
      : [...new Set(selecting.flatMap((rule) => rule.names.map((name) => name.toLowerCase())))];
  }
  if (names === undefined) {
    return row.label;
  }
  if (names === "any") {
    return `${row.label} with any name`;
  }
  return names.length > 0
    ? `${row.label} named ${names.join(", ")}`
    : `${row.label} named by a rule (no rule is in force)`;
}

interface StatusWording {
  readonly detail: PlaceReportDetail;
  readonly clause: string;
  readonly canStillHold: (label: string) => string;
}

const STATUS_WORDING: Readonly<Record<PlaceExamStatus, StatusWording>> = {
  removed: {
    detail: "removed",
    clause: "Removes",
    canStillHold: (label) => `Nothing. Every value in ${label} is removed.`,
  },
  "kept-by-allowlist": {
    detail: "kept by allowlist",
    clause: "Keeps by allowlist",
    canStillHold: (label) =>
      `Any secret written into ${label} remains: the allowlist keeps it without examining it.`,
  },
  "kept-not-examined": {
    detail: "not examined: may contain secrets",
    clause: "Keeps without examining",
    canStillHold: (label) => `Any secret in ${label} remains: it was not examined.`,
  },
};

const STATUS_ORDER: readonly PlaceExamStatus[] = [
  "removed",
  "kept-by-allowlist",
  "kept-not-examined",
];

export const PLACE_SEPARATOR = "; ";

function describeLevel(places: readonly HarPlaceCoverage[]): {
  readonly guarantee: string;
  readonly remainingRisk: string;
} {
  const phrase = (place: HarPlaceCoverage): string => `${place.label} (${place.fields.join(", ")})`;
  const clauses = STATUS_ORDER.flatMap((status) => {
    const matching = places.filter((place) => place.status === status);
    return matching.length > 0
      ? [`${STATUS_WORDING[status].clause}: ${matching.map(phrase).join(PLACE_SEPARATOR)}.`]
      : [];
  });
  const kept = places.filter((place) => place.status !== "removed");
  return {
    guarantee: [
      ...clauses,
      "Every kept value and the order of keys stay as they were.",
      "Each removal is listed by field path in log._harExport.redaction.records and in _harExport.redactedFields on its entry.",
    ].join(" "),
    remainingRisk:
      kept.length > 0
        ? `Any secret in a kept place remains: ${kept.map((place) => place.label).join(PLACE_SEPARATOR)}.`
        : "No place is kept.",
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
    const label = placeLabel(place, rules, table);
    return {
      place,
      label,
      fields: FIELDS_BY_PLACE.get(place) ?? [],
      status,
      count: counts.get(place) ?? 0,
      detail: STATUS_WORDING[status].detail,
      canStillHold: STATUS_WORDING[status].canStillHold(label),
    };
  });
}

class RedactionTracker {
  readonly #entryIndex: number;
  readonly #removals = new Map<
    string,
    {
      place: HarRedactionPlace;
      field: HarModelStringField | HarModelNumberField;
      ruleId: string;
      count: number;
    }
  >();
  readonly #fields = new Set<HarModelStringField | HarModelNumberField>();
  readonly placeCounts = new Map<HarRedactionPlace, number>();

  constructor(entryIndex: number) {
    this.#entryIndex = entryIndex;
  }

  kept<F extends HarModelStringField>(_field: F, place: PlaceOf<F>, amount = 1): void {
    if (amount > 0) {
      this.placeCounts.set(place, (this.placeCounts.get(place) ?? 0) + amount);
    }
  }

  removed<F extends HarModelStringField | HarModelNumberField>(
    field: F,
    place: F extends HarModelStringField ? PlaceOf<F> : "malformed-number",
    ruleId: string,
    amount = 1,
  ): void {
    if (amount <= 0) {
      return;
    }
    this.placeCounts.set(place, (this.placeCounts.get(place) ?? 0) + amount);
    this.#fields.add(field);
    const key = `${place}\0${field}\0${ruleId}`;
    const prior = this.#removals.get(key);
    if (prior) {
      prior.count += amount;
    } else {
      this.#removals.set(key, { place, field, ruleId, count: amount });
    }
  }

  records(): readonly HarRedactionRecord[] {
    return [...this.#removals.values()].map((item) => ({
      entryIndex: this.#entryIndex,
      place: item.place,
      field: item.field,
      ruleId: item.ruleId,
      count: item.count,
    }));
  }

  get fields(): readonly (HarModelStringField | HarModelNumberField)[] {
    return [...this.#fields];
  }
}

interface RedactContext {
  readonly level: RedactionLevel;
  readonly rules: readonly HarRedactionRule[];
  readonly replacement: string;
  readonly tracker: RedactionTracker;
  isRemoved(place: HarRedactionPlace): boolean;
  levelRule(place: HarRedactionPlace): string;
  emptied(): string;
}

function createContext(
  entryIndex: number,
  level: RedactionLevel,
  rules: readonly HarRedactionRule[],
  replacement: string,
  table: Readonly<Record<HarRedactionPlace, HarPlaceRule>>,
): RedactContext {
  return {
    level,
    rules,
    replacement,
    tracker: new RedactionTracker(entryIndex),
    isRemoved(place) {
      return effectivePlaceStatus(place, level, rules, table) === "removed";
    },
    levelRule(place) {
      return `${level}:${place}`;
    },
    emptied() {
      return level === "shareable" ? "" : replacement;
    },
  };
}

// Rebuilds `source` in its own key order. A key in `changes` takes the new value, or is deleted when
// the new value is undefined. Keys only in `changes` go last.
function rebuild<T extends object>(source: T, changes: Readonly<Record<string, unknown>>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(changes, key)) {
      out[key] = value;
    } else if (changes[key] !== undefined) {
      out[key] = changes[key];
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.hasOwn(source, key) && value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

function countStringsInUnknown(value: unknown): number {
  if (typeof value === "string") {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item) => sum + countStringsInUnknown(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce((sum: number, item) => sum + countStringsInUnknown(item), 0);
  }
  return 0;
}

// A value whose JSON type is not the one HAR 1.2 gives the field is not a value of that field, and
// no other place covers it, so both levels remove it.
function removeMalformedNumbers(
  source: object,
  fields: readonly HarModelNumberField[],
  ctx: RedactContext,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.slice(field.lastIndexOf(".") + 1);
    const value = (source as Record<string, unknown>)[key];
    const row = HAR_MODEL_NUMBER_FIELD_TABLE[field];
    if (value !== undefined && typeof value !== row.type) {
      ctx.tracker.removed(field, "malformed-number", ctx.levelRule("malformed-number"));
      changes[key] = row.whenRemoved;
    }
  }
  return changes;
}

function redactProtocolString(
  value: string,
  field: FieldIn<"protocol-metadata">,
  ctx: RedactContext,
): string {
  if (ctx.isRemoved("protocol-metadata")) {
    ctx.tracker.removed(field, "protocol-metadata", ctx.levelRule("protocol-metadata"));
    return "";
  }
  ctx.tracker.kept(field, "protocol-metadata");
  return value;
}

function redactProtocolIso(
  value: IsoDateTime,
  field: FieldIn<"protocol-metadata">,
  ctx: RedactContext,
): IsoDateTime {
  if (ctx.isRemoved("protocol-metadata")) {
    ctx.tracker.removed(field, "protocol-metadata", ctx.levelRule("protocol-metadata"));
    return toIsoDateTime("1970-01-01T00:00:00.000Z")!;
  }
  ctx.tracker.kept(field, "protocol-metadata");
  return value;
}

function redactProtocolPageId(
  value: PageId,
  field: FieldIn<"protocol-metadata">,
  ctx: RedactContext,
): PageId {
  if (ctx.isRemoved("protocol-metadata")) {
    ctx.tracker.removed(field, "protocol-metadata", ctx.levelRule("protocol-metadata"));
    return toPageId("page_redacted")!;
  }
  ctx.tracker.kept(field, "protocol-metadata");
  return value;
}

function redactComment(
  comment: string | undefined,
  field: FieldIn<"comment">,
  ctx: RedactContext,
): string | undefined {
  if (comment === undefined) {
    return undefined;
  }
  if (ctx.isRemoved("comment")) {
    ctx.tracker.removed(field, "comment", ctx.levelRule("comment"));
    return undefined;
  }
  ctx.tracker.kept(field, "comment");
  return comment;
}

function redactCustomFields(
  source: object,
  owned: ReadonlySet<string>,
  field: FieldIn<"other-custom-field">,
  ctx: RedactContext,
  extraOwned?: ReadonlySet<string>,
): Record<string, undefined> {
  const keys = Object.keys(source).filter(
    (key) => !owned.has(key) && !(extraOwned?.has(key) ?? false),
  );
  const amount = keys.reduce(
    (sum, key) => sum + countStringsInUnknown((source as Record<string, unknown>)[key]),
    0,
  );
  if (!ctx.isRemoved("other-custom-field")) {
    ctx.tracker.kept(field, "other-custom-field", amount);
    return {};
  }
  ctx.tracker.removed(field, "other-custom-field", ctx.levelRule("other-custom-field"), amount);
  return Object.fromEntries(keys.map((key) => [key, undefined]));
}

function redactDeclaredCustomField(
  value: unknown,
  field: FieldIn<"other-custom-field">,
  ctx: RedactContext,
): unknown {
  const amount = countStringsInUnknown(value);
  if (ctx.isRemoved("other-custom-field")) {
    ctx.tracker.removed(field, "other-custom-field", ctx.levelRule("other-custom-field"), amount);
    return undefined;
  }
  ctx.tracker.kept(field, "other-custom-field", amount);
  return value;
}

function redactStructuredUrl(
  raw: string,
  ctx: RedactContext,
  field: "request.url" | "log.pages[].title",
): string {
  const isPage = field === "log.pages[].title";
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
      if (ctx.isRemoved("request-url-userinfo")) {
        const rule = findMatchingRule(ctx.rules, "url-userinfo", "userinfo");
        ctx.tracker.removed(
          field,
          "request-url-userinfo",
          rule?.id ?? ctx.levelRule("request-url-userinfo"),
        );
        nextUserinfoPrefix = ctx.level === "shareable" ? "" : `${encodedReplacement}@`;
      } else {
        ctx.tracker.kept(field, "request-url-userinfo");
        nextUserinfoPrefix = `${userinfo}@`;
      }
    }

    if (!isPage) {
      if (ctx.isRemoved("request-url-host")) {
        ctx.tracker.removed("request.url", "request-url-host", ctx.levelRule("request-url-host"));
        hostPort = "redacted.invalid";
      } else if (hostPort.length > 0) {
        ctx.tracker.kept("request.url", "request-url-host");
      }
    }

    let nextPath = pathPart;
    if (!isPage && pathPart.length > 0) {
      if (ctx.isRemoved("request-url-path")) {
        ctx.tracker.removed("request.url", "request-url-path", ctx.levelRule("request-url-path"));
        nextPath = "/";
      } else {
        ctx.tracker.kept("request.url", "request-url-path");
      }
    }

    head = `${schemePrefix}${nextUserinfoPrefix}${hostPort}${nextPath}`;
  }

  let nextQuery: string | null = null;
  if (query !== null) {
    const otherQueryRemoved = !isPage && ctx.isRemoved("request-url-query");
    const keptSegments: string[] = [];
    for (const segment of query.split("&")) {
      const eqIndex = segment.indexOf("=");
      const rawName = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
      const secretRule =
        segment.length > 0
          ? findMatchingRule(ctx.rules, "query", safeDecodeQueryComponent(rawName))
          : undefined;
      if (secretRule) {
        if (ctx.isRemoved("request-url-query-secret")) {
          ctx.tracker.removed(field, "request-url-query-secret", secretRule.id);
          if (!otherQueryRemoved) {
            keptSegments.push(`${rawName}=${encodedReplacement}`);
          }
        } else {
          ctx.tracker.kept(field, "request-url-query-secret");
          keptSegments.push(segment);
        }
      } else if (otherQueryRemoved) {
        if (segment.length > 0) {
          ctx.tracker.removed(
            "request.url",
            "request-url-query",
            ctx.levelRule("request-url-query"),
          );
        }
      } else {
        if (!isPage && segment.length > 0) {
          ctx.tracker.kept("request.url", "request-url-query");
        }
        keptSegments.push(segment);
      }
    }
    nextQuery = otherQueryRemoved && keptSegments.length === 0 ? null : keptSegments.join("&");
  }

  let nextFragment: string | null = fragment;
  if (fragment !== null && !isPage) {
    if (ctx.isRemoved("request-url-fragment")) {
      if (fragment.length > 0) {
        ctx.tracker.removed(
          "request.url",
          "request-url-fragment",
          ctx.levelRule("request-url-fragment"),
        );
      }
      nextFragment = null;
    } else if (fragment.length > 0) {
      ctx.tracker.kept("request.url", "request-url-fragment");
    }
  }

  const queryPart = nextQuery !== null ? `?${nextQuery}` : "";
  const fragmentPart = nextFragment !== null ? `#${nextFragment}` : "";
  return `${head}${queryPart}${fragmentPart}`;
}

function redactPageTitle(title: string, ctx: RedactContext): string {
  const afterUrl = redactStructuredUrl(title, ctx, "log.pages[].title");
  if (ctx.isRemoved("page-title")) {
    if (title.length > 0) {
      ctx.tracker.removed("log.pages[].title", "page-title", ctx.levelRule("page-title"));
    }
    return "";
  }
  if (afterUrl.length > 0) {
    ctx.tracker.kept("log.pages[].title", "page-title");
  }
  return afterUrl;
}

type HeaderValuePlace = PlaceOf<"request.headers[].value">;

function classifyHeaderValuePlace(
  headerName: string,
  rules: readonly HarRedactionRule[],
): { readonly place: HeaderValuePlace; readonly rule?: HarRedactionRule | undefined } {
  // Some proxies keep the colon or stray spaces in a header name; the rule still applies.
  const rule = findMatchingRule(rules, "header", headerName.trim().replace(/\s*:$/u, ""));
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

type Side = "request" | "response";

function redactHeaders(
  headers: readonly HarNameValue[],
  side: Side,
  ctx: RedactContext,
): readonly HarNameValue[] {
  return headers.map((header) => {
    const changes: Record<string, unknown> = {
      ...redactCustomFields(header, OWNED_FIELDS.nameValue, `${side}.headers[].<custom>`, ctx),
      comment: redactComment(header.comment, `${side}.headers[].comment`, ctx),
    };

    if (ctx.isRemoved("header-name")) {
      ctx.tracker.removed(`${side}.headers[].name`, "header-name", ctx.levelRule("header-name"));
      changes.name = "";
    } else {
      ctx.tracker.kept(`${side}.headers[].name`, "header-name");
    }

    const { place, rule } = classifyHeaderValuePlace(header.name, ctx.rules);
    if (ctx.isRemoved(place)) {
      ctx.tracker.removed(`${side}.headers[].value`, place, rule?.id ?? ctx.levelRule(place));
      changes.value = ctx.emptied();
    } else {
      ctx.tracker.kept(`${side}.headers[].value`, place);
    }
    return rebuild(header, changes);
  });
}

const COOKIE_METADATA_KEYS = ["name", "path", "domain", "expires"] as const;

function redactCookies(
  cookies: readonly HarCookie[],
  side: Side,
  ctx: RedactContext,
): readonly HarCookie[] {
  const metaRemoved = ctx.isRemoved("cookie-metadata");
  const valueRemoved = ctx.isRemoved("cookie");
  const result: HarCookie[] = [];

  for (const cookie of cookies) {
    const changes: Record<string, unknown> = {
      ...removeMalformedNumbers(
        cookie,
        [`${side}.cookies[].httpOnly`, `${side}.cookies[].secure`],
        ctx,
      ),
      ...redactCustomFields(cookie, OWNED_FIELDS.cookie, `${side}.cookies[].<custom>`, ctx),
      comment: redactComment(cookie.comment, `${side}.cookies[].comment`, ctx),
    };

    for (const key of COOKIE_METADATA_KEYS) {
      if (typeof cookie[key] !== "string") {
        continue;
      }
      if (metaRemoved) {
        ctx.tracker.removed(
          `${side}.cookies[].${key}`,
          "cookie-metadata",
          ctx.levelRule("cookie-metadata"),
        );
        changes[key] = key === "name" ? "" : undefined;
      } else {
        ctx.tracker.kept(`${side}.cookies[].${key}`, "cookie-metadata");
      }
    }

    if (valueRemoved) {
      const rule = findMatchingRule(ctx.rules, "cookie", cookie.name);
      ctx.tracker.removed(`${side}.cookies[].value`, "cookie", rule?.id ?? ctx.levelRule("cookie"));
      changes.value = ctx.emptied();
    } else {
      ctx.tracker.kept(`${side}.cookies[].value`, "cookie");
    }

    const next = rebuild(cookie, changes);
    if (metaRemoved && valueRemoved && keepsOnly(next, OWNED_FIELDS.cookie, ["name", "value"])) {
      continue;
    }
    result.push(next);
  }
  return result;
}

// True when every key left on `item` is one of `emptiedKeys` or a non-string field the spec owns, so
// the item no longer carries anything worth keeping.
function keepsOnly(
  item: object,
  owned: ReadonlySet<string>,
  emptiedKeys: readonly string[],
): boolean {
  return Object.entries(item).every(
    ([key, value]) =>
      emptiedKeys.includes(key) ||
      (owned.has(key) && key !== "comment" && typeof value !== "string"),
  );
}

function redactQueryString(
  queryString: readonly HarNameValue[],
  ctx: RedactContext,
): readonly HarNameValue[] {
  const nameRemoved = ctx.isRemoved("query-string");
  const result: HarNameValue[] = [];

  for (const item of queryString) {
    const changes: Record<string, unknown> = {
      ...redactCustomFields(item, OWNED_FIELDS.nameValue, "request.queryString[].<custom>", ctx),
      comment: redactComment(item.comment, "request.queryString[].comment", ctx),
    };

    if (nameRemoved) {
      ctx.tracker.removed(
        "request.queryString[].name",
        "query-string",
        ctx.levelRule("query-string"),
      );
      changes.name = "";
    } else {
      ctx.tracker.kept("request.queryString[].name", "query-string");
    }

    const rule = findMatchingRule(ctx.rules, "query", item.name);
    const valuePlace = rule ? "query-string-secret" : "query-string";
    const valueRemoved = ctx.isRemoved(valuePlace);
    if (valueRemoved) {
      ctx.tracker.removed(
        "request.queryString[].value",
        valuePlace,
        rule?.id ?? ctx.levelRule(valuePlace),
      );
      changes.value = ctx.emptied();
    } else {
      ctx.tracker.kept("request.queryString[].value", valuePlace);
    }

    const next = rebuild(item, changes);
    if (nameRemoved && valueRemoved && keepsOnly(next, OWNED_FIELDS.nameValue, ["name", "value"])) {
      continue;
    }
    result.push(next);
  }
  return result;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function classifyRequestBodyPlace(
  mimeType: string,
  text: string,
): PlaceOf<"request.postData.text"> {
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
): PlaceOf<"response.content.text"> {
  if (encoding?.toLowerCase() === "base64") {
    return "response-body-base64";
  }
  const mime = mimeType.toLowerCase();
  if (mime.includes("json") || looksLikeJson(text)) {
    return "response-body-json";
  }
  return "response-body-other";
}

const PARAM_METADATA_KEYS = ["name", "fileName", "contentType"] as const;

function redactParams(
  params: readonly HarPostDataParam[],
  ctx: RedactContext,
): readonly HarPostDataParam[] {
  const metaRemoved = ctx.isRemoved("body-param");
  const result: HarPostDataParam[] = [];

  for (const param of params) {
    const changes: Record<string, unknown> = {
      ...redactCustomFields(
        param,
        OWNED_FIELDS.postParam,
        "request.postData.params[].<custom>",
        ctx,
      ),
      comment: redactComment(param.comment, "request.postData.params[].comment", ctx),
    };

    for (const key of PARAM_METADATA_KEYS) {
      if (typeof param[key] !== "string") {
        continue;
      }
      if (metaRemoved) {
        ctx.tracker.removed(
          `request.postData.params[].${key}`,
          "body-param",
          ctx.levelRule("body-param"),
        );
        changes[key] = key === "name" ? "" : undefined;
      } else {
        ctx.tracker.kept(`request.postData.params[].${key}`, "body-param");
      }
    }

    const rule = findBodyRule(ctx.rules, param.name);
    const valuePlace = rule ? "body-param-secret" : "body-param";
    let valueRemoved = param.value === undefined;
    if (param.value !== undefined) {
      if (ctx.isRemoved(valuePlace)) {
        ctx.tracker.removed(
          "request.postData.params[].value",
          valuePlace,
          rule?.id ?? ctx.levelRule(valuePlace),
        );
        changes.value = ctx.emptied();
        valueRemoved = true;
      } else {
        ctx.tracker.kept("request.postData.params[].value", valuePlace);
      }
    }

    const next = rebuild(param, changes);
    if (metaRemoved && valueRemoved && keepsOnly(next, OWNED_FIELDS.postParam, ["name", "value"])) {
      continue;
    }
    result.push(next);
  }
  return result;
}

function redactPostData(
  postData: HarPostData | undefined,
  ctx: RedactContext,
): HarPostData | undefined {
  if (!postData) {
    return undefined;
  }
  const changes: Record<string, unknown> = {
    ...redactCustomFields(postData, OWNED_FIELDS.postData, "request.postData.<custom>", ctx),
    comment: redactComment(postData.comment, "request.postData.comment", ctx),
    mimeType: redactProtocolString(postData.mimeType, "request.postData.mimeType", ctx),
    params: redactParams(postData.params, ctx),
  };

  const text = postData.text;
  if (typeof text === "string" && text.length > 0) {
    const bodyPlace = classifyRequestBodyPlace(postData.mimeType, text);
    if (ctx.isRemoved(bodyPlace)) {
      ctx.tracker.removed("request.postData.text", bodyPlace, ctx.levelRule(bodyPlace));
      changes.text = "";
    } else {
      ctx.tracker.kept("request.postData.text", bodyPlace);
    }
  }
  return rebuild(postData, changes);
}

function redactContent(content: HarContent, ctx: RedactContext): HarContent {
  const changes: Record<string, unknown> = {
    ...removeMalformedNumbers(
      content,
      ["response.content.size", "response.content.compression"],
      ctx,
    ),
    ...redactCustomFields(content, OWNED_FIELDS.content, "response.content.<custom>", ctx),
    comment: redactComment(content.comment, "response.content.comment", ctx),
    mimeType: redactProtocolString(content.mimeType, "response.content.mimeType", ctx),
  };
  if (typeof content.encoding === "string") {
    changes.encoding = redactProtocolString(content.encoding, "response.content.encoding", ctx);
  }

  const text = content.text;
  if (typeof text === "string" && text.length > 0) {
    const bodyPlace = classifyResponseBodyPlace(content.mimeType, content.encoding, text);
    if (ctx.isRemoved(bodyPlace)) {
      ctx.tracker.removed("response.content.text", bodyPlace, ctx.levelRule(bodyPlace));
      changes.text = undefined;
    } else {
      ctx.tracker.kept("response.content.text", bodyPlace);
    }
  }
  return rebuild(content, changes);
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
  ...CACHE_ENTRY_STRING_KEYS,
]);

function redactCacheEntry(
  entry: HarCacheEntry | null | undefined,
  slot: "beforeRequest" | "afterRequest",
  ctx: RedactContext,
): HarCacheEntry | null | undefined {
  if (entry === undefined || entry === null) {
    return entry;
  }
  const changes: Record<string, unknown> = {
    ...removeMalformedNumbers(entry, [`cache.${slot}.hitCount`], ctx),
    ...redactCustomFields(entry, CACHE_ENTRY_ALL_OWNED, `cache.${slot}.<custom>`, ctx),
    comment: redactComment(entry.comment, `cache.${slot}.comment`, ctx),
  };
  for (const key of CACHE_ENTRY_STRING_KEYS) {
    if (typeof entry[key] !== "string") {
      continue;
    }
    if (ctx.isRemoved("cache")) {
      ctx.tracker.removed(`cache.${slot}.${key}`, "cache", ctx.levelRule("cache"));
      changes[key] = undefined;
    } else {
      ctx.tracker.kept(`cache.${slot}.${key}`, "cache");
    }
  }
  return rebuild(entry, changes);
}

function redactCache(cache: HarCache, ctx: RedactContext): HarCache {
  return rebuild(cache, {
    ...redactCustomFields(cache, OWNED_FIELDS.cache, "cache.<custom>", ctx),
    comment: redactComment(cache.comment, "cache.comment", ctx),
    beforeRequest: redactCacheEntry(cache.beforeRequest, "beforeRequest", ctx),
    afterRequest: redactCacheEntry(cache.afterRequest, "afterRequest", ctx),
  });
}

const TIMING_FIELDS: readonly HarModelNumberField[] = [
  "timings.blocked",
  "timings.dns",
  "timings.connect",
  "timings.send",
  "timings.wait",
  "timings.receive",
  "timings.ssl",
];

function redactTimings(timings: HarTimings, ctx: RedactContext): HarTimings {
  return rebuild(timings, {
    ...removeMalformedNumbers(timings, TIMING_FIELDS, ctx),
    ...redactCustomFields(timings, OWNED_FIELDS.timings, "timings.<custom>", ctx),
    comment: redactComment(timings.comment, "timings.comment", ctx),
  });
}

function countOwnStrings<F extends HarModelStringField>(
  source: unknown,
  ownFields: Readonly<Record<string, F>>,
  customField: F,
  skip: ReadonlySet<string>,
  counts: Map<F, number>,
): void {
  const add = (field: F, amount: number): void => {
    if (amount > 0) {
      counts.set(field, (counts.get(field) ?? 0) + amount);
    }
  };
  if (typeof source !== "object" || source === null) {
    add(customField, countStringsInUnknown(source));
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    const own = ownFields[key];
    if (own !== undefined) {
      add(own, typeof value === "string" ? 1 : 0);
    } else if (!skip.has(key)) {
      add(customField, countStringsInUnknown(value));
    }
  }
}

function countInitiatorStack(stack: unknown, counts: Map<FieldIn<"initiator">, number>): void {
  if (stack === undefined) {
    return;
  }
  countOwnStrings(
    stack,
    {},
    "entry._initiator.stack.<custom>",
    OWNED_FIELDS.initiatorStack,
    counts,
  );
  if (typeof stack !== "object" || stack === null) {
    return;
  }
  const { callFrames, parent } = stack as Partial<ChromeInitiatorStack>;
  for (const frame of Array.isArray(callFrames) ? callFrames : []) {
    countOwnStrings(
      frame,
      {
        functionName: "entry._initiator.stack.callFrames[].functionName",
        scriptId: "entry._initiator.stack.callFrames[].scriptId",
        url: "entry._initiator.stack.callFrames[].url",
      },
      "entry._initiator.stack.callFrames[].<custom>",
      OWNED_FIELDS.initiatorFrame,
      counts,
    );
  }
  countInitiatorStack(parent, counts);
}

function redactInitiator(
  initiator: ChromeInitiator | undefined,
  ctx: RedactContext,
): ChromeInitiator | undefined {
  if (initiator === undefined) {
    return undefined;
  }
  const counts = new Map<FieldIn<"initiator">, number>();
  countOwnStrings(
    initiator,
    {
      type: "entry._initiator.type",
      url: "entry._initiator.url",
      requestId: "entry._initiator.requestId",
    },
    "entry._initiator.<custom>",
    OWNED_FIELDS.initiator,
    counts,
  );
  countInitiatorStack((initiator as Partial<ChromeInitiator>).stack, counts);
  const removed = ctx.isRemoved("initiator");
  for (const [field, amount] of counts) {
    if (removed) {
      ctx.tracker.removed(field, "initiator", ctx.levelRule("initiator"), amount);
    } else {
      ctx.tracker.kept(field, "initiator", amount);
    }
  }
  return removed ? undefined : initiator;
}

function redactWebSocketMessages(
  messages: readonly ChromeWebSocketMessage[] | undefined,
  ctx: RedactContext,
): readonly ChromeWebSocketMessage[] | undefined {
  if (messages === undefined) {
    return undefined;
  }
  const counts = new Map<FieldIn<"websocket">, number>();
  for (const message of Array.isArray(messages) ? messages : [messages]) {
    countOwnStrings(
      message,
      { type: "entry._webSocketMessages[].type", data: "entry._webSocketMessages[].data" },
      "entry._webSocketMessages[].<custom>",
      OWNED_FIELDS.webSocketMessage,
      counts,
    );
  }
  const removed = ctx.isRemoved("websocket");
  for (const [field, amount] of counts) {
    if (removed) {
      ctx.tracker.removed(field, "websocket", ctx.levelRule("websocket"), amount);
    } else {
      ctx.tracker.kept(field, "websocket", amount);
    }
  }
  return removed ? undefined : messages;
}

const EXPORT_ANNOTATION_KEYS = ["source", "bodyState", "bodyMissing", "bodyCheck"] as const;

function redactEntryExport(
  extension: HarEntryExtension | undefined,
  ctx: RedactContext,
): Record<string, unknown> {
  if (typeof extension !== "object" || extension === null) {
    return {};
  }
  const changes: Record<string, unknown> = {
    ...redactCustomFields(extension, OWNED_FIELDS.entryExport, "entry._harExport.<custom>", ctx),
  };
  for (const key of EXPORT_ANNOTATION_KEYS) {
    if (typeof extension[key] !== "string") {
      continue;
    }
    if (ctx.isRemoved("export-annotation")) {
      ctx.tracker.removed(
        `entry._harExport.${key}`,
        "export-annotation",
        ctx.levelRule("export-annotation"),
      );
      changes[key] = undefined;
    } else {
      ctx.tracker.kept(`entry._harExport.${key}`, "export-annotation");
    }
  }
  if (extension.redactedFields !== undefined) {
    ctx.tracker.removed(
      "entry._harExport.redactedFields",
      "redaction-record",
      ctx.levelRule("redaction-record"),
      Math.max(1, countStringsInUnknown(extension.redactedFields)),
    );
    changes.redactedFields = undefined;
  }
  return changes;
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

const ENTRY_CUSTOM_STRING_FIELDS = [
  ["serverIPAddress", "entry.serverIPAddress"],
  ["connection", "entry.connection"],
  ["_securityState", "entry._securityState"],
  ["_priority", "entry._priority"],
  ["_resourceType", "entry._resourceType"],
  ["_fromCache", "entry._fromCache"],
  ["_connectionId", "entry._connectionId"],
] as const;

const RESPONSE_DECLARED_CUSTOM = new Set<string>(["_error"]);

function redactRequest(entry: HarEntry, ctx: RedactContext): HarEntry["request"] {
  const request = entry.request;
  const url = redactStructuredUrl(request.url, ctx, "request.url");
  return rebuild(request, {
    ...removeMalformedNumbers(request, ["request.headersSize", "request.bodySize"], ctx),
    ...redactCustomFields(request, OWNED_FIELDS.request, "request.<custom>", ctx),
    method: redactProtocolString(request.method, "request.method", ctx),
    url: toHarUrl(url) ?? request.url,
    httpVersion: redactProtocolString(request.httpVersion, "request.httpVersion", ctx),
    cookies: redactCookies(request.cookies, "request", ctx),
    headers: redactHeaders(request.headers, "request", ctx),
    queryString: redactQueryString(request.queryString, ctx),
    postData: redactPostData(request.postData, ctx),
    comment: redactComment(request.comment, "request.comment", ctx),
  });
}

function redactResponse(entry: HarEntry, ctx: RedactContext): HarEntry["response"] {
  const response = entry.response;
  const changes: Record<string, unknown> = {
    ...removeMalformedNumbers(
      response,
      ["response.status", "response.headersSize", "response.bodySize"],
      ctx,
    ),
    ...redactCustomFields(
      response,
      OWNED_FIELDS.response,
      "response.<custom>",
      ctx,
      RESPONSE_DECLARED_CUSTOM,
    ),
    statusText: redactProtocolString(response.statusText, "response.statusText", ctx),
    httpVersion: redactProtocolString(response.httpVersion, "response.httpVersion", ctx),
    cookies: redactCookies(response.cookies, "response", ctx),
    headers: redactHeaders(response.headers, "response", ctx),
    content: redactContent(response.content, ctx),
    comment: redactComment(response.comment, "response.comment", ctx),
  };
  if (response.redirectURL.length > 0) {
    if (ctx.isRemoved("redirect-url")) {
      ctx.tracker.removed("response.redirectURL", "redirect-url", ctx.levelRule("redirect-url"));
      changes.redirectURL = "";
    } else {
      ctx.tracker.kept("response.redirectURL", "redirect-url");
    }
  }
  if (response._error !== undefined) {
    changes._error = redactDeclaredCustomField(response._error, "response._error", ctx);
  }
  return rebuild(response, changes);
}

function redactEntryWithContext(
  entry: HarEntry,
  ctx: RedactContext,
): { readonly entry: HarEntry; readonly records: readonly HarRedactionRecord[] } {
  const exportChanges = redactEntryExport(entry._harExport, ctx);
  const changes: Record<string, unknown> = {
    ...removeMalformedNumbers(entry, ["entry.time"], ctx),
    ...redactCustomFields(entry, OWNED_FIELDS.entry, "entry.<custom>", ctx, ENTRY_DECLARED_CUSTOM),
    pageref:
      entry.pageref !== undefined
        ? redactProtocolPageId(entry.pageref, "entry.pageref", ctx)
        : undefined,
    startedDateTime: redactProtocolIso(entry.startedDateTime, "entry.startedDateTime", ctx),
    request: redactRequest(entry, ctx),
    response: redactResponse(entry, ctx),
    cache: redactCache(entry.cache, ctx),
    timings: redactTimings(entry.timings, ctx),
    comment: redactComment(entry.comment, "entry.comment", ctx),
    _initiator: redactInitiator(entry._initiator, ctx),
    _webSocketMessages: redactWebSocketMessages(entry._webSocketMessages, ctx),
  };
  for (const [key, field] of ENTRY_CUSTOM_STRING_FIELDS) {
    if (entry[key] !== undefined) {
      changes[key] = redactDeclaredCustomField(entry[key], field, ctx);
    }
  }

  const removedFields = ctx.tracker.fields;
  if (entry._harExport !== undefined || removedFields.length > 0) {
    changes._harExport = rebuild(entry._harExport ?? {}, {
      ...exportChanges,
      ...(removedFields.length > 0 ? { redactedFields: removedFields } : {}),
    });
  }
  return { entry: rebuild(entry, changes), records: ctx.tracker.records() };
}

function redactCreator(
  creator: HarCreator,
  prefix: "log.creator" | "log.browser",
  ctx: RedactContext,
): HarCreator {
  const removed = ctx.isRemoved("protocol-metadata");
  const name = redactProtocolString(creator.name, `${prefix}.name`, ctx);
  const version = redactProtocolString(creator.version, `${prefix}.version`, ctx);
  return rebuild(creator, {
    ...redactCustomFields(creator, OWNED_FIELDS.creator, `${prefix}.<custom>`, ctx),
    name: removed ? "redacted" : name,
    version: removed ? "0" : version,
    comment: redactComment(creator.comment, `${prefix}.comment`, ctx),
  });
}

function redactPage(page: HarPage, ctx: RedactContext): HarPage {
  return rebuild(page, {
    ...redactCustomFields(page, OWNED_FIELDS.page, "log.pages[].<custom>", ctx),
    startedDateTime: redactProtocolIso(page.startedDateTime, "log.pages[].startedDateTime", ctx),
    id: redactProtocolPageId(page.id, "log.pages[].id", ctx),
    title: redactPageTitle(page.title, ctx),
    pageTimings: rebuild(page.pageTimings, {
      ...removeMalformedNumbers(
        page.pageTimings,
        ["log.pages[].pageTimings.onContentLoad", "log.pages[].pageTimings.onLoad"],
        ctx,
      ),
      ...redactCustomFields(
        page.pageTimings,
        OWNED_FIELDS.pageTimings,
        "log.pages[].pageTimings.<custom>",
        ctx,
      ),
      comment: redactComment(page.pageTimings.comment, "log.pages[].pageTimings.comment", ctx),
    }),
    comment: redactComment(page.comment, "log.pages[].comment", ctx),
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
  const next = redactStructuredUrl(url, ctx, "request.url");
  const records = ctx.tracker.records();
  return { url: next, touched: records.length > 0 || next !== url, records };
}

export function redactHarEntry(
  entry: HarEntry,
  optionsOrRules: RedactHarOptions | readonly HarRedactionRule[] | undefined,
  entryIndex: number,
): RedactHarEntryResult {
  const { level, rules, replacement, table } = normalizeOptions(optionsOrRules);
  const ctx = createContext(entryIndex, level, rules, replacement, table);
  const result = redactEntryWithContext(entry, ctx);
  const places = buildPlacesReport(level, rules, ctx.tracker.placeCounts, table);
  return {
    entry: result.entry,
    url: result.entry.request.url,
    touched: result.records.length > 0,
    records: result.records,
    covered: places
      .filter((place) => place.status !== "kept-not-examined")
      .map((place) => place.place),
    places,
  };
}

export function redactHar(document: HarDocument, options?: RedactHarOptions): RedactHarResult {
  const { level, rules, replacement, table } = normalizeOptions(options);
  const allRecords: HarRedactionRecord[] = [];
  const totalCounts = new Map<HarRedactionPlace, number>();
  let entriesAffected = 0;

  const merge = (ctx: RedactContext): void => {
    for (const [place, count] of ctx.tracker.placeCounts) {
      totalCounts.set(place, (totalCounts.get(place) ?? 0) + count);
    }
    allRecords.push(...ctx.tracker.records());
  };

  const pages = document.log.pages?.map((page) => {
    const ctx = createContext(-1, level, rules, replacement, table);
    const updated = redactPage(page, ctx);
    merge(ctx);
    return updated;
  });

  const entries = document.log.entries.map((entry, index) => {
    const ctx = createContext(index, level, rules, replacement, table);
    const result = redactEntryWithContext(entry, ctx);
    if (result.records.length > 0) {
      entriesAffected += 1;
    }
    merge(ctx);
    return result.entry;
  });

  const logCtx = createContext(-1, level, rules, replacement, table);
  const log = document.log;
  const exportCustom =
    log._harExport !== undefined
      ? redactCustomFields(
          log._harExport,
          OWNED_FIELDS.logExport,
          "log._harExport.<custom>",
          logCtx,
        )
      : {};
  if (log._harExport?.redaction !== undefined) {
    logCtx.tracker.removed(
      "log._harExport.redaction",
      "redaction-record",
      logCtx.levelRule("redaction-record"),
    );
  }
  const version = redactProtocolString(log.version, "log.version", logCtx);
  const logChanges: Record<string, unknown> = {
    ...redactCustomFields(log, OWNED_FIELDS.log, "log.<custom>", logCtx, new Set(["_harExport"])),
    version: logCtx.isRemoved("protocol-metadata") ? "1.2" : version,
    creator: redactCreator(log.creator, "log.creator", logCtx),
    browser: log.browser ? redactCreator(log.browser, "log.browser", logCtx) : undefined,
    pages,
    entries,
    comment: redactComment(log.comment, "log.comment", logCtx),
  };
  merge(logCtx);

  const places = buildPlacesReport(level, rules, totalCounts, table);
  const notExamined = places.filter((place) => place.status === "kept-not-examined");
  const report: HarLogRedactionExtension = {
    applied: true,
    level,
    ...describeLevel(places),
    totalRemoved: allRecords.reduce((sum, record) => sum + record.count, 0),
    entriesAffected,
    rules: [...new Set(allRecords.map((record) => record.ruleId))],
    records: allRecords,
    places,
    notExamined,
    notInspected: notExamined.map((place) => place.place),
  };
  logChanges._harExport = rebuild(log._harExport ?? {}, { ...exportCustom, redaction: report });

  return { document: { log: rebuild(log, logChanges) }, report };
}
