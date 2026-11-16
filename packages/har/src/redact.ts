import { OWNED_FIELDS, pickCustomFields, safeDecodeQueryComponent } from "./internal.ts";
import {
  HAR_REDACTION_PLACES,
  toHarUrl,
  type HarContent,
  type HarCookie,
  type HarDocument,
  type HarEntry,
  type HarLogRedactionExtension,
  type HarNameValue,
  type HarPlaceCoverage,
  type HarPostData,
  type HarPostDataParam,
  type HarRedactionPlace,
  type HarRedactionRecord,
  type HarRedactionTarget,
  type HarUrl,
  type PlaceExamStatus,
  type RedactionDetector,
  type RedactionLevel,
} from "./model.ts";

export interface HarRedactionRule {
  readonly id: string;
  readonly target: HarRedactionTarget;
  readonly names: readonly string[];
  readonly matchAll?: boolean | undefined;
}

export interface RedactHarOptions {
  readonly rules?: readonly HarRedactionRule[] | undefined;
  readonly extraRules?: readonly HarRedactionRule[] | undefined;
  readonly replacement?: string | undefined;
  readonly level?: RedactionLevel | undefined;
  readonly detectors?: readonly RedactionDetector[] | undefined;
}

export interface RedactHarResult {
  readonly document: HarDocument;
  readonly report: HarLogRedactionExtension;
}

export interface RedactionLevelSpec {
  readonly id: RedactionLevel;
  readonly guarantee: string;
  readonly detectors: readonly RedactionDetector[];
  readonly dropBodies: boolean;
  readonly dropCustomFields: boolean;
}

const USERINFO_LIMIT = "Nothing in the userinfo after a URL is parsed.";

const BASE64_LIMIT =
  "A value shorter than 20 characters, a hex hash, a UUID, or a base64 image can remain inside decoded JSON. A secret inside base64 that is not JSON can remain.";

const STRICT_REMOVED = "Nothing can remain. The field was removed.";

const NOT_EXAMINED_LIMIT = "Any secret can remain. This place was not examined.";

export const REDACTION_LEVEL_TABLE: Readonly<Record<RedactionLevel, RedactionLevelSpec>> = {
  default: {
    id: "default",
    guarantee:
      "Every string is checked for URLs and for token-shaped values, and listed secret names are removed. A short value, a hex hash, a UUID, or a base64 image can remain, and each place says so.",
    detectors: ["structured-removal", "name-match", "url", "json-walk", "token-shape"],
    dropBodies: false,
    dropCustomFields: false,
  },
  strict: {
    id: "strict",
    guarantee:
      "Request bodies, response bodies, and custom fields are removed. Every remaining string is checked for URLs and for token-shaped values, and listed secret names are removed.",
    detectors: ["structured-removal", "name-match", "url", "json-walk", "token-shape"],
    dropBodies: true,
    dropCustomFields: true,
  },
};

const PLACE_DETECTORS: Record<HarRedactionPlace, readonly RedactionDetector[]> = {
  "request-url-query": ["name-match", "url", "token-shape"],
  "request-url-userinfo": ["url"],
  "request-url-fragment": ["name-match", "url", "token-shape"],
  "request-url-path": ["url", "token-shape"],
  "named-header": ["structured-removal", "name-match", "url", "token-shape"],
  "url-header": ["url", "token-shape", "name-match"],
  cookie: ["structured-removal", "token-shape", "url"],
  "query-string": ["name-match", "url", "token-shape"],
  "body-param": ["name-match", "token-shape", "url"],
  "body-json": ["name-match", "json-walk", "url", "token-shape"],
  "body-form": ["name-match", "url", "token-shape"],
  "body-multipart": ["name-match", "token-shape", "url"],
  "request-body-other": ["json-walk", "url", "token-shape", "name-match"],
  "redirect-url": ["name-match", "url", "token-shape"],
  "response-body-json": ["name-match", "json-walk", "url", "token-shape"],
  "response-body-base64": ["json-walk", "name-match", "url", "token-shape"],
  "page-title": ["name-match", "url", "token-shape"],
  initiator: ["url", "token-shape", "json-walk", "name-match"],
  "response-body-other": ["url", "token-shape", "json-walk"],
  websocket: ["json-walk", "url", "token-shape", "name-match"],
  cache: ["url", "token-shape", "name-match"],
  comment: ["url", "token-shape"],
  "other-custom-field": ["url", "token-shape", "json-walk", "name-match"],
};

const CONSULTED_TARGETS: Partial<Record<HarRedactionPlace, readonly HarRedactionTarget[]>> = {
  "named-header": ["header"],
  "url-header": ["header-url", "query"],
  cookie: ["cookie"],
  "query-string": ["query"],
  "request-url-query": ["query"],
  "request-url-fragment": ["query"],
  "redirect-url": ["query"],
  "page-title": ["query"],
  initiator: ["query", "initiator"],
  "body-param": ["body"],
  "body-json": ["body"],
  "body-form": ["body"],
  "body-multipart": ["body"],
  "request-body-other": ["body"],
  "response-body-json": ["body"],
  "response-body-base64": ["body"],
  websocket: ["body"],
  cache: ["body"],
  "other-custom-field": ["body"],
};

