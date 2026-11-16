import { safeDecodeQueryComponent } from "./internal.ts";
import {
  HAR_REDACTION_PLACES,
  toHarUrl,
  type HarContent,
  type HarCookie,
  type HarDocument,
  type HarEntry,
  type HarLogRedactionExtension,
  type HarNameValue,
  type HarPostData,
  type HarPostDataParam,
  type HarRedactionPlace,
  type HarRedactionRecord,
  type HarRedactionTarget,
  type HarUrl,
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
}

export interface RedactHarResult {
  readonly document: HarDocument;
  readonly report: HarLogRedactionExtension;
}

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

const PLACE_TARGETS: readonly {
  readonly place: HarRedactionPlace;
  readonly targets: readonly HarRedactionTarget[];
}[] = [
  { place: "request-url-query", targets: ["query"] },
  { place: "request-url-userinfo", targets: ["url-userinfo"] },
  { place: "named-header", targets: ["header"] },
  { place: "url-header", targets: ["header-url"] },
  { place: "cookie", targets: ["cookie"] },
  { place: "query-string", targets: ["query"] },
  { place: "body-param", targets: ["body"] },
  { place: "body-json", targets: ["body"] },
  { place: "body-form", targets: ["body"] },
  { place: "body-multipart", targets: ["body"] },
  { place: "redirect-url", targets: ["query"] },
  { place: "response-body-json", targets: ["body"] },
  { place: "page-title", targets: ["query"] },
  { place: "initiator", targets: ["initiator"] },
  { place: "response-body-other", targets: [] },
  { place: "websocket", targets: [] },
  { place: "cache", targets: [] },
  { place: "comment", targets: [] },
  { place: "other-custom-field", targets: [] },
];

function notInspectedPlaces(rules: readonly HarRedactionRule[]): readonly HarRedactionPlace[] {
  const targets = new Set(rules.map((rule) => rule.target));
  return HAR_REDACTION_PLACES.filter((place) => {
    const covered = PLACE_TARGETS.find((item) => item.place === place);
    if (!covered || covered.targets.length === 0) {
      return true;
    }
    return covered.targets.every((target) => !targets.has(target));
  });
}

const DEFAULT_REPLACEMENT = "[REDACTED]";

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

