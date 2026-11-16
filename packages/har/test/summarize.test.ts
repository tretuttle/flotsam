import { describe, expect, it } from "vite-plus/test";

import { buildHar } from "../src/build.ts";
import { toHarUrl, toIsoDateTime, toMimeType } from "../src/model.ts";
import { redactHar } from "../src/redact.ts";
import { classifyEntryBodyState, summarizeEntries, summarizeHar } from "../src/summarize.ts";

describe("summarizeHar", () => {
  it("reports counts, byte totals, hosts, time range, and missing bodies by reason", () => {
    const doc = buildHar({
      creator: { name: "Caller", version: "1" },
      entries: [
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:00.000Z")!,
          time: 100,
          request: {
            method: "GET",
            url: toHarUrl("https://app.example/index.html")!,
            headers: [{ name: "Authorization", value: "Bearer s3cr3t" }],
            headersSize: 120,
            bodySize: 0,
          },
          response: {
            status: 200,
            headersSize: 80,
            bodySize: 10,
            content: {
              size: 13,
              mimeType: toMimeType("text/html")!,
              text: "<h1>Home</h1>",
            },
          },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:01.000Z")!,
          time: 50,
          request: {
            method: "GET",
            url: toHarUrl("https://cdn.example/video.mp4")!,
            headersSize: 100,
            bodySize: 0,
          },
          response: {
            status: 206,
            headersSize: 90,
            bodySize: 4096,
            content: {
              size: 4096,
              mimeType: toMimeType("video/mp4")!,
            },
          },
          _harExport: { bodyState: "media-skipped" },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:02.000Z")!,
          time: 20,
          request: {
            method: "GET",
            url: toHarUrl("https://app.example/old.wasm")!,
            headersSize: 100,
            bodySize: 0,
          },
          response: {
            status: 200,
            headersSize: 70,
            bodySize: 50_000,
            content: {
              size: 50_000,
              mimeType: toMimeType("application/wasm")!,
            },
          },
          _harExport: { bodyState: "evicted" },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:03.000Z")!,
          time: 15,
          request: {
            method: "GET",
            url: toHarUrl("https://app.example/api/ping")!,
            headersSize: 90,
            bodySize: 0,
          },
          response: {
            status: 204,
            headersSize: 40,
            bodySize: 0,
          },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:04.000Z")!,
          time: 5,
          request: {
            method: "GET",
            url: toHarUrl("https://app.example/aborted.json")!,
            headersSize: 80,
            bodySize: 0,
          },
          response: {
            status: 0,
            headersSize: -1,
            bodySize: -1,
          },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:05.000Z")!,
          time: 25,
          request: {
            method: "GET",
            url: toHarUrl("https://app.example/icon.png")!,
            headersSize: 95,
            bodySize: 0,
          },
          response: {
            status: 200,
            headersSize: 60,
            bodySize: 3,
            content: {
              size: 3,
              mimeType: toMimeType("image/png")!,
              encoding: "base64",
              text: "AQID",
            },
          },
        },
        {
          startedDateTime: toIsoDateTime("2026-11-16T05:00:06.000Z")!,
          time: 12,
          request: {
            method: "GET",
            url: toHarUrl("https://app.example/ff-discarded.js")!,
            headersSize: 95,
            bodySize: 0,
          },
          response: {
            status: 200,
            headersSize: 60,
            bodySize: 200,
            content: {
              size: 500,
              mimeType: toMimeType("application/javascript")!,
              comment: "Response bodies are not included.",
            },
          },
        },
      ],
    });

    const { document: redacted } = redactHar(doc);
    const summary = summarizeHar(redacted);

    expect(summary.pageCount).toBe(1);
    expect(summary.entryCount).toBe(7);
    expect(summary.hosts).toEqual(["app.example", "cdn.example"]);
    expect(summary.timeRange).toEqual({
      start: "2026-11-16T05:00:00.000Z",
      end: "2026-11-16T05:00:06.012Z",
    });
    expect(summary.wallSpanMs).toBe(6012);
    expect(summary.sumEntryTimeMs).toBe(227);

    expect(summary.bytes).toEqual({
      requestHeaders: 680,
      requestBody: 0,
      responseHeaders: 400,
      responseBodyWire: 54_309,
      responseBodyDecoded: 54_612,
      includedResponseTextBytes: 16,
    });

    expect(summary.bodies).toEqual({
      withBody: 2,
      withoutBody: 5,
      empty: 1,
      missing: 4,
      missingByReason: {
        "not-included": 0,
        evicted: 1,
        discarded: 0,
        aborted: 1,
        "media-skipped": 1,
        "size-limit": 0,
        unavailable: 0,
        unknown: 1,
      },
    });

    expect(summary.statusBuckets).toEqual({
      failed: 1,
      informational: 0,
      success: 6,
      redirect: 0,
      clientError: 0,
      serverError: 0,
    });
    expect(summary.redaction).toEqual({
      applied: true,
      totalRemoved: 1,
      entriesAffected: 1,
    });
    expect(classifyEntryBodyState(redacted.log.entries[1]!)).toBe("media-skipped");
  });

  it("handles empty entry sets without crashing", () => {
    const empty = summarizeEntries([]);
    expect(empty.entryCount).toBe(0);
    expect(empty.timeRange).toBeNull();
    expect(empty.wallSpanMs).toBe(0);
    expect(empty.bodies.withBody).toBe(0);
    expect(empty.bodies.withoutBody).toBe(0);
  });
});
