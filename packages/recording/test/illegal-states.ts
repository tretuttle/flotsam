// Every contradictory state an adversary built against round 1, as a value the types must reject. If a type change
// accepts one, its @ts-expect-error is unused and typecheck fails with TS2578. Each legal twin follows its case, so a
// type that rejects everything cannot pass either. test/planted-types.test.ts weakens the types and expects failure.

import type {
  AbandonedExchange,
  AnsweredExchange,
  BodyLocation,
  Capture,
  SettledBody,
} from "../src/exchange.ts";
import type { ByteCount, PositiveMinutes, TabId } from "../src/ids.ts";
import type { ArchiveRootRow } from "../src/layout.ts";
import type { RouteOutcome } from "../src/routes.ts";
import { facts, ID, request, response, SITE, stop } from "./fixtures.ts";

const at: BodyLocation = { kind: "file", site: SITE, id: ID, length: 14 as ByteCount };

// deepseek F7: an exchange abandoned before stop that claims a stored body.
export const abandonedButStored: AbandonedExchange = {
  kind: "abandoned",
  request,
  response,
  reason: "browser-closed",
  // @ts-expect-error an abandoned exchange has no stored body
  body: { kind: "stored", at, encoding: null, check: "length-matched" },
  upload: { kind: "none" },
};
export const legalAbandoned: AbandonedExchange = {
  kind: "abandoned",
  request,
  response,
  reason: "recording-stopped",
  body: { kind: "incomplete", reason: "recording-stopped" },
  upload: { kind: "none" },
};

// deepseek F7: an answered exchange with no stop.
export const answeredWithoutStop: AnsweredExchange = {
  kind: "answered",
  request,
  response,
  // @ts-expect-error an answered exchange always has its stop facts
  stop: null,
  route: "small",
  body: { kind: "empty" },
  upload: { kind: "none" },
};
export const legalAnswered: AnsweredExchange = {
  kind: "answered",
  request,
  response,
  stop,
  route: "small",
  body: { kind: "stored", at, encoding: null, check: "length-matched" },
  upload: { kind: "none" },
};

// deepseek F5: disable or update reported as the browser closing. The abandon reason says which of the two happened.
// @ts-expect-error "shutdown" does not exist
export const vagueShutdown: SettledBody = { kind: "incomplete", reason: "shutdown" };
// Coordinator decision 2026-11-16: a body cut at the body cap keeps its first part, so it is never stored as missing.
// @ts-expect-error over-body-cap is a stored first part, not an incomplete body
export const cappedAsMissing: SettledBody = { kind: "incomplete", reason: "over-body-cap" };
export const legalCapped: SettledBody = { kind: "stored", at, encoding: null, check: "first-part" };

// deepseek F7 / argon 12: a raw negative tab id and a range of zero minutes.
// @ts-expect-error a tab is a parsed TabId
export const negativeTab: TabId = -1;
// @ts-expect-error minutes are a parsed PositiveMinutes
export const lastZero: PositiveMinutes = 0;

// argon 12: the XDG rule extended with .local/share on the variable's own value.
export const doubledXdg: ArchiveRootRow = {
  platform: "linux",
  base: {
    kind: "xdg-data-home",
    env: "XDG_DATA_HOME",
    // @ts-expect-error the XDG base has no `under`; only the fallback has fallbackUnder
    under: [".local", "share"],
    fallbackKey: "Home",
    fallbackUnder: [".local", "share"],
  },
  appFolder: "one-click-har",
  dirMode: 0o700,
  fileMode: 0o600,
};
export const legalXdg: ArchiveRootRow = {
  platform: "linux",
  base: {
    kind: "xdg-data-home",
    env: "XDG_DATA_HOME",
    fallbackKey: "Home",
    fallbackUnder: [".local", "share"],
  },
  appFolder: "one-click-har",
  dirMode: 0o700,
  fileMode: 0o600,
};

// round 1 routes: a copy row with no action, or an empty row with a reason.
// @ts-expect-error a copy route names at least one action
export const copyNothing: RouteOutcome = { kind: "copy", actions: [] };
// @ts-expect-error an empty body has no reason
export const emptyWithReason: RouteOutcome = { kind: "empty", reason: "media-setting" };
export const legalCopy: RouteOutcome = { kind: "copy", actions: ["file-tee"] };

// opus 8 / argon 5: a 304 decided as no body while it still awaits its merge. awaiting-merge carries no route.
export const decidedAwaiting: Capture = {
  phase: "awaiting-merge",
  id: ID,
  facts,
  upload: { kind: "none" },
  // @ts-expect-error awaiting-merge has no route yet; the merged head decides it
  route: { id: "no-body", kind: "empty" },
};
export const legalAwaiting: Capture = {
  phase: "awaiting-merge",
  id: ID,
  facts,
  upload: { kind: "none" },
};
