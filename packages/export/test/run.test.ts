import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";
import * as HarValidator from "har-validator";
import { buildHarEntry } from "@one-click-har/har/build";
import { isoDateTimeFromEpochMs, toHarUrl, type HarDocument } from "@one-click-har/har/model";
import { parseHarJson } from "@one-click-har/har/parse";
import { redactHarEntry } from "@one-click-har/har/redact";
import { summarizeHar } from "@one-click-har/har/summarize";
import {
  exchangeId,
  parsePositiveMinutes,
  toMinute,
  type ByteCount,
  type ChannelKey,
  type EpochMs,
  type PackId,
} from "@one-click-har/recording/ids";
import { afterAll, describe, expect, it } from "vite-plus/test";
import type { ExportRequest } from "../src/jobs.ts";
import {
  REDACT_BODY_MAX,
  WriteRefused,
  runExport,
  type ExportPorts,
  type RedactPort,
} from "../src/run.ts";
import { resolveSelection } from "../src/selection.ts";
import type {
  BodySource,
  DevtoolsBodyRef,
  Material,
  SourceItem,
  SourceRef,
} from "../src/source.ts";
import type { WrittenBody, WrittenPlace, WrittenUrl } from "../src/written.ts";
import { RUN_ID, SITE, TAB_KEY, T0, makeHarEntry } from "./fixtures.ts";
import { run300MbBench, type HeapRunStats } from "./heap-runner.ts";
import { importMutated } from "./mutate.ts";

const require = NodeModule.createRequire(import.meta.url);
const HAR_TO_K6_PKG = require.resolve("har-to-k6/package.json");
const HAR_TO_K6_BIN = NodePath.join(NodePath.dirname(HAR_TO_K6_PKG), "bin", "har-to-k6.js");

const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "och-export-run-"));
afterAll(() => NodeFS.rmSync(tmpDir, { recursive: true, force: true }));

function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "api_key",
  "apikey",
  "key",
  "client_secret",
  "secret",
  "password",
  "auth",
  "code",
]);

function redactJsonValue(val: unknown): { readonly value: unknown; readonly touched: boolean } {
  if (Array.isArray(val)) {
    let touched = false;
    const out = val.map((item) => {
      const r = redactJsonValue(item);
      if (r.touched) touched = true;
      return r.value;
    });
    return { value: out, touched };
  }
  if (typeof val === "object" && val !== null) {
    let touched = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (SECRET_KEYS.has(k.toLowerCase()) && typeof v === "string") {
        out[k] = "[REDACTED]";
        touched = true;
      } else {
        const r = redactJsonValue(v);
        out[k] = r.value;
        if (r.touched) touched = true;
      }
    }
    return { value: out, touched };
  }
  return { value: val, touched: false };
}

function createTestRedactPort(mode: "remove" | "keep"): RedactPort {
  if (mode === "keep") {
    return {
      entry: (entry) => ({
        entry,
        url: entry.request.url as unknown as WrittenUrl,
        touched: false,
      }),
      body: (_mime, bytes) => ({ body: bytes as WrittenBody, touched: false }),
      covered: [],
    };
  }
  let entryIdx = 0;
  const covered: readonly WrittenPlace[] = [
    "url",
    "headers",
    "cookies",
    "query",
    "post-data",
    "json-body",
    "form-body",
    "page-title",
  ];
  return {
    entry: (entry) => {
      const res = redactHarEntry(entry, undefined, entryIdx);
      entryIdx += 1;
      return {
        entry: res.entry,
        url: res.url as unknown as WrittenUrl,
        touched: res.touched,
      };
    },
    body: (mimeType, bytes) => {
      const lower = mimeType.toLowerCase();
      const text = new TextDecoder().decode(bytes);
      if (lower.includes("json")) {
        try {
          const parsed: unknown = JSON.parse(text);
          const red = redactJsonValue(parsed);
          return {
            body: new TextEncoder().encode(JSON.stringify(red.value)) as WrittenBody,
            touched: red.touched,
          };
        } catch {
          return null;
        }
      }
      if (lower.includes("x-www-form-urlencoded")) {
        const params = new URLSearchParams(text);
        let touched = false;
        const keys = Array.from(params.keys());
        for (const k of keys) {
          if (SECRET_KEYS.has(k.toLowerCase())) {
            params.set(k, "[REDACTED]");
            touched = true;
          }
        }
        return {
          body: new TextEncoder().encode(params.toString()) as WrittenBody,
          touched,
        };
      }
      return null;
    },
    covered,
  };
}

