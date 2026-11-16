// The export itself, host-neutral: both hosts call runExport with their own ports, and Node tests call it with fakes.

import type { HarEntry, HarPostData } from "@one-click-har/har/model";
import type { BodyCheck } from "@one-click-har/recording/exchange";
import type { ByteCount } from "@one-click-har/recording/ids";
import {
  encodeChunk,
  encodeTextChunk,
  entryExtension,
  entryHead,
  entryTail,
  finishEncoder,
  startEncoder,
  textModeFor,
  type BodyEnd,
  type EncoderState,
} from "./entry-writer.ts";
import { encodeUtf8 } from "./internal.ts";
import type { ExportRequest, WriteFailure } from "./jobs.ts";
import { devtoolsBodyWanted, mergeEntry, pairItems, type MergedEntry } from "./merge.ts";
import { MISSING_REASONS, type MissingReason } from "./missing.ts";
import { finishPages, pageFor, startPages } from "./pages.ts";
import { emptyReport, reportComment, tally, type ExportReport } from "./report.ts";
import type { ResolvedSelection } from "./selection.ts";
import {
  classifyUrl,
  type AbortSignalLike,
  type BodyCandidates,
  type BodyReader,
  type BodySource,
  type ExchangeSource,
  type SourceItem,
} from "./source.ts";
import type { WrittenBody, WrittenPlace, WrittenUrl } from "./written.ts";

export const BODY_CHUNK_BYTES = 3 * 1_048_576;
/** JSON and form bodies up to this size are read whole, parsed and redacted when secrets are removed. */
export const REDACT_BODY_MAX = 1_048_576;

/** Where the document goes. The host's sink batches writes and owns the .part file and its rename. */
export interface HarSink {
  write(text: string): Promise<void>;
  readonly bytesWritten: () => ByteCount;
}

/** Thrown by a sink when the file system refuses. The only error runExport lets out, besides an abort. */
export class WriteRefused extends Error {
  readonly failure: WriteFailure;

  constructor(failure: WriteFailure, message?: string) {
    super(message ?? failure.kind);
    this.name = "WriteRefused";
    this.failure = failure;
  }
}

/**
 * The only producer of Written values. With secrets "remove" it applies @one-click-har/har/redact; with "keep" it
 * passes values through. Page titles, bodies and entries reach the sink only through it.
 */
export interface RedactPort {
  entry(entry: HarEntry): {
    readonly entry: HarEntry;
    readonly url: WrittenUrl;
    readonly touched: boolean;
  };
  /** JSON or form bodies up to REDACT_BODY_MAX. null for a body it does not parse; the report lists it as not scanned. */
  body(
    mimeType: string,
    bytes: Uint8Array,
  ): { readonly body: WrittenBody; readonly touched: boolean } | null;
  readonly covered: readonly WrittenPlace[];
}

export interface ExportPorts {
  readonly recording: ExchangeSource;
  readonly devtools: ExchangeSource;
  readonly bodies: BodyReader;
  readonly sink: HarSink;
  readonly creator: { readonly name: string; readonly version: string };
  readonly redact: RedactPort;
  /** Wire-encoded bytes to decoded bytes, chunk by chunk (gzip, deflate, br, zstd). */
  readonly decode: (
    encoding: string,
    chunks: AsyncIterable<Uint8Array>,
  ) => AsyncIterable<Uint8Array>;
  readonly yieldNow: () => Promise<void>;
  readonly onProgress: (p: {
    readonly done: number;
    readonly total: number;
    readonly bytes: ByteCount;
  }) => void;
  readonly signal: AbortSignalLike;
}

function throwIfAborted(signal: AbortSignalLike): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const err = new Error("Export aborted");
  err.name = "AbortError";
  throw err;
}

function isRedactableBodyMime(mimeType: string): boolean {
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return base.includes("json") || base.includes("x-www-form-urlencoded");
}

function addNotNetworkCounts(
  target: Record<string, number>,
  source: { readonly [scheme: string]: number },
): void {
  for (const [scheme, count] of Object.entries(source)) {
    if (count > 0) target[scheme] = (target[scheme] ?? 0) + count;
  }
}