const BODY_PLACES = new Set<HarRedactionPlace>([
  "body-param",
  "body-json",
  "body-form",
  "body-multipart",
  "request-body-other",
  "response-body-json",
  "response-body-base64",
  "response-body-other",
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
      "client_secret",
      "secret",
      "password",
      "auth",
      "code",
      "sig",
      "signature",
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
      "client_secret",
      "secret",
      "password",
      "auth",
      "code",
    ],
  },
  { id: "header:x-api-key", target: "header", names: ["x-api-key", "api-key", "x-api-token"] },
  {
    id: "header:x-csrf-token",
    target: "header",
    names: ["x-csrf-token", "x-xsrf-token", "csrf-token"],
  },
  { id: "header:location", target: "header-url", names: ["location"] },
  { id: "header:referer", target: "header-url", names: ["referer", "referrer"] },
  { id: "header:path", target: "header-url", names: [":path"] },
  { id: "url:userinfo", target: "url-userinfo", names: ["userinfo"] },
  { id: "initiator:url", target: "initiator", names: ["url"] },
];

const DEFAULT_REPLACEMENT = "[REDACTED]";
const JWT_SOURCE = "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}";
const TOKEN_SOURCE = "[A-Za-z0-9+/=_-]{20,}";
const URL_SOURCE = "[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^\\s\"'<>]*";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

function isHex(value: string): boolean {
  return /^[0-9a-fA-F]+$/u.test(value);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isHyphenatedSlug(value: string): boolean {
  return (value.match(/-/gu) ?? []).length >= 2 && !/[+/=]/u.test(value);
}

function isCredentialToken(value: string, minLength: number): boolean {
  if (value.length < minLength || isUuid(value) || isHex(value) || isHyphenatedSlug(value)) {
    return false;
  }
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(value)) {
    return false;
  }
  return (
    /[A-Za-z]/u.test(value) && /\d/u.test(value) && /[A-Z]/u.test(value) && /[a-z]/u.test(value)
  );
}

function decodeBase64(input: string): Uint8Array | null {
  const clean = input.replace(/\s+/gu, "");
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(clean)) {
    return null;
  }
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const chunk = clean.slice(index, index + 4);
    const sextets = chunk.split("").map((char) => {
      if (char === "=") {
        return 0;
      }
      const found = B64_CHARS.indexOf(char);
      return found;
    });
    if (sextets.some((part) => part < 0)) {
      return null;
    }
    const a = sextets[0] ?? 0;
    const b = sextets[1] ?? 0;
    const c = sextets[2] ?? 0;
    const d = sextets[3] ?? 0;
    bytes.push((a << 2) | (b >> 4));
    if (chunk[2] !== "=") {
      bytes.push(((b & 15) << 4) | (c >> 2));
    }
    if (chunk[3] !== "=") {
      bytes.push(((c & 3) << 6) | d);
    }
  }
  return Uint8Array.from(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = index + 1 < bytes.length ? (bytes[index + 1] ?? 0) : 0;
    const c = index + 2 < bytes.length ? (bytes[index + 2] ?? 0) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64_CHARS[(triple >> 18) & 63] ?? "";
    out += B64_CHARS[(triple >> 12) & 63] ?? "";
    out += index + 1 < bytes.length ? (B64_CHARS[(triple >> 6) & 63] ?? "") : "=";
    out += index + 2 < bytes.length ? (B64_CHARS[triple & 63] ?? "") : "=";
  }
  return out;
}

function decodeBase64Ascii(input: string): string | null {
  const bytes = decodeBase64(input);
  if (!bytes) {
    return null;
  }
  let text = "";
  for (const byte of bytes) {
    if (byte > 127) {
      return null;
    }
    text += String.fromCharCode(byte);
  }
  return text;
}

function encodeAsciiBase64(text: string): string {
  const bytes = Uint8Array.from(text.split("").map((char) => char.charCodeAt(0)));
  return encodeBase64(bytes);
}

function isImageBase64(text: string): boolean {
  if (text.startsWith("data:image/")) {
    return true;
  }
  if (text.length < 80 || !/^[A-Za-z0-9+/=\s]+$/u.test(text)) {
    return false;
  }
  const decoded = decodeBase64(text.slice(0, 64));
  if (!decoded || decoded.length < 4) {
    return false;
  }
  const png = decoded[0] === 0x89 && decoded[1] === 0x50;
  const jpeg = decoded[0] === 0xff && decoded[1] === 0xd8;
  const gif = decoded[0] === 0x47 && decoded[1] === 0x49;
  const webp = decoded[0] === 0x52 && decoded[1] === 0x49;
  return png || jpeg || gif || webp;
}

function isBlob(text: string): boolean {
  return isImageBase64(text) || (text.length > 200 && /^[A-Za-z0-9+/=\s]+$/u.test(text));
}

function hasJwt(text: string): boolean {
  return new RegExp(JWT_SOURCE, "u").test(text);
}

