import { describe, expect, it } from "vite-plus/test";

import { buildHar } from "../src/build.ts";
import { toHarUrl, toIsoDateTime, toMimeType } from "../src/model.ts";
import { parseHar } from "../src/parse.ts";
import { DEFAULT_REDACTION_RULES, redactHar } from "../src/redact.ts";

describe("redactHar", () => {
  it("removes every listed secret across headers, cookies, query, and body and records removals", () => {
    const doc = buildHar({
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
    expect(JSON.parse(first.request.postData!.text)).toEqual({
      user: "alice",
      nested: { password: "[REDACTED]" },
    });

    const second = redacted.log.entries[1]!;
    expect(second.request.postData?.text).toBe(
      "client_secret=%5BREDACTED%5D&grant_type=client_credentials",
    );

    expect(report.applied).toBe(true);
    expect(report.entriesAffected).toBe(2);
    expect(report.totalRemoved).toBe(9);
    expect(redacted.log._harAnytime?.redaction).toEqual(report);
    expect(first._harAnytime?.redactedFields).toContain("header:Authorization");
    expect(first._harAnytime?.redactedFields).toContain("query:access_token");
    expect(first._harAnytime?.redactedFields).toContain("body:password");
    expect(parseHar(redacted).ok).toBe(true);
  });

  it("documents the rule-table limit when a secret is planted in an unlisted place", () => {
    expect(DEFAULT_REDACTION_RULES.some((rule) => rule.target === "header")).toBe(true);
    const unlistedHeaderSecret = "unlisted-custom-header-secret";
    const unlistedResponseBodySecret = "unlisted-response-body-secret";

    const doc = buildHar({
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
    // Limit: default rules do not inspect unlisted custom headers or response bodies.
    expect(defaultEntry.request.headers.find((h) => h.name === "X-Custom-Debug-Token")?.value).toBe(
      unlistedHeaderSecret,
    );
    expect(defaultEntry.response.content.text).toContain(unlistedResponseBodySecret);

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
});