function filterNetworkItems(
  items: readonly SourceItem[],
  notNetwork: Record<string, number>,
): SourceItem[] {
  const kept: SourceItem[] = [];
  for (const item of items) {
    const kind = classifyUrl(item.url);
    if (kind.kind === "network") {
      kept.push(item);
    } else if (kind.kind === "not-network") {
      notNetwork[kind.scheme] = (notNetwork[kind.scheme] ?? 0) + 1;
    } else {
      notNetwork["malformed"] = (notNetwork["malformed"] ?? 0) + 1;
    }
  }
  return kept;
}

function concatBytes(parts: readonly Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodeUtf8Whole(bytes: Uint8Array): string {
  let state = startEncoder("utf8-text");
  const first = encodeChunk(state, bytes);
  state = first.state;
  const last = finishEncoder(state);
  return JSON.parse(`"${first.json}${last.json}"`) as string;
}

async function openFirstCandidate(
  candidates: readonly BodySource[],
  bodies: BodyReader,
  signal: AbortSignalLike,
): Promise<
  | {
      readonly ok: true;
      readonly candidate: BodySource;
      readonly body: Extract<
        Awaited<ReturnType<BodyReader["open"]>>,
        { readonly ok: true }
      >["body"];
    }
  | { readonly ok: false; readonly reason: MissingReason }
> {
  let lastReason: MissingReason = "source-error";
  for (const candidate of candidates) {
    throwIfAborted(signal);
    try {
      const res = await bodies.open(candidate, BODY_CHUNK_BYTES, signal);
      if (res.ok) return { ok: true, candidate, body: res.body };
      lastReason = res.reason;
    } catch (err) {
      throwIfAborted(signal);
      if (err instanceof WriteRefused) throw err;
      lastReason = "source-error";
    }
  }
  return { ok: false, reason: lastReason };
}

function countWireBytes(
  chunks: AsyncIterable<Uint8Array>,
  onBytes: (n: number) => void,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of chunks) {
        onBytes(chunk.byteLength);
        yield chunk;
      }
    },
  };
}

async function resolveUpload(
  merged: MergedEntry,
  request: ExportRequest,
  ports: ExportPorts,
  notScanned: Set<string>,
): Promise<{
  readonly entry: HarEntry;
  readonly secretsTouched: boolean;
  readonly neverStored: boolean;
}> {
  const req = merged.entry.request;
  let upload = merged.upload;
  if (request.bodies === "omit" && upload.kind === "candidates") {
    upload = { kind: "none", reason: "omitted-by-choice" };
  }

  if (upload.kind === "empty") {
    const cleanReq = { ...req };
    delete (cleanReq as { postData?: HarPostData }).postData;
    return {
      entry: { ...merged.entry, request: { ...cleanReq, bodySize: -1 } },
      secretsTouched: false,
      neverStored: false,
    };
  }

  if (upload.kind === "none") {
    const cleanReq = { ...req };
    delete (cleanReq as { postData?: HarPostData }).postData;
    return {
      entry: {
        ...merged.entry,
        request: {
          ...cleanReq,
          bodySize: -1,
          comment: MISSING_REASONS[upload.reason].comment,
        },
      },
      secretsTouched: false,
      neverStored: upload.reason === "upload-never-stored",
    };
  }

  const opened = await openFirstCandidate(upload.list, ports.bodies, ports.signal);
  if (!opened.ok) {
    const cleanReq = { ...req };
    delete (cleanReq as { postData?: HarPostData }).postData;
    return {
      entry: {
        ...merged.entry,
        request: {
          ...cleanReq,
          bodySize: -1,
          comment: MISSING_REASONS[opened.reason].comment,
        },
      },
      secretsTouched: false,
      neverStored: false,
    };
  }

  const mimeType = req.postData?.mimeType ?? "";
  let secretsTouched = false;
  let rawBytes: Uint8Array;
  try {
    if (opened.body.kind === "bytes") {
      const stream =
        opened.body.wireEncoding !== null
          ? ports.decode(opened.body.wireEncoding, opened.body.chunks)
          : opened.body.chunks;
      const parts: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of stream) {
        throwIfAborted(ports.signal);
        parts.push(chunk);
        total += chunk.byteLength;
      }
      rawBytes = concatBytes(parts, total);
    } else {
      let text = "";
      for await (const chunk of opened.body.chunks) {
        throwIfAborted(ports.signal);
        text += chunk;
      }
      rawBytes = encodeUtf8(text);
    }
  } catch (err) {
    throwIfAborted(ports.signal);
    if (err instanceof WriteRefused) throw err;
    const cleanReq = { ...req };
    delete (cleanReq as { postData?: HarPostData }).postData;
    return {
      entry: {
        ...merged.entry,
        request: {
          ...cleanReq,
          bodySize: -1,
          comment: MISSING_REASONS["source-error"].comment,
        },
      },
      secretsTouched: false,
      neverStored: false,
    };
  }

  let writtenBytes = rawBytes;
  if (request.secrets === "remove") {
    if (rawBytes.byteLength <= REDACT_BODY_MAX && isRedactableBodyMime(mimeType)) {
      const redacted = ports.redact.body(mimeType, rawBytes);
      if (redacted !== null) {
        writtenBytes = redacted.body;
        secretsTouched = redacted.touched;
      } else {
        notScanned.add("request-body");
      }
    } else if (rawBytes.byteLength > 0) {
      notScanned.add("request-body");
    }
  }

  const text = decodeUtf8Whole(writtenBytes);
  return {
    entry: {
      ...merged.entry,
      request: {
        ...req,
        bodySize: writtenBytes.byteLength,
        postData: {
          mimeType,
          params: req.postData?.params ?? [],
          text,
        },
      },
    },
    secretsTouched,
    neverStored: false,
  };
}

