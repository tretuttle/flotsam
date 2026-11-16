import { describe, expect, it } from "vite-plus/test";

import { settle, type SettledExchange } from "../src/exchange.ts";
import { parsePositiveMinutes, parseTabId, type ByteCount } from "../src/ids.ts";
import { rootSegments } from "../src/layout.ts";
import { decodeLine, encodeLine } from "../src/log.ts";
import { compileRoutes, resolveRow, type RouteOutcome } from "../src/routes.ts";
import { request, response, stop } from "./fixtures.ts";

const MiB = 1_048_576;
import * as states from "./illegal-states.ts";

// A value only the type checker rejects could still arrive from disk. The log decoder is that boundary, so it must
// reject the same states at run time and accept each legal twin.
const roundTrip = (exchange: SettledExchange) =>
  decodeLine(encodeLine({ v: 2, exchange }).slice(0, -1));
const answeredWith = (body: unknown): SettledExchange =>
  ({ ...states.legalAnswered, body }) as SettledExchange;

describe("the log decoder rejects what the types reject", () => {
  it.each([
    ["an abandoned exchange with a stored body", states.abandonedButStored],
    ["an answered exchange without stop", states.answeredWithoutStop],
    ["an incomplete body for a reason that does not exist", answeredWith(states.vagueShutdown)],
    ["a capped body stored as missing", answeredWith(states.cappedAsMissing)],
  ])("%s decodes to null", (_label, exchange) => {
    expect(roundTrip(exchange)).toBeNull();
  });

  it.each([
    ["abandoned, recording stopped", states.legalAbandoned],
    ["answered with a stored body", states.legalAnswered],
    ["answered with a first part kept at the cap", answeredWith(states.legalCapped)],
    [
      "unanswered",
      {
        kind: "unanswered",
        request,
        stop: { ...stop, status: { kind: "failed", error: "NS_ERROR_CONNECTION_REFUSED" } },
        upload: { kind: "none" },
      } as SettledExchange,
    ],
    [
      "abandoned before any head",
      {
        kind: "abandoned",
        request,
        response: null,
        reason: "browser-closed",
        body: { kind: "incomplete", reason: "browser-closed" },
        upload: { kind: "none" },
      } as SettledExchange,
    ],
    [
      "answered with a 304 head",
      {
        ...states.legalAnswered,
        response: { ...response, status: 304 },
        route: "awaiting-merge",
        body: { kind: "empty" },
      } as SettledExchange,
    ],
  ])("the legal twin %s round-trips", (_label, exchange) => {
    expect(roundTrip(exchange)).toEqual({ v: 2, exchange });
  });
});

// The rest have no decoder in front of them, so the code that reads each one must not be fooled by it either.
describe("the code behind the other types holds without them", () => {
  it("argon 12: a stray `under` on the XDG base never extends the variable's own value", () => {
    const env = (name: string) => (name === "XDG_DATA_HOME" ? "/home/u/.local/share" : null);
    const home = () => "/home/u";
    expect(rootSegments(states.doubledXdg, env, home)).toEqual([
      "/home/u/.local/share",
      "one-click-har",
    ]);
    expect(rootSegments(states.legalXdg, env, home)).toEqual(
      rootSegments(states.doubledXdg, env, home),
    );
  });

  it("a copy row with no action is never recordable, and an empty row's stray reason is dropped", () => {
    const compiled = compileRoutes({
      platform: "linux",
      excluded: [],
      keepMedia: false,
      maxBodyBytes: (64 * MiB) as ByteCount,
      supported: ["memory-tee", "file-tee"],
    });
    const facts = {
      method: "GET",
      status: 200,
      source: "network",
      mimeType: null,
      contentLength: 14 as ByteCount,
      hasLocation: false,
    } as const;
    const withOutcome = (outcome: RouteOutcome) =>
      resolveRow({ id: "small", when: () => true, outcome, evidence: "design" }, compiled, facts);
    expect(withOutcome(states.copyNothing)).toEqual({
      id: "small",
      kind: "not-kept",
      reason: "not-recordable-here",
    });
    expect(withOutcome(states.legalCopy)).toEqual({ id: "small", kind: "file-tee", cap: 16 * MiB });
    expect(withOutcome(states.emptyWithReason)).toEqual({ id: "small", kind: "empty" });
  });

  it("opus 8 / argon 5: a 304 still awaiting its merge settles with no body, whatever route it carries", () => {
    for (const capture of [states.decidedAwaiting, states.legalAwaiting] as const) {
      if (capture.phase !== "awaiting-merge") throw new Error("fixture must await its merge");
      expect(settle({ capture, stop, sink: null }, null)).toMatchObject({
        route: "awaiting-merge",
        body: { kind: "empty" },
      });
    }
  });

  it("the tab and minute parsers refuse the values the brands keep out", () => {
    expect([parseTabId(states.negativeTab), parsePositiveMinutes(states.lastZero)]).toEqual([
      null,
      null,
    ]);
  });
});
