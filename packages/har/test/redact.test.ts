import { describe, expect, it } from "vite-plus/test";

import { buildHar } from "../src/build.ts";
import { toHarUrl, toIsoDateTime, toMimeType } from "../src/model.ts";
import { parseHar } from "../src/parse.ts";
import { DEFAULT_REDACTION_RULES, REDACTION_LEVEL_TABLE, redactHar } from "../src/redact.ts";

describe("redactHar", () => {
  it("removes every listed secret across headers, cookies, query, and body and records removals", () => {
    const doc = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: {
            method: "POST",
            url: toHarUrl("https://api.example/oauth/token?access_token=q-secret-1&page=2")!,
            headers: [
              { name: "Cookie", value: "sid=cookie-secret-1" },
              { name: "Authorization", value: "Bearer auth-secret-1" },
              { name: "Proxy-Authorization", value: "Basic proxy-secret-1" },
              { name: "Accept", value: "application/json" },
            ],
            cookies: [{ name: "sid", value: "cookie-secret-1" }],
            postData: {
              mimeType: toMimeType("application/json")!,
              text: JSON.stringify({
                user: "alice",
                nested: { password: "body-json-secret-1" },
              }),
            },
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: [{ name: "Set-Cookie", value: "refresh=set-cookie-secret-1; HttpOnly" }],
            cookies: [{ name: "refresh", value: "set-cookie-secret-1", httpOnly: true }],
            content: {
              mimeType: toMimeType("application/json")!,
              text: '{"status":"ok"}',
            },
          },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:01.000Z")!,
          request: {
            method: "POST",
            url: toHarUrl("https://api.example/form")!,
            postData: {
              mimeType: toMimeType("application/x-www-form-urlencoded")!,
              params: [
                { name: "client_secret", value: "form-secret-1" },
                { name: "grant_type", value: "client_credentials" },
              ],
              text: "client_secret=form-secret-1&grant_type=client_credentials",
            },
          },
          response: {
            status: 204,
          },
        },
      ],
    });

    const { document: redacted, report } = redactHar(doc);
    const serialized = JSON.stringify(redacted);

    for (const secret of [
      "cookie-secret-1",
      "auth-secret-1",
      "proxy-secret-1",
      "set-cookie-secret-1",
      "q-secret-1",
      "body-json-secret-1",
      "form-secret-1",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    const first = redacted.log.entries[0]!;
    expect(first.request.url).toBe(
      "https://api.example/oauth/token?access_token=%5BREDACTED%5D&page=2",
    );
    expect(first.request.queryString).toEqual([
      {
        name: "access_token",
        value: "[REDACTED]",
        comment: "redacted by query:secrets",
      },
      { name: "page", value: "2" },
    ]);
    expect(first.request.headers.find((h) => h.name === "Accept")?.value).toBe("application/json");
    expect(JSON.parse(first.request.postData!.text ?? "")).toEqual({
      user: "alice",
      nested: { password: "[REDACTED]" },
    });

    const second = redacted.log.entries[1]!;
    expect(second.request.postData?.text).toBe(
      "client_secret=%5BREDACTED%5D&grant_type=client_credentials",
    );

    expect(report.applied).toBe(true);
    expect(report.level).toBe("default");
    expect(report.guarantee).toBe(REDACTION_LEVEL_TABLE.default.guarantee);
    expect(report.entriesAffected).toBe(2);
    expect(report.totalRemoved).toBe(11);
    expect(report.records.some((record) => record.target === "page")).toBe(true);
    expect(report.notInspected).toEqual([]);
    expect(report.places.every((place) => place.status !== "not-examined")).toBe(true);
    expect(redacted.log._harExport?.redaction).toEqual(report);
    expect(first._harExport?.redactedFields).toContain("header:Authorization");
    expect(first._harExport?.redactedFields).toContain("query:access_token");
    expect(first._harExport?.redactedFields).toContain("body:password");
    expect(parseHar(redacted).ok).toBe(true);
  });

  it("documents the rule-table limit when a secret is planted in an unlisted place", () => {
    expect(DEFAULT_REDACTION_RULES.some((rule) => rule.target === "header")).toBe(true);
    const unlistedHeaderSecret = "unlisted-custom-header-secret";
    const unlistedResponseBodySecret = "unlisted-response-body-secret";

    const doc = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: {
            method: "GET",
            url: toHarUrl("https://api.example/debug")!,
            headers: [
              { name: "Authorization", value: "Bearer listed-secret" },
              { name: "X-Custom-Debug-Token", value: unlistedHeaderSecret },
            ],
          },
          response: {
            status: 200,
            content: {
              mimeType: toMimeType("application/json")!,
              text: JSON.stringify({ diagnosticToken: unlistedResponseBodySecret }),
            },
          },
        },
      ],
    });

    const defaultRedacted = redactHar(doc);
    const defaultEntry = defaultRedacted.document.log.entries[0]!;
    expect(defaultEntry.request.headers.find((h) => h.name === "Authorization")?.value).toBe(
      "[REDACTED]",
    );
    expect(defaultEntry.request.headers.find((h) => h.name === "X-Custom-Debug-Token")?.value).toBe(
      unlistedHeaderSecret,
    );
    expect(defaultEntry.response.content.text).toContain(unlistedResponseBodySecret);
    const headerPlace = defaultRedacted.report.places.find((place) => place.place === "url-header");
    const bodyPlace = defaultRedacted.report.places.find(
      (place) => place.place === "response-body-json",
    );
    expect(headerPlace?.status).toBe("examined");
    expect(headerPlace?.canStillHold).toContain("hyphenated slug");
    expect(bodyPlace?.status).toBe("examined");
    expect(bodyPlace?.canStillHold).toContain("hyphenated slug");
    expect(defaultRedacted.report.notInspected).toEqual([]);

    const withExtraRule = redactHar(doc, {
      extraRules: [
        { id: "header:custom-debug", target: "header", names: ["x-custom-debug-token"] },
      ],
    });
    expect(
      withExtraRule.document.log.entries[0]!.request.headers.find(
        (h) => h.name === "X-Custom-Debug-Token",
      )?.value,
    ).toBe("[REDACTED]");
  });

  it("removes every planted secret, records the page title, and names uninspected places", () => {
    const secret = (key: string) => `SECRET_${key}_7f3a`;
    const pair = (name: string, value: string) => ({ name, value });
    const planted = {
      startedDateTime: "2026-11-16T06:00:00.000Z",
      time: 10,
      request: {
        method: "POST",
        url: `https://user:${secret("URLPASS")}@api.example/v1/items?access_token=${secret("QUERY")}&q=1`,
        httpVersion: "HTTP/2",
        cookies: [{ name: "sid", value: secret("COOKIEARR") }],
        headers: [
          pair("AUTHORIZATION", `Bearer ${secret("AUTHHDR")}`),
          pair("Cookie", `sid=${secret("COOKIEHDR")}`),
          pair("X-Api-Key", secret("XAPIKEY")),
          pair("Referer", `https://app.example/cb?code=${secret("REFERER")}`),
          pair(":path", `/v1/items?access_token=${secret("H2PATH")}`),
          pair("X-CSRF-Token", secret("CSRF")),
        ],
        queryString: [pair("access_token", secret("QUERY")), pair("q", "1")],
        headersSize: -1,
        bodySize: 0,
        postData: {
          mimeType: "application/json",
          params: [{ name: "password", value: secret("PARAM") }],
          text: JSON.stringify({
            password: secret("JSONPW"),
            accessToken: secret("CAMEL"),
            nested: { client_secret: secret("NESTED") },
          }),
        },
      },
      response: {
        status: 302,
        statusText: "Found",
        httpVersion: "HTTP/2",
        cookies: [{ name: "sid", value: secret("RESCOOKIE") }],
        headers: [
          pair("Set-Cookie", `sid=${secret("SETCOOKIE")}; HttpOnly`),
          pair("Location", `https://app.example/cb?code=${secret("LOCATION")}`),
        ],
        content: {
          mimeType: "application/json",
          size: 80,
          text: JSON.stringify({
            access_token: secret("RESBODY"),
            refresh_token: secret("RESBODY2"),
          }),
        },
        redirectURL: `https://app.example/cb?code=${secret("REDIRECT")}`,
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 1, wait: 5, receive: 4 },
      pageref: "page_1",
      _initiator: { type: "script", url: `https://app.example/x.js?token=${secret("INITIATOR")}` },
    };
    const formEntry = {
      startedDateTime: "2026-11-16T06:00:01.000Z",
      time: 10,
      request: {
        method: "POST",
        url: "https://api.example/login",
        httpVersion: "HTTP/2",
        cookies: [],
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
        postData: {
          mimeType: "application/x-www-form-urlencoded",
          params: [],
          text: `user=a&password=${secret("FORM")}`,
        },
      },
      response: {
        status: 200,
        statusText: "OK",
        httpVersion: "HTTP/2",
        cookies: [],
        headers: [],
        content: { mimeType: "text/html", size: 0 },
        redirectURL: "",
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 1, wait: 1, receive: 1 },
    };
    const multipartEntry = {
      startedDateTime: "2026-11-16T06:00:02.000Z",
      time: 10,
      request: {
        method: "POST",
        url: "https://api.example/upload",
        httpVersion: "HTTP/2",
        cookies: [],
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
        postData: {
          mimeType: "multipart/form-data; boundary=b",
          params: [],
          text: `--b\r\nContent-Disposition: form-data; name="password"\r\n\r\n${secret("MULTIPART")}\r\n--b--`,
        },
      },
      response: {
        status: 200,
        statusText: "OK",
        httpVersion: "HTTP/2",
        cookies: [],
        headers: [],
        content: { mimeType: "text/html", size: 0 },
        redirectURL: "",
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 1, wait: 1, receive: 1 },
    };
    const keys = [
      "URLPASS",
      "QUERY",
      "AUTHHDR",
      "COOKIEHDR",
      "XAPIKEY",
      "REFERER",
      "H2PATH",
      "CSRF",
      "COOKIEARR",
      "PARAM",
      "JSONPW",
      "CAMEL",
      "NESTED",
      "SETCOOKIE",
      "LOCATION",
      "RESCOOKIE",
      "REDIRECT",
      "RESBODY",
      "RESBODY2",
      "INITIATOR",
      "FORM",
      "MULTIPART",
      "PAGETITLE",
    ];
    const parsed = parseHar({
      log: {
        version: "1.2",
        creator: { name: "Caller", version: "1" },
        pages: [
          {
            id: "page_1",
            title: `https://app.example/?token=${secret("PAGETITLE")}`,
            startedDateTime: "2026-11-16T05:59:59.000Z",
            pageTimings: {},
          },
        ],
        entries: [planted, formEntry, multipartEntry],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const { document, report } = redactHar(parsed.document);
    const serialized = JSON.stringify(document);
    const leaked = keys.filter((key) => serialized.includes(secret(key)));
    expect(leaked).toEqual([]);
    expect(keys.filter((key) => !serialized.includes(secret(key)))).toHaveLength(23);
    expect(report.records.some((record) => record.target === "page")).toBe(true);
    expect(report.notInspected).toEqual([]);
    expect(report.places.find((place) => place.place === "request-url-userinfo")?.status).toBe(
      "removed",
    );
    expect("_harAnytime" in document.log).toBe(false);
    expect(document.log._harExport?.redaction).toEqual(report);
    expect(parseHar(document).ok).toBe(true);
  });
});