function redactTokenShapes(text: string, replacement: string): string {
  if (isBlob(text)) {
    return text;
  }
  let next = text.replace(/\bBearer\s+(\S+)/giu, (match, token: string) => {
    if (isCredentialToken(token, 8) || hasJwt(token)) {
      return match.replace(token, replacement);
    }
    return match;
  });
  next = next.replace(new RegExp(JWT_SOURCE, "gu"), replacement);
  next = next.replace(new RegExp(TOKEN_SOURCE, "gu"), (token) => {
    if (isImageBase64(token) || !isCredentialToken(token, 20)) {
      return token;
    }
    return replacement;
  });
  return next;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

interface RemovalKey {
  readonly target: HarRedactionTarget;
  readonly field: string;
  readonly ruleId: string;
  readonly detector: RedactionDetector;
  readonly place: HarRedactionPlace;
}

class RedactionLog {
  readonly #entryIndex: number;
  readonly #counts = new Map<string, RemovalKey & { count: number }>();
  readonly #fields = new Set<string>();
  readonly places = new Map<HarRedactionPlace, Set<RedactionDetector>>();

  constructor(entryIndex: number) {
    this.#entryIndex = entryIndex;
  }

  mark(
    place: HarRedactionPlace,
    detector: RedactionDetector,
    target: HarRedactionTarget,
    field: string,
    ruleId: string,
    amount = 1,
  ): void {
    const key = `${place}\0${detector}\0${target}\0${field.toLowerCase()}\0${ruleId}`;
    this.#fields.add(`${target}:${field}`);
    const existing = this.places.get(place);
    if (existing) {
      existing.add(detector);
    } else {
      this.places.set(place, new Set([detector]));
    }
    const prior = this.#counts.get(key);
    if (prior) {
      prior.count += amount;
    } else {
      this.#counts.set(key, { place, detector, target, field, ruleId, count: amount });
    }
  }

  records(url: HarUrl): readonly HarRedactionRecord[] {
    return [...this.#counts.values()].map((item) => ({
      entryIndex: this.#entryIndex,
      url,
      place: item.place,
      target: item.target,
      field: item.field,
      ruleId: item.ruleId,
      detector: item.detector,
      count: item.count,
    }));
  }

  get fields(): readonly string[] {
    return [...this.#fields];
  }
}

interface ScanContext {
  readonly rules: readonly HarRedactionRule[];
  readonly replacement: string;
  readonly detectors: ReadonlySet<RedactionDetector>;
  readonly log: RedactionLog;
  has(detector: RedactionDetector): boolean;
}

function targetForPlace(place: HarRedactionPlace): HarRedactionTarget {
  if (place === "cookie") {
    return "cookie";
  }
  if (place === "named-header" || place === "url-header") {
    return "header";
  }
  if (place === "request-url-userinfo") {
    return "url-userinfo";
  }
  if (place === "page-title") {
    return "page";
  }
  if (place === "initiator") {
    return "initiator";
  }
  if (
    place === "body-param" ||
    place === "body-json" ||
    place === "body-form" ||
    place === "body-multipart" ||
    place === "request-body-other" ||
    place === "response-body-json" ||
    place === "response-body-base64" ||
    place === "response-body-other"
  ) {
    return "body";
  }
  return "query";
}

function markText(
  ctx: ScanContext,
  place: HarRedactionPlace,
  detector: RedactionDetector,
  field: string,
  ruleId: string,
): void {
  ctx.log.mark(place, detector, targetForPlace(place), field, ruleId);
}

function redactQueryParts(
  query: string,
  ctx: ScanContext,
  place: HarRedactionPlace,
): { readonly text: string; readonly changed: boolean } {
  if (query.length === 0) {
    return { text: query, changed: false };
  }
  let changed = false;
  const encodedReplacement = encodeURIComponent(ctx.replacement);
  const segments = query.split("&").map((segment) => {
    if (segment.length === 0) {
      return segment;
    }
    const eqIndex = segment.indexOf("=");
    const rawName = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? "" : segment.slice(eqIndex + 1);
    const decodedName = safeDecodeQueryComponent(rawName);
    const decodedValue = safeDecodeQueryComponent(rawValue);
    const rule = ctx.has("name-match")
      ? findMatchingRule(ctx.rules, "query", decodedName)
      : undefined;
    const byUrl =
      ctx.has("url") &&
      (isCredentialToken(decodedValue, 16) || /^[0-9a-fA-F]{16,}$/u.test(decodedValue));
    const byToken =
      ctx.has("token-shape") && (hasJwt(decodedValue) || isCredentialToken(decodedValue, 20));
    if (!rule && !byUrl && !byToken) {
      if (ctx.has("url") && (decodedValue.includes("://") || decodedValue.includes("@"))) {
        const scanned = redactLeaf(decodedValue, place, ctx);
        if (scanned !== decodedValue) {
          changed = true;
          return `${rawName}=${encodeURIComponent(scanned)}`;
        }
      }
      if (ctx.has("token-shape")) {
        const scannedSegment = redactTokenShapes(segment, ctx.replacement);
        if (scannedSegment !== segment) {
          changed = true;
          markText(ctx, place, "token-shape", decodedName || "query", "token-shape");
          return scannedSegment;
        }
      }
      return segment;
    }
    changed = true;
    if (rule) {
      markText(ctx, place, "name-match", decodedName, rule.id);
    } else if (byUrl) {
      markText(ctx, place, "url", decodedName || "query", "url");
    } else {
      markText(ctx, place, "token-shape", decodedName || "query", "token-shape");
    }
    return `${rawName}=${encodedReplacement}`;
  });
  return { text: changed ? segments.join("&") : query, changed };
}

