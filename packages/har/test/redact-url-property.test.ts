import { describe, expect, it } from "vite-plus/test";

import { isHarUrl, type HarDocument } from "../src/model.ts";
import { redactHar } from "../src/redact.ts";

interface UrlCase {
  readonly url: string;
  // Text the level removes: under `shareable` every query value, query name, fragment and userinfo,
  // under `standard` the userinfo and the values of listed query names.
  readonly shareableRemoves: readonly string[];
  readonly standardRemoves: readonly string[];
}

const SCHEME_SHAPES: ReadonlyArray<(userinfo: string) => string> = [
  (userinfo) => `https://${userinfo}app.example/a/b`,
  (userinfo) => `http://${userinfo}app.example:8080/`,
  (userinfo) => `wss://${userinfo}[::1]:8443/socket`,
  (userinfo) => `ftp://${userinfo}files.example`,
  (userinfo) => `https://${userinfo}/no-host`,
  () => "data:",
  () => "data:text/plain;base64,QUJD",
  (userinfo) => `blob:https://${userinfo}app.example/0d1f`,
  (userinfo) => `view-source:https://${userinfo}app.example/index.html`,
  (userinfo) => `jar:https://${userinfo}app.example/bundle.jar!/main.js`,
  (userinfo) => `blob:https://${userinfo}/no-host`,
  () => "about:",
  () => "about:blank",
  () => "javascript:void(0)",
  () => "mailto:someone@mail.example",
  () => "/relative/path",
  () => "",
];

const USERINFO: ReadonlyArray<(marker: string) => string> = [
  () => "",
  (marker) => `user:${marker}@`,
  (marker) => `${marker}@`,
  (marker) => `user:%4D${marker.slice(1)}@`,
];

const QUERIES: ReadonlyArray<(marker: string) => string> = [
  () => "",
  () => "?",
  (marker) => `?access_token=${marker}`,
  (marker) => `?q=${marker}&page=2`,
  (marker) => `?${marker}=1`,
  (marker) => `?x=${encodeURIComponent(`é${marker}`)}`,
  (marker) => `?token=%4D${marker.slice(1)}&&`,
  (marker) => `?%61ccess_token=${marker}`,
];

const FRAGMENTS: ReadonlyArray<(marker: string) => string> = [
  () => "",
  () => "#",
  (marker) => `#${marker}`,
  (marker) => `#access_token=${marker}`,
];

function buildCases(): readonly UrlCase[] {
  const cases: UrlCase[] = [];
  let seq = 0;
  const marker = (part: string) => {
    seq += 1;
    return `M${part}${String(seq)}Z`;
  };
  for (const shape of SCHEME_SHAPES) {
    for (const userinfo of USERINFO) {
      for (const query of QUERIES) {
        for (const fragment of FRAGMENTS) {
          const user = marker("U");
          const queryMarker = marker("Q");
          const fragmentMarker = marker("F");
          const userText = userinfo(user);
          const head = shape(userText);
          const queryText = query(queryMarker);
          const fragmentText = fragment(fragmentMarker);
          const holds = (text: string, id: string) => (text.includes(id.slice(1)) ? [id] : []);
          const secretQuery = ["?access_token=", "?token=", "?%61ccess_token="].some((name) =>
            queryText.startsWith(name),
          );
          cases.push({
            url: `${head}${queryText}${fragmentText}`,
            shareableRemoves: [
              ...(head.includes(userText) && userText.length > 0 ? holds(userText, user) : []),
              ...holds(queryText, queryMarker),
              ...holds(fragmentText, fragmentMarker),
            ],
            standardRemoves: [
              ...(head.includes(userText) && userText.length > 0 ? holds(userText, user) : []),
              ...(secretQuery ? holds(queryText, queryMarker) : []),
            ],
          });
        }
      }
    }
  }
  return cases;
}

