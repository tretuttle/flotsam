import { describe, expect, it } from "vite-plus/test";

import {
  HAR_VALIDATION_RULES,
  parseHar,
  parseHarJson,
  type HarValidationRule,
} from "../src/parse.ts";

function makeValidHar(): Record<string, unknown> {
  return {
    log: {
      version: "1.2",
      creator: { name: "HAR Anytime", version: "1.0.0" },
      browser: { name: "Zen", version: "160.0" },
      pages: [
        {
          startedDateTime: "2026-11-16T05:00:00.000Z",
          id: "page_0",
          title: "https://example.com/",
          pageTimings: { onContentLoad: 120, onLoad: 240 },
        },
      ],
      entries: [
        {
          pageref: "page_0",
          startedDateTime: "2026-11-16T05:00:00.050Z",
          time: 45,
          request: {
            method: "GET",
            url: "https://example.com/?view=full",
            httpVersion: "HTTP/2.0",
            cookies: [{ name: "prefs", value: "compact" }],
            headers: [{ name: "Accept", value: "text/html" }],
            queryString: [{ name: "view", value: "full" }],
            headersSize: 128,
            bodySize: 0,
          },
          response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/2.0",
            cookies: [],
            headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
            content: {
              size: 15,
              mimeType: "text/html; charset=utf-8",
              text: "<h1>Hello</h1>\n",
            },
            redirectURL: "",
            headersSize: 96,
            bodySize: 15,
          },
          cache: {},
          timings: {
            blocked: 2,
            dns: 5,
            connect: 10,
            ssl: 5,
            send: 3,
            wait: 15,
            receive: 10,
          },
          serverIPAddress: "93.184.216.34",
          connection: "443",
        },
      ],
    },
  };
}

function cloneHar(mutate: (har: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(makeValidHar())) as Record<string, unknown>;
  mutate(copy);
  return copy;
}

