import type { CustomHarFields, HarUrl } from "./model.ts";

export function pickCustomFields(record: object): CustomHarFields {
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("_")) {
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
