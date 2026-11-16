import { describe, expect, it } from "vite-plus/test";
import { summarize } from "./measure.ts";

describe("summarize", () => {
  it("reports the median, the spread, and the run count", () => {
    expect(summarize([10, 1, 3, 2])).toEqual({
      median: 2.5,
      spread: 9,
      min: 1,
      max: 10,
      runCount: 4,
    });
    expect(summarize([4, 1, 9]).median).toBe(4);
  });
});
