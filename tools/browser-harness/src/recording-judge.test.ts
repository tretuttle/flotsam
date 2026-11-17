import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import type { BodyLocation, SettledExchange, StopFacts } from "@one-click-har/recording/exchange";
import type { ByteCount, EpochMs, ExchangeId, PackId, Site } from "@one-click-har/recording/ids";
import type { BodyRouteId } from "@one-click-har/recording/routes";
import type { ArchiveEntry, ArchiveLine } from "./archive.ts";
import { ID_ENDLESS_CHUNK } from "./extended-fixtures.ts";
import {
  flipFirstByte,
  identityExpectations,
  judgeArchiveModes,
  judgeDownloads,
  judgeExpectations,
  judgeStoredBodies,
  ROUTE_ROWS,
  routeExpectations,
} from "./recording-judge.ts";
import { endlessPrefix, expectedFromServer } from "./recording-truth.ts";
import type { SequenceTruth } from "./server.ts";

const ORIGIN = "http://127.0.0.1:9";
const sha = (bytes: Buffer): string => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const ok: StopFacts = {
  status: { kind: "ok" },
  endedAt: 0 as EpochMs,
  timings: {
    blocked: null,
    dns: null,
    connect: null,
    ssl: null,
    send: null,
    wait: null,
    receive: null,
  },
  transferSize: 0 as ByteCount,
  encodedBodySize: 0 as ByteCount,
};

let packOffset = 0;
const at = (length: number): BodyLocation => {
  const location: BodyLocation = {
    kind: "pack",
    pack: "s/r-0" as PackId,
    offset: packOffset,
    length: length as ByteCount,
  };
  packOffset += length;
  return location;
};

const request = (path: string) => ({
  id: `r.${String(path.length)}` as ExchangeId,
  url: `${ORIGIN}${path}`,
  method: "GET",
  httpVersion: "HTTP/1.1",
  headers: [],
  startedAt: 0 as EpochMs,
  tab: null,
  topSite: "127.0.0.1" as Site,
  policyType: 1,
});

type Body = "empty" | "not-kept" | "stored" | "aborted";
const answered = (
  path: string,
  options: {
    route?: BodyRouteId;
    body?: Body;
    status?: number;
    seq?: number;
    source?: "network" | "cache" | "service-worker";
    length?: number;
  } = {},
): SettledExchange => {
  const body = options.body ?? "stored";
  return {
    kind: "answered",
    request: request(path),
    response: {
      status: options.status ?? 200,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: options.seq === undefined ? [] : [["X-Seq", String(options.seq)]],
      mimeType: null,
      contentLength: null,
      contentEncoding: null,
      source: options.source ?? "network",
      redirectTo: null,
      remoteAddress: null,
    },
    stop:
      body === "aborted"
        ? { ...ok, status: { kind: "failed", error: "NS_BINDING_ABORTED" as never } }
        : ok,
    upload: { kind: "none" },
    route: options.route ?? "small",
    body:
      body === "stored"
        ? { kind: "stored", at: at(options.length ?? 4), encoding: null, check: "length-matched" }
        : body === "aborted"
          ? { kind: "incomplete", reason: "network-aborted" }
          : body === "empty"
            ? { kind: "empty" }
            : { kind: "not-kept", reason: "streaming-response" },
  } as SettledExchange;
};
const line = (exchange: SettledExchange): ArchiveLine => ({
  siteDir: "127.0.0.1",
  segment: "r-0.jsonl",
  exchange,
});

describe("stored bodies", () => {
  const first = Buffer.from("first body");
  const second = Buffer.from("r".repeat(20));
  const truths: SequenceTruth[] = [
    {
      seq: 1,
      method: "GET",
      path: "/a",
      url: "/a",
      status: 200,
      expectedLength: 10,
      wireBytesSent: 10,
      wireSha256: sha(first),
      decodedLength: 10,
      decodedSha256: sha(first),
      aborted: false,
    },
    {
      seq: 2,
      method: "GET",
      path: "/reval",
      url: "/reval",
      status: 200,
      expectedLength: 20,
      wireBytesSent: 20,
      wireSha256: sha(second),
      decodedLength: 20,
      decodedSha256: sha(second),
      aborted: false,
    },
    {
      seq: 3,
      method: "GET",
      path: "/reval",
      url: "/reval",
      status: 304,
      expectedLength: 0,
      wireBytesSent: 0,
      wireSha256: sha(Buffer.alloc(0)),
      decodedLength: 0,
      decodedSha256: null,
      aborted: false,
    },
  ];
  const server = {
    getSequenceTruth: (seq: number) => truths.find((t) => t.seq === seq),
    getAllSequenceTruth: () => new Map(truths.map((t) => [t.seq, t])),
  };
  const lines = [
    line(answered("/a", { seq: 1, length: first.length })),
    line(answered("/reval", { seq: 3, status: 304, length: second.length })),
  ];
  const bytes = new Map<number, Buffer>();
  const stored = lines.map((l) =>
    l.exchange.kind === "answered" && l.exchange.body.kind === "stored" ? l.exchange.body.at : null,
  );
  bytes.set(0, first);
  bytes.set(1, second);
  const read = (location: BodyLocation): Buffer | null =>
    bytes.get(stored.indexOf(location)) ?? null;

  it("is exact against the server's digest, and a merged 304 against the 200 it revalidated", () => {
    const verdicts = judgeStoredBodies(lines, expectedFromServer(server), read);
    expect(verdicts.map((v) => v.verdict)).toEqual(["exact", "exact"]);
  });

  it("reads one flipped byte as exactly one wrong body, and a missing file as missing", () => {
    const target = stored[1];
    if (target === null || target === undefined) throw new Error("no stored location");
    const planted = judgeStoredBodies(
      lines,
      expectedFromServer(server),
      flipFirstByte(read, target),
    );
    expect(planted.map((v) => v.verdict)).toEqual(["exact", "wrong"]);
    expect(
      judgeStoredBodies(lines, expectedFromServer(server), () => null).map((v) => v.verdict),
    ).toEqual(["missing", "missing"]);
  });

  it("expects a capped body to be the endless stream's first bytes", () => {
    const prefix = ID_ENDLESS_CHUNK.toString("utf8").repeat(3).slice(0, 5000);
    expect(endlessPrefix(5000)).toEqual({ sha256: sha(Buffer.from(prefix)), length: 5000 });
  });
});

