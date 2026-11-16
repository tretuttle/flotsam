import { buildHarEntry } from "@one-click-har/har/build";
import { isoDateTimeFromEpochMs, toHarUrl } from "@one-click-har/har/model";
import { classifyEntryBodyState } from "@one-click-har/har/summarize";
import { describe, expect, it } from "vite-plus/test";
import { MISSING_REASONS, type MissingReason } from "../src/missing.ts";
import { T0 } from "./fixtures.ts";

describe("MISSING_REASONS", () => {
  const entries = Object.entries(MISSING_REASONS) as [
    MissingReason,
    (typeof MISSING_REASONS)[MissingReason],
  ][];

  it("every reason has plain copy without emoji or em dashes", () => {
    for (const [reason, row] of entries) {
      expect(row.comment.length, reason).toBeGreaterThan(0);
      expect(row.reportLabel.length, reason).toBeGreaterThan(0);
      expect(row.comment, reason).not.toContain("\u2014");
      expect(row.reportLabel, reason).not.toContain("\u2014");
    }
  });

  it("agrees with @one-click-har/har/summarize classifyEntryBodyState on every reason", () => {
    for (const [reason, row] of entries) {
      const entry = buildHarEntry({
        startedDateTime: isoDateTimeFromEpochMs(T0),
        request: { method: "GET", url: toHarUrl("https://app.example/")! },
        response: {
          status: 200,
          content: { size: -1, mimeType: "text/plain", comment: row.comment },
        },
        _harExport: { bodyState: row.harState, bodyMissing: reason },
      });
      expect(classifyEntryBodyState(entry), reason).toEqual({
        state: "missing",
        reason: row.harState,
      });
    }
  });
});
