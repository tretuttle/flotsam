import { describe, expect, it } from "vite-plus/test";

import {
  exchangeId,
  parseChannelKey,
  parseExchangeId,
  parsePositiveMinutes,
  parseRunId,
  parseSite,
  parseTabId,
  runIdAt,
  toMinute,
  type ChannelKey,
  type EpochMs,
  type RunId,
} from "../src/ids.ts";

describe("parsers reject malformed input", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2 ** 31 - 1, 2 ** 31 - 1],
    [-1, null],
    [1.5, null],
    ["1", null],
    [Number.NaN, null],
    [2 ** 31, null],
    [null, null],
  ])("tab id %s parses to %s", (raw, want) => {
    expect(parseTabId(raw)).toBe(want);
  });

  it.each([
    [1, 1],
    [15, 15],
    [525_600, 525_600],
    [0, null],
    [-15, null],
    [2.5, null],
    [525_601, null],
    ["15", null],
  ])("minutes %s parse to %s", (raw, want) => {
    expect(parsePositiveMinutes(raw)).toBe(want);
  });

  it.each([
    ["example.com", "example.com"],
    ["Example.COM", "example.com"],
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "localhost"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["::1", "::1"],
    ["2001:db8::8a2e:370:7334", "2001:db8::8a2e:370:7334"],
    ["", null],
    ["https://example.com/", null],
    ["example.com/path", null],
    ["exa mple.com", null],
    ["-example.com", null],
    ["example..com", null],
    ["bücher.example", null],
    [
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
    ],
    [`${"a".repeat(64)}.com`, null],
    [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`, null],
    [42, null],
  ])("site %j parses to %j", (raw, want) => {
    expect(parseSite(raw)).toBe(want);
  });
});

describe("exchange ids carry the run", () => {
  it("round-trips through parseExchangeId", () => {
    const run = runIdAt(1_794_800_000_000 as EpochMs);
    expect(run).toBe("mwipkv7k");
    const id = exchangeId(run, "15032385539" as ChannelKey);
    expect(id).toBe("mwipkv7k.15032385539");
    expect(parseExchangeId(id)).toEqual({ run, channel: "15032385539" });
  });

  it("opus 6: the same channel id in two runs gives two ids", () => {
    const channel = "15032385539" as ChannelKey;
    expect(exchangeId("mhz01" as RunId, channel)).not.toBe(exchangeId("mhz02" as RunId, channel));
  });

  it.each([
    "mhz02",
    "mhz02.",
    ".15",
    "mhz02.015",
    "MHZ02.15",
    "mhz02.15.1",
    "mhz02.-1",
    "mhz-02.15",
    "mhz02.123456789012345678901",
  ])("%j is not an exchange id", (raw) => {
    expect(parseExchangeId(raw)).toBeNull();
  });

  it("run and channel parsers accept only their own shapes", () => {
    expect(parseRunId("mhz02")).toBe("mhz02");
    expect(parseRunId("mhz-02")).toBeNull();
    expect(parseChannelKey("0")).toBe("0");
    expect(parseChannelKey("007")).toBeNull();
  });
});

describe("toMinute", () => {
  it.each([
    [1_794_800_000_000, 1_794_799_980_000],
    [1_794_799_980_000, 1_794_799_980_000],
    [1_794_799_980_000 + 59_999, 1_794_799_980_000],
  ])("%d starts minute %d", (at, minute) => {
    expect(toMinute(at as EpochMs)).toBe(minute);
  });
});
