// Writes one entry as JSON in three parts, so a body never becomes one string and every field that depends on the
// body is written after the body (argon 11).

import type { HarEntry, HarEntryExtension } from "@one-click-har/har/model";
import type { BodyCheck } from "@one-click-har/recording/exchange";
import { utf8ByteLength } from "./internal.ts";
import { MISSING_REASONS, type MissingReason } from "./missing.ts";

export type TextMode = "utf8-text" | "base64";

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const TEXTUAL_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
]);
const CONTENT_OWNED = new Set(["size", "compression", "mimeType", "text", "encoding", "comment"]);

function extractCharset(mimeType: string | null): string | null {
  if (mimeType === null) return null;
  const match = /;\s*charset\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/iu.exec(mimeType);
  if (!match?.[1]) return null;
  return match[1].replace(/^["']|["']$/gu, "");
}

function isUtf8OrAbsent(charset: string | null): boolean {
  if (charset === null) return true;
  const norm = charset
    .trim()
    .replace(/^["']|["']$/gu, "")
    .toLowerCase();
  return norm === "" || norm === "utf-8" || norm === "utf8";
}

function isTextualMime(mimeType: string | null): boolean {
  if (mimeType === null) return false;
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "") return false;
  return (
    base.startsWith("text/") ||
    TEXTUAL_MIME_TYPES.has(base) ||
    base.endsWith("+json") ||
    base.endsWith("+xml") ||
    base.includes("svg")
  );
}

/** Text for textual MIME types (text/*, json, xml, javascript, svg) with a UTF-8 or absent charset; base64 otherwise. */
export function textModeFor(mimeType: string | null, charset: string | null): TextMode {
  const effectiveCharset = charset ?? extractCharset(mimeType);
  if (!isUtf8OrAbsent(effectiveCharset)) return "base64";
  return isTextualMime(mimeType) ? "utf8-text" : "base64";
}

export interface EncoderState {
  readonly mode: TextMode;
  /** Base64: up to 2 bytes waiting for a 3-byte group. Text: an incomplete UTF-8 sequence. */
  readonly carry: Uint8Array;
  /** Decoded bytes consumed so far. The tail's content.size. */
  readonly bytes: number;
  /** Replaced invalid UTF-8 sequences. Reported as `_harExport.lossyText` when non-zero. */
  readonly replaced: number;
}

export function startEncoder(mode: TextMode): EncoderState {
  return { mode, carry: new Uint8Array(0), bytes: 0, replaced: 0 };
}

function encodeBase64Triplet(a: number, b: number, c: number): string {
  const n = (a << 16) | (b << 8) | c;
  return (
    BASE64_CHARS[(n >> 18) & 63]! +
    BASE64_CHARS[(n >> 12) & 63]! +
    BASE64_CHARS[(n >> 6) & 63]! +
    BASE64_CHARS[n & 63]!
  );
}

function encodeBase64Chunk(
  state: EncoderState,
  bytes: Uint8Array,
): { readonly json: string; readonly state: EncoderState } {
  const carry = state.carry;
  const total = carry.length + bytes.length;
  const full = Math.floor(total / 3) * 3;
  const byteAt = (index: number): number =>
    index < carry.length ? carry[index]! : bytes[index - carry.length]!;
  let json = "";
  for (let i = 0; i < full; i += 3) {
    json += encodeBase64Triplet(byteAt(i), byteAt(i + 1), byteAt(i + 2));
  }
  const rem = total - full;
  const nextCarry = new Uint8Array(rem);
  for (let i = 0; i < rem; i += 1) {
    nextCarry[i] = byteAt(full + i);
  }
  return {
    json,
    state: { mode: "base64", carry: nextCarry, bytes: state.bytes + bytes.length, replaced: 0 },
  };
}

function escapeCodeUnit(unit: number): string {
  switch (unit) {
    case 0x22:
      return String.raw`\"`;
    case 0x5c:
      return String.raw`\\`;
    case 0x08:
      return String.raw`\b`;
    case 0x0c:
      return String.raw`\f`;
    case 0x0a:
      return String.raw`\n`;
    case 0x0d:
      return String.raw`\r`;
    case 0x09:
      return String.raw`\t`;
    default:
      if (unit < 0x20) {
        return `\\u${unit.toString(16).padStart(4, "0")}`;
      }
      return String.fromCharCode(unit);
  }
}

function encodeUtf8Chunk(
  state: EncoderState,
  bytes: Uint8Array,
): { readonly json: string; readonly state: EncoderState } {
  const carry = state.carry;
  const total = carry.length + bytes.length;
  const byteAt = (index: number): number =>
    index < carry.length ? carry[index]! : bytes[index - carry.length]!;

  let json = "";
  let replaced = state.replaced;
  let bytesNeeded = 0;
  let bytesSeen = 0;
  let codePoint = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let seqStart = 0;

  for (let i = 0; i < total; i += 1) {
    const b = byteAt(i);
    if (bytesNeeded === 0) {
      if (b <= 0x7f) {
        json += escapeCodeUnit(b);
      } else if (b >= 0xc2 && b <= 0xdf) {
        seqStart = i;
        bytesNeeded = 1;
        codePoint = b & 0x1f;
      } else if (b === 0xe0) {
        seqStart = i;
        bytesNeeded = 2;
        codePoint = 0;
        lower = 0xa0;
      } else if ((b >= 0xe1 && b <= 0xec) || b === 0xee || b === 0xef) {
        seqStart = i;
        bytesNeeded = 2;
        codePoint = b & 0x0f;
      } else if (b === 0xed) {
        seqStart = i;
        bytesNeeded = 2;
        codePoint = b & 0x0f;
        upper = 0x9f;
      } else if (b === 0xf0) {
        seqStart = i;
        bytesNeeded = 3;
        codePoint = 0;
        lower = 0x90;
      } else if (b >= 0xf1 && b <= 0xf3) {
        seqStart = i;
        bytesNeeded = 3;
        codePoint = b & 0x07;
      } else if (b === 0xf4) {
        seqStart = i;
        bytesNeeded = 3;
        codePoint = b & 0x07;
        upper = 0x8f;
      } else {
        json += "\ufffd";
        replaced += 1;
      }
      continue;
    }

    if (b < lower || b > upper) {
      bytesNeeded = 0;
      bytesSeen = 0;
      codePoint = 0;
      lower = 0x80;
      upper = 0xbf;
      json += "\ufffd";
      replaced += 1;
      i -= 1;
      continue;
    }

    lower = 0x80;
    upper = 0xbf;
    codePoint = (codePoint << 6) | (b & 0x3f);
    bytesSeen += 1;
    if (bytesSeen === bytesNeeded) {
      json += codePoint > 0xffff ? String.fromCodePoint(codePoint) : escapeCodeUnit(codePoint);
      bytesNeeded = 0;
      bytesSeen = 0;
      codePoint = 0;
    }
  }

  const nextCarry =
    bytesNeeded > 0
      ? Uint8Array.from({ length: total - seqStart }, (_, idx) => byteAt(seqStart + idx))
      : new Uint8Array(0);

  return {
    json,
    state: {
      mode: "utf8-text",
      carry: nextCarry,
      bytes: state.bytes + bytes.length,
      replaced,
    },
  };
}

/** Bytes in, already JSON-escaped text out, no surrounding quotes. */
export function encodeChunk(
  state: EncoderState,
  bytes: Uint8Array,
): { readonly json: string; readonly state: EncoderState } {
  return state.mode === "base64" ? encodeBase64Chunk(state, bytes) : encodeUtf8Chunk(state, bytes);
}

const base64TextCharCount = new WeakMap<EncoderState, number>();

function countNonPadBase64Chars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x3d) continue;
    count += 1;
  }
  return count;
}

