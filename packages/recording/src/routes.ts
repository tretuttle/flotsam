// Which requests are recorded at all (GATES) and what happens to each body (BODY_ROUTES). Both are data: the recorder
// evaluates them on the parent main thread at examine time, and the options page and the docs render the same rows.
// Every body kept is copied from its first byte into storage this extension owns; nothing reads the HTTP cache.

import type { ByteCount, NonEmpty, Site } from "./ids.ts";
import type { Platform } from "./layout.ts";

/** A row in MEASUREMENTS.md, or "design" for a rule with no measurement behind it. */
export type MeasurementId = `${"R" | "C" | "S" | "L" | "P"}${number}${"" | "w" | "m"}` | "design";

/** Read before any header or URL. A gate match means no line, no sink, no count. */
export interface GateFacts {
  readonly privateBrowsingId: number;
  readonly triggeringIsSystem: boolean;
  readonly browsingContextId: number;
  readonly loadingScheme: string;
  /** null only when no rule in TOP_SITE_RULES can name a site; such a channel is recorded under no site. */
  readonly topSite: Site | null;
}

export type GateId = "private-window" | "browser-internal" | "extension-page" | "excluded-site";

export interface Gate {
  readonly id: GateId;
  readonly test: (g: GateFacts, excluded: ReadonlySet<Site>) => boolean;
  readonly evidence: MeasurementId;
}

/**
 * Ordered cheapest first. A service worker's own channel has browsingContextId 0 but a content triggering
 * principal, so it passes browser-internal and is recorded under the worker's site (argon 4, TOP_SITE_RULES).
 * @public
 */
export const GATES: readonly Gate[] = [
  { id: "private-window", test: (g) => g.privateBrowsingId > 0, evidence: "R11" },
  {
    id: "browser-internal",
    test: (g) => g.triggeringIsSystem && g.browsingContextId === 0,
    evidence: "R11",
  },
  { id: "extension-page", test: (g) => g.loadingScheme === "moz-extension", evidence: "design" },
  {
    id: "excluded-site",
    test: (g, excluded) => g.topSite !== null && excluded.has(g.topSite),
    evidence: "design",
  },
];

export function firstGate(facts: GateFacts, excluded: ReadonlySet<Site>): GateId | null {
  return GATES.find((g) => g.test(facts, excluded))?.id ?? null;
}

/** Why a body was not kept by rule. The export turns each into a sentence through MISSING_REASONS. */
export type NotKeptReason =
  | "media-setting" //         audio/* or video/* while settings.media is "details-only"
  | "streaming-response" //    text/event-stream, multipart/x-mixed-replace: declared to never end
  | "not-recordable-here"; //  the capture backend has no action this row accepts (standard build, Chromium)

/**
 * How a body is copied; a backend declares the actions it has. memory-tee: a native tee into a storage stream capped
 * at the declared length, appended to the site's pack by a native copier. file-tee: a native tee into
 * incoming/<run>.<channel>.part from byte 0. stream-filter: webRequest.filterResponseData (standard build).
 */
export type CaptureAction = "memory-tee" | "file-tee" | "stream-filter";

export type BodyRouteId =
  | "no-body"
  | "redirect"
  | "awaiting-merge"
  | "streaming"
  | "media-details"
  | "small"
  | "large-or-unknown";

/** Which topic delivered the response head. "service-worker" is service-worker-synthesized-response. */
export type ResponseSource = "network" | "cache" | "revalidated" | "service-worker";

/** The facts a row may read. A strict subset of what examine reads, so routing cannot grow a header dependency. */
export interface RouteFacts {
  readonly method: string;
  readonly status: number;
  readonly source: ResponseSource;
  readonly mimeType: string | null;
  /** Wire length. null when the channel reports -1 (chunked, HTTP/2 without length, most service-worker bodies). */
  readonly contentLength: ByteCount | null;
  /** A Location header is present. Gecko follows a 3xx only with one; without it the body reaches the page. */
  readonly hasLocation: boolean;
}

/** Built once per settings change. The hot path reads only this. */
export interface CompiledRoutes {
  readonly excluded: ReadonlySet<Site>;
  readonly keepMedia: boolean;
  /** MEMORY_TEE_MAX for this platform. */
  readonly memoryTeeMax: ByteCount;
  /** One body file never grows past this, so one stream cannot fill the archive. */
  readonly bodyFileCap: ByteCount;
  readonly supported: ReadonlySet<CaptureAction>;
}

/** What a row does with the body. The union makes "copy with no action" and "empty with a reason" unwritable. */
export type RouteOutcome =
  | { readonly kind: "empty" }
  | { readonly kind: "awaiting-merge" }
  | { readonly kind: "not-kept"; readonly reason: NotKeptReason }
  | { readonly kind: "copy"; readonly actions: NonEmpty<CaptureAction> };

export interface BodyRoute {
  readonly id: BodyRouteId;
  readonly when: (f: RouteFacts, c: CompiledRoutes) => boolean;
  readonly outcome: RouteOutcome;
  readonly evidence: MeasurementId;
}

const STREAMING_MIME: readonly string[] = ["text/event-stream", "multipart/x-mixed-replace"];
const REDIRECT_STATUS: readonly number[] = [301, 302, 303, 307, 308];