function bodyCandidatesForRequest(body: BodyCandidates, request: ExportRequest): BodyCandidates {
  if (request.bodies === "omit" && body.kind === "candidates") {
    return { kind: "none", reason: "omitted-by-choice" };
  }
  return body;
}

interface StreamedBodyResult {
  readonly end: BodyEnd;
  readonly bodyFrom: "stored" | "devtools" | null;
  readonly unchecked: boolean;
  readonly secretsTouched: boolean;
}

async function writeBodyPartPrefix(
  sink: HarSink,
  prefix: string,
  entry: HarEntry,
  mode: "utf8-text" | "base64",
): Promise<void> {
  const bodyKey = mode === "base64" ? ',"encoding":"base64","text":"' : ',"text":"';
  await sink.write(`${prefix}${entryHead(entry)}${bodyKey}`);
}

async function finishAndCloseEntry(
  sink: HarSink,
  encoder: EncoderState,
  end: BodyEnd,
  merged: MergedEntry,
): Promise<void> {
  const finished = finishEncoder(encoder);
  const ext = entryExtension(
    end.kind === "complete"
      ? { ...end, encoder: finished.state }
      : end.kind === "cut-short"
        ? { ...end, encoder: finished.state }
        : end,
    merged.sources,
    merged.inProgress,
  );
  await sink.write(
    `${finished.json}"${entryTail(
      end.kind === "complete"
        ? { ...end, encoder: finished.state }
        : end.kind === "cut-short"
          ? { ...end, encoder: finished.state }
          : end,
      ext,
    )}`,
  );
}

async function writeNoBodyEntry(
  sink: HarSink,
  prefix: string,
  entry: HarEntry,
  end: Extract<BodyEnd, { readonly kind: "empty" | "missing" }>,
  merged: MergedEntry,
): Promise<void> {
  const ext = entryExtension(end, merged.sources, merged.inProgress);
  await sink.write(`${prefix}${entryHead(entry)}${entryTail(end, ext)}`);
}