/** For DevTools' text slices, which are already decoded: JSON-escape only. Counts UTF-8 bytes for content.size. */
export function encodeTextChunk(
  state: EncoderState,
  text: string,
): { readonly json: string; readonly state: EncoderState } {
  const json = JSON.stringify(text).slice(1, -1);
  if (state.mode === "base64") {
    const prevChars = base64TextCharCount.get(state) ?? 0;
    const totalChars = prevChars + countNonPadBase64Chars(text);
    const nextState: EncoderState = { ...state, bytes: Math.floor((totalChars * 3) / 4) };
    base64TextCharCount.set(nextState, totalChars);
    return { json, state: nextState };
  }
  return {
    json,
    state: { ...state, bytes: state.bytes + utf8ByteLength(text) },
  };
}

export function finishEncoder(state: EncoderState): {
  readonly json: string;
  readonly state: EncoderState;
} {
  if (state.carry.length === 0) {
    return { json: "", state };
  }
  if (state.mode === "base64") {
    const a = state.carry[0]!;
    if (state.carry.length === 1) {
      const json = `${BASE64_CHARS[a >> 2]!}${BASE64_CHARS[(a & 3) << 4]!}==`;
      return { json, state: { ...state, carry: new Uint8Array(0) } };
    }
    const b = state.carry[1]!;
    const json = `${BASE64_CHARS[a >> 2]!}${BASE64_CHARS[((a & 3) << 4) | (b >> 4)]!}${BASE64_CHARS[(b & 0x0f) << 2]!}=`;
    return { json, state: { ...state, carry: new Uint8Array(0) } };
  }
  return {
    json: "\ufffd",
    state: { ...state, carry: new Uint8Array(0), replaced: state.replaced + 1 },
  };
}