function redactOneUrl(text: string, ctx: ScanContext, place: HarRedactionPlace): string {
  let next = text;
  if (ctx.has("url") || ctx.has("token-shape")) {
    const userinfo = ctx.has("url")
      ? /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#@]*)@/u.exec(next)
      : null;
    if (userinfo) {
      markText(ctx, "request-url-userinfo", "url", "userinfo", "url");
      next = `${userinfo[1] ?? ""}${encodeURIComponent(ctx.replacement)}@${next.slice(userinfo[0].length)}`;
    }
    const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/u.exec(next);
    if (scheme) {
      const pathStart = scheme[0].length;
      const rest = next.slice(pathStart);
      const pathEnd = rest.search(/[?#]/u);
      const path = pathEnd === -1 ? rest : rest.slice(0, pathEnd);
      const segments = path.split("/");
      let pathChanged = false;
      const nextSegments = segments.map((segment) => {
        const decoded = safeDecodeQueryComponent(segment);
        if (ctx.has("token-shape") && (hasJwt(decoded) || /^Bearer\s+\S+/iu.test(decoded))) {
          pathChanged = true;
          markText(ctx, "request-url-path", "token-shape", "path", "token-shape");
          return encodeURIComponent(ctx.replacement);
        }
        if (!isCredentialToken(decoded, 16)) {
          return segment;
        }
        pathChanged = true;
        const pathDetector: RedactionDetector = ctx.has("url") ? "url" : "token-shape";
        markText(ctx, "request-url-path", pathDetector, "path", pathDetector);
        return encodeURIComponent(ctx.replacement);
      });
      if (pathChanged) {
        next = `${next.slice(0, pathStart)}${nextSegments.join("/")}${pathEnd === -1 ? "" : rest.slice(pathEnd)}`;
      }
    }
  }
  const hashStart = next.indexOf("#");
  const beforeHash = hashStart === -1 ? next : next.slice(0, hashStart);
  const fragment = hashStart === -1 ? "" : next.slice(hashStart + 1);
  const queryStart = beforeHash.indexOf("?");
  const head = queryStart === -1 ? beforeHash : beforeHash.slice(0, queryStart);
  const query = queryStart === -1 ? "" : beforeHash.slice(queryStart + 1);
  const queryPlace =
    place === "page-title" ||
    place === "redirect-url" ||
    place === "url-header" ||
    place === "initiator"
      ? place
      : "request-url-query";
  const redactedQuery = redactQueryParts(query, ctx, queryPlace);
  const redactedFragment = redactQueryParts(
    fragment,
    ctx,
    place === "redirect-url" || place === "url-header" ? place : "request-url-fragment",
  );
  if (!redactedQuery.changed && !redactedFragment.changed && next === text) {
    return text;
  }
  const queryText =
    queryStart === -1 && !redactedQuery.changed
      ? ""
      : redactedQuery.changed || query.length > 0
        ? `?${redactedQuery.text}`
        : "";
  const fragmentText =
    hashStart === -1 && !redactedFragment.changed
      ? ""
      : redactedFragment.changed || fragment.length > 0
        ? `#${redactedFragment.text}`
        : "";
  return `${head}${queryText}${fragmentText}`;
}

function redactUrlText(text: string, ctx: ScanContext, place: HarRedactionPlace): string {
  if (text.includes("://")) {
    return text.replace(new RegExp(URL_SOURCE, "gu"), (match) => redactOneUrl(match, ctx, place));
  }
  if (text.includes("?") || text.includes("#") || text.includes("@")) {
    return redactOneUrl(text, ctx, place);
  }
  return text;
}

function redactJson(value: unknown, place: HarRedactionPlace, ctx: ScanContext): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, place, ctx));
  }
  if (typeof value === "object" && value !== null) {
    const next: Record<string, unknown> = {};
    for (const [key, fieldVal] of Object.entries(value)) {
      const rule = ctx.has("name-match") ? findBodyRule(ctx.rules, key) : undefined;
      if (rule) {
        markText(ctx, place, "name-match", key, rule.id);
        next[key] = ctx.replacement;
      } else {
        next[key] = redactJson(fieldVal, place, ctx);
      }
    }
    return next;
  }
  if (typeof value === "string") {
    return redactLeaf(value, place, ctx);
  }
  return value;
}

function redactLeaf(text: string, place: HarRedactionPlace, ctx: ScanContext): string {
  let next = text;
  if (ctx.has("url") || ctx.has("token-shape")) {
    const urlled = redactUrlText(next, ctx, place);
    if (urlled !== next) {
      next = urlled;
    }
  }
  if (ctx.has("token-shape")) {
    const tok = redactTokenShapes(next, ctx.replacement);
    if (tok !== next) {
      markText(ctx, place, "token-shape", "token", "token-shape");
      next = tok;
    }
  }
  return next;
}

function redactText(text: string, place: HarRedactionPlace, ctx: ScanContext): string {
  if (ctx.has("json-walk") && looksLikeJson(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      const walked = redactJson(parsed, place, ctx);
      const serialized = JSON.stringify(walked);
      if (serialized !== JSON.stringify(parsed)) {
        return serialized;
      }
    } catch {
      // Not JSON. Fall through to URL and token checks.
    }
  }
  return redactLeaf(text, place, ctx);
}

function redactUnknown(value: unknown, place: HarRedactionPlace, ctx: ScanContext): unknown {
  if (typeof value === "string") {
    return redactText(value, place, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, place, ctx));
  }
  if (typeof value === "object" && value !== null) {
    const next: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const childPlace: HarRedactionPlace = key === "comment" ? "comment" : place;
      const rule =
        key !== "comment" && ctx.has("name-match") ? findBodyRule(ctx.rules, key) : undefined;
      if (rule && typeof field === "string") {
        markText(ctx, childPlace, "name-match", key, rule.id);
        next[key] = ctx.replacement;
      } else {
        next[key] = redactUnknown(field, childPlace, ctx);
      }
    }
    return next;
  }
  return value;
}

function customPlace(key: string): HarRedactionPlace {
  if (key === "_initiator") {
    return "initiator";
  }
  if (key === "_webSocketMessages") {
    return "websocket";
  }
  if (key === "comment") {
    return "comment";
  }
  return "other-custom-field";
}

