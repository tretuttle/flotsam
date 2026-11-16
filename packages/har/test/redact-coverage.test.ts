import { describe, expect, it } from "vite-plus/test";

import { decodeAsciiBase64, encodeAsciiBase64 } from "./ascii-base64.ts";
import { buildHar } from "../src/build.ts";
import {
  HAR_REDACTION_PLACES,
  REDACTION_DETECTORS,
  REDACTION_LEVELS,
  toHarUrl,
  toIsoDateTime,
  toMimeType,
} from "../src/model.ts";
import { parseHar } from "../src/parse.ts";
import { REDACTION_LEVEL_TABLE, redactHar } from "../src/redact.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function entry(start: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    startedDateTime: start,
    time: 10,
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
      content: { size: 0, mimeType: "text/plain" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 1, wait: 1, receive: 1 },
    ...extra,
  };
}

describe("redaction coverage", () => {
  it("states each level as one guarantee and enforces it", () => {
    const secret = "Aa1entropySecretValue99";
    const doc = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: {
            method: "POST",
            url: toHarUrl("https://api.example/a")!,
            postData: {
              mimeType: toMimeType("text/plain")!,
              text: secret,
            },
          },
          response: {
            status: 200,
            content: { mimeType: toMimeType("text/plain")!, text: secret },
          },
          _requestContext: { apiKey: secret },
        },
      ],
    });

    const strict = redactHar(doc, { level: "strict" });
    const strictText = JSON.stringify(strict.document);
    expect(Object.keys(REDACTION_LEVEL_TABLE)).toEqual([...REDACTION_LEVELS]);
    expect(REDACTION_LEVEL_TABLE.default.detectors).toEqual([...REDACTION_DETECTORS]);
    expect(strict.report.guarantee).toBe(REDACTION_LEVEL_TABLE.strict.guarantee);
    expect(strictText).not.toContain(secret);
    expect(strict.document.log.entries[0]!.request.postData?.text).toBe("");
    expect(strict.document.log.entries[0]!.response.content.text).toBeUndefined();
    expect(strict.document.log.entries[0]!._requestContext).toBeUndefined();
    expect(
      strict.report.places.find((place) => place.place === "response-body-other")?.canStillHold,
    ).toBe("Nothing can remain. The field was removed.");

    const loose = redactHar(doc);
    expect(loose.report.guarantee).toBe(REDACTION_LEVEL_TABLE.default.guarantee);
    expect(JSON.stringify(loose.document)).not.toContain(secret);
  });

  it("keeps hashes, UUIDs, and base64 images, and removes hex in a query", () => {
    const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const doc = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          request: {
            method: "GET",
            url: toHarUrl(`https://cdn.example/a?sig=${hash}`)!,
          },
          response: {
            status: 200,
            content: {
              mimeType: toMimeType("application/json")!,
              text: JSON.stringify({ checksum: hash, id: uuid, icon: PNG }),
            },
          },
          comment: `${hash} ${uuid}`,
        },
      ],
    });
    const { document, report } = redactHar(doc);
    const body = document.log.entries[0]!.response.content.text ?? "";
    expect(document.log.entries[0]!.request.url).not.toContain(hash);
    expect(body).toContain(hash);
    expect(body).toContain(uuid);
    expect(body).toContain(PNG);
    expect(document.log.entries[0]!.comment).toContain(uuid);
    const query = report.places.find((place) => place.place === "request-url-query");
    expect(query?.canStillHold).toContain("Hex of 16 or more characters");
    const json = report.places.find((place) => place.place === "response-body-json");
    expect(json?.canStillHold).toContain("hex hash");
    expect(json?.canStillHold).toContain("UUID");
    expect(json?.canStillHold).toContain("base64 image");
  });

  it("strips userinfo without a userinfo name and does not call a short query inspected-clean", () => {
    const parsed = parseHar({
      log: {
        version: "1.2",
        creator: { name: "Caller", version: "1" },
        entries: [
          entry("2026-11-16T05:00:00.000Z", "https://api.example/home", {
            request: {
              method: "GET",
              url: "https://api.example/home",
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [
                {
                  name: "Referer",
                  value: "https://user:SECRETUSER@app.example/back?password=ab",
                },
              ],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
          }),
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { document, report } = redactHar(parsed.document, {
      rules: [{ id: "ref", target: "header-url", names: ["referer"] }],
    });
    const referer = document.log.entries[0]!.request.headers[0]?.value ?? "";
    expect(referer).not.toContain("SECRETUSER");
    expect(referer).toContain("password=ab");
    const userinfo = report.places.find((place) => place.place === "request-url-userinfo");
    const header = report.places.find((place) => place.place === "url-header");
    expect(userinfo?.status).toBe("removed");
    expect(userinfo?.detectors).toContain("url");
    expect(header?.status).not.toBe("not-examined");
    expect(header?.canStillHold).toContain("shorter than 20");
    expect(report.notInspected).not.toContain("url-header");
    expect(report.notInspected).not.toContain("request-url-userinfo");
  });

  it("keeps a JWT when the token detector is off and says so", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.Aaa1bbbCcc2dddEee3fffGh";
    const parsed = parseHar({
      log: {
        version: "1.2",
        creator: { name: "Caller", version: "1" },
        entries: [
          {
            ...entry("2026-11-16T05:00:00.000Z", "https://api.example/a"),
            comment: jwt,
          },
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { document, report } = redactHar(parsed.document, {
      detectors: ["structured-removal", "name-match", "url", "json-walk"],
    });
    expect(document.log.entries[0]!.comment).toContain(jwt);
    const comment = report.places.find((place) => place.place === "comment");
    expect(comment?.detectors).not.toContain("token-shape");
    expect(comment?.canStillHold).toContain("token-shaped value can remain");
  });

  it("marks every place not examined when no detector runs", () => {
    const parsed = parseHar({
      log: {
        version: "1.2",
        creator: { name: "Caller", version: "1" },
        entries: [entry("2026-11-16T05:00:00.000Z", "https://api.example/a")],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { report } = redactHar(parsed.document, { detectors: [] });
    expect(report.notInspected).toEqual([...HAR_REDACTION_PLACES]);
    expect(report.places.every((place) => place.status === "not-examined")).toBe(true);
    expect(report.places.every((place) => place.canStillHold.includes("not examined"))).toBe(true);
  });

  it("removes the round 2 planted secrets", () => {
    const secret = (key: string) => `SECRET_${key}_9c2e`;
    const jwt = (key: string) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${key}In0.${secret(key)}`;
    const signed = `https://bucket.s3.amazonaws.com/f.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261116&X-Amz-Signature=${secret("S3_SIG")}&X-Amz-Security-Token=${secret("S3_STS")}`;
    const keys = [
      "RB_SIGNEDURL",
      "WS_JWT",
      "REDIR_SETCOOKIE",
      "REDIR_RESCOOKIE",
      "GQL_BEARER",
      "CUSTOM_APIKEY",
      "S3_SIG",
      "S3_STS",
      "GKEY",
      "IMPLICIT_LOC",
      "IMPLICIT_REDIR",
      "TEXTPLAIN_JSON",
      "X_AUTH_TOKEN",
      "WS_PROTOCOL",
      "B64_JSON",
      "HTML_CSRF",
      "ENTRY_COMMENT",
      "PATH_TOKEN",
      "WS_URL",
      "STACK_URL",
      "ID_TOKEN_ARRAY",
      "SAFARI_COOKIE",
      "CACHE_ETAG",
      "REFRESH_COOKIE_HDR",
    ];
    const parsed = parseHar({
      log: {
        version: "1.2",
        creator: { name: "t", version: "1" },
        pages: [
          {
            id: "page_0",
            title: "https://app.example/",
            startedDateTime: "2026-11-16T09:59:59.000Z",
            pageTimings: {},
          },
        ],
        entries: [
          entry("2026-11-16T10:00:00.000Z", "https://app.example/api/files", {
            response: {
              status: 200,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              content: {
                size: 100,
                mimeType: "application/json",
                text: JSON.stringify({
                  name: "f.zip",
                  downloadUrl: `https://bucket.s3.amazonaws.com/f.zip?X-Amz-Signature=${secret("RB_SIGNEDURL")}`,
                }),
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:01.000Z", `wss://rt.example/socket?token=${secret("WS_URL")}`, {
            response: {
              status: 101,
              statusText: "",
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [],
              content: { size: 0, mimeType: "" },
              redirectURL: "",
              headersSize: -1,
              bodySize: 0,
            },
            request: {
              method: "GET",
              url: `wss://rt.example/socket?token=${secret("WS_URL")}`,
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [
                { name: "Sec-WebSocket-Protocol", value: `bearer, ${secret("WS_PROTOCOL")}` },
              ],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
            _webSocketMessages: [
              {
                type: "send",
                time: 1,
                opcode: 1,
                data: JSON.stringify({ type: "auth", token: jwt("WS_JWT") }),
              },
            ],
          }),
          entry("2026-11-16T10:00:02.000Z", "https://sso.example/login/callback", {
            response: {
              status: 302,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [
                { name: "SESSIONID", value: secret("REDIR_SETCOOKIE"), path: "/" },
                { name: "SESSIONID2", value: secret("REDIR_RESCOOKIE") },
              ],
              headers: [
                {
                  name: "Set-Cookie",
                  value: `SESSIONID=${secret("REDIR_SETCOOKIE")}; Path=/; HttpOnly`,
                },
                { name: "Location", value: "https://app.example/home" },
              ],
              content: { size: 0, mimeType: "text/plain" },
              redirectURL: "https://app.example/home",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:03.000Z", "https://app.example/graphql", {
            request: {
              method: "POST",
              url: "https://app.example/graphql",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
              postData: {
                mimeType: "application/json",
                params: [],
                text: JSON.stringify({
                  variables: { authorization: `Bearer ${secret("GQL_BEARER")}` },
                }),
              },
            },
          }),
          entry("2026-11-16T10:00:04.000Z", "https://app.example/api/x", {
            _requestContext: { apiKey: secret("CUSTOM_APIKEY") },
          }),
          entry("2026-11-16T10:00:05.000Z", signed),
          entry(
            "2026-11-16T10:00:06.000Z",
            `https://maps.googleapis.com/maps/api/geocode/json?address=x&key=${secret("GKEY")}`,
          ),
          entry("2026-11-16T10:00:07.000Z", "https://idp.example/authorize?response_type=token", {
            response: {
              status: 302,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [
                {
                  name: "Location",
                  value: `https://app.example/cb#access_token=${secret("IMPLICIT_LOC")}&token_type=bearer`,
                },
              ],
              content: { size: 0, mimeType: "text/plain" },
              redirectURL: `https://app.example/cb#access_token=${secret("IMPLICIT_REDIR")}&token_type=bearer`,
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:08.000Z", "https://app.example/api/login", {
            request: {
              method: "POST",
              url: "https://app.example/api/login",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
              postData: {
                mimeType: "text/plain;charset=UTF-8",
                params: [],
                text: JSON.stringify({ user: "a", password: secret("TEXTPLAIN_JSON") }),
              },
            },
          }),
          entry("2026-11-16T10:00:09.000Z", "https://cloud.example/v3/servers", {
            request: {
              method: "GET",
              url: "https://cloud.example/v3/servers",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [
                { name: "X-Auth-Token", value: secret("X_AUTH_TOKEN") },
                { name: "cookie", value: `refresh=${secret("REFRESH_COOKIE_HDR")}` },
              ],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
          }),
          entry("2026-11-16T10:00:10.000Z", "https://app.example/oauth/token", {
            response: {
              status: 200,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              content: {
                size: 80,
                mimeType: "application/json",
                encoding: "base64",
                text: encodeAsciiBase64(
                  JSON.stringify({ access_token: secret("B64_JSON"), token_type: "bearer" }),
                ),
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:11.000Z", "https://app.example/settings", {
            response: {
              status: 200,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              content: {
                size: 90,
                mimeType: "text/html",
                text: `<form><input type="hidden" name="csrf_token" value="${secret("HTML_CSRF")}"></form>`,
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:12.000Z", "https://app.example/x", {
            comment: `debug token=${secret("ENTRY_COMMENT")}`,
          }),
          entry(
            "2026-11-16T10:00:13.000Z",
            `https://app.example/auth/magic/${secret("PATH_TOKEN")}`,
          ),
          entry("2026-11-16T10:00:14.000Z", "https://app.example/y.js", {
            _initiator: {
              type: "script",
              stack: {
                callFrames: [
                  {
                    functionName: "f",
                    scriptId: "1",
                    url: `https://app.example/a.js?token=${secret("STACK_URL")}`,
                    lineNumber: 1,
                    columnNumber: 1,
                  },
                ],
              },
            },
          }),
          entry("2026-11-16T10:00:15.000Z", "https://app.example/oidc", {
            response: {
              status: 200,
              statusText: "",
              httpVersion: "HTTP/2",
              cookies: [],
              headers: [],
              content: {
                size: 60,
                mimeType: "application/json",
                text: JSON.stringify({ results: [{ id_token: secret("ID_TOKEN_ARRAY") }] }),
              },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          }),
          entry("2026-11-16T10:00:16.000Z", "https://mail.example/inbox", {
            request: {
              method: "GET",
              url: "https://mail.example/inbox",
              httpVersion: "HTTP/2",
              cookies: [{ name: "sid", value: secret("SAFARI_COOKIE") }],
              headers: [],
              queryString: [],
              headersSize: -1,
              bodySize: 0,
            },
          }),
          entry("2026-11-16T10:00:17.000Z", "https://app.example/cached", {
            cache: { beforeRequest: { eTag: `W/"${secret("CACHE_ETAG")}"`, hitCount: 1 } },
          }),
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { document } = redactHar(parsed.document);
    const decoded = document.log.entries
      .filter((item) => item.response.content.encoding === "base64" && item.response.content.text)
      .map((item) => decodeAsciiBase64(item.response.content.text ?? ""));
    const out = [JSON.stringify(document), ...decoded].join("\n");
    const stayed = keys.filter((key) => out.includes(secret(key)));
    expect(stayed).toEqual([]);
  });
});