function nodeDecode(
  encoding: string,
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (encoding !== "gzip" && encoding !== "deflate") return chunks;
  return {
    async *[Symbol.asyncIterator]() {
      const transform = encoding === "gzip" ? NodeZlib.createGunzip() : NodeZlib.createInflate();
      const piped = NodeStream.Readable.from(chunks).pipe(transform);
      for await (const chunk of piped) {
        yield new Uint8Array(chunk as Buffer);
      }
    },
  };
}

function makeSelection() {
  const m0 = toMinute(T0);
  return resolveSelection(
    {
      scope: "everything",
      range: { kind: "last", minutes: parsePositiveMinutes(15)! },
      include: "all",
    },
    { now: m0, localMidnight: m0, tab: TAB_KEY, tabFirstSeen: m0, devtoolsFirst: m0 },
  );
}

describe("runExport over fake ports in Node", () => {
  it("writes a valid HAR 1.2 file, converts with har-to-k6, decodes SHA-256 bodies, filters data: rows, and removes all secrets", async () => {
    const secrets = [
      "secret-oauth-code-99",
      "secret-auth-bearer-xyz",
      "secret-cookie-sid-77",
      "secret-json-token-44",
      "secret-form-password-55",
      "secret-upload-api-key-33",
    ] as const;

    const jsonPlain = new TextEncoder().encode(
      JSON.stringify({
        ok: true,
        padding: "compressible-payload-".repeat(20),
        token: secrets[3],
        nested: { access_token: secrets[3] },
      }),
    );
    const jsonGzip = NodeZlib.gzipSync(jsonPlain);
    const pngBytes = NodeCrypto.randomBytes(4096);
    const formPlain = new TextEncoder().encode(`user=alice&password=${secrets[4]}`);
    const uploadPlain = new TextEncoder().encode(JSON.stringify({ api_key: secrets[5] }));

    const expectedUnredactedHashes = {
      png: sha256(pngBytes),
    };

    const k1 = exchangeId(RUN_ID, "1" as ChannelKey);
    const k2 = exchangeId(RUN_ID, "2" as ChannelKey);
    const k3 = exchangeId(RUN_ID, "3" as ChannelKey);
    const k4 = exchangeId(RUN_ID, "4" as ChannelKey);

    const recItems: SourceItem[] = [
      {
        source: "recording",
        key: k1,
        startedAt: T0,
        startedMinute: toMinute(T0),
        url: `https://app.example/callback?code=${secrets[0]}&state=ok`,
        method: "GET",
        tab: TAB_KEY,
        site: SITE,
        navigation: true,
        fetchOrXhr: false,
        inProgress: false,
        ref: "r1" as unknown as SourceRef,
      },
      {
        source: "recording",
        key: k2,
        startedAt: (T0 + 10) as EpochMs,
        startedMinute: toMinute(T0),
        url: "https://app.example/logo.png",
        method: "GET",
        tab: TAB_KEY,
        site: SITE,
        navigation: false,
        fetchOrXhr: false,
        inProgress: false,
        ref: "r2" as unknown as SourceRef,
      },
      {
        source: "recording",
        key: k3,
        startedAt: (T0 + 20) as EpochMs,
        startedMinute: toMinute(T0),
        url: "https://app.example/login",
        method: "POST",
        tab: TAB_KEY,
        site: SITE,
        navigation: false,
        fetchOrXhr: true,
        inProgress: false,
        ref: "r3" as unknown as SourceRef,
      },
    ];

    const dtItems: SourceItem[] = [
      {
        source: "devtools",
        key: k1,
        startedAt: (T0 + 2) as EpochMs,
        startedMinute: toMinute(T0),
        url: `https://app.example/callback?code=${secrets[0]}&state=ok`,
        method: "GET",
        tab: TAB_KEY,
        site: SITE,
        navigation: true,
        fetchOrXhr: false,
        inProgress: false,
        ref: "d1" as unknown as SourceRef,
      },
      {
        source: "devtools",
        key: null,
        startedAt: (T0 + 15) as EpochMs,
        startedMinute: toMinute(T0),
        url: "data:image/png;base64,iVBORw0KGgo=",
        method: "GET",
        tab: TAB_KEY,
        site: SITE,
        navigation: false,
        fetchOrXhr: false,
        inProgress: false,
        ref: "d-data" as unknown as SourceRef,
      },
      {
        source: "devtools",
        key: k4,
        startedAt: (T0 + 30) as EpochMs,
        startedMinute: toMinute(T0),
        url: "https://app.example/form",
        method: "POST",
        tab: TAB_KEY,
        site: SITE,
        navigation: false,
        fetchOrXhr: true,
        inProgress: false,
        ref: "d4" as unknown as SourceRef,
      },
    ];

    const packAt = (id: string, len: number): BodySource => ({
      kind: "stored",
      at: {
        kind: "pack",
        pack: `${SITE}/${RUN_ID}-0` as PackId,
        offset: 0,
        length: len as ByteCount,
      },
      wireEncoding: id === "r1" ? "gzip" : null,
      check: "length-matched",
    });

    const dtRef4 = "dt4" as unknown as DevtoolsBodyRef;
    const bodyMap = new Map<
      BodySource,
      { chunks: Uint8Array[] | string[]; kind: "bytes" | "text"; wireEncoding?: string | null }
    >([
      // Assigned per load below
    ]);

    const materials = new Map<string, Material>();
    const b1 = packAt("r1", jsonGzip.length);
    bodyMap.set(b1, {
      kind: "bytes",
      chunks: [jsonGzip.subarray(0, 10), jsonGzip.subarray(10)],
      wireEncoding: "gzip",
    });
    materials.set("r1", {
      entry: makeHarEntry({
        url: `https://app.example/callback?code=${secrets[0]}&state=ok`,
        startedAt: T0,
        mimeType: "application/json",
        headers: [
          { name: "Authorization", value: `Bearer ${secrets[1]}` },
          { name: "Cookie", value: `sid=${secrets[2]}` },
        ],
        bodySize: jsonGzip.length,
      }),
      body: { kind: "candidates", list: [b1] },
      upload: { kind: "empty" },
    });
    materials.set("d1", {
      entry: makeHarEntry({
        url: `https://app.example/callback?code=${secrets[0]}&state=ok`,
        startedAt: (T0 + 2) as EpochMs,
        mimeType: "application/json",
        headers: [
          { name: "Authorization", value: `Bearer ${secrets[1]}` },
          { name: "Cookie", value: `sid=${secrets[2]}` },
        ],
        bodySize: jsonGzip.length,
      }),
      body: { kind: "none", reason: "devtools-discarded" },
      upload: { kind: "empty" },
    });
    const b2 = packAt("r2", pngBytes.length);
    bodyMap.set(b2, {
      kind: "bytes",
      chunks: [pngBytes.subarray(0, 1024), pngBytes.subarray(1024)],
      wireEncoding: null,
    });
    materials.set("r2", {
      entry: makeHarEntry({
        url: "https://app.example/logo.png",
        startedAt: (T0 + 10) as EpochMs,
        mimeType: "image/png",
        bodySize: pngBytes.length,
      }),
      body: { kind: "candidates", list: [b2] },
      upload: { kind: "empty" },
    });
    const u3 = packAt("u3", uploadPlain.length);
    bodyMap.set(u3, { kind: "bytes", chunks: [uploadPlain], wireEncoding: null });
    materials.set("r3", {
      entry: buildHarEntry({
        startedDateTime: isoDateTimeFromEpochMs((T0 + 20) as EpochMs),
        request: {
          method: "POST",
          url: toHarUrl("https://app.example/login")!,
          httpVersion: "HTTP/2.0",
          headers: [{ name: "Content-Type", value: "application/json" }],
          postData: { mimeType: "application/json", text: "" },
        },
        response: {
          status: 204,
          statusText: "No Content",
          content: { size: 0, mimeType: "" },
          bodySize: 0,
        },
        timings: { send: 1, wait: 2, receive: 1 },
      }),
      body: { kind: "empty" },
      upload: { kind: "candidates", list: [u3] },
    });
    const b4: BodySource = {
      kind: "devtools",
      ref: dtRef4,
      encoding: null,
      length: formPlain.length,
    };
    bodyMap.set(b4, { kind: "text", chunks: [new TextDecoder().decode(formPlain)] });
    materials.set("d4", {
      entry: makeHarEntry({
        url: "https://app.example/form",
        startedAt: (T0 + 30) as EpochMs,
        mimeType: "application/x-www-form-urlencoded",
      }),
      body: { kind: "candidates", list: [b4] },
      upload: { kind: "empty" },
    });

    const runWithSecrets = async (secretsMode: "remove" | "keep") => {
      let out = "";
      let byteCount = 0;
      const ports: ExportPorts = {
        recording: {
          name: "recording",
          async list() {
            return { items: recItems, notNetwork: {} };
          },
          async load(item) {
            return materials.get(item.ref as unknown as string)!;
          },
        },
        devtools: {
          name: "devtools",
          async list() {
            return { items: dtItems, notNetwork: {} };
          },
          async load(item) {
            return materials.get(item.ref as unknown as string)!;
          },
        },
        bodies: {
          async open(source) {
            const entry = bodyMap.get(source);
            if (!entry) return { ok: false, reason: "source-error" };
            if (entry.kind === "bytes") {
              const chunks = entry.chunks as Uint8Array[];
              return {
                ok: true,
                body: {
                  kind: "bytes",
                  wireEncoding: entry.wireEncoding ?? null,
                  chunks: {
                    async *[Symbol.asyncIterator]() {
                      for (const c of chunks) yield c;
                    },
                  },
                },
              };
            }
            const chunks = entry.chunks as string[];
            return {
              ok: true,
              body: {
                kind: "text",
                encoding: null,
                chunks: {
                  async *[Symbol.asyncIterator]() {
                    for (const c of chunks) yield c;
                  },
                },
              },
            };
          },
        },
        sink: {
          async write(text) {
            out += text;
            byteCount += Buffer.byteLength(text, "utf8");
          },
          bytesWritten: () => byteCount as ByteCount,
        },
        creator: { name: "One-Click HAR", version: "0.0.0" },
        redact: createTestRedactPort(secretsMode),
        decode: nodeDecode,
        yieldNow: async () => {},
        onProgress: () => {},
        signal: new AbortController().signal,
      };
      const req: ExportRequest = {
        selection: {
          scope: "everything",
          range: { kind: "last", minutes: parsePositiveMinutes(15)! },
          include: "all",
        },
        bodies: "include",
        secrets: secretsMode,
        packaging: "har",
        fileName: null,
      };
      const report = await runExport(req, makeSelection(), ports);
      return { out, report };
    };

    // 1. Keep mode (negative control for secret scan): secrets are present in the written document.
    const smoke = await run300MbBench(1, 1);
    expect(smoke).toHaveLength(1);
    expect(REDACT_BODY_MAX).toBe(1_048_576);
    const kept = await runWithSecrets("keep");
    for (const s of secrets) {
      expect(kept.out).toContain(s);
    }

    // 2. Remove mode: valid JSON, passes HAR 1.2, passes har-validator 5.1.5, converts with har-to-k6 0.13.0, zero secrets.
    const removed = await runWithSecrets("remove");
    const doc = JSON.parse(removed.out) as HarDocument;

    expect(parseHarJson(removed.out).ok).toBe(true);
    await expect(HarValidator.har(doc)).resolves.toBe(doc);

    // Every secret removed from whole document, page titles included.
    for (const s of secrets) {
      expect(removed.out).not.toContain(s);
    }
    expect(doc.log.pages![0]!.title).not.toContain(secrets[0]);
    expect(doc.log.pages![0]!.title).toContain("REDACTED");

    // data: row counted, not written as an entry.
    expect(doc.log.entries).toHaveLength(4);
    expect(removed.report.notNetwork).toEqual({ "data:": 1 });
    expect(removed.report.bodies.filledIn).toBe(1);

    // Gzip body decoded size and PNG base64 SHA-256 exact.
    const entry1 = doc.log.entries[0]!;
    expect(entry1.response.bodySize).toBe(jsonGzip.length);
    expect(entry1.response.content.size).toBe(
      Buffer.byteLength(entry1.response.content.text!, "utf8"),
    );
    expect(entry1.response.content.size).toBeGreaterThan(jsonGzip.length);
    const entry2 = doc.log.entries[1]!;
    const decodedPng = new Uint8Array(Buffer.from(entry2.response.content.text!, "base64"));
    expect(sha256(decodedPng)).toBe(expectedUnredactedHashes.png);

    // har-to-k6 conversion: check output file exists and contains k6 script, not just exit code.
    const harPath = NodePath.join(tmpDir, "export.har");
    const k6Path = NodePath.join(tmpDir, "k6-out.js");
    NodeFS.writeFileSync(harPath, removed.out, "utf8");
    const k6Res = NodeChildProcess.spawnSync(
      process.execPath,
      [HAR_TO_K6_BIN, harPath, "-o", k6Path],
      {
        encoding: "utf8",
      },
    );
    expect(k6Res.status).toBe(0);
    expect(NodeFS.existsSync(k6Path), `har-to-k6 failed: ${k6Res.stdout}${k6Res.stderr}`).toBe(
      true,
    );
    const k6Text = NodeFS.readFileSync(k6Path, "utf8");
    expect(k6Text).toContain("http.get(");
    expect(k6Text).toContain("https://app.example/callback");
  });

  it("recovers cleanly when a body reader fails after its first chunk or is capped at first-part", async () => {
    const k1 = exchangeId(RUN_ID, "10" as ChannelKey);
    const k2 = exchangeId(RUN_ID, "11" as ChannelKey);
    const items: SourceItem[] = [
      {
        source: "recording",
        key: k1,
        startedAt: T0,
        startedMinute: toMinute(T0),
        url: "https://app.example/cut",
        method: "GET",
        tab: TAB_KEY,
        site: SITE,
        navigation: true,
        fetchOrXhr: false,
        inProgress: false,
        ref: "cut" as unknown as SourceRef,
      },
      {
        source: "recording",
        key: k2,
        startedAt: (T0 + 5) as EpochMs,
        startedMinute: toMinute(T0),
        url: "https://app.example/capped",
        method: "GET",
        tab: TAB_KEY,
        site: SITE,
        navigation: false,
        fetchOrXhr: false,
        inProgress: false,
        ref: "cap" as unknown as SourceRef,
      },
    ];
    const srcCut: BodySource = {
      kind: "stored",
      at: { kind: "file", site: SITE, id: k1, length: 100 as ByteCount },
      wireEncoding: null,
      check: "length-matched",
    };
    const srcCap: BodySource = {
      kind: "stored",
      at: { kind: "file", site: SITE, id: k2, length: 50 as ByteCount },
      wireEncoding: null,
      check: "first-part",
    };
    let out = "";
    let bytes = 0;
    const ports: ExportPorts = {
      recording: {
        name: "recording",
        async list() {
          return { items, notNetwork: {} };
        },
        async load(item) {
          const ref = item.ref as unknown as string;
          return {
            entry: makeHarEntry({ url: item.url, mimeType: "text/plain" }),
            body: { kind: "candidates", list: [ref === "cut" ? srcCut : srcCap] },
            upload: { kind: "empty" },
          };
        },
      },
      devtools: {
        name: "devtools",
        async list() {
          return { items: [], notNetwork: {} };
        },
        async load() {
          throw new Error("unused");
        },
      },
      bodies: {
        async open(source) {
          if (source === srcCut) {
            return {
              ok: true,
              body: {
                kind: "bytes",
                wireEncoding: null,
                chunks: {
                  async *[Symbol.asyncIterator]() {
                    yield new TextEncoder().encode("first-chunk-");
                    throw new Error("EIO");
                  },
                },
              },
            };
          }
          return {
            ok: true,
            body: {
              kind: "bytes",
              wireEncoding: null,
              chunks: {
                async *[Symbol.asyncIterator]() {
                  yield new TextEncoder().encode("first-part-only");
                },
              },
            },
          };
        },
      },
      sink: {
        async write(text) {
          out += text;
          bytes += Buffer.byteLength(text, "utf8");
        },
        bytesWritten: () => bytes as ByteCount,
      },
      creator: { name: "One-Click HAR", version: "0.0.0" },
      redact: createTestRedactPort("remove"),
      decode: nodeDecode,
      yieldNow: async () => {},
      onProgress: () => {},
      signal: new AbortController().signal,
    };

    const report = await runExport(
      {
        selection: {
          scope: "everything",
          range: { kind: "last", minutes: parsePositiveMinutes(15)! },
          include: "all",
        },
        bodies: "include",
        secrets: "remove",
        packaging: "har",
        fileName: null,
      },
      makeSelection(),
      ports,
    );

    const doc = JSON.parse(out) as HarDocument;
    await expect(HarValidator.har(doc)).resolves.toBe(doc);
    expect(report.bodies.cutShort).toBe(2);
    expect(doc.log.entries[0]!.response.content.text).toBe("first-chunk-");
    expect(doc.log.entries[0]!._harExport).toMatchObject({
      bodyState: "unavailable",
      bodyMissing: "source-error",
      bodyIncomplete: true,
    });
    expect(doc.log.entries[1]!.response.content.text).toBe("first-part-only");
    expect(doc.log.entries[1]!._harExport).toMatchObject({
      bodyState: "unavailable",
      bodyMissing: "over-body-cap",
      bodyIncomplete: true,
    });
    const summary = summarizeHar(doc);
    expect(summary.bodies.withBody).toBe(0);
    expect(summary.bodies.incomplete).toBe(2);
  });

  it("cancel stops within one chunk and WriteRefused propagates", async () => {
    const controller = new AbortController();
    let chunksYielded = 0;
    const k1 = exchangeId(RUN_ID, "20" as ChannelKey);
    const src: BodySource = {
      kind: "stored",
      at: { kind: "file", site: SITE, id: k1, length: 100 as ByteCount },
      wireEncoding: null,
      check: "length-matched",
    };
    const item: SourceItem = {
      source: "recording",
      key: k1,
      startedAt: T0,
      startedMinute: toMinute(T0),
      url: "https://app.example/stream",
      method: "GET",
      tab: TAB_KEY,
      site: SITE,
      navigation: true,
      fetchOrXhr: false,
      inProgress: false,
      ref: "s" as unknown as SourceRef,
    };

    const ports: ExportPorts = {
      recording: {
        name: "recording",
        async list() {
          return { items: [item], notNetwork: {} };
        },
        async load() {
          return {
            entry: makeHarEntry({ url: item.url, mimeType: "text/plain" }),
            body: { kind: "candidates", list: [src] },
            upload: { kind: "empty" },
          };
        },
      },
      devtools: {
        name: "devtools",
        async list() {
          return { items: [], notNetwork: {} };
        },
        async load() {
          throw new Error("unused");
        },
      },
      bodies: {
        async open() {
          return {
            ok: true,
            body: {
              kind: "bytes",
              wireEncoding: null,
              chunks: {
                async *[Symbol.asyncIterator]() {
                  chunksYielded += 1;
                  yield new TextEncoder().encode("chunk-1");
                  controller.abort();
                  chunksYielded += 1;
                  yield new TextEncoder().encode("chunk-2");
                },
              },
            },
          };
        },
      },
      sink: {
        async write() {},
        bytesWritten: () => 0 as ByteCount,
      },
      creator: { name: "One-Click HAR", version: "0.0.0" },
      redact: createTestRedactPort("keep"),
      decode: nodeDecode,
      yieldNow: async () => {},
      onProgress: () => {},
      signal: controller.signal,
    };

    await expect(
      runExport(
        {
          selection: {
            scope: "everything",
            range: { kind: "last", minutes: parsePositiveMinutes(15)! },
            include: "all",
          },
          bodies: "include",
          secrets: "keep",
          packaging: "har",
          fileName: null,
        },
        makeSelection(),
        ports,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(chunksYielded).toBe(2); // Stopped immediately on the chunk after abort.

    const refusingPorts: ExportPorts = {
      ...ports,
      signal: new AbortController().signal,
      sink: {
        async write() {
          throw new WriteRefused({
            kind: "disk-full",
            needBytes: 100 as ByteCount,
            freeBytes: 0 as ByteCount,
          });
        },
        bytesWritten: () => 0 as ByteCount,
      },
    };
    await expect(
      runExport(
        {
          selection: {
            scope: "everything",
            range: { kind: "last", minutes: parsePositiveMinutes(15)! },
            include: "all",
          },
          bodies: "include",
          secrets: "keep",
          packaging: "har",
          fileName: null,
        },
        makeSelection(),
        refusingPorts,
      ),
    ).rejects.toBeInstanceOf(WriteRefused);
  });

  it("streams a 300 MB synthetic export on a 512 MB heap across 3 runs", () => {
    const runnerUrl = NodeURL.pathToFileURL(
      NodePath.join(import.meta.dirname, "heap-runner.ts"),
    ).href;
    const script = `import { run300MbBench } from ${JSON.stringify(runnerUrl)}; const r = await run300MbBench(3); console.log(JSON.stringify(r));`;
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      ["--max-old-space-size=512", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    );
    expect(child.status, `child stderr: ${child.stderr}`).toBe(0);
    const stats = JSON.parse(child.stdout.trim()) as readonly HeapRunStats[];
    expect(stats).toHaveLength(3);
    for (const s of stats) {
      expect(s.requests).toBe(100);
      expect(s.bytesWritten).toBeGreaterThanOrEqual(300 * 1_048_576);
      expect(s.peakHeapBytes).toBeLessThan(512 * 1_048_576);
    }
    const maxHeapMiB = Math.max(...stats.map((s) => s.peakHeapBytes)) / 1_048_576;
    const maxRssMiB = Math.max(...stats.map((s) => s.peakRssBytes)) / 1_048_576;
    const times = stats.map((s) => `${String(s.elapsedMs)}ms`).join(", ");
    console.log(
      `300 MB export on 512 MB heap (3 runs): peakHeap=${maxHeapMiB.toFixed(1)} MiB, peakRss=${maxRssMiB.toFixed(1)} MiB, times=[${times}]`,
    );
  });

  it("planted: skipping classifyUrl in runExport causes har-to-k6 to write no file", async () => {
    const mutated = await importMutated<{ runExport: typeof runExport }>("run.ts", {
      id: "skip-classify-url",
      from: "const recItems = filterNetworkItems(recListing.items, notNetwork);\n  const dtItems = filterNetworkItems(dtListing.items, notNetwork);",
      to: "const recItems = [...recListing.items];\n  const dtItems = [...dtListing.items];",
    });

    const dataItem: SourceItem = {
      source: "devtools",
      key: null,
      startedAt: T0,
      startedMinute: toMinute(T0),
      url: "data:image/png;base64,iVBORw0KGgo=",
      method: "GET",
      tab: TAB_KEY,
      site: SITE,
      navigation: true,
      fetchOrXhr: false,
      inProgress: false,
      ref: "data" as unknown as SourceRef,
    };
    let out = "";
    let bytes = 0;
    await mutated.runExport(
      {
        selection: {
          scope: "everything",
          range: { kind: "last", minutes: parsePositiveMinutes(15)! },
          include: "all",
        },
        bodies: "omit",
        secrets: "remove",
        packaging: "har",
        fileName: null,
      },
      makeSelection(),
      {
        recording: {
          name: "recording",
          async list() {
            return { items: [], notNetwork: {} };
          },
          async load() {
            throw new Error("unused");
          },
        },
        devtools: {
          name: "devtools",
          async list() {
            return { items: [dataItem], notNetwork: {} };
          },
          async load() {
            return {
              entry: buildHarEntry({
                startedDateTime: isoDateTimeFromEpochMs(T0),
                request: { method: "GET", url: toHarUrl("data:image/png;base64,iVBORw0KGgo=")! },
                response: { status: 200 },
              }),
              body: { kind: "empty" },
              upload: { kind: "empty" },
            };
          },
        },
        bodies: {
          async open() {
            return { ok: false, reason: "source-error" };
          },
        },
        sink: {
          async write(t) {
            out += t;
            bytes += Buffer.byteLength(t, "utf8");
          },
          bytesWritten: () => bytes as ByteCount,
        },
        creator: { name: "One-Click HAR", version: "0.0.0" },
        redact: createTestRedactPort("remove"),
        decode: nodeDecode,
        yieldNow: async () => {},
        onProgress: () => {},
        signal: new AbortController().signal,
      },
    );

    const harPath = NodePath.join(tmpDir, "mutated-data.har");
    const k6Path = NodePath.join(tmpDir, "mutated-k6.js");
    NodeFS.writeFileSync(harPath, out, "utf8");
    const k6Res = NodeChildProcess.spawnSync(
      process.execPath,
      [HAR_TO_K6_BIN, harPath, "-o", k6Path],
      {
        encoding: "utf8",
      },
    );
    expect(k6Res.status).toBe(0);
    expect(NodeFS.existsSync(k6Path)).toBe(false);
  });
});