function copyCustom(
  source: object,
  owned: ReadonlySet<string>,
  ctx: ScanContext,
  dropCustom: boolean,
): Record<string, unknown> {
  const custom = pickCustomFields(source, owned);
  if (dropCustom) {
    if (Object.keys(custom).length > 0) {
      ctx.log.mark("other-custom-field", "structured-removal", "body", "custom", "strict:custom");
    }
    return {};
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(custom)) {
    if (key === "_harExport") {
      continue;
    }
    next[key] = redactUnknown(value, customPlace(key), ctx);
  }
  return next;
}

function scanComment(comment: string | undefined, ctx: ScanContext): string | undefined {
  if (comment === undefined) {
    return undefined;
  }
  return redactText(comment, "comment", ctx);
}

function withValue(
  item: HarNameValue,
  value: string,
  ctx: ScanContext,
  note?: string,
): HarNameValue {
  let comment = scanComment(item.comment, ctx);
  if (note) {
    comment = appendComment(comment, note);
  }
  return {
    ...item,
    value,
    ...(comment !== undefined ? { comment } : {}),
  };
}

function redactHeaders(
  headers: readonly HarNameValue[],
  ctx: ScanContext,
): readonly HarNameValue[] {
  return headers.map((header) => {
    const rule =
      ctx.has("structured-removal") || ctx.has("name-match")
        ? findMatchingRule(ctx.rules, "header", header.name)
        : undefined;
    if (rule) {
      markText(ctx, "named-header", "structured-removal", header.name, rule.id);
      return withValue(header, ctx.replacement, ctx, `redacted by ${rule.id}`);
    }
    const nextValue = redactText(header.value, "url-header", ctx);
    if (nextValue === header.value) {
      return withValue(header, header.value, ctx);
    }
    return withValue(header, nextValue, ctx, "redacted by url");
  });
}

function redactCookies(cookies: readonly HarCookie[], ctx: ScanContext): readonly HarCookie[] {
  return cookies.map((cookie) => {
    const rule =
      ctx.has("structured-removal") || ctx.has("name-match")
        ? findMatchingRule(ctx.rules, "cookie", cookie.name)
        : undefined;
    const path = cookie.path === undefined ? undefined : redactText(cookie.path, "cookie", ctx);
    const domain =
      cookie.domain === undefined ? undefined : redactText(cookie.domain, "cookie", ctx);
    const comment = scanComment(cookie.comment, ctx);
    if (rule) {
      markText(ctx, "cookie", "structured-removal", cookie.name, rule.id);
      return {
        ...cookie,
        value: ctx.replacement,
        ...(path !== undefined ? { path } : {}),
        ...(domain !== undefined ? { domain } : {}),
        comment: appendComment(comment, `redacted by ${rule.id}`),
      };
    }
    const nextValue = redactText(cookie.value, "cookie", ctx);
    return {
      ...cookie,
      value: nextValue,
      ...(path !== undefined ? { path } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(comment !== undefined ? { comment } : {}),
    };
  });
}

function redactQueryString(
  queryString: readonly HarNameValue[],
  ctx: ScanContext,
): readonly HarNameValue[] {
  return queryString.map((item) => {
    const rule = ctx.has("name-match")
      ? findMatchingRule(ctx.rules, "query", item.name)
      : undefined;
    const byUrl =
      ctx.has("url") &&
      (isCredentialToken(item.value, 16) || /^[0-9a-fA-F]{16,}$/u.test(item.value));
    const byToken =
      ctx.has("token-shape") && (hasJwt(item.value) || isCredentialToken(item.value, 20));
    if (rule || byUrl || byToken) {
      if (rule) {
        markText(ctx, "query-string", "name-match", item.name, rule.id);
      } else if (byUrl) {
        markText(ctx, "query-string", "url", item.name, "url");
      } else {
        markText(ctx, "query-string", "token-shape", item.name, "token-shape");
      }
      return withValue(
        item,
        ctx.replacement,
        ctx,
        `redacted by ${rule?.id ?? (byUrl ? "url" : "token-shape")}`,
      );
    }
    const scanned = redactLeaf(item.value, "query-string", ctx);
    if (scanned === item.value) {
      return withValue(item, item.value, ctx);
    }
    return withValue(item, scanned, ctx, "redacted by url");
  });
}

function redactFormText(text: string, ctx: ScanContext, tracked: ReadonlySet<string>): string {
  const encodedReplacement = encodeURIComponent(ctx.replacement);
  let changed = false;
  const segments = text.split("&").map((segment) => {
    if (segment.length === 0) {
      return segment;
    }
    const eqIndex = segment.indexOf("=");
    const rawName = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? "" : segment.slice(eqIndex + 1);
    const decodedName = safeDecodeQueryComponent(rawName);
    const decodedValue = safeDecodeQueryComponent(rawValue);
    const rule = ctx.has("name-match") ? findBodyRule(ctx.rules, decodedName) : undefined;
    if (!rule) {
      const scanned = redactLeaf(decodedValue, "body-form", ctx);
      if (scanned === decodedValue) {
        return segment;
      }
      changed = true;
      return `${rawName}=${encodeURIComponent(scanned)}`;
    }
    changed = true;
    if (!tracked.has(decodedName.toLowerCase())) {
      markText(ctx, "body-form", "name-match", decodedName, rule.id);
    }
    return `${rawName}=${encodedReplacement}`;
  });
  return changed ? segments.join("&") : text;
}

function redactMultipartText(text: string, ctx: ScanContext): string {
  return text.replace(
    /(content-disposition:[^\r\n]*\bname="([^"]+)"[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n)([\s\S]*?)(?=\r\n--|$)/giu,
    (match, headers: string, name: string, body: string) => {
      const rule = ctx.has("name-match") ? findBodyRule(ctx.rules, name) : undefined;
      if (!rule) {
        return `${headers}${redactText(body, "body-multipart", ctx)}`;
      }
      markText(ctx, "body-multipart", "name-match", name, rule.id);
      return `${headers}${ctx.replacement}`;
    },
  );
}

