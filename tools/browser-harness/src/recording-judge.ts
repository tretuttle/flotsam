import * as NodeCrypto from "node:crypto";
import type {
  AnsweredExchange,
  BodyLocation,
  SettledExchange,
} from "@one-click-har/recording/exchange";
import type { BodyRouteId } from "@one-click-har/recording/routes";
import type { ArchiveEntry, ArchiveLine } from "./archive.ts";

/** What a stored body must hash to, from the fixture server or from what the page itself received. */
export type ExpectedBody = { readonly sha256: string; readonly length: number };

export type BodyVerdict = {
  readonly url: string;
  readonly verdict: "exact" | "wrong" | "missing" | "no-ground-truth";
  readonly detail: string;
};

const sha256 = (bytes: Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const pathOf = (exchange: SettledExchange): string => new URL(exchange.request.url).pathname;

export const responseHeader = (exchange: AnsweredExchange, name: string): string | null =>
  exchange.response.headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

type StoredLine = AnsweredExchange & {
  readonly body: { readonly kind: "stored"; readonly at: BodyLocation };
};

export const storedLines = (lines: readonly ArchiveLine[]): readonly StoredLine[] =>
  lines.flatMap(({ exchange }) =>
    exchange.kind === "answered" && exchange.body.kind === "stored" ? [exchange as StoredLine] : [],
  );

/** Every stored body against its expected digest. A wrong byte anywhere in the body changes the digest. */
export function judgeStoredBodies(
  lines: readonly ArchiveLine[],
  expectedFor: (exchange: StoredLine) => ExpectedBody | null,
  read: (at: BodyLocation) => Buffer | null,
): readonly BodyVerdict[] {
  return storedLines(lines).map((exchange) => {
    const url = exchange.request.url;
    const expected = expectedFor(exchange);
    if (expected === null)
      return { url, verdict: "no-ground-truth", detail: "nothing to compare with" };
    const bytes = read(exchange.body.at);
    if (bytes === null) return { url, verdict: "missing", detail: "stored location not on disk" };
    const actual = sha256(bytes);
    return actual === expected.sha256 && bytes.length === expected.length
      ? { url, verdict: "exact", detail: `${String(bytes.length)} bytes` }
      : {
          url,
          verdict: "wrong",
          detail: `${String(bytes.length)} bytes ${actual.slice(0, 12)}, expected ${String(expected.length)} ${expected.sha256.slice(0, 12)}`,
        };
  });
}

/** The same bytes with one byte flipped: the planted failure every body check must catch. */
export const flipFirstByte =
  (read: (at: BodyLocation) => Buffer | null, target: BodyLocation) =>
  (at: BodyLocation): Buffer | null => {
    const bytes = read(at);
    if (bytes === null || at !== target || bytes.length === 0) return bytes;
    const copy = Buffer.from(bytes);
    copy[0] = (copy[0] ?? 0) ^ 0xff;
    return copy;
  };

type Expectation = {
  readonly id: string;
  /** null when the archive reads as the design says. */
  readonly problem: (lines: readonly SettledExchange[]) => string | null;
};

const withPath = (lines: readonly SettledExchange[], path: string): readonly SettledExchange[] =>
  lines.filter((exchange) => pathOf(exchange) === path);

const answered = (lines: readonly SettledExchange[]): readonly AnsweredExchange[] =>
  lines.flatMap((exchange) => (exchange.kind === "answered" ? [exchange] : []));

/** Each body route row, the fixture path that exercises it, and the body it must settle to. */
export const ROUTE_ROWS: readonly {
  readonly row: BodyRouteId;
  readonly path: string;
  readonly body: "empty" | "not-kept" | "stored";
}[] = [
  { row: "no-body", path: "/route/no-content", body: "empty" },
  { row: "redirect", path: "/id/r1", body: "empty" },
  { row: "streaming", path: "/route/events", body: "not-kept" },
  { row: "media-details", path: "/fixtures/video", body: "not-kept" },
  { row: "small", path: "/fixtures/range", body: "stored" },
  { row: "large-or-unknown", path: "/fixtures/chunked", body: "stored" },
];

export const routeExpectations: readonly Expectation[] = ROUTE_ROWS.map(({ row, path, body }) => ({
  id: `route ${row}`,
  problem: (lines) => {
    const found = answered(withPath(lines, path));
    if (found.length === 0) return `${path}: no answered line`;
    const wrong = found.filter((exchange) => exchange.route !== row || exchange.body.kind !== body);
    return wrong.length === 0
      ? null
      : `${path}: ${wrong.map((e) => `${e.route} ${e.body.kind}`).join(", ")}, expected ${row} ${body}`;
  },
}));

/** The identity fixtures, read as the architecture says (PLAN.md, PR 3). Body bytes are judged separately. */
export const identityExpectations: readonly Expectation[] = [
  {
    id: "both /poll bodies stored",
    problem: (lines) => {
      const polls = answered(withPath(lines, "/poll")).filter((e) => e.body.kind === "stored");
      return polls.length === 2 ? null : `${String(polls.length)} stored /poll bodies, expected 2`;
    },
  },
  {
    id: "the cancelled download is network-aborted",
    problem: (lines) => {
      const big = answered(withPath(lines, "/id/big"));
      return big.length === 1 &&
        big[0]?.body.kind === "incomplete" &&
        big[0].body.reason === "network-aborted"
        ? null
        : `/id/big read as ${JSON.stringify(big.map((e) => e.body))}`;
    },
  },
  {
    id: "the 304 is one exchange with status 304 and a stored body",
    problem: (lines) => {
      const reval = answered(withPath(lines, "/id/reval"));
      const statuses = reval.map((e) => `${String(e.response.status)} ${e.body.kind}`).sort();
      return JSON.stringify(statuses) === JSON.stringify(["200 stored", "304 stored"])
        ? null
        : `/id/reval lines: ${statuses.join(", ")}`;
    },
  },
  {
    id: "the cache hit is stored from the cache",
    problem: (lines) => {
      const sources = answered(withPath(lines, "/id/cached")).map(
        (e) => `${e.response.source} ${e.body.kind}`,
      );
      return sources.includes("cache stored") ? null : `/id/cached lines: ${sources.join(", ")}`;
    },
  },
  {
    id: "redirect hops are empty and the target is stored once",
    problem: (lines) => {
      const hops = answered([...withPath(lines, "/id/r1"), ...withPath(lines, "/id/r2")]);
      const finals = answered(withPath(lines, "/id/rfinal"));
      return hops.length === 2 &&
        hops.every((e) => e.route === "redirect" && e.body.kind === "empty") &&
        finals.length === 1 &&
        finals[0]?.body.kind === "stored"
        ? null
        : `hops ${JSON.stringify(hops.map((e) => [e.route, e.body.kind]))}, targets ${String(finals.length)}`;
    },
  },
  {
    id: "both service-worker responses are stored from the worker",
    problem: (lines) => {
      const worker = answered([
        ...withPath(lines, "/sw/synth"),
        ...withPath(lines, "/sw/pass"),
      ]).filter((e) => e.response.source === "service-worker" && e.body.kind === "stored");
      return worker.map(pathOf).sort().join(",") === "/sw/pass,/sw/synth"
        ? null
        : `service-worker lines stored: ${worker.map(pathOf).join(", ")}`;
    },
  },
  {
    id: "the refused port is an unanswered line with NS_ERROR_CONNECTION_REFUSED",
    problem: (lines) => {
      const refused = withPath(lines, "/refused");
      const first = refused[0];
      return refused.length === 1 &&
        first?.kind === "unanswered" &&
        first.stop.status.kind === "failed" &&
        first.stop.status.error === "NS_ERROR_CONNECTION_REFUSED"
        ? null
        : `/refused read as ${JSON.stringify(refused.map((e) => [e.kind, "stop" in e ? e.stop.status : null]))}`;
    },
  },
];

export const judgeExpectations = (
  expectations: readonly Expectation[],
  lines: readonly ArchiveLine[],
): readonly string[] => {
  const exchanges = lines.map((line) => line.exchange);
  return expectations.flatMap((e) => {
    const problem = e.problem(exchanges);
    return problem === null ? [] : [`${e.id}: ${problem}`];
  });
};

/** Directories 0700 and files 0600, and at least one file of each kind, so no kind escapes the rule unseen. */
export const judgeArchiveModes = (
  entries: readonly ArchiveEntry[],
  kinds: readonly string[],
): readonly string[] => [
  ...entries
    .filter((e) => e.mode !== (e.kind === "directory" ? 0o700 : 0o600))
    .map((e) => `${e.path} is ${e.kind} mode ${e.mode.toString(8)}`),
  ...kinds
    .filter((kind) => !entries.some((e) => e.kind === "file" && e.path.endsWith(`.${kind}`)))
    .map((kind) => `no .${kind} file was written to judge`),
];

/** The extension never adds to the Downloads list, so no download may point anywhere under the data home. */
export const judgeDownloads = (targets: readonly string[], dataHome: string): string | null => {
  const inside = targets.filter((target) => target.startsWith(`${dataHome}/`));
  return inside.length === 0
    ? null
    : `the Downloads list points into the data home: ${inside.join(", ")}`;
};