function foldKey(name: string): string {
  return name.replace(/[_-]/gu, "").toLowerCase();
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

class EntryRedactionTracker {
  readonly #entryIndex: number;
  readonly #counts = new Map<string, Omit<HarRedactionRecord, "url">>();
  readonly #fields = new Set<string>();

  constructor(entryIndex: number) {
    this.#entryIndex = entryIndex;
  }

  record(target: HarRedactionTarget, field: string, ruleId: string, amount = 1): void {
    const key = `${target}\0${field.toLowerCase()}\0${ruleId}`;
    this.#fields.add(`${target}:${field}`);
    const existing = this.#counts.get(key);
    if (existing) {
      this.#counts.set(key, { ...existing, count: existing.count + amount });
    } else {
      this.#counts.set(key, {
        entryIndex: this.#entryIndex,
        target,
        field,
        ruleId,
        count: amount,
      });
    }
  }

  buildRecords(redactedUrl: HarUrl): readonly HarRedactionRecord[] {
    return [...this.#counts.values()].map((item) => ({ ...item, url: redactedUrl }));
  }

  get fields(): readonly string[] {
    return [...this.#fields];
  }
}

function redactHeaders(
  headers: readonly HarNameValue[],
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): readonly HarNameValue[] {
  return headers.map((header) => {
    const rule = findMatchingRule(rules, "header", header.name);
    if (rule) {
      tracker.record("header", header.name, rule.id);
      return {
        ...header,
        value: replacement,
        comment: appendComment(header.comment, `redacted by ${rule.id}`),
      };
    }
    const urlRule = findMatchingRule(rules, "header-url", header.name);
    if (!urlRule) {
      return header;
    }
    const nextValue = redactTextUrl(header.value, rules, replacement, tracker, new Set());
    if (nextValue === header.value) {
      return header;
    }
    return {
      ...header,
      value: nextValue,
      comment: appendComment(header.comment, `redacted by ${urlRule.id}`),
    };
  });
}

function redactCookies(
  cookies: readonly HarCookie[],
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): readonly HarCookie[] {
  return cookies.map((cookie) => {
    const rule = findMatchingRule(rules, "cookie", cookie.name);
    if (!rule) {
      return cookie;
    }
    tracker.record("cookie", cookie.name, rule.id);
    return {
      ...cookie,
      value: replacement,
      comment: appendComment(cookie.comment, `redacted by ${rule.id}`),
    };
  });
}

function redactQueryString(
  queryString: readonly HarNameValue[],
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): { readonly pairs: readonly HarNameValue[]; readonly trackedNames: ReadonlySet<string> } {
  const trackedNames = new Set<string>();
  const pairs = queryString.map((item) => {
    const rule = findMatchingRule(rules, "query", item.name);
    if (!rule) {
      return item;
    }
    trackedNames.add(item.name.toLowerCase());
    tracker.record("query", item.name, rule.id);
    return {
      ...item,
      value: replacement,
      comment: appendComment(item.comment, `redacted by ${rule.id}`),
    };
  });
  return { pairs, trackedNames };
}

function redactUserinfo(
  text: string,
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): string {
  const rule = findMatchingRule(rules, "url-userinfo", "userinfo");
  if (!rule) {
    return text;
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#@]*)@/u.exec(text);
  if (!match) {
    return text;
  }
  tracker.record("url-userinfo", "userinfo", rule.id);
  return `${match[1] ?? ""}${encodeURIComponent(replacement)}@${text.slice(match[0].length)}`;
}

function redactQueryText(
  text: string,
  rules: readonly HarRedactionRule[],
  replacement: string,
  alreadyTrackedNames: ReadonlySet<string>,
  tracker: EntryRedactionTracker,
): string {
  const queryStart = text.indexOf("?");
  if (queryStart === -1) {
    return text;
  }
  const hashStart = text.indexOf("#", queryStart + 1);
  const base = text.slice(0, queryStart + 1);
  const querySlice =
    hashStart === -1 ? text.slice(queryStart + 1) : text.slice(queryStart + 1, hashStart);
  const suffix = hashStart === -1 ? "" : text.slice(hashStart);
  if (querySlice.length === 0) {
    return text;
  }

  const encodedReplacement = encodeURIComponent(replacement);
  let changed = false;
  const segments = querySlice.split("&").map((segment) => {
    if (segment.length === 0) {
      return segment;
    }
    const eqIndex = segment.indexOf("=");
    const rawName = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const decodedName = safeDecodeQueryComponent(rawName);
    const rule = findMatchingRule(rules, "query", decodedName);
    if (!rule) {
      return segment;
    }
    changed = true;
    if (!alreadyTrackedNames.has(decodedName.toLowerCase())) {
      tracker.record("query", decodedName, rule.id);
    }
    return `${rawName}=${encodedReplacement}`;
  });

  if (!changed) {
    return text;
  }
  return `${base}${segments.join("&")}${suffix}`;
}

function redactTextUrl(
  text: string,
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
  alreadyTrackedNames: ReadonlySet<string>,
): string {
  return redactQueryText(
    redactUserinfo(text, rules, replacement, tracker),
    rules,
    replacement,
    alreadyTrackedNames,
    tracker,
  );
}

function redactUrlQuery(
  url: HarUrl,
  rules: readonly HarRedactionRule[],
  replacement: string,
  alreadyTrackedNames: ReadonlySet<string>,
  tracker: EntryRedactionTracker,
): HarUrl {
  const next = redactTextUrl(url, rules, replacement, tracker, alreadyTrackedNames);
  return toHarUrl(next) ?? url;
}

function redactJsonValue(
  value: unknown,
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): { readonly value: unknown; readonly changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = redactJsonValue(item, rules, replacement, tracker);
      if (result.changed) {
        changed = true;
      }
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, fieldVal] of Object.entries(value)) {
      const rule = findBodyRule(rules, key);
      if (rule) {
        changed = true;
        tracker.record("body", key, rule.id);
        next[key] = replacement;
      } else {
        const nested = redactJsonValue(fieldVal, rules, replacement, tracker);
        if (nested.changed) {
          changed = true;
        }
        next[key] = nested.value;
      }
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

function redactFormText(
  text: string,
  rules: readonly HarRedactionRule[],
  replacement: string,
  alreadyTrackedParams: ReadonlySet<string>,
  tracker: EntryRedactionTracker,
): string {
  const encodedReplacement = encodeURIComponent(replacement);
  let changed = false;
  const segments = text.split("&").map((segment) => {
    if (segment.length === 0) {
      return segment;
    }
    const eqIndex = segment.indexOf("=");
    const rawName = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const decodedName = safeDecodeQueryComponent(rawName);
    const rule = findBodyRule(rules, decodedName);
    if (!rule) {
      return segment;
    }
    changed = true;
    if (!alreadyTrackedParams.has(decodedName.toLowerCase())) {
      tracker.record("body", decodedName, rule.id);
    }
    return `${rawName}=${encodedReplacement}`;
  });
  return changed ? segments.join("&") : text;
}

function redactMultipartText(
  text: string,
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): string {
  return text.replace(
    /(content-disposition:[^\r\n]*\bname="([^"]+)"[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n)([\s\S]*?)(?=\r\n--|$)/giu,
    (match, headers: string, name: string) => {
      const rule = findBodyRule(rules, name);
      if (!rule) {
        return match;
      }
      tracker.record("body", name, rule.id);
      return `${headers}${replacement}`;
    },
  );
}

function redactResponseContent(
  content: HarContent,
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): HarContent {
  const text = content.text;
  if (text === undefined || text.length === 0 || content.encoding?.toLowerCase() === "base64") {
    return content;
  }
  const mime = content.mimeType.toLowerCase();
  const trimmed = text.trimStart();
  const looksJson = mime.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson) {
    return content;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const redacted = redactJsonValue(parsed, rules, replacement, tracker);
    if (!redacted.changed) {
      return content;
    }
    const nextText = JSON.stringify(redacted.value);
    return { ...content, text: nextText };
  } catch {
    return content;
  }
}