describe("parseHar and parseHarJson", () => {
  it("parses a hand-written Firefox HAR fixture derived from har-builder.js with custom fields", () => {
    const firefoxHar = {
      log: {
        version: "1.2",
        creator: { name: "Zen", version: "160.0a1" },
        browser: { name: "Zen", version: "160.0a1" },
        pages: [
          {
            id: "page_1",
            pageTimings: { onContentLoad: 312, onLoad: 640 },
            startedDateTime: "2026-11-16T00:05:00.100-05:00",
            title: "https://app.example.test/models",
          },
        ],
        entries: [
          {
            startedDateTime: "2026-11-16T00:05:00.100-05:00",
            request: {
              bodySize: 0,
              method: "GET",
              url: "https://app.example.test/models",
              httpVersion: "HTTP/3",
              headers: [
                { name: "Host", value: "app.example.test" },
                { name: "Accept", value: "text/html" },
              ],
              cookies: [{ name: "sid", value: "abc123", httpOnly: true, secure: true }],
              queryString: [],
              headersSize: 210,
            },
            response: {
              status: 200,
              statusText: "OK",
              httpVersion: "HTTP/3",
              headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
              cookies: [],
              content: {
                mimeType: "text/html; charset=utf-8",
                size: 1200,
                comment: "Response bodies are not included.",
              },
              redirectURL: "",
              headersSize: 180,
              bodySize: 540,
            },
            cache: {},
            timings: {
              blocked: 1,
              dns: 4,
              connect: 12,
              ssl: 8,
              send: 1,
              wait: 24,
              receive: 6,
            },
            time: 56,
            _securityState: "secure",
            _priority: "Highest",
            serverIPAddress: "203.0.113.10",
            connection: "443",
            pageref: "page_1",
          },
          {
            startedDateTime: "2026-11-16T00:05:00.320-05:00",
            request: {
              bodySize: 23,
              method: "POST",
              url: "https://app.example.test/api/save",
              httpVersion: "HTTP/2.0",
              headers: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }],
              cookies: [],
              queryString: [],
              headersSize: 190,
              postData: {
                mimeType: "application/x-www-form-urlencoded",
                params: [
                  { name: "scene", value: "robot" },
                  { name: "format", value: "glb" },
                ],
                text: "scene=robot&format=glb",
              },
            },
            response: {
              status: 304,
              statusText: "Not Modified",
              httpVersion: "HTTP/2.0",
              headers: [],
              cookies: [],
              content: {
                mimeType: "application/json",
                size: 64,
                encoding: "base64",
                text: "eyJvayI6dHJ1ZX0=",
              },
              redirectURL: "",
              headersSize: 95,
              bodySize: 0,
            },
            cache: {
              afterRequest: {
                expires: "1794880000",
                lastFetched: "1794800000",
                fetchCount: "3",
                _dataSize: "64",
                _lastModified: "1794790000",
                _device: "disk",
              },
            },
            timings: {
              blocked: 0,
              dns: 0,
              connect: 0,
              ssl: 0,
              send: 2,
              wait: 11,
              receive: 1,
            },
            time: 14,
            _securityState: "secure",
            _priority: "Normal",
            pageref: "page_1",
          },
        ],
      },
    };

    const result = parseHar(firefoxHar);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.document.log.entries).toHaveLength(2);
    const first = result.document.log.entries[0]!;
    const second = result.document.log.entries[1]!;
    expect(first._securityState).toBe("secure");
    expect(first._priority).toBe("Highest");
    expect(second.cache.afterRequest?._device).toBe("disk");
    expect(second.cache.afterRequest?.fetchCount).toBe("3");
    expect(second.request.postData?.params).toHaveLength(2);
    expect(second.response.content.encoding).toBe("base64");
  });

  it("parses Chrome custom underscore fields and strips UTF-8 BOM", () => {
    const chromeHar = cloneHar((har) => {
      const log = har.log as Record<string, unknown>;
      const entries = log.entries as Array<Record<string, unknown>>;
      const entry = entries[0]!;
      entry._initiator = { type: "script", url: "https://example.com/app.js", lineNumber: 12 };
      entry._resourceType = "xhr";
      entry._fromCache = "disk";
      entry._webSocketMessages = [{ type: "send", time: 1.5, opcode: 1, data: "ping" }];
      const response = entry.response as Record<string, unknown>;
      response._transferSize = 240;
      response._error = null;
      const timings = entry.timings as Record<string, unknown>;
      timings._blocked_queueing = 1.2;
    });

    const jsonWithBom = `\uFEFF${JSON.stringify(chromeHar)}`;
    const result = parseHarJson(jsonWithBom);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const entry = result.document.log.entries[0]!;
    expect(entry._resourceType).toBe("xhr");
    expect(entry._fromCache).toBe("disk");
    expect(entry._initiator?.type).toBe("script");
    expect(entry.response._transferSize).toBe(240);
    expect(entry.timings._blocked_queueing).toBe(1.2);
  });

  const ruleFixtures: Record<
    HarValidationRule,
    {
      readonly pass: () => ReturnType<typeof parseHarJson>;
      readonly fail: () => ReturnType<typeof parseHarJson>;
    }
  > = {
    "json-syntax": {
      pass: () => parseHarJson(JSON.stringify(makeValidHar())),
      fail: () => parseHarJson("{not valid json"),
    },
    "root-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () => parseHar({ notLog: {} }),
    },
    "log-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () => parseHar({ log: [] }),
    },
    "log-version": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).version = "";
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).version = "2.0";
          }),
        ),
    },
    "creator-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).creator = { name: "", version: "1.0" };
          }),
        ),
    },
    "browser-object": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            delete (har.log as Record<string, unknown>).browser;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).browser = "Firefox";
          }),
        ),
    },
    "pages-array": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const log = har.log as Record<string, unknown>;
            delete log.pages;
            delete (log.entries as Array<Record<string, unknown>>)[0]!.pageref;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).pages = {};
          }),
        ),
    },
    "page-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            ((har.log as Record<string, unknown>).pages as unknown[])[0] = "bad-page";
          }),
        ),
    },
    "page-id-unique": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const pages = (har.log as Record<string, unknown>).pages as Array<
              Record<string, unknown>
            >;
            pages.push({
              startedDateTime: "2026-11-16T05:01:00.000Z",
              id: "page_1",
              title: "https://example.com/next",
              pageTimings: { onContentLoad: -1, onLoad: -1 },
            });
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const pages = (har.log as Record<string, unknown>).pages as Array<
              Record<string, unknown>
            >;
            pages.push({
              startedDateTime: "2026-11-16T05:01:00.000Z",
              id: "page_0",
              title: "https://example.com/dup",
              pageTimings: { onContentLoad: -1, onLoad: -1 },
            });
          }),
        ),
    },
    "page-timings-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const pages = (har.log as Record<string, unknown>).pages as Array<
              Record<string, unknown>
            >;
            pages[0]!.pageTimings = null;
          }),
        ),
    },
    "entries-array": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).entries = [];
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            (har.log as Record<string, unknown>).entries = "none";
          }),
        ),
    },
    "entry-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            ((har.log as Record<string, unknown>).entries as unknown[])[0] = 42;
          }),
        ),
    },
    "entry-pageref-exists": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.pageref = "missing_page";
          }),
        ),
    },
    "iso-datetime": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.startedDateTime = "2026-02-30T10:00:00Z";
          }),
        ),
    },
    "non-negative-number": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.time = -5;
          }),
        ),
    },
    "size-or-sentinel": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).headersSize = -1;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).headersSize = -2;
          }),
        ),
    },
    "timing-or-sentinel": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.timings as Record<string, unknown>).dns = -1;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.timings as Record<string, unknown>).dns = -2;
          }),
        ),
    },
    "request-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.request = null;
          }),
        ),
    },
    "request-url": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).url = "/relative/path";
          }),
        ),
    },
    "response-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.response = "ok";
          }),
        ),
    },
    "response-status": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).status = 0;
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).status = 1000;
          }),
        ),
    },
    "redirect-url": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).redirectURL =
              "https://example.com/next";
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).redirectURL = "not a url";
          }),
        ),
    },
    "content-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.response as Record<string, unknown>).content = null;
          }),
        ),
    },
    "mime-type": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (
              (entries[0]!.response as Record<string, unknown>).content as Record<string, unknown>
            ).mimeType = "";
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (
              (entries[0]!.response as Record<string, unknown>).content as Record<string, unknown>
            ).mimeType = "invalid-mime";
          }),
        ),
    },
    "post-data-object": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).postData = {
              mimeType: "application/json",
              text: "{}",
            };
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).postData = {
              mimeType: "application/json",
            };
          }),
        ),
    },
    "post-data-param-object": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).postData = {
              mimeType: "application/x-www-form-urlencoded",
              params: [{ name: "a", value: "1" }],
            };
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).postData = {
              mimeType: "application/x-www-form-urlencoded",
              params: [{ value: "missing-name" }],
            };
          }),
        ),
    },
    "name-value-array": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).headers = [{ name: "X-Test" }];
          }),
        ),
    },
    "cookie-array": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            (entries[0]!.request as Record<string, unknown>).cookies = [
              { name: "a", value: "1", httpOnly: "yes" },
            ];
          }),
        ),
    },
    "cache-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.cache = [];
          }),
        ),
    },
    "cache-entry-object": {
      pass: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.cache = { beforeRequest: null, afterRequest: { eTag: "v1", hitCount: 1 } };
          }),
        ),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.cache = { afterRequest: "bad" };
          }),
        ),
    },
    "timings-object": {
      pass: () => parseHar(makeValidHar()),
      fail: () =>
        parseHar(
          cloneHar((har) => {
            const entries = (har.log as Record<string, unknown>).entries as Array<
              Record<string, unknown>
            >;
            entries[0]!.timings = null;
          }),
        ),
    },
  };

  it("covers every validator rule with a passing and a failing fixture", () => {
    expect(Object.keys(ruleFixtures).sort()).toEqual([...HAR_VALIDATION_RULES].sort());

    for (const rule of HAR_VALIDATION_RULES) {
      const pair = ruleFixtures[rule];
      const passed = pair.pass();
      expect(passed.ok, `expected rule ${rule} pass fixture to succeed`).toBe(true);

      const failed = pair.fail();
      expect(failed.ok, `expected rule ${rule} fail fixture to fail`).toBe(false);
      if (!failed.ok) {
        expect(
          failed.problems.some((problem) => problem.rule === rule),
          `expected failure for rule ${rule}, got ${failed.problems.map((p) => p.rule).join(", ")}`,
        ).toBe(true);
      }
    }
  });
});