function documentWithUrls(urls: readonly string[]): HarDocument {
  return {
    log: {
      version: "1.2",
      creator: { name: "c", version: "1" },
      entries: urls.map((url) => ({
        startedDateTime: "2026-11-16T09:00:00.000Z",
        time: 1,
        request: {
          method: "GET",
          url,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: 200,
          statusText: "OK",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          content: { size: 0, mimeType: "text/plain" },
          redirectURL: "",
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  } as unknown as HarDocument;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Each marker's text without its first letter, so a percent-escaped first letter still matches.
function holdsMarker(text: string, marker: string): boolean {
  const tail = marker.slice(1);
  return text.includes(tail) || decoded(text).includes(tail);
}

describe("request URL redaction over generated URLs", () => {
  const cases = buildCases();

  it("covers every scheme shape, with and without authority, userinfo, query and fragment", () => {
    expect(cases.length).toBe(
      SCHEME_SHAPES.length * USERINFO.length * QUERIES.length * FRAGMENTS.length,
    );
    expect(cases.some((item) => !isHarUrl(item.url))).toBe(true);
    expect(cases.some((item) => isHarUrl(item.url) && item.url.startsWith("data:?"))).toBe(true);
  });

  for (const level of ["shareable", "standard"] as const) {
    it(`leaves no ${level}-removed text in the output and never puts an input URL back (${level})`, () => {
      const { document, report } = redactHar(documentWithUrls(cases.map((item) => item.url)), {
        level,
      });
      const failures: string[] = [];
      const replaced = new Set(
        report.records
          .filter((record) => record.place === "wrong-type" && record.field === "request.url")
          .map((record) => record.entryIndex),
      );
      document.log.entries.forEach((entry, index) => {
        const item = cases[index]!;
        const output = JSON.stringify(entry);
        const removes = level === "shareable" ? item.shareableRemoves : item.standardRemoves;
        for (const marker of removes) {
          if (holdsMarker(output, marker)) {
            failures.push(`${item.url} kept ${marker} as ${entry.request.url}`);
          }
        }
        if (!isHarUrl(entry.request.url)) {
          failures.push(`${item.url} gave an invalid URL ${entry.request.url}`);
        }
        if (!isHarUrl(item.url) && entry.request.url === item.url) {
          failures.push(`${item.url} is not a URL and was passed through`);
        }
        if (entry.request.url === "https://redacted.invalid/" && !replaced.has(index)) {
          failures.push(`${item.url} was replaced without a wrong-type record`);
        }
      });
      expect(failures).toEqual([]);
      for (const place of ["request-url-userinfo", "request-url-query-secret"]) {
        expect(report.places.find((entry) => entry.place === place)?.status).toBe("removed");
      }
      if (level === "shareable") {
        for (const place of ["request-url-query", "request-url-fragment"]) {
          expect(report.places.find((entry) => entry.place === place)?.status).toBe("removed");
        }
      }
    });
  }
});

// A small seeded generator, so every run plants the same URLs and a failure can be replayed.
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface NestedCase {
  readonly text: string;
  readonly userinfo: readonly string[];
}

const KNOWN_WRAPPERS: ReadonlyArray<(inner: string) => string> = [
  (inner) => `blob:${inner}`,
  (inner) => `view-source:${inner}`,
  (inner) => `jar:${inner}!/inner.js`,
  (inner) => `filesystem:${inner}/temporary/file.txt`,
  (inner) => `feed:${inner}`,
  (inner) => `web+x:${inner}`,
];

const AUTHORITY_SCHEMES = ["https", "http", "wss", "ftp", "moz-extension", "x-unknown+v2"];

function buildNestedCases(count: number): readonly NestedCase[] {
  const random = seededRandom(20261116);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const unknownScheme = () =>
    `${pick(["a", "q", "z"])}${Math.floor(random() * 1e6).toString(36)}${pick(["", "+x", ".y", "-z"])}`;
  let seq = 0;
  const cases: NestedCase[] = [];
  for (let index = 0; index < count; index += 1) {
    const userinfo: string[] = [];
    const credential = () => {
      seq += 1;
      const marker = `MN${String(seq)}Z`;
      userinfo.push(marker);
      return pick([`user:${marker}@`, `${marker}@`, `${marker}:pw@`]);
    };
    let url = `${pick(AUTHORITY_SCHEMES)}://${credential()}inner.example/p`;
    const depth = 1 + Math.floor(random() * 3);
    for (let level = 0; level < depth; level += 1) {
      const outer = `${pick(AUTHORITY_SCHEMES)}://${credential()}outer${String(level)}.example`;
      url = pick<(inner: string) => string>([
        ...KNOWN_WRAPPERS,
        (inner) => `${unknownScheme()}:${inner}`,
        (inner) => `${outer}/go/${inner}`,
        (inner) => `${outer}/?next=${inner}`,
        (inner) => `${outer}/?next=${encodeURIComponent(inner)}`,
        (inner) => `${outer}/?next=${encodeURIComponent(encodeURIComponent(inner))}`,
        (inner) => `${outer}/#${inner}`,
      ])(url);
    }
    cases.push({ text: url, userinfo });
  }
  return cases;
}

describe("userinfo in URLs inside URLs", () => {
  const cases = buildNestedCases(3000);

  it("plants userinfo at up to four authorities per URL, in wrappers known and unknown", () => {
    expect(Math.max(...cases.map((item) => item.userinfo.length))).toBe(4);
    expect(cases.some((item) => /^[a-z][a-z0-9]*[+.-]?[a-z]?:(?!\/)/u.test(item.text))).toBe(true);
  });

  for (const level of ["standard", "shareable"] as const) {
    it(`removes the userinfo of every authority in request URLs and page titles (${level})`, () => {
      const document = documentWithUrls(cases.map((item) => item.text));
      const withTitles = {
        log: {
          ...document.log,
          pages: cases.map((item, index) => ({
            startedDateTime: "2026-11-16T09:00:00.000Z",
            id: `p${String(index)}`,
            title: `Opened ${item.text} from the menu`,
            pageTimings: {},
          })),
        },
      } as unknown as HarDocument;
      const { document: redacted } = redactHar(withTitles, { level });
      const raw = JSON.stringify(redacted.log.entries) + JSON.stringify(redacted.log.pages);
      const output = `${raw}\n${decoded(raw)}`;
      const survivors = cases.flatMap((item) =>
        item.userinfo.filter((marker) => output.includes(marker.slice(1))),
      );
      expect(survivors).toEqual([]);
    });
  }
});
