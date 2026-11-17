import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  CANCEL_BOUND_BYTES,
  convertsWithK6,
  judgeAfterCrash,
  judgeCancel,
  judgeDiskFull,
  judgeExport,
  judgeTabCases,
  PLANTS,
  plantDataRow,
  plantNoCreator,
  plantSecretInTitle,
  validateHar,
  type TruthServer,
} from "./export-judge.ts";
import type { SequenceTruth, ServedRequest } from "./server.ts";

const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "och-export-judge-"));
afterAll(() => NodeFS.rmSync(work, { recursive: true, force: true }));

const sha = (b: Uint8Array) => NodeCrypto.createHash("sha256").update(b).digest("hex");
const HOST = "127.0.0.1:8080";
const SECRET = "SECRETJUDGE";

/** What a fixture server sent: a text page, and a gzip body whose decoded bytes differ from the wire bytes. */
const page = Buffer.from("<!doctype html><title>t</title>", "utf8");
const decoded = NodeCrypto.randomBytes(5000);
const wire = NodeZlib.gzipSync(decoded);
const sent: readonly (SequenceTruth & { readonly body: Buffer })[] = [
  {
    seq: 1,
    method: "GET",
    path: "/",
    url: "/?access_token=x",
    status: 200,
    expectedLength: page.length,
    wireBytesSent: page.length,
    wireSha256: sha(page),
    decodedLength: page.length,
    decodedSha256: sha(page),
    aborted: false,
    body: page,
  },
  {
    seq: 2,
    method: "GET",
    path: "/fixtures/gzip",
    url: "/fixtures/gzip",
    status: 200,
    expectedLength: wire.length,
    wireBytesSent: wire.length,
    wireSha256: sha(wire),
    decodedLength: decoded.length,
    decodedSha256: sha(decoded),
    aborted: false,
    body: decoded,
  },
];
const servers: readonly TruthServer[] = [
  {
    host: HOST,
    server: {
      getSequenceTruth: (seq) => sent.find((t) => t.seq === seq),
      getRequestLog: (): readonly ServedRequest[] =>
        sent.map((t) => ({
          seq: t.seq,
          method: t.method,
          path: t.path,
          url: t.url,
          status: t.status,
        })),
    },
  },
];

/** The file a correct export writes, built here from what the server sent. */
const exported = JSON.stringify({
  log: {
    version: "1.2",
    creator: { name: "One-Click HAR", version: "0.1.0" },
    pages: [
      {
        startedDateTime: "2026-11-16T00:00:00.000Z",
        id: "page_0",
        title: `http://${HOST}/?access_token=%5BREDACTED%5D`,
        pageTimings: {},
      },
    ],
    entries: sent.map((t) => ({
      pageref: "page_0",
      startedDateTime: "2026-11-16T00:00:00.000Z",
      time: 1,
      request: {
        method: "GET",
        url: `http://${HOST}${t.path}`,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 200,
        statusText: "OK",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [
          { name: "X-Seq", value: String(t.seq) },
          { name: "Content-Length", value: String(t.wireBytesSent) },
        ],
        content: {
          size: t.body.length,
          mimeType: "application/octet-stream",
          text: t.body.toString("base64"),
          encoding: "base64",
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: t.wireBytesSent,
      },
      cache: {},
      timings: { send: 0, wait: 1, receive: 0 },
    })),
  },
});
const expectation = { servers, hosts: [HOST], previewCount: 2, secret: SECRET };

describe("the export judge", () => {
  it("passes an export that holds every logged request with its server's decoded bytes", async () => {
    expect(judgeExport(exported, expectation)).toEqual({ entries: 2, exact: 2, problems: [] });
    expect(await validateHar(exported)).toBeNull();
    const file = NodePath.join(work, "ok.har");
    NodeFS.writeFileSync(file, exported);
    expect(convertsWithK6(file, work)).toBe(true);
  });

  it.each(PLANTS)("catches $name", (plant) => {
    const planted = JSON.stringify(plant.mutate(JSON.parse(exported)));
    expect(judgeExport(planted, expectation).problems).not.toEqual([]);
  });

  it("catches the secret in a page title, a count the popup did not show, and an entry from another server", () => {
    expect(judgeExport(plantSecretInTitle(exported, SECRET), expectation).problems).not.toEqual([]);
    expect(judgeExport(exported, { ...expectation, previewCount: 3 }).problems).toEqual([
      "2 entries, the popup said 3",
    ]);
    expect(judgeExport(exported, { ...expectation, hosts: [] }).problems).toHaveLength(2);
  });

  it("sees har-to-k6 reject a data: row and har-validator reject a log without its creator", async () => {
    const file = NodePath.join(work, "data-row.har");
    NodeFS.writeFileSync(file, plantDataRow(exported));
    expect(convertsWithK6(file, work)).toBe(false);
    expect(await validateHar(plantNoCreator(exported))).not.toBeNull();
  });
});

describe("the tab, cancel, disk-full and crash judges", () => {
  const state = {
    name: "getPopup({ tabId: 0 })",
    expect: "state" as const,
    state: { read: (v: unknown) => v, equals: 1 },
  };
  const refused = { name: "getPopup({ tabId: -1 })", expect: "refused" as const };

  it("wants states for missing tabs and refusals for negative ids", () => {
    expect(
      judgeTabCases([
        { case: state, called: { ok: true, value: 1 } },
        { case: refused, called: { ok: false, error: "Invalid" } },
      ]),
    ).toEqual([]);
    expect(judgeTabCases([{ case: state, called: { ok: false, error: "boom" } }])).toHaveLength(1);
    expect(judgeTabCases([{ case: refused, called: { ok: true, value: {} } }])).toHaveLength(1);
  });

  const journal = '{"started":"/d/x.har.part"}\n{"ended":"/d/x.har.part"}\n';
  it("wants a cancel to stop within one chunk and leave nothing", () => {
    const ok = {
      state: "cancelled",
      audit: { bytesAtCancel: 10, bytesAtStop: 10 + CANCEL_BOUND_BYTES },
      left: [],
      journal,
    };
    expect(judgeCancel(ok)).toEqual([]);
    expect(
      judgeCancel({ ...ok, audit: { bytesAtCancel: 10, bytesAtStop: 11 + CANCEL_BOUND_BYTES } }),
    ).toHaveLength(1);
    expect(judgeCancel({ ...ok, left: ["x.har.part"] })).toHaveLength(1);
    expect(judgeCancel({ ...ok, journal: '{"started":"/d/x.har.part"}\n' })).toHaveLength(1);
  });

  it("wants disk-full with a need above the free bytes, on the tmpfs, leaving nothing", () => {
    const ok = {
      state: { kind: "write-failed", failure: { kind: "disk-full", needBytes: 9, freeBytes: 0 } },
      tmpfs: true,
      left: [],
      journal,
    };
    expect(judgeDiskFull(ok)).toEqual([]);
    expect(judgeDiskFull({ ...ok, tmpfs: false })).toHaveLength(1);
    expect(
      judgeDiskFull({
        ...ok,
        state: { kind: "write-failed", failure: { kind: "disk-full", needBytes: 9, freeBytes: 9 } },
      }),
    ).toHaveLength(1);
    expect(judgeDiskFull({ ...ok, state: { kind: "done" } })).toHaveLength(1);
  });

  it("wants the next start to delete the part a killed export left", () => {
    expect(judgeAfterCrash({ steps: ["delete-export-part"], left: [] })).toEqual([]);
    expect(judgeAfterCrash({ steps: [], left: ["killed.har.part"] })).toHaveLength(2);
  });
});