function redactPostData(
  postData: HarPostData | undefined,
  ctx: ScanContext,
  dropBodies: boolean,
): HarPostData | undefined {
  if (!postData) {
    return undefined;
  }
  if (dropBodies) {
    ctx.log.mark("request-body-other", "structured-removal", "body", "postData", "strict:body");
    return {
      mimeType: postData.mimeType,
      text: "",
      params: postData.params.map((param) => ({
        name: param.name,
        ...(param.value !== undefined ? { value: "" } : {}),
        ...(param.fileName !== undefined
          ? { fileName: redactText(param.fileName, "body-param", ctx) }
          : {}),
        ...(param.contentType !== undefined ? { contentType: param.contentType } : {}),
      })),
      ...(postData.comment !== undefined ? { comment: scanComment(postData.comment, ctx) } : {}),
    };
  }
  const tracked = new Set<string>();
  const params: HarPostDataParam[] = postData.params.map((param) => {
    const rule = ctx.has("name-match") ? findBodyRule(ctx.rules, param.name) : undefined;
    const comment = scanComment(param.comment, ctx);
    const fileName =
      param.fileName === undefined ? undefined : redactText(param.fileName, "body-param", ctx);
    if (rule && param.value !== undefined) {
      tracked.add(param.name.toLowerCase());
      markText(ctx, "body-param", "name-match", param.name, rule.id);
      return {
        ...param,
        value: ctx.replacement,
        ...(fileName !== undefined ? { fileName } : {}),
        comment: appendComment(comment, `redacted by ${rule.id}`),
      };
    }
    const value =
      param.value === undefined ? undefined : redactLeaf(param.value, "body-param", ctx);
    return {
      ...param,
      ...(value !== undefined ? { value } : {}),
      ...(fileName !== undefined ? { fileName } : {}),
      ...(comment !== undefined ? { comment } : {}),
    };
  });
  const postComment = scanComment(postData.comment, ctx);
  let text = postData.text;
  if (typeof text === "string" && text.length > 0) {
    const mime = postData.mimeType.toLowerCase();
    if (looksLikeJson(text)) {
      text = redactText(text, "body-json", ctx);
    } else if (mime.includes("x-www-form-urlencoded")) {
      text = redactFormText(text, ctx, tracked);
    } else if (mime.includes("multipart/")) {
      text = redactMultipartText(text, ctx);
    } else {
      text = redactText(text, "request-body-other", ctx);
    }
  }
  return {
    ...postData,
    params,
    text,
    ...(postComment !== undefined ? { comment: postComment } : {}),
  };
}

function redactContent(content: HarContent, ctx: ScanContext, dropBodies: boolean): HarContent {
  const contentComment = scanComment(content.comment, ctx);
  if (dropBodies) {
    ctx.log.mark("response-body-other", "structured-removal", "body", "content", "strict:body");
    return {
      size: content.size,
      mimeType: content.mimeType,
      ...(content.compression !== undefined ? { compression: content.compression } : {}),
      ...(content.encoding !== undefined ? { encoding: content.encoding } : {}),
      ...(contentComment !== undefined ? { comment: contentComment } : {}),
    };
  }
  const text = content.text;
  if (text === undefined || text === null || text.length === 0) {
    return contentComment !== undefined ? { ...content, comment: contentComment } : content;
  }
  if (content.encoding?.toLowerCase() === "base64") {
    const decoded = decodeBase64Ascii(text);
    if (decoded && looksLikeJson(decoded)) {
      const redacted = redactText(decoded, "response-body-base64", ctx);
      if (redacted !== decoded) {
        return {
          ...content,
          text: encodeAsciiBase64(redacted),
          ...(contentComment !== undefined ? { comment: contentComment } : {}),
        };
      }
    }
    return contentComment !== undefined ? { ...content, comment: contentComment } : content;
  }
  const mime = content.mimeType.toLowerCase();
  const place: HarRedactionPlace =
    looksLikeJson(text) || mime.includes("json") ? "response-body-json" : "response-body-other";
  const nextText = redactText(text, place, ctx);
  if (nextText === text) {
    return contentComment !== undefined ? { ...content, comment: contentComment } : content;
  }
  return {
    ...content,
    text: nextText,
    ...(contentComment !== undefined ? { comment: contentComment } : {}),
  };
}

function redactCache(cache: HarEntry["cache"], ctx: ScanContext): HarEntry["cache"] {
  return redactUnknown(cache, "cache", ctx) as HarEntry["cache"];
}

