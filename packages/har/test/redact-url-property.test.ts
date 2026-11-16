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
  () => "blob:https://app.example/0d1f",
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
          const secretQuery =
            queryText.startsWith("?access_token=") || queryText.startsWith("?token=");
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
