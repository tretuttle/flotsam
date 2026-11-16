import type { CustomHarFields, HarUrl } from "./model.ts";

// Spec-owned names are parsed explicitly. Every other key is kept so a round trip
// still has fields the HAR 1.2 spec does not name, such as a cookie sameSite.
const HAR_OWNED_FIELDS = new Set([
  "name",
  "version",
  "comment",
  "browser",
  "pages",
  "entries",
  "id",
  "title",
  "startedDateTime",
  "pageTimings",
  "onContentLoad",
  "onLoad",
  "value",
  "path",
  "domain",
  "expires",
  "httpOnly",
  "secure",
  "fileName",
  "contentType",
  "mimeType",
  "params",
  "text",
  "method",
  "url",
  "httpVersion",
  "cookies",
  "headers",
  "queryString",
  "postData",
  "headersSize",
  "bodySize",
  "status",
  "statusText",
  "content",
  "redirectURL",
  "size",
  "compression",
  "encoding",
  "beforeRequest",
  "afterRequest",
  "lastAccess",
  "lastFetched",
  "eTag",
  "hitCount",
  "fetchCount",
  "blocked",
  "dns",
  "connect",
  "send",
  "wait",
  "receive",
  "ssl",
  "pageref",
  "time",
  "request",
  "response",
  "cache",
  "timings",
  "serverIPAddress",
  "connection",
  "log",
]);

export function pickCustomFields(record: object): CustomHarFields {
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!HAR_OWNED_FIELDS.has(key)) {
      custom[key] = value;
    }
  }
  return custom as CustomHarFields;
}

export function utf8ByteLength(text: string): number {
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

export function safeDecodeQueryComponent(raw: string): string {
  const plusAsSpace = raw.replace(/\+/gu, " ");
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
}

export function extractUrlHost(url: HarUrl): string | null {
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