/** The entry without response.content's text, size, compression, encoding and comment, and without _harExport. */
export function entryHead(entry: HarEntry): string {
  const entryRest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key !== "response" && key !== "_harExport" && value !== undefined) {
      entryRest[key] = value;
    }
  }
  const responseRest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry.response)) {
    if (key !== "content" && value !== undefined) {
      responseRest[key] = value;
    }
  }
  const contentHead: Record<string, unknown> = { mimeType: entry.response.content.mimeType };
  for (const [key, value] of Object.entries(entry.response.content)) {
    if (!CONTENT_OWNED.has(key) && value !== undefined) {
      contentHead[key] = value;
    }
  }
  const entryJson = JSON.stringify(entryRest);
  const responseJson = JSON.stringify(responseRest);
  const contentJson = JSON.stringify(contentHead);
  return `${entryJson.slice(0, -1)},"response":${responseJson.slice(0, -1)},"content":${contentJson.slice(0, -1)}`;
}

/** How the body ended. Exactly one of these per entry, decided after the stream, never before. */
export type BodyEnd =
  | {
      readonly kind: "complete";
      readonly encoder: EncoderState;
      readonly wireBytes: number;
      readonly check: BodyCheck;
      readonly from: "stored" | "devtools";
    }
  | { readonly kind: "cut-short"; readonly encoder: EncoderState; readonly reason: MissingReason }
  | { readonly kind: "missing"; readonly reason: MissingReason }
  | { readonly kind: "empty" };

/**
 * `_harExport` for the entry: source, bodyState, bodyMissing, bodyIncomplete, bodyCheck, lossyText, inProgress.
 * bodyState is "present" only for a complete body; a cut-short body is "unavailable" with bodyIncomplete true, so
 * @one-click-har/har/summarize counts it as missing (deepseek F9).
 */
export function entryExtension(
  end: BodyEnd,
  source: "both" | "recording-only" | "devtools-only",
  inProgress: boolean,
): HarEntryExtension {
  const base = { source, ...(inProgress ? { inProgress: true } : {}) };
  switch (end.kind) {
    case "complete":
      return {
        ...base,
        bodyState: "present",
        bodyCheck: end.check,
        ...(end.encoder.replaced > 0 ? { lossyText: end.encoder.replaced } : {}),
      };
    case "cut-short":
      return {
        ...base,
        bodyState: "unavailable",
        bodyMissing: end.reason,
        bodyIncomplete: true,
        ...(end.encoder.replaced > 0 ? { lossyText: end.encoder.replaced } : {}),
      };
    case "missing":
      return {
        ...base,
        bodyState: MISSING_REASONS[end.reason].harState,
        bodyMissing: end.reason,
      };
    case "empty":
      return { ...base, bodyState: "empty" };
  }
}

/** Closes content, response and the entry from what actually happened while streaming. */
export function entryTail(end: BodyEnd, extension: HarEntryExtension): string {
  let size: number;
  let compression: number | undefined;
  let comment: string | undefined;

  switch (end.kind) {
    case "complete":
      size = end.encoder.bytes;
      if (end.from === "stored" && end.wireBytes >= 0 && end.encoder.bytes !== end.wireBytes) {
        compression = Math.trunc(end.encoder.bytes - end.wireBytes);
      }
      break;
    case "cut-short":
      size = end.encoder.bytes;
      comment = MISSING_REASONS[end.reason].comment;
      break;
    case "missing":
      size = -1;
      comment = MISSING_REASONS[end.reason].comment;
      break;
    case "empty":
      size = 0;
      break;
  }

  let tail = `,"size":${String(size)}`;
  if (compression !== undefined) {
    tail += `,"compression":${String(compression)}`;
  }
  if (comment !== undefined) {
    tail += `,"comment":${JSON.stringify(comment)}`;
  }
  return `${tail}}},"_harExport":${JSON.stringify(extension)}}`;
}