/**
 * The largest known length that goes through the memory tee, per platform (rule: proto-premise/preregister.md).
 * Linux showed no cliff up to 1 MiB (R1). Windows and macOS keep 1 MiB until their sweep runs (R1w, R1m); a
 * measured cliff changes their row and nothing else.
 * @public
 */
export const MEMORY_TEE_MAX: {
  readonly [P in Platform]: { readonly bytes: ByteCount; readonly evidence: MeasurementId };
} = {
  linux: { bytes: 1_048_576 as ByteCount, evidence: "R1" },
  win: { bytes: 1_048_576 as ByteCount, evidence: "R1w" },
  macosx: { bytes: 1_048_576 as ByteCount, evidence: "R1m" },
};

const isMedia = (f: RouteFacts): boolean =>
  f.mimeType?.startsWith("audio/") === true || f.mimeType?.startsWith("video/") === true;

const LARGE_OR_UNKNOWN: BodyRoute = {
  id: "large-or-unknown",
  when: () => true,
  outcome: { kind: "copy", actions: ["file-tee", "stream-filter"] },
  evidence: "R3",
};

/** First matching row wins, and the order is part of the contract. The last row matches anything. */
export const BODY_ROUTES: readonly BodyRoute[] = [
  {
    id: "no-body",
    when: (f) =>
      f.method === "HEAD" ||
      (f.status >= 100 && f.status < 200) ||
      f.status === 204 ||
      f.status === 205,
    outcome: { kind: "empty" },
    evidence: "design",
  },
  {
    id: "redirect",
    when: (f) => REDIRECT_STATUS.includes(f.status) && f.hasLocation,
    outcome: { kind: "empty" },
    evidence: "R15",
  },
  {
    id: "awaiting-merge",
    when: (f) => f.status === 304 && f.source === "network",
    outcome: { kind: "awaiting-merge" },
    evidence: "R14",
  },
  {
    id: "streaming",
    when: (f) => STREAMING_MIME.includes(f.mimeType ?? ""),
    outcome: { kind: "not-kept", reason: "streaming-response" },
    evidence: "design",
  },
  {
    id: "media-details",
    when: (f, c) => isMedia(f) && !c.keepMedia,
    outcome: { kind: "not-kept", reason: "media-setting" },
    evidence: "design",
  },
  {
    id: "small",
    when: (f, c) => f.contentLength !== null && f.contentLength < c.memoryTeeMax,
    outcome: { kind: "copy", actions: ["memory-tee", "file-tee", "stream-filter"] },
    evidence: "R2",
  },
  LARGE_OR_UNKNOWN,
];

/** What the recorder acts on: a row resolved against the backend's actions. Each sink kind carries its own cap. */
export type Route =
  | { readonly id: BodyRouteId; readonly kind: "empty" }
  | { readonly id: BodyRouteId; readonly kind: "awaiting-merge" }
  | { readonly id: BodyRouteId; readonly kind: "not-kept"; readonly reason: NotKeptReason }
  /** cap is the declared Content-Length: the storage stream cannot hold more, and the count must equal it. */
  | { readonly id: BodyRouteId; readonly kind: "memory-tee"; readonly cap: ByteCount }
  /** cap is CompiledRoutes.bodyFileCap: the watchdog closes the stream there and only the first part is kept. */
  | { readonly id: BodyRouteId; readonly kind: "file-tee"; readonly cap: ByteCount }
  | { readonly id: BodyRouteId; readonly kind: "stream-filter"; readonly cap: ByteCount };

export function compileRoutes(input: {
  readonly platform: Platform;
  readonly excluded: readonly Site[];
  readonly keepMedia: boolean;
  /** settings.retention.maxBodyBytes. bodyFileCap is a quarter of it, so one body is at most a quarter of the archive. */
  readonly maxBodyBytes: ByteCount;
  readonly supported: readonly CaptureAction[];
}): CompiledRoutes {
  return {
    excluded: new Set(input.excluded),
    keepMedia: input.keepMedia,
    memoryTeeMax: MEMORY_TEE_MAX[input.platform].bytes,
    bodyFileCap: Math.floor(input.maxBodyBytes / 4) as ByteCount,
    supported: new Set(input.supported),
  };
}

/**
 * A row against the backend's actions: the first action the backend has wins. A memory tee needs a declared length
 * to cap its storage stream (proto-lifecycle: closing one does not stop the tee), so without one it is skipped. A
 * copy row with no usable action resolves to not-recordable-here.
 */
export function resolveRow(row: BodyRoute, compiled: CompiledRoutes, facts: RouteFacts): Route {
  const { id, outcome } = row;
  if (outcome.kind === "empty" || outcome.kind === "awaiting-merge")
    return { id, kind: outcome.kind };
  if (outcome.kind === "not-kept") return { id, kind: "not-kept", reason: outcome.reason };
  for (const action of outcome.actions) {
    if (!compiled.supported.has(action)) continue;
    if (action !== "memory-tee") return { id, kind: action, cap: compiled.bodyFileCap };
    if (facts.contentLength !== null) return { id, kind: action, cap: facts.contentLength };
  }
  return { id, kind: "not-kept", reason: "not-recordable-here" };
}

/** Hot path, once per examined response: the first matching row of BODY_ROUTES, resolved. */
export function chooseRoute(compiled: CompiledRoutes, facts: RouteFacts): Route {
  return resolveRow(
    BODY_ROUTES.find((r) => r.when(facts, compiled)) ?? LARGE_OR_UNKNOWN,
    compiled,
    facts,
  );
}