function redactInitiatorValue(
  value: unknown,
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): unknown {
  if (typeof value === "string") {
    if (!value.includes("?") && !value.includes("@")) {
      return value;
    }
    return redactTextUrl(value, rules, replacement, tracker, new Set());
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactInitiatorValue(item, rules, replacement, tracker));
  }
  if (typeof value === "object" && value !== null) {
    const next: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      next[key] = redactInitiatorValue(field, rules, replacement, tracker);
    }
    return next;
  }
  return value;
}

function redactPostData(
  postData: HarPostData | undefined,
  rules: readonly HarRedactionRule[],
  replacement: string,
  tracker: EntryRedactionTracker,
): HarPostData | undefined {
  if (!postData) {
    return undefined;
  }

  const trackedParams = new Set<string>();
  const params: HarPostDataParam[] = postData.params.map((param) => {
    const rule = findBodyRule(rules, param.name);
    if (!rule || param.value === undefined) {
      return param;
    }
    trackedParams.add(param.name.toLowerCase());
    tracker.record("body", param.name, rule.id);
    return {
      ...param,
      value: replacement,
      comment: appendComment(param.comment, `redacted by ${rule.id}`),
    };
  });

  let text = postData.text;
  const mimeLower = postData.mimeType.toLowerCase();
  if (text.length > 0) {
    if (mimeLower.includes("json")) {
      try {
        const parsed: unknown = JSON.parse(text);
        const redacted = redactJsonValue(parsed, rules, replacement, tracker);
        if (redacted.changed) {
          text = JSON.stringify(redacted.value);
        }
      } catch {
        // Leave non-JSON payload unchanged when Content-Type mislabels it.
      }
    } else if (mimeLower.includes("x-www-form-urlencoded")) {
      text = redactFormText(text, rules, replacement, trackedParams, tracker);
    } else if (mimeLower.includes("multipart/")) {
      text = redactMultipartText(text, rules, replacement, tracker);
    }
  }

  return {
    ...postData,
    params,
    text,
  };
}