async function streamByteBody(
  entry: HarEntry,
  prefix: string,
  check: BodyCheck,
  from: "stored" | "devtools",
  rawBody: { readonly chunks: AsyncIterable<Uint8Array>; readonly wireEncoding: string | null },
  merged: MergedEntry,
  request: ExportRequest,
  ports: ExportPorts,
  notScanned: Set<string>,
): Promise<StreamedBodyResult> {
  const mimeType = entry.response.content.mimeType;
  const mode = textModeFor(mimeType, null);
  let wireBytes = 0;
  const countedWire = countWireBytes(rawBody.chunks, (n) => {
    wireBytes += n;
  });
  const decodedStream =
    rawBody.wireEncoding !== null ? ports.decode(rawBody.wireEncoding, countedWire) : countedWire;

  const shouldTryRedact = request.secrets === "remove" && isRedactableBodyMime(mimeType);
  let encoder = startEncoder(mode);
  let headWritten = false;
  let buffered: Uint8Array[] = [];
  let bufferedLen = 0;
  let secretsTouched = false;

  const flushHeadAndBuffer = async (): Promise<void> => {
    await writeBodyPartPrefix(ports.sink, prefix, entry, mode);
    headWritten = true;
    for (const part of buffered) {
      const step = encodeChunk(encoder, part);
      encoder = step.state;
      if (step.json.length > 0) await ports.sink.write(step.json);
    }
    buffered = [];
  };

  try {
    for await (const chunk of decodedStream) {
      throwIfAborted(ports.signal);
      if (chunk.byteLength === 0) continue;
      if (!headWritten && shouldTryRedact) {
        if (bufferedLen + chunk.byteLength <= REDACT_BODY_MAX) {
          buffered.push(chunk);
          bufferedLen += chunk.byteLength;
          continue;
        }
        notScanned.add("response-body (>1 MB)");
        await flushHeadAndBuffer();
      } else if (!headWritten) {
        if (request.secrets === "remove") notScanned.add("response-body");
        await writeBodyPartPrefix(ports.sink, prefix, entry, mode);
        headWritten = true;
      }
      const step = encodeChunk(encoder, chunk);
      encoder = step.state;
      if (step.json.length > 0) await ports.sink.write(step.json);
    }
  } catch (err) {
    throwIfAborted(ports.signal);
    if (err instanceof WriteRefused) throw err;
    if (!headWritten && bufferedLen === 0) {
      await writeNoBodyEntry(
        ports.sink,
        prefix,
        entry,
        { kind: "missing", reason: "source-error" },
        merged,
      );
      return {
        end: { kind: "missing", reason: "source-error" },
        bodyFrom: null,
        unchecked: false,
        secretsTouched: false,
      };
    }
    if (!headWritten) await flushHeadAndBuffer();
    const end: BodyEnd = { kind: "cut-short", encoder, reason: "source-error" };
    await finishAndCloseEntry(ports.sink, encoder, end, merged);
    return { end, bodyFrom: from, unchecked: false, secretsTouched: false };
  }

  if (!headWritten && bufferedLen === 0) {
    await writeNoBodyEntry(ports.sink, prefix, entry, { kind: "empty" }, merged);
    return { end: { kind: "empty" }, bodyFrom: null, unchecked: false, secretsTouched: false };
  }

  if (!headWritten) {
    const whole = concatBytes(buffered, bufferedLen);
    buffered = [];
    const redacted = ports.redact.body(mimeType, whole);
    let toWrite: Uint8Array = whole;
    if (redacted !== null) {
      toWrite = redacted.body;
      secretsTouched = redacted.touched;
    } else {
      notScanned.add("response-body");
    }
    await writeBodyPartPrefix(ports.sink, prefix, entry, mode);
    const step = encodeChunk(encoder, toWrite);
    encoder = step.state;
    if (step.json.length > 0) await ports.sink.write(step.json);
  }

  const end: BodyEnd =
    check === "first-part"
      ? { kind: "cut-short", encoder, reason: "over-body-cap" }
      : { kind: "complete", encoder, wireBytes, check, from };
  await finishAndCloseEntry(ports.sink, encoder, end, merged);
  return {
    end,
    bodyFrom: from,
    unchecked: check === "sink-only",
    secretsTouched,
  };
}

