import { describe, expect, it } from "vite-plus/test";
import { parseExportId, parseExportRequest } from "../src/jobs.ts";
import { M0 } from "./fixtures.ts";
import { importMutated } from "./mutate.ts";

const validSelection = {
  scope: "everything",
  range: { kind: "last", minutes: 15 },
  include: "all",
};

const validRequest = {
  selection: validSelection,
  bodies: "include",
  secrets: "remove",
  packaging: "har",
  fileName: null,
};

describe("parseExportRequest rejection table", () => {
  it.each([
    ["null", null],
    ["array", []],
    [
      "invalid selection",
      {
        ...validRequest,
        selection: { scope: "everything", range: { kind: "last", minutes: 0 }, include: "all" },
      },
    ],
    ["bad bodies", { ...validRequest, bodies: "partial" }],
    ["bad secrets", { ...validRequest, secrets: "strip" }],
    ["har.zip rejected until measured", { ...validRequest, packaging: "har.zip" }],
    ["har.gz rejected until measured", { ...validRequest, packaging: "har.gz" }],
    ["unknown packaging", { ...validRequest, packaging: "json" }],
    ["empty fileName", { ...validRequest, fileName: "" }],
    ["whitespace fileName", { ...validRequest, fileName: "   " }],
    ["path traversal fileName", { ...validRequest, fileName: "../secret.har" }],
    ["slash in fileName", { ...validRequest, fileName: "dir/file.har" }],
    ["colon in fileName", { ...validRequest, fileName: "C:file.har" }],
    ["number fileName", { ...validRequest, fileName: 42 }],
    ["undefined fileName", { ...validRequest, fileName: undefined }],
  ])("rejects %s", (_label, raw) => {
    expect(parseExportRequest(raw)).toBeNull();
  });

  it("accepts valid requests with null or sanitized fileName", () => {
    expect(parseExportRequest(validRequest)).toEqual(validRequest);
    expect(parseExportRequest({ ...validRequest, fileName: "capture.har" })).toEqual({
      ...validRequest,
      fileName: "capture.har",
    });
  });

  it("planted: accepting har.zip in ACCEPTED_PACKAGING fails the rejection test", async () => {
    const mutated = await importMutated<{ parseExportRequest: typeof parseExportRequest }>(
      "jobs.ts",
      {
        id: "accept-har-zip",
        from: '  "har.zip": false,',
        to: '  "har.zip": true,',
      },
    );
    expect(mutated.parseExportRequest({ ...validRequest, packaging: "har.zip" })).not.toBeNull();
  });
});

describe("parseExportId", () => {
  it.each([
    ["exp-1", "exp-1"],
    ["job_42.a", "job_42.a"],
    ["", null],
    ["../job", null],
    ["job/1", null],
    ["a".repeat(65), null],
    [123, null],
    [null, null],
  ])("parses %j as %j", (raw, want) => {
    expect(parseExportId(raw)).toBe(want);
  });

  it("minute fixture stays aligned", () => {
    expect(M0 % 60_000).toBe(0);
  });
});