describe("route rows", () => {
  const correct = ROUTE_ROWS.map(({ row, path, body }) =>
    line(answered(path, { route: row, body })),
  );

  it("holds when each row's fixture settles to its row and body", () => {
    expect(judgeExpectations(routeExpectations, correct)).toEqual([]);
  });

  it("catches two rows swapped", () => {
    const [a, b] = ROUTE_ROWS;
    if (a === undefined || b === undefined) throw new Error("two rows");
    const swapped = [
      line(answered(a.path, { route: b.row, body: a.body })),
      line(answered(b.path, { route: a.row, body: b.body })),
      ...correct.slice(2),
    ];
    expect(judgeExpectations(routeExpectations, swapped)).toHaveLength(2);
  });
});

describe("identity fixtures", () => {
  const correct: SettledExchange[] = [
    answered("/poll"),
    answered("/poll"),
    answered("/id/big", { route: "large-or-unknown", body: "aborted" }),
    answered("/id/reval"),
    answered("/id/reval", { status: 304 }),
    answered("/id/cached"),
    answered("/id/cached", { source: "cache" }),
    answered("/id/r1", { route: "redirect", body: "empty", status: 302 }),
    answered("/id/r2", { route: "redirect", body: "empty", status: 307 }),
    answered("/id/rfinal"),
    answered("/sw/synth", { route: "large-or-unknown", source: "service-worker" }),
    answered("/sw/pass", { source: "service-worker" }),
    {
      kind: "unanswered",
      request: request("/refused"),
      stop: { ...ok, status: { kind: "failed", error: "NS_ERROR_CONNECTION_REFUSED" as never } },
      upload: { kind: "none" },
    },
  ];

  it("holds for the archive the design describes", () => {
    expect(judgeExpectations(identityExpectations, correct.map(line))).toEqual([]);
  });

  it.each([
    [
      "the 304 kept as a second 200",
      (all: SettledExchange[]) =>
        all.map((e) =>
          e.kind === "answered" && e.response.status === 304 ? answered("/id/reval") : e,
        ),
    ],
    [
      "a redirect hop that kept a body",
      (all: SettledExchange[]) =>
        all.map((e) => (e.request.url.endsWith("/id/r1") ? answered("/id/r1") : e)),
    ],
    [
      "the cancelled download stored as complete",
      (all: SettledExchange[]) =>
        all.map((e) => (e.request.url.endsWith("/id/big") ? answered("/id/big") : e)),
    ],
    [
      "the refused port missing",
      (all: SettledExchange[]) => all.filter((e) => !e.request.url.endsWith("/refused")),
    ],
  ])("catches %s", (_name, plant) => {
    expect(judgeExpectations(identityExpectations, plant(correct).map(line))).toHaveLength(1);
  });
});

describe("archive files", () => {
  const entries: ArchiveEntry[] = [
    { path: ".", kind: "directory", mode: 0o700, size: 0 },
    { path: "k/sites/a/log/r-0.jsonl", kind: "file", mode: 0o600, size: 9 },
  ];

  it("flags a file readable by others and a kind the run never wrote", () => {
    expect(judgeArchiveModes(entries, ["jsonl"])).toEqual([]);
    expect(
      judgeArchiveModes(
        [...entries, { path: "k/settings.json", kind: "file", mode: 0o644, size: 2 }],
        ["jsonl", "pack"],
      ),
    ).toEqual(["k/settings.json is file mode 644", "no .pack file was written to judge"]);
  });

  it("flags a download that points into the data home", () => {
    expect(judgeDownloads(["/home/u/Downloads/a.bin"], "/data")).toBeNull();
    expect(judgeDownloads(["/data/one-click-har/x.har"], "/data")).toMatch(
      /points into the data home/,
    );
  });
});
