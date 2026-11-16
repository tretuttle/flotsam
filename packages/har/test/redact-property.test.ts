import { describe, expect, it } from "vite-plus/test";

import { decodeAsciiBase64, encodeAsciiBase64 } from "./ascii-base64.ts";
import { HAR_REDACTION_PLACES, type HarRedactionPlace } from "../src/model.ts";
import { parseHar } from "../src/parse.ts";
import { redactHar } from "../src/redact.ts";

const CASES = 2000;
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SLOTS = [
  "request-url-query",
  "request-url-userinfo",
  "request-url-fragment",
  "request-url-path",
  "named-header",
  "url-header",
  "cookie",
  "query-string",
  "body-param",
  "body-json",
  "body-form",
  "body-multipart",
  "request-body-other",
  "redirect-url",
  "response-body-json",
  "response-body-base64",
  "page-title",
  "initiator",
  "response-body-other",
  "websocket",
  "cache",
  "comment",
  "other-custom-field",
] as const satisfies readonly HarRedactionPlace[];

type Slot = (typeof SLOTS)[number];
type Kind =
  | "jwt"
  | "bearer"
  | "entropy"
  | "url-credential"
  | "listed-name"
  | "short-random"
  | "hex-hash"
  | "uuid"
  | "image-base64";

const KINDS: readonly Kind[] = [
  "jwt",
  "bearer",
  "entropy",
  "url-credential",
  "listed-name",
  "short-random",
  "hex-hash",
  "uuid",
  "image-base64",
];

const QUERY_PLACES = new Set<HarRedactionPlace>([
  "request-url-query",
  "request-url-fragment",
  "query-string",
]);

const NAMED = new Set<Slot>([
  "request-url-query",
  "request-url-fragment",
  "query-string",
  "body-param",
  "body-json",
  "body-form",
  "body-multipart",
  "response-body-json",
  "response-body-base64",
  "other-custom-field",
  "websocket",
]);

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixed(rng: () => number, index: number, length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const head = `A${index.toString(36)}a1`;
  let body = head;
  while (body.length < length) {
    body += alphabet[Math.floor(rng() * alphabet.length)] ?? "A";
  }
  return body.slice(0, length);
}

function hex(rng: () => number, index: number): string {
  const digits = "0123456789abcdef";
  let body = index.toString(16).padStart(6, "0");
  while (body.length < 64) {
    body += digits[Math.floor(rng() * 16)] ?? "0";
  }
  return body.slice(0, 64);
}

function uuid(index: number): string {
  return `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, "0")}`;
}

function stamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
}

interface Planted {
  readonly index: number;
  readonly place: HarRedactionPlace;
  readonly kind: Kind;
  readonly marker: string;
  readonly wholesale: boolean;
}

