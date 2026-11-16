import { buildHarEntry } from "@one-click-har/har/build";
import { isoDateTimeFromEpochMs, toHarUrl } from "@one-click-har/har/model";
import {
  exchangeId,
  parsePositiveMinutes,
  toMinute,
  type ByteCount,
  type ChannelKey,
  type EpochMs,
  type PackId,
  type RunId,
  type Site,
} from "@one-click-har/recording/ids";
import { BODY_CHUNK_BYTES, runExport, type ExportPorts } from "../src/run.ts";
import { resolveSelection } from "../src/selection.ts";
import type { BodySource, SourceItem, SourceRef } from "../src/source.ts";
import type { WrittenBody, WrittenUrl } from "../src/written.ts";

export interface HeapRunStats {
  readonly run: number;
  readonly bytesWritten: number;
  readonly peakHeapBytes: number;
  readonly peakRssBytes: number;
  readonly elapsedMs: number;
  readonly requests: number;
}

export async function run300MbBench(runs = 3, entryCount = 100): Promise<readonly HeapRunStats[]> {
  const bodySize = BODY_CHUNK_BYTES; // 100 * 3 MiB = 300 MiB
  const runId = "mhz02" as RunId;
  const site = "bench.example" as Site;
  const t0 = 1_794_800_040_000 as EpochMs;
  const m0 = toMinute(t0);
  const chunkTemplate = new Uint8Array(bodySize);
  chunkTemplate.fill(0x41); // 'A'

  const items: SourceItem[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    const startedAt = (t0 + i) as EpochMs;
    items.push({
      source: "recording",
      key: exchangeId(runId, String(i + 1) as ChannelKey),
      startedAt,
      startedMinute: m0,
      url: `https://bench.example/blob/${String(i)}`,
      method: "GET",
      tab: null,
      site,
      navigation: i === 0,
      fetchOrXhr: true,
      inProgress: false,
      ref: String(i) as unknown as SourceRef,
    });
  }

  const baseEntry = buildHarEntry({
    startedDateTime: isoDateTimeFromEpochMs(t0),
    request: {
      method: "GET",
      url: toHarUrl("https://bench.example/blob")!,
      httpVersion: "HTTP/2.0",
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/2.0",
      content: { size: -1, mimeType: "application/octet-stream" },
      bodySize,
    },
    timings: { send: 1, wait: 1, receive: 1 },
  });

  const selection = resolveSelection(
    {
      scope: "everything",
      range: { kind: "last", minutes: parsePositiveMinutes(15)! },
      include: "all",
    },
    { now: m0, localMidnight: m0, tab: null, tabFirstSeen: null, devtoolsFirst: null },
  );

  const results: HeapRunStats[] = [];
  for (let r = 0; r < runs; r += 1) {
    let written = 0;
    let peakHeap = process.memoryUsage().heapUsed;
    let peakRss = process.memoryUsage().rss;
    const sampleMem = () => {
      const m = process.memoryUsage();
      if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
      if (m.rss > peakRss) peakRss = m.rss;
    };

    const ports: ExportPorts = {
      recording: {
        name: "recording",
        async list() {
          return { items, notNetwork: {} };
        },
        async load(item) {
          const bodySource: BodySource = {
            kind: "stored",
            at: {
              kind: "pack",
              pack: `${site}/${runId}-0` as PackId,
              offset: 0,
              length: bodySize as ByteCount,
            },
            wireEncoding: null,
            check: "length-matched",
          };
          return {
            entry: {
              ...baseEntry,
              request: { ...baseEntry.request, url: toHarUrl(item.url)! },
            },
            body: { kind: "candidates", list: [bodySource] },
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
                  yield chunkTemplate;
                },
              },
            },
          };
        },
      },
      sink: {
        async write(text: string) {
          written += Buffer.byteLength(text, "utf8");
          sampleMem();
        },
        bytesWritten: () => written as ByteCount,
      },
      creator: { name: "One-Click HAR", version: "0.0.0" },
      redact: {
        entry: (entry) => ({
          entry,
          url: entry.request.url as unknown as WrittenUrl,
          touched: false,
        }),
        body: (_mime, bytes) => ({ body: bytes as WrittenBody, touched: false }),
        covered: [],
      },
      decode: (_enc, chunks) => chunks,
      yieldNow: async () => {},
      onProgress: () => {},
      signal: new AbortController().signal,
    };

    const start = performance.now();
    const report = await runExport(
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
      selection,
      ports,
    );
    const elapsedMs = Math.round(performance.now() - start);
    sampleMem();
    results.push({
      run: r + 1,
      bytesWritten: report.fileBytes,
      peakHeapBytes: peakHeap,
      peakRssBytes: peakRss,
      elapsedMs,
      requests: report.requests,
    });
  }
  return results;
}