function redactEntry(
  entry: HarEntry,
  entryIndex: number,
  rules: readonly HarRedactionRule[],
  replacement: string,
): { readonly entry: HarEntry; readonly records: readonly HarRedactionRecord[] } {
  const tracker = new EntryRedactionTracker(entryIndex);

  const requestHeaders = redactHeaders(entry.request.headers, rules, replacement, tracker);
  const requestCookies = redactCookies(entry.request.cookies, rules, replacement, tracker);
  const { pairs: queryString, trackedNames } = redactQueryString(
    entry.request.queryString,
    rules,
    replacement,
    tracker,
  );
  const url = redactUrlQuery(entry.request.url, rules, replacement, trackedNames, tracker);
  const postData = redactPostData(entry.request.postData, rules, replacement, tracker);

  const responseHeaders = redactHeaders(entry.response.headers, rules, replacement, tracker);
  const responseCookies = redactCookies(entry.response.cookies, rules, replacement, tracker);
  const redirectURL = redactTextUrl(
    entry.response.redirectURL,
    rules,
    replacement,
    tracker,
    new Set(),
  );
  const content = redactResponseContent(entry.response.content, rules, replacement, tracker);
  const inspectInitiator = rules.some((rule) => rule.target === "initiator");
  const initiator = inspectInitiator
    ? redactInitiatorValue(entry._initiator, rules, replacement, tracker)
    : entry._initiator;

  const records = tracker.buildRecords(url);
  if (records.length === 0) {
    return { entry, records };
  }

  const existingFields = entry._harExport?.redactedFields ?? [];
  const mergedFields = [...new Set([...existingFields, ...tracker.fields])];

  const updatedEntry: HarEntry = {
    ...entry,
    request: {
      ...entry.request,
      url,
      headers: requestHeaders,
      cookies: requestCookies,
      queryString,
      ...(postData !== undefined ? { postData } : {}),
    },
    response: {
      ...entry.response,
      headers: responseHeaders,
      cookies: responseCookies,
      redirectURL,
      content,
    },
    ...(initiator !== undefined ? { _initiator: initiator as HarEntry["_initiator"] } : {}),
    _harExport: {
      ...entry._harExport,
      redactedFields: mergedFields,
    },
  };

  return { entry: updatedEntry, records };
}

function redactPageTitle(
  title: string,
  rules: readonly HarRedactionRule[],
  replacement: string,
): string {
  const titleUrl = toHarUrl(title);
  if (!titleUrl) {
    return title;
  }
  const tracker = new EntryRedactionTracker(-1);
  return redactUrlQuery(titleUrl, rules, replacement, new Set(), tracker);
}

function pageTitleRecords(
  before: string,
  after: string,
  rules: readonly HarRedactionRule[],
  replacement: string,
): readonly HarRedactionRecord[] {
  if (before === after) {
    return [];
  }
  const tracker = new EntryRedactionTracker(-1);
  const titleUrl = toHarUrl(before);
  if (!titleUrl) {
    return [];
  }
  const redacted = redactUrlQuery(titleUrl, rules, replacement, new Set(), tracker);
  const url = toHarUrl(String(redacted)) ?? titleUrl;
  return tracker.buildRecords(url).map((record) => ({ ...record, target: "page" as const }));
}

export function redactHar(document: HarDocument, options?: RedactHarOptions): RedactHarResult {
  const rules = [...(options?.rules ?? DEFAULT_REDACTION_RULES), ...(options?.extraRules ?? [])];
  const replacement = options?.replacement ?? DEFAULT_REPLACEMENT;

  const allRecords: HarRedactionRecord[] = [];
  const appliedRules = new Set<string>();
  let entriesAffected = 0;

  const pages = document.log.pages?.map((page) => {
    const nextTitle = redactPageTitle(page.title, rules, replacement);
    if (nextTitle === page.title) {
      return page;
    }
    for (const record of pageTitleRecords(page.title, nextTitle, rules, replacement)) {
      allRecords.push(record);
      appliedRules.add(record.ruleId);
    }
    return { ...page, title: nextTitle };
  });

  const entries = document.log.entries.map((entry, index) => {
    const result = redactEntry(entry, index, rules, replacement);
    if (result.records.length > 0) {
      entriesAffected += 1;
      for (const record of result.records) {
        allRecords.push(record);
        appliedRules.add(record.ruleId);
      }
    }
    return result.entry;
  });

  const totalRemoved = allRecords.reduce((sum, record) => sum + record.count, 0);
  const report: HarLogRedactionExtension = {
    applied: true,
    totalRemoved,
    entriesAffected,
    rules: [...appliedRules],
    records: allRecords,
    notInspected: notInspectedPlaces(rules),
  };

  const redactedDocument: HarDocument = {
    log: {
      ...document.log,
      ...(pages !== undefined ? { pages } : {}),
      entries,
      _harExport: {
        ...document.log._harExport,
        redaction: report,
      },
    },
  };

  return { document: redactedDocument, report };
}