async function streamTextBody(
  entry: HarEntry,
  prefix: string,
  rawBody: { readonly chunks: AsyncIterable<string>; readonly encoding: "base64" | null },
  merged: MergedEntry,
  request: ExportRequest,
  ports: ExportPorts,
  notScanned: Set<string>,
): Promise<StreamedBodyResult> {
  const mimeType = entry.response.content.mimeType;
  const mode = rawBody.encoding === "base64" ? "base64" : textModeFor(mimeType, null);
  const shouldTryRedact =
    request.secrets === "remove" && rawBody.encoding === null && isRedactableBodyMime(mimeType);

  let encoder = startEncoder(mode);
  let headWritten = false;
  let buffered = "";
  let secretsTouched = false;

  const flushHeadAndBuffer = async (): Promise<void> => {
    await writeBodyPartPrefix(ports.sink, prefix, entry, mode);
    headWritten = true;
    if (buffered.length > 0) {
      const step = encodeTextChunk(encoder, buffered);
      encoder = step.state;
      if (step.json.length > 0) await ports.sink.write(step.json);
      buffered = "";
    }
  };

  try {
    for await (const slice of rawBody.chunks) {
      throwIfAborted(ports.signal);
      if (slice.length === 0) continue;
      if (!headWritten && shouldTryRedact) {
        if (buffered.length + slice.length <= REDACT_BODY_MAX) {
          buffered += slice;
          continue;
        }
        notScanned.add("response-body (>1 MB)");
        await flushHeadAndBuffer();
      } else if (!headWritten) {
        if (request.secrets === "remove") notScanned.add("response-body");
        await writeBodyPartPrefix(ports.sink, prefix, entry, mode);
        headWritten = true;
      }
      const step = encodeTextChunk(encoder, slice);
      encoder = step.state;
      if (step.json.length > 0) await ports.sink.write(step.json);
    }
  } catch (err) {
    throwIfAborted(ports.signal);
    if (err instanceof WriteRefused) throw err;
    if (!headWritten && buffered.length === 0) {
      await writeNoBodyEntry(
        ports.sink,
        prefix,
        entry,
        { kind: "missing", reason: "source-error" },
        merged,
      );
      return {
        end: { kind: "missing", reason: "source-error" },
        bodyFrom: null,
        unchecked: false,
        secretsTouched: false,
      };
    }
    if (!headWritten) await flushHeadAndBuffer();
    const end: BodyEnd = { kind: "cut-short", encoder, reason: "source-error" };
    await finishAndCloseEntry(ports.sink, encoder, end, merged);
    return { end, bodyFrom: "devtools", unchecked: false, secretsTouched: false };
  }

  if (!headWritten && buffered.length === 0) {
    await writeNoBodyEntry(ports.sink, prefix, entry, { kind: "empty" }, merged);
    return { end: { kind: "empty" }, bodyFrom: null, unchecked: false, secretsTouched: false };
  }

  if (!headWritten) {
    const rawBytes = encodeUtf8(buffered);
    buffered = "";
    const redacted = ports.redact.body(mimeType, rawBytes);
    await writeBodyPartPrefix(ports.sink, prefix, entry, mode);
    if (redacted !== null) {
      secretsTouched = redacted.touched;
      const step = encodeChunk(encoder, redacted.body);
      encoder = step.state;
      if (step.json.length > 0) await ports.sink.write(step.json);
    } else {
      notScanned.add("response-body");
      const step = encodeChunk(encoder, rawBytes);
      encoder = step.state;
      if (step.json.length > 0) await ports.sink.write(step.json);
    }
  }

  const end: BodyEnd = {
    kind: "complete",
    encoder,
    wireBytes: -1,
    check: "sink-only",
    from: "devtools",
  };
  await finishAndCloseEntry(ports.sink, encoder, end, merged);
  return { end, bodyFrom: "devtools", unchecked: false, secretsTouched };
}

/**
 * Writes one complete HAR 1.2 document into ports.sink and returns what it wrote. Never rejects for a missing or
 * unreadable body: that is a comment in the entry and a count in the report.
 */
