import {
  toHarUrl,
  type HarCookie,
  type HarDocument,
  type HarEntry,
  type HarLogRedactionExtension,
  type HarNameValue,
  type HarPostData,
  type HarPostDataParam,
  type HarRedactionRecord,
  type HarRedactionTarget,
  type HarUrl,
} from "./model.ts";

export interface HarRedactionRule {
  readonly id: string;
  readonly target: HarRedactionTarget;
  // Empty list on a cookie rule matches every cookie name.
  readonly names: readonly string[];
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
  { id: "cookie:all", target: "cookie", names: [] },
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
];

const DEFAULT_REPLACEMENT = "[REDACTED]";

function safeDecodeComponent(raw: string): string {
  const withSpaces = raw.replace(/\+/gu, " ");
  try {
    return decodeURIComponent(withSpaces);
  } catch {
    return withSpaces;
  }
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
    if (target === "cookie" && rule.names.length === 0) {
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
    if (!rule) {
      return header;
    }
    tracker.record("header", header.name, rule.id);
    return {
      ...header,
      value: replacement,
      comment: appendComment(header.comment, `redacted by ${rule.id}`),
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

function redactUrlQuery(
  url: HarUrl,
  rules: readonly HarRedactionRule[],
  replacement: string,
  alreadyTrackedNames: ReadonlySet<string>,
  tracker: EntryRedactionTracker,
): HarUrl {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) {
    return url;
  }
  const hashStart = url.indexOf("#", queryStart + 1);
  const base = url.slice(0, queryStart + 1);
  const querySlice =
    hashStart === -1 ? url.slice(queryStart + 1) : url.slice(queryStart + 1, hashStart);
  const suffix = hashStart === -1 ? "" : url.slice(hashStart);
  if (querySlice.length === 0) {
    return url;
  }

  const encodedReplacement = encodeURIComponent(replacement);
  let changed = false;
  const segments = querySlice.split("&").map((segment) => {
    if (segment.length === 0) {
      return segment;
    }
    const eqIndex = segment.indexOf("=");
    const rawName = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const decodedName = safeDecodeComponent(rawName);
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
    return url;
  }
  return toHarUrl(`${base}${segments.join("&")}${suffix}`) ?? url;
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
      const rule = findMatchingRule(rules, "body", key);
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
    const decodedName = safeDecodeComponent(rawName);
    const rule = findMatchingRule(rules, "body", decodedName);
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
    const rule = findMatchingRule(rules, "body", param.name);
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

  const records = tracker.buildRecords(url);
  if (records.length === 0) {
    return { entry, records };
  }

  const existingFields = entry._harAnytime?.redactedFields ?? [];
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
    },
    _harAnytime: {
      ...entry._harAnytime,
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

export function redactHar(document: HarDocument, options?: RedactHarOptions): RedactHarResult {
  const rules = [...(options?.rules ?? DEFAULT_REDACTION_RULES), ...(options?.extraRules ?? [])];
  const replacement = options?.replacement ?? DEFAULT_REPLACEMENT;

  const allRecords: HarRedactionRecord[] = [];
  const appliedRules = new Set<string>();
  let entriesAffected = 0;

  const pages = document.log.pages?.map((page) => {
    const nextTitle = redactPageTitle(page.title, rules, replacement);
    return nextTitle === page.title ? page : { ...page, title: nextTitle };
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
  };

  const redactedDocument: HarDocument = {
    log: {
      ...document.log,
      ...(pages !== undefined ? { pages } : {}),
      entries,
      _harAnytime: {
        ...document.log._harAnytime,
        redaction: report,
      },
    },
  };

  return { document: redactedDocument, report };
}