function redactEntry(
  entry: HarEntry,
  entryIndex: number,
  ctxBase: Omit<ScanContext, "log" | "has">,
  dropBodies: boolean,
  dropCustom: boolean,
): { readonly entry: HarEntry; readonly records: readonly HarRedactionRecord[] } {
  const log = new RedactionLog(entryIndex);
  const ctx: ScanContext = {
    ...ctxBase,
    log,
    has(detector) {
      return ctxBase.detectors.has(detector);
    },
  };
  const requestHeaders = redactHeaders(entry.request.headers, ctx);
  const requestCookies = redactCookies(entry.request.cookies, ctx);
  const queryString = redactQueryString(entry.request.queryString, ctx);
  let urlText =
    ctx.has("url") || ctx.has("token-shape")
      ? redactOneUrl(entry.request.url, ctx, "request-url-query")
      : entry.request.url;
  if (ctx.has("token-shape")) {
    const tokUrl = redactTokenShapes(urlText, ctx.replacement);
    if (tokUrl !== urlText) {
      markText(ctx, "request-url-path", "token-shape", "url", "token-shape");
      urlText = tokUrl;
    }
  }
  const url = toHarUrl(urlText) ?? entry.request.url;
  const postData = redactPostData(entry.request.postData, ctx, dropBodies);
  const responseHeaders = redactHeaders(entry.response.headers, ctx);
  const responseCookies = redactCookies(entry.response.cookies, ctx);
  const redirectURL = redactText(entry.response.redirectURL, "redirect-url", ctx);
  const content = redactContent(entry.response.content, ctx, dropBodies);
  const requestCustom = copyCustom(entry.request, OWNED_FIELDS.request, ctx, dropCustom);
  const responseCustom = copyCustom(entry.response, OWNED_FIELDS.response, ctx, dropCustom);
  const entryCustom = copyCustom(entry, OWNED_FIELDS.entry, ctx, dropCustom);
  const comment =
    entry.comment === undefined ? undefined : redactText(entry.comment, "comment", ctx);
  const records = log.records(url);
  const updated: HarEntry = {
    ...entryCustom,
    ...(entry.pageref !== undefined ? { pageref: entry.pageref } : {}),
    startedDateTime: entry.startedDateTime,
    time: entry.time,
    request: {
      ...requestCustom,
      method: entry.request.method,
      url,
      httpVersion: entry.request.httpVersion,
      cookies: requestCookies,
      headers: requestHeaders,
      queryString,
      ...(postData !== undefined ? { postData } : {}),
      headersSize: entry.request.headersSize,
      bodySize: entry.request.bodySize,
      ...(entry.request.comment !== undefined
        ? { comment: redactText(entry.request.comment, "comment", ctx) }
        : {}),
    },
    response: {
      ...responseCustom,
      status: entry.response.status,
      statusText: entry.response.statusText,
      httpVersion: entry.response.httpVersion,
      cookies: responseCookies,
      headers: responseHeaders,
      content,
      redirectURL,
      headersSize: entry.response.headersSize,
      bodySize: entry.response.bodySize,
      ...(entry.response.comment !== undefined
        ? { comment: redactText(entry.response.comment, "comment", ctx) }
        : {}),
    },
    cache: redactCache(entry.cache, ctx),
    timings: redactUnknown(entry.timings, "other-custom-field", ctx) as HarEntry["timings"],
    ...(entry.serverIPAddress !== undefined
      ? { serverIPAddress: redactText(entry.serverIPAddress, "other-custom-field", ctx) }
      : {}),
    ...(entry.connection !== undefined
      ? { connection: redactText(entry.connection, "other-custom-field", ctx) }
      : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(records.length > 0
      ? {
          _harExport: {
            ...entry._harExport,
            redactedFields: [
              ...new Set([...(entry._harExport?.redactedFields ?? []), ...log.fields]),
            ],
          },
        }
      : entry._harExport
        ? { _harExport: entry._harExport }
        : {}),
  };
  return { entry: updated, records: log.records(url) };
}

function rulesCover(
  place: HarRedactionPlace,
  rules: readonly HarRedactionRule[],
  detector: RedactionDetector,
): boolean {
  if (detector === "structured-removal") {
    if (place === "cookie") {
      return rules.some((rule) => rule.target === "cookie");
    }
    if (place === "named-header") {
      return rules.some((rule) => rule.target === "header");
    }
    return false;
  }
  if (detector !== "name-match") {
    return true;
  }
  const targets = CONSULTED_TARGETS[place];
  if (!targets) {
    return false;
  }
  return rules.some((rule) => targets.includes(rule.target));
}

function residualLimit(place: HarRedactionPlace, ran: readonly RedactionDetector[]): string {
  const parts: string[] = [];
  if (!ran.includes("token-shape")) {
    parts.push("A token-shaped value can remain.");
  }
  if (!ran.includes("url") && place !== "request-url-userinfo") {
    parts.push("A URL can remain.");
  }
  if (
    !ran.includes("name-match") &&
    !ran.includes("structured-removal") &&
    CONSULTED_TARGETS[place]
  ) {
    parts.push("A listed name can remain.");
  }
  if (place === "cookie" && ran.includes("structured-removal")) {
    parts.push(
      "Cookie values are removed wholesale. A secret in the cookie path, domain, or comment can remain when it is shorter than 20 characters, a hex hash, a UUID, a base64 image, or a hyphenated slug.",
    );
    return parts.join(" ");
  }
  if (place === "named-header" && ran.includes("structured-removal")) {
    parts.push(
      "A header whose name is listed is removed wholesale. A value shorter than 20 characters, a hex hash, a UUID, a base64 image, or a hyphenated slug can remain on any other header.",
    );
    return parts.join(" ");
  }
  if (place === "request-url-userinfo") {
    parts.push(ran.includes("url") ? USERINFO_LIMIT : "Userinfo was not parsed.");
    return parts.join(" ");
  }
  if (place === "response-body-base64") {
    parts.push(BASE64_LIMIT);
    return parts.join(" ");
  }
  if (place === "request-url-path" && (ran.includes("url") || ran.includes("token-shape"))) {
    parts.push(
      "A path segment shorter than 16 characters, a hex hash, a UUID, or a hyphenated slug can remain.",
    );
    return parts.join(" ");
  }
  const queryValue =
    place === "request-url-query" || place === "request-url-fragment" || place === "query-string";
  if (queryValue && ran.includes("url")) {
    parts.push(
      "A value shorter than 16 characters whose name is not listed can remain. A UUID can remain. Hex of 16 or more characters in a query or fragment is removed.",
    );
    return parts.join(" ");
  }
  parts.push(
    "A value shorter than 20 characters, a hex hash, a UUID, a base64 image, or a hyphenated slug can remain.",
  );
  return parts.join(" ");
}

function coverageFor(
  active: ReadonlySet<RedactionDetector>,
  rules: readonly HarRedactionRule[],
  removed: ReadonlyMap<HarRedactionPlace, ReadonlySet<RedactionDetector>>,
  level: RedactionLevelSpec,
): readonly HarPlaceCoverage[] {
  return HAR_REDACTION_PLACES.map((place) => {
    const dropped =
      (level.dropBodies && BODY_PLACES.has(place)) ||
      (level.dropCustomFields && place === "other-custom-field");
    const ran = PLACE_DETECTORS[place].filter(
      (detector) => active.has(detector) && (dropped || rulesCover(place, rules, detector)),
    );
    if (dropped && active.has("structured-removal")) {
      if (!ran.includes("structured-removal")) {
        ran.push("structured-removal");
      }
    }
    const removedBy = [...(removed.get(place) ?? [])].filter(
      (detector) => ran.includes(detector) || dropped,
    );
    let status: PlaceExamStatus;
    if (ran.length === 0 && !dropped) {
      status = "not-examined";
    } else if (removedBy.length > 0 || dropped) {
      status = "removed";
    } else {
      status = "examined";
    }
    const canStillHold =
      status === "not-examined"
        ? NOT_EXAMINED_LIMIT
        : dropped
          ? STRICT_REMOVED
          : residualLimit(place, ran);
    return {
      place,
      status,
      detectors: ran,
      removedBy,
      canStillHold,
    };
  });
}

export function redactHar(document: HarDocument, options?: RedactHarOptions): RedactHarResult {
  const level = REDACTION_LEVEL_TABLE[options?.level ?? "default"];
  const detectors = new Set<RedactionDetector>(options?.detectors ?? level.detectors);
  const rules = [...(options?.rules ?? DEFAULT_REDACTION_RULES), ...(options?.extraRules ?? [])];
  const replacement = options?.replacement ?? DEFAULT_REPLACEMENT;
  const ctxBase = { rules, replacement, detectors };
  const allRecords: HarRedactionRecord[] = [];
  const removed = new Map<HarRedactionPlace, Set<RedactionDetector>>();
  const appliedRules = new Set<string>();
  let entriesAffected = 0;

  const noteRecords = (records: readonly HarRedactionRecord[]): void => {
    for (const record of records) {
      allRecords.push(record);
      appliedRules.add(record.ruleId);
      const bucket = removed.get(record.place);
      if (bucket) {
        bucket.add(record.detector);
      } else {
        removed.set(record.place, new Set([record.detector]));
      }
    }
  };

  const pages = document.log.pages?.map((page) => {
    const log = new RedactionLog(-1);
    const ctx: ScanContext = { ...ctxBase, log, has: (detector) => detectors.has(detector) };
    const title = redactText(page.title, "page-title", ctx);
    const comment = scanComment(page.comment, ctx);
    const timingComment = scanComment(page.pageTimings.comment, ctx);
    const pageCustom = copyCustom(page, OWNED_FIELDS.page, ctx, level.dropCustomFields);
    const timingCustom = copyCustom(
      page.pageTimings,
      OWNED_FIELDS.pageTimings,
      ctx,
      level.dropCustomFields,
    );
    const records = log.records(toHarUrl(title) ?? toHarUrl("https://redacted.invalid/")!);
    noteRecords(records);
    return {
      ...pageCustom,
      startedDateTime: page.startedDateTime,
      id: page.id,
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
  });

  const entries = document.log.entries.map((entry, index) => {
    const result = redactEntry(entry, index, ctxBase, level.dropBodies, level.dropCustomFields);
    if (result.records.length > 0) {
      entriesAffected += 1;
      noteRecords(result.records);
    }
    return result.entry;
  });

  const docLog = new RedactionLog(-1);
  const docCtx: ScanContext = {
    ...ctxBase,
    log: docLog,
    has: (detector) => detectors.has(detector),
  };
  const logCustom = copyCustom(document.log, OWNED_FIELDS.log, docCtx, level.dropCustomFields);
  const logComment = scanComment(document.log.comment, docCtx);
  const creator = redactUnknown(
    document.log.creator,
    "other-custom-field",
    docCtx,
  ) as HarDocument["log"]["creator"];
  const browser = document.log.browser
    ? (redactUnknown(document.log.browser, "other-custom-field", docCtx) as NonNullable<
        HarDocument["log"]["browser"]
      >)
    : undefined;
  noteRecords(docLog.records(toHarUrl("https://redacted.invalid/")!));

  const places = coverageFor(detectors, rules, removed, level);
  const report: HarLogRedactionExtension = {
    applied: true,
    level: level.id,
    guarantee: level.guarantee,
    totalRemoved: allRecords.reduce((sum, record) => sum + record.count, 0),
    entriesAffected,
    rules: [...appliedRules],
    records: allRecords,
    places,
    notInspected: places
      .filter((place) => place.status === "not-examined")
      .map((place) => place.place),
  };

  const redactedDocument: HarDocument = {
    log: {
      ...logCustom,
      version: document.log.version,
      creator,
      ...(browser ? { browser } : {}),
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