export async function runExport(
  request: ExportRequest,
  selection: ResolvedSelection,
  ports: ExportPorts,
): Promise<ExportReport> {
  throwIfAborted(ports.signal);
  const [recListing, dtListing] = await Promise.all([
    ports.recording.list(selection),
    ports.devtools.list(selection),
  ]);
  throwIfAborted(ports.signal);

  const notNetwork: Record<string, number> = {};
  addNotNetworkCounts(notNetwork, recListing.notNetwork);
  addNotNetworkCounts(notNetwork, dtListing.notNetwork);

  const recItems = filterNetworkItems(recListing.items, notNetwork);
  const dtItems = filterNetworkItems(dtListing.items, notNetwork);

  const { pairs, unpaired } = pairItems(recItems, dtItems);
  let report = emptyReport(request.secrets, unpaired, notNetwork);
  const notScanned = new Set<string>();
  let pageState = startPages();

  const total = pairs.length;
  ports.onProgress({ done: 0, total, bytes: ports.sink.bytesWritten() });

  await ports.sink.write(
    `{"log":{"version":"1.2","creator":${JSON.stringify(ports.creator)},"entries":[`,
  );

  for (let i = 0; i < pairs.length; i += 1) {
    throwIfAborted(ports.signal);
    const pair = pairs[i]!;
    const includeBodies = request.bodies === "include";
    const recMat =
      pair.kind === "devtools-only"
        ? null
        : await ports.recording.load(pair.recording, { body: includeBodies });
    const dtMat =
      pair.kind === "recording-only"
        ? null
        : await ports.devtools.load(pair.devtools, {
            body: includeBodies && devtoolsBodyWanted(pair, recMat),
          });
    throwIfAborted(ports.signal);

    const merged = mergeEntry(pair, recMat, dtMat);
    const withUpload = await resolveUpload(merged, request, ports, notScanned);
    const redactedEntry = ports.redact.entry(withUpload.entry);
    const tab = pair.kind === "devtools-only" ? pair.devtools.tab : pair.recording.tab;
    const startedAt =
      pair.kind === "devtools-only" ? pair.devtools.startedAt : pair.recording.startedAt;
    const pageStep = pageFor(pageState, {
      tab,
      startedAt,
      navigation: merged.navigation,
      url: redactedEntry.url,
    });
    pageState = pageStep.state;
    const entryToWrite: HarEntry = { ...redactedEntry.entry, pageref: pageStep.pageref };

    const prefix = i > 0 ? "," : "";
    const effectiveBody = bodyCandidatesForRequest(merged.body, request);

    let streamed: StreamedBodyResult;
    if (effectiveBody.kind === "empty") {
      await writeNoBodyEntry(ports.sink, prefix, entryToWrite, { kind: "empty" }, merged);
      streamed = {
        end: { kind: "empty" },
        bodyFrom: null,
        unchecked: false,
        secretsTouched: false,
      };
    } else if (effectiveBody.kind === "none") {
      const end: BodyEnd = { kind: "missing", reason: effectiveBody.reason };
      await writeNoBodyEntry(ports.sink, prefix, entryToWrite, end, merged);
      streamed = { end, bodyFrom: null, unchecked: false, secretsTouched: false };
    } else {
      const opened = await openFirstCandidate(effectiveBody.list, ports.bodies, ports.signal);
      if (!opened.ok) {
        const end: BodyEnd = { kind: "missing", reason: opened.reason };
        await writeNoBodyEntry(ports.sink, prefix, entryToWrite, end, merged);
        streamed = { end, bodyFrom: null, unchecked: false, secretsTouched: false };
      } else if (opened.body.kind === "bytes") {
        const check: BodyCheck =
          opened.candidate.kind === "stored" ? opened.candidate.check : "sink-only";
        const from = opened.candidate.kind === "stored" ? "stored" : "devtools";
        streamed = await streamByteBody(
          entryToWrite,
          prefix,
          check,
          from,
          opened.body,
          merged,
          request,
          ports,
          notScanned,
        );
      } else {
        streamed = await streamTextBody(
          entryToWrite,
          prefix,
          opened.body,
          merged,
          request,
          ports,
          notScanned,
        );
      }
    }

    const writtenBody =
      streamed.end.kind === "complete"
        ? ("included" as const)
        : streamed.end.kind === "empty"
          ? ("empty" as const)
          : streamed.end.kind === "cut-short"
            ? ({ cutShort: streamed.end.reason } as const)
            : ({ missing: streamed.end.reason } as const);

    report = tally(report, merged, {
      body: writtenBody,
      bodyFrom: streamed.bodyFrom,
      unchecked: streamed.unchecked,
      secretsTouched: redactedEntry.touched || withUpload.secretsTouched || streamed.secretsTouched,
      neverStored: withUpload.neverStored,
    });

    ports.onProgress({ done: i + 1, total, bytes: ports.sink.bytesWritten() });
    await ports.yieldNow();
  }

  throwIfAborted(ports.signal);
  const pages = finishPages(pageState);
  const reportWithSecrets: ExportReport =
    report.secrets.mode === "remove"
      ? {
          ...report,
          secrets: {
            ...report.secrets,
            covered: [...ports.redact.covered],
            notScanned: [...notScanned],
          },
        }
      : report;

  const comment = reportComment(reportWithSecrets);
  const reportForFooter: ExportReport = {
    ...reportWithSecrets,
    fileBytes: ports.sink.bytesWritten(),
  };
  await ports.sink.write(
    `],"pages":${JSON.stringify(pages)},"comment":${JSON.stringify(comment)},"_harExport":{"report":${JSON.stringify(reportForFooter)}}}}`,
  );

  return { ...reportWithSecrets, fileBytes: ports.sink.bytesWritten() };
}