function payload(
  kind: Kind,
  index: number,
  rng: () => number,
): { readonly marker: string; readonly text: string } {
  if (kind === "jwt") {
    const marker = mixed(rng, index, 24);
    return { marker, text: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.${marker}` };
  }
  if (kind === "bearer") {
    const marker = mixed(rng, index, 24);
    return { marker, text: `Bearer ${marker}` };
  }
  if (kind === "entropy") {
    const marker = mixed(rng, index, 24);
    return { marker, text: marker };
  }
  if (kind === "url-credential") {
    const marker = mixed(rng, index, 18);
    return { marker, text: `https://user:${marker}@files.example/a` };
  }
  if (kind === "listed-name") {
    const marker = `v${String(index)}`;
    return { marker, text: marker };
  }
  if (kind === "short-random") {
    const marker = `q${String(index)}z`;
    return { marker, text: marker };
  }
  if (kind === "hex-hash") {
    const marker = hex(rng, index);
    return { marker, text: marker };
  }
  if (kind === "uuid") {
    const marker = uuid(index);
    return { marker, text: marker };
  }
  return { marker: PNG, text: PNG };
}

function chooseSlot(natural: Slot, kind: Kind): Slot {
  let slot: Slot = natural;
  if (kind === "listed-name" && !NAMED.has(slot)) {
    slot = "body-json";
  }
  if (kind === "image-base64") {
    slot = "response-body-other";
  }
  if (kind === "url-credential" && (slot === "request-url-path" || slot === "cookie")) {
    slot = "request-url-userinfo";
  }
  if (kind !== "url-credential" && slot === "request-url-userinfo") {
    slot = "comment";
  }
  return slot;
}

function blank(index: number, url: string): Record<string, unknown> {
  return {
    pageref: `p${String(index)}`,
    startedDateTime: stamp(index),
    time: 5,
    request: {
      method: "GET",
      url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: { size: 1, mimeType: "text/plain", text: "ok" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 1,
    },
    cache: {},
    timings: { send: 1, wait: 1, receive: 1 },
  };
}

function plant(slot: Slot, kind: Kind, text: string, index: number): Record<string, unknown> {
  const key = kind === "listed-name" ? "password" : "note";
  const wrapped =
    text.includes("://") ||
    kind === "hex-hash" ||
    kind === "uuid" ||
    kind === "short-random" ||
    kind === "image-base64"
      ? text
      : `https://files.example/a?${key}=${encodeURIComponent(text)}`;
  if (slot === "request-url-query") {
    return blank(index, `https://ex.test/a?${key}=${encodeURIComponent(text)}`);
  }
  if (slot === "request-url-userinfo") {
    return blank(index, text.includes("://") ? text : `https://user:${text}@files.example/a`);
  }
  if (slot === "request-url-fragment") {
    return blank(index, `https://ex.test/cb#${key}=${encodeURIComponent(text)}`);
  }
  if (slot === "request-url-path") {
    return blank(index, `https://ex.test/p/${encodeURIComponent(text)}`);
  }
  if (slot === "page-title") {
    return blank(index, "https://ex.test/title");
  }
  if (slot === "named-header") {
    const row = blank(index, "https://ex.test/h");
    (row.request as Record<string, unknown>).headers = [
      { name: `X-Custom-${String(index)}`, value: text },
    ];
    return row;
  }
  if (slot === "url-header") {
    const row = blank(index, "https://ex.test/h");
    (row.request as Record<string, unknown>).headers = [{ name: "Referer", value: wrapped }];
    return row;
  }
  if (slot === "cookie") {
    const row = blank(index, "https://ex.test/c");
    (row.request as Record<string, unknown>).cookies = [{ name: "sid", value: text }];
    return row;
  }
  if (slot === "query-string") {
    const row = blank(index, "https://ex.test/q");
    (row.request as Record<string, unknown>).queryString = [{ name: key, value: text }];
    return row;
  }
  if (
    slot === "body-param" ||
    slot === "body-json" ||
    slot === "body-form" ||
    slot === "body-multipart" ||
    slot === "request-body-other"
  ) {
    const row = blank(index, "https://ex.test/b");
    const request = row.request as Record<string, unknown>;
    request.method = "POST";
    if (slot === "body-param") {
      request.postData = {
        mimeType: "application/x-www-form-urlencoded",
        params: [{ name: key, value: text }],
        text: "",
      };
    } else if (slot === "body-json") {
      request.postData = {
        mimeType: "application/json",
        params: [],
        text: JSON.stringify({ [key]: text }),
      };
    } else if (slot === "body-form") {
      request.postData = {
        mimeType: "application/x-www-form-urlencoded",
        params: [],
        text: `${key}=${encodeURIComponent(text)}`,
      };
    } else if (slot === "body-multipart") {
      request.postData = {
        mimeType: "multipart/form-data; boundary=b",
        params: [],
        text: `--b\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${text}\r\n--b--`,
      };
    } else {
      request.postData = { mimeType: "text/plain", params: [], text: `note ${text}` };
    }
    return row;
  }
  if (slot === "redirect-url") {
    const row = blank(index, "https://ex.test/r");
    (row.response as Record<string, unknown>).redirectURL = wrapped;
    return row;
  }
  if (slot === "response-body-json") {
    const row = blank(index, "https://ex.test/j");
    (row.response as Record<string, unknown>).content = {
      size: text.length,
      mimeType: "application/json",
      text: JSON.stringify({ [key]: text }),
    };
    return row;
  }
  if (slot === "response-body-base64") {
    const row = blank(index, "https://ex.test/b64");
    (row.response as Record<string, unknown>).content = {
      size: text.length,
      mimeType: "application/json",
      encoding: "base64",
      text: encodeAsciiBase64(JSON.stringify({ [key]: text })),
    };
    return row;
  }
  if (slot === "response-body-other") {
    const row = blank(index, "https://ex.test/html");
    (row.response as Record<string, unknown>).content = {
      size: text.length,
      mimeType: "text/html",
      text: kind === "image-base64" ? text : `<p>${text}</p>`,
    };
    return row;
  }
  if (slot === "initiator") {
    const row = blank(index, "https://ex.test/i");
    row._initiator = {
      type: "script",
      stack: {
        callFrames: [
          {
            functionName: "f",
            scriptId: "1",
            url: wrapped,
            lineNumber: 1,
            columnNumber: 1,
          },
        ],
      },
    };
    return row;
  }
  if (slot === "websocket") {
    const row = blank(index, "https://ex.test/ws");
    row._webSocketMessages = [
      { type: "send", time: 1, opcode: 1, data: JSON.stringify({ [key]: text }) },
    ];
    return row;
  }
  if (slot === "cache") {
    const row = blank(index, "https://ex.test/cache");
    row.cache = { beforeRequest: { eTag: text, hitCount: 1 } };
    return row;
  }
  if (slot === "other-custom-field") {
    const row = blank(index, "https://ex.test/custom");
    row._requestContext = { [key]: text };
    return row;
  }
  const row = blank(index, "https://ex.test/comment");
  row.comment = text;
  return row;
}

function admits(
  canStillHold: string,
  status: string,
  kind: Kind,
  place: HarRedactionPlace,
): boolean {
  if (status === "not-examined" || canStillHold.includes("Any secret can remain")) {
    return true;
  }
  if (canStillHold.includes("Nothing can remain")) {
    return false;
  }
  if (kind === "image-base64") {
    return /base64 image|not JSON/u.test(canStillHold);
  }
  if (kind === "uuid") {
    return canStillHold.includes("UUID");
  }
  if (kind === "hex-hash") {
    if (QUERY_PLACES.has(place) && canStillHold.includes("Hex of 16 or more characters")) {
      return false;
    }
    return /hex hash/u.test(canStillHold);
  }
  if (kind === "short-random") {
    return /shorter than \d+/u.test(canStillHold);
  }
  if (kind === "listed-name") {
    return canStillHold.includes("listed name can remain");
  }
  if (kind === "url-credential") {
    return (
      canStillHold.includes("URL can remain") || canStillHold.includes("Userinfo was not parsed")
    );
  }
  return canStillHold.includes("token-shaped value can remain");
}

describe("generated secret coverage", () => {
  it("removes each planted secret or names the place that can still hold it", () => {
    const rng = mulberry32(0xc0ffee);
    const planted: Planted[] = [];
    const entries: Record<string, unknown>[] = [];
    const pages: Record<string, unknown>[] = [];
    const seen = new Set<HarRedactionPlace>();
    const grid = SLOTS.length * KINDS.length;
    for (let index = 0; index < CASES; index += 1) {
      const kind =
        index < grid
          ? (KINDS[index % KINDS.length] ?? "entropy")
          : (KINDS[Math.floor(rng() * KINDS.length)] ?? "entropy");
      const natural =
        index < grid
          ? (SLOTS[Math.floor(index / KINDS.length)] ?? "comment")
          : (SLOTS[Math.floor(rng() * SLOTS.length)] ?? "comment");
      const slot = chooseSlot(natural, kind);
      const made = payload(kind, index, rng);
      entries.push(plant(slot, kind, made.text, index));
      pages.push({
        id: `p${String(index)}`,
        title: slot === "page-title" ? made.text : "https://ex.test/",
        startedDateTime: stamp(index),
        pageTimings: {},
      });
      planted.push({
        index,
        place: slot,
        kind,
        marker: made.marker,
        wholesale: slot === "cookie",
      });
      seen.add(slot);
    }
    expect([...SLOTS].sort()).toEqual([...HAR_REDACTION_PLACES].sort());
    expect([...seen].sort()).toEqual([...SLOTS].sort());

    const parsed = parseHar({
      log: {
        version: "1.2",
        creator: { name: "Caller", version: "1" },
        pages,
        entries,
      },
    });
    expect(
      parsed.ok,
      parsed.ok ? "" : parsed.problems.map((problem) => problem.message).join("\n"),
    ).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { document, report } = redactHar(parsed.document);
    const failures: string[] = [];
    for (const item of planted) {
      const entry = document.log.entries.find(
        (candidate) => candidate.startedDateTime === stamp(item.index),
      );
      const page = document.log.pages?.find(
        (candidate) => candidate.id === `p${String(item.index)}`,
      );
      const decoded =
        entry?.response.content.encoding === "base64" && entry.response.content.text
          ? decodeAsciiBase64(entry.response.content.text)
          : "";
      const haystack = `${JSON.stringify(entry ?? {})}\n${JSON.stringify(page ?? {})}\n${decoded}`;
      const stayed = haystack.includes(item.marker);
      const coverage = report.places.find((place) => place.place === item.place);
      if (!coverage) {
        failures.push(`${String(item.index)} ${item.place} missing coverage`);
        continue;
      }
      const benign =
        item.kind === "hex-hash" ||
        item.kind === "uuid" ||
        item.kind === "image-base64" ||
        item.kind === "short-random";
      const removedOnPurpose =
        item.wholesale || (item.kind === "hex-hash" && QUERY_PLACES.has(item.place));
      if (benign && !stayed && !removedOnPurpose) {
        failures.push(`${String(item.index)} ${item.kind} removed from ${item.place}`);
      }
      if (stayed && !admits(coverage.canStillHold, coverage.status, item.kind, item.place)) {
        failures.push(
          `${String(item.index)} ${item.kind} stayed in ${item.place} (${coverage.status}: ${coverage.canStillHold})`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
