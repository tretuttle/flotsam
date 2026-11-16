// Observers, gates, facts and sinks on the parent main thread, for every HTTP channel. Owns the live map and the cap
// watchdog; hands every settled exchange and every byte on disk to the store. No body byte is read into script and
// nothing touches the HTTP cache.

import { DEFAULT_REDACTION_RULES } from "@one-click-har/har/rules";
import {
  abandon,
  EXAMINE_ACCEPTS,
  examine,
  open,
  unanswered,
  type AbandonReason,
  type Capture,
  type ExamineTopic,
  type ExchangeFacts,
  type Header,
  type NetError,
  type RequestFacts,
  type ResponseFacts,
  type SinkResult,
  type StopFacts,
  type Timings,
  type UploadOutcome,
} from "@one-click-har/recording/exchange";
import {
  exchangeId,
  parseChannelKey,
  type ByteCount,
  type EpochMs,
  type ExchangeId,
  type RunId,
  type Site,
  type TabKey,
} from "@one-click-har/recording/ids";
import { partPath, type SafeFolder } from "@one-click-har/recording/layout";
import {
  chooseRoute,
  firstGate,
  type CompiledRoutes,
  type GateFacts,
  type ResponseSource,
  type Route,
} from "@one-click-har/recording/routes";
import { topSiteOf } from "@one-click-har/recording/site";
import {
  errorName,
  localFile,
  openOutput,
  siteOfHost,
  siteOfUri,
  type Modes,
  type Timers,
} from "./gecko-io.ts";
import type { CopiedBytes, PendingUpload, Store } from "./store.ts";

const OPENING = "http-on-opening-request";
const STOP = "http-on-stop-request";
/** Which topic delivered the head, as the route rows read it. */
const EXAMINE_SOURCE: { readonly [T in ExamineTopic]: ResponseSource } = {
  "http-on-examine-response": "network",
  "http-on-examine-cached-response": "cache",
  "http-on-examine-merged-response": "revalidated",
  "service-worker-synthesized-response": "service-worker",
};
const isExamineTopic = (topic: string): topic is ExamineTopic => topic in EXAMINE_SOURCE;
const TOPICS: readonly string[] = [OPENING, ...Object.keys(EXAMINE_SOURCE), STOP];

const NS_BINDING_REDIRECTED = 0x804b0003;
const STORAGE_SEGMENT = 16_384;
const WATCHDOG_MS = 250;
const UPLOAD_MAX = 1_048_576;
/** Past this many live requests, new ones are not recorded and the overflow is counted. */
const MAX_LIVE = 20_000;
/** An internal redirect's source keeps NS_BINDING_REDIRECTED and never reaches examine or stop; its target carries the request. */
const SWEEP_EVERY = 256;
const MAX_ERRORS_KEPT = 20;
const PREPARE_FAILURES: { readonly [name: string]: "disk-full" | "access-denied" } = {
  NS_ERROR_FILE_NO_DEVICE_SPACE: "disk-full",
  NS_ERROR_FILE_ACCESS_DENIED: "access-denied",
};
const SECRET_HEADERS: ReadonlySet<string> = new Set(
  DEFAULT_REDACTION_RULES.filter((rule) => rule.target === "header").flatMap((rule) => rule.names),
);

interface Sink {
  /** Set by the sink's own onStopRequest, after it closed its stream. */
  result: SinkResult | null;
  bytes: CopiedBytes | null;
  /** file-tee only: the watchdog closes it at the cap; shutdown closes it so the tee stops writing. */
  readonly output: FileOutputStream | null;
  readonly part: string | null;
  readonly cap: number;
  cappedAt: number | null;
}

interface LiveEntry {
  capture: Capture;
  /** The object the latest topic delivered: an internal redirect (a service worker's interception) keeps the id and replaces the object. */
  channel: HttpChannel;
  site: Site | null;
  sink: Sink | null;
  upload: PendingUpload | null;
  stop: StopFacts | null;
}

export interface Recorder {
  setRoutes(routes: CompiledRoutes): void;
  /** Removes the observers, closes every file tee, and writes an abandoned line for each live capture. */
  stop(reason: AbandonReason): void;
  readonly counts: () => {
    readonly live: number;
    readonly overflow: number;
    readonly observerErrors: readonly string[];
    /** Main-thread milliseconds spent in each topic's observer, for the harness's cost breakdown. */
    readonly observerMs: Readonly<Record<string, number>>;
  };
}

const optional = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

const version = (read: (major: { value?: number }, minor: { value?: number }) => void): string => {
  const major: { value?: number } = {};
  const minor: { value?: number } = {};
  try {
    read(major, minor);
    return `HTTP/${String(major.value ?? 1)}.${String(minor.value ?? 1)}`;
  } catch {
    return "HTTP/1.1";
  }
};

const headersOf = (
  visit: (visitor: HeaderVisitor) => void,
  neverStoreSecrets: boolean,
): Header[] => {
  const headers: Header[] = [];
  try {
    visit({
      visitHeader: (name, value) => {
        headers.push([
          name,
          neverStoreSecrets && SECRET_HEADERS.has(name.toLowerCase()) ? null : value,
        ]);
      },
    });
  } catch {
    // A channel without headers of this kind.
  }
  return headers;
};

const span = (from: number, to: number): number | null =>
  from > 0 && to >= from ? (to - from) / 1000 : null;

const timingsOf = (channel: HttpChannel): Timings => {
  const t = optional(() => channel.QueryInterface(Ci.nsITimedChannel));
  if (t === null)
    return {
      blocked: null,
      dns: null,
      connect: null,
      ssl: null,
      send: null,
      wait: null,
      receive: null,
    };
  const firstAfterOpen =
    [t.domainLookupStartTime, t.connectStartTime, t.requestStartTime].find((v) => v > 0) ?? 0;
  return {
    blocked: span(t.asyncOpenTime, firstAfterOpen),
    dns: span(t.domainLookupStartTime, t.domainLookupEndTime),
    connect: span(t.connectStartTime, t.connectEndTime),
    ssl: span(t.secureConnectionStartTime, t.connectEndTime),
    send: null,
    wait: span(t.requestStartTime, t.responseStartTime),
    receive: span(t.responseStartTime, t.responseEndTime),
  };
};

const stopFactsOf = (channel: HttpChannel): StopFacts => {
  const status = channel.status;
  return {
    status: Components.isSuccessCode(status)
      ? { kind: "ok" }
      : status === NS_BINDING_REDIRECTED
        ? { kind: "redirected" }
        : { kind: "failed", error: errorName(status) as NetError },
    endedAt: Date.now() as EpochMs,
    timings: timingsOf(channel),
    transferSize: (optional(() => channel.transferSize) ?? 0) as ByteCount,
    encodedBodySize: (optional(() => channel.encodedBodySize) ?? 0) as ByteCount,
  };
};

/** A null browsing context is a fact (worker channels), never a TypeError (argon 4). */
const topSiteOfChannel = (channel: HttpChannel): Site | null => {
  const info = channel.loadInfo;
  const context = info.browsingContext;
  const principal = info.loadingPrincipal ?? info.triggeringPrincipal;
  return topSiteOf({
    policyType: info.externalContentPolicyType,
    isAttachment:
      optional(() => channel.contentDisposition === Ci.nsIChannel.DISPOSITION_ATTACHMENT) ?? false,
    channelSite: siteOfUri(channel.URI),
    tabDocumentSite: siteOfUri(context?.top.currentWindowGlobal?.documentURI),
    principalSite: principal.isContentPrincipal ? siteOfHost(principal.asciiHost) : null,
    hasBrowsingContext: context !== null,
  }).site;
};

const gateFactsOf = (channel: HttpChannel, topSite: Site | null): GateFacts => {
  const info = channel.loadInfo;
  return {
    privateBrowsingId: info.originAttributes.privateBrowsingId,
    triggeringIsSystem: info.triggeringPrincipal.isSystemPrincipal,
    browsingContextId: info.browsingContextID,
    loadingScheme: info.loadingPrincipal?.scheme ?? "",
    topSite,
  };
};

const header = (channel: HttpChannel, name: string): string | null => {
  const value = optional(() => channel.getResponseHeader(name));
  return value === null || value === "" ? null : value;
};

export function startRecorder(options: {
  readonly run: RunId;
  readonly routes: CompiledRoutes;
  readonly store: Store;
  readonly root: SafeFolder;
  readonly modes: Modes;
  readonly timers: Timers;
}): Recorder {
  const { run, store, root, modes, timers } = options;
  let routes = options.routes;
  let stopped = false;
  let overflow = 0;
  let admitted = 0;
  const observerErrors: string[] = [];
  const observerMs: Record<string, number> = {};
  const live = new Map<number, LiveEntry>();
  const watched = new Set<Sink>();
  let watchdog: { cancel(): void } | null = null;
  const neverStore = (): boolean => store.settings().user.secretStorage === "never-store";

  const tabOf = (channel: HttpChannel): TabKey | null => {
    const browserId = channel.loadInfo.browsingContext?.top.browserId ?? 0;
    return browserId > 0 ? { run, browserId } : null;
  };

  const requestFacts = (entry: LiveEntry, id: ExchangeId, startedAt: EpochMs): RequestFacts => {
    const { channel } = entry;
    const internal = optional(() => channel.QueryInterface(Ci.nsIHttpChannelInternal));
    return {
      id,
      url: channel.URI.spec,
      method: channel.requestMethod,
      httpVersion:
        internal === null ? "HTTP/1.1" : version((a, b) => internal.getRequestVersion(a, b)),
      headers: headersOf((v) => channel.visitRequestHeaders(v), neverStore()),
      startedAt,
      tab: tabOf(channel),
      topSite: entry.site,
      policyType: channel.loadInfo.externalContentPolicyType,
    };
  };

  const responseFacts = (channel: HttpChannel, topic: ExamineTopic): ResponseFacts => {
    const internal = optional(() => channel.QueryInterface(Ci.nsIHttpChannelInternal));
    const status = channel.responseStatus;
    const location = header(channel, "Location");
    const length = channel.contentLength;
    return {
      status,
      statusText: optional(() => channel.responseStatusText) ?? "",
      httpVersion:
        internal === null ? "HTTP/1.1" : version((a, b) => internal.getResponseVersion(a, b)),
      headers: headersOf((v) => channel.visitResponseHeaders(v), neverStore()),
      mimeType: (optional(() => channel.contentType) ?? "").toLowerCase() || null,
      contentLength: length >= 0 ? (length as ByteCount) : null,
      contentEncoding: header(channel, "Content-Encoding")?.trim().toLowerCase() ?? null,
      source: EXAMINE_SOURCE[topic],
      redirectTo:
        location !== null && status >= 300 && status < 400
          ? (optional(() => channel.URI.resolve(location)) ?? null)
          : null,
      remoteAddress: internal === null ? null : optional(() => internal.remoteAddress),
    };
  };

  /** A rewindable upload stream up to 1 MiB, read natively and rewound to where it was (row R7). */
  const readUpload = (entry: LiveEntry): UploadOutcome => {
    const stream = optional(() => entry.channel.QueryInterface(Ci.nsIUploadChannel).uploadStream);
    if (stream === null) return { kind: "none" };
    if (neverStore()) return { kind: "not-kept", reason: "upload-never-stored" };
    const seekable = optional(() =>
      (stream as unknown as { QueryInterface(i: XpcomInterface): SeekableStream }).QueryInterface(
        Ci.nsISeekableStream,
      ),
    );
    if (seekable === null) return { kind: "not-kept", reason: "upload-not-rewindable" };
    const position = seekable.tell();
    try {
      seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
      const length = seekable.available();
      if (length > UPLOAD_MAX) return { kind: "not-kept", reason: "upload-too-large" };
      if (length === 0) return { kind: "none" };
      const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
      const buffer = NetUtil.readInputStream(seekable, length);
      const copy = Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(
        Ci.nsIArrayBufferInputStream,
      );
      copy.setData(buffer, 0, buffer.byteLength);
      const contentType = optional(() => entry.channel.getRequestHeader("Content-Type"));
      const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() || null;
      entry.upload = { stream: copy, length: buffer.byteLength as ByteCount, mimeType };
      return { kind: "none" };
    } catch {
      return { kind: "not-kept", reason: "upload-not-rewindable" };
    } finally {
      optional(() => seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, position));
    }
  };

  const watch = (sink: Sink): void => {
    watched.add(sink);
    watchdog ??= timers.repeat(WATCHDOG_MS, () => {
      for (const each of watched) {
        if (each.result !== null || each.part === null || each.output === null) {
          watched.delete(each);
          continue;
        }
        const size = optional(() => localFile(each.part ?? "").fileSize) ?? 0;
        if (size >= each.cap) {
          optional(() => each.output?.close());
          each.cappedAt = size;
          watched.delete(each);
        }
      }
      if (watched.size === 0) {
        watchdog?.cancel();
        watchdog = null;
      }
    });
  };

  const commit = (entry: LiveEntry): void => {
    const { capture, stop } = entry;
    if (stop === null) return;
    if (capture.phase === "copying" && entry.sink?.result === null) return;
    live.delete(entry.channel.channelId);
    switch (capture.phase) {
      case "opened": {
        const request = requestFacts(entry, capture.id, capture.startedAt);
        store.commitUnanswered(entry.site, unanswered(capture, request, stop, { kind: "none" }));
        return;
      }
      case "copying":
        store.commit({
          site: entry.site,
          input: {
            capture,
            stop,
            sink: entry.sink?.result ?? { kind: "prepare-failed", why: "other" },
          },
          bytes: entry.sink?.bytes ?? null,
          upload: entry.upload,
        });
        return;
      case "decided":
      case "awaiting-merge":
        store.commit({
          site: entry.site,
          input: { capture, stop, sink: null },
          bytes: null,
          upload: entry.upload,
        });
        return;
    }
  };

  /** Every object is built before the channel is touched: a throw between setNewListener and init hangs the request (R13). */
  const startSink = (
    entry: LiveEntry,
    route: Extract<Route, { readonly kind: "memory-tee" | "file-tee" }>,
    id: ExchangeId,
  ): Sink => {
    const traceable = entry.channel.QueryInterface(Ci.nsITraceableChannel);
    const tee = Cc["@mozilla.org/network/stream-listener-tee;1"].createInstance(
      Ci.nsIStreamListenerTee,
    );
    if (route.kind === "memory-tee") {
      const storage = Cc["@mozilla.org/storagestream;1"].createInstance(Ci.nsIStorageStream);
      storage.init(STORAGE_SEGMENT, Math.max(route.cap, 1));
      const output = storage.getOutputStream(0);
      const sink: Sink = {
        result: null,
        bytes: null,
        output: null,
        part: null,
        cap: route.cap,
        cappedAt: null,
      };
      const observer: RequestObserver = {
        onStartRequest: () => undefined,
        onStopRequest: () => {
          optional(() => output.close());
          if (stopped) return;
          sink.result = { kind: "closed", bytes: storage.length as ByteCount, cappedAt: null };
          sink.bytes = { kind: "memory", stream: storage.newInputStream(0) };
          commit(entry);
        },
      };
      const original = traceable.setNewListener(tee);
      tee.init(original, output, observer);
      return sink;
    }
    const part = PathUtils.join(root, ...partPath(id));
    let output: FileOutputStream;
    try {
      output = openOutput(part, false, modes);
    } catch (error) {
      const name = errorName((error as { result?: number }).result ?? 0);
      return {
        result: { kind: "prepare-failed", why: PREPARE_FAILURES[name] ?? "other" },
        bytes: null,
        output: null,
        part: null,
        cap: route.cap,
        cappedAt: null,
      };
    }
    const sink: Sink = { result: null, bytes: null, output, part, cap: route.cap, cappedAt: null };
    const observer: RequestObserver = {
      onStartRequest: () => undefined,
      onStopRequest: () => {
        optional(() => output.close());
        if (stopped) return;
        const bytes = optional(() => localFile(part).fileSize) ?? 0;
        sink.result = {
          kind: "closed",
          bytes: bytes as ByteCount,
          cappedAt: sink.cappedAt as ByteCount | null,
        };
        sink.bytes = { kind: "part", id };
        commit(entry);
      },
    };
    const original = traceable.setNewListener(tee);
    tee.init(original, output, observer);
    watch(sink);
    return sink;
  };

  const admit = (channel: HttpChannel): LiveEntry | null => {
    if (!(channel.URI.schemeIs("http") || channel.URI.schemeIs("https"))) return null;
    if (firstGate(gateFactsOf(channel, null), routes.excluded) !== null) return null;
    const key = parseChannelKey(String(channel.channelId));
    if (key === null) return null;
    if (live.size >= MAX_LIVE) {
      overflow += 1;
      return null;
    }
    admitted += 1;
    if (admitted % SWEEP_EVERY === 0) {
      for (const [id, each] of live) {
        if (
          each.capture.phase === "opened" &&
          optional(() => each.channel.status) === NS_BINDING_REDIRECTED
        )
          live.delete(id);
      }
    }
    const entry: LiveEntry = {
      capture: open(exchangeId(run, key), Date.now() as EpochMs),
      channel,
      site: null,
      sink: null,
      upload: null,
      stop: null,
    };
    live.set(channel.channelId, entry);
    return entry;
  };

  const onExamine = (channel: HttpChannel, topic: ExamineTopic): void => {
    const entry = live.get(channel.channelId) ?? admit(channel);
    if (entry === null) return;
    entry.channel = channel;
    const before = entry.capture;
    if (!EXAMINE_ACCEPTS[before.phase].topics.includes(topic)) return;
    const site = topSiteOfChannel(channel);
    if (firstGate(gateFactsOf(channel, site), routes.excluded) !== null) {
      live.delete(channel.channelId);
      return;
    }
    entry.site = site;
    const id = before.id;
    const response = responseFacts(channel, topic);
    const startedAt = before.phase === "opened" ? before.startedAt : before.facts.request.startedAt;
    const facts: ExchangeFacts = { request: requestFacts(entry, id, startedAt), response };
    const route = chooseRoute(routes, {
      method: channel.requestMethod,
      status: response.status,
      source: response.source,
      mimeType: response.mimeType,
      contentLength: response.contentLength,
      hasLocation: header(channel, "Location") !== null,
    });
    const upload = before.phase === "opened" ? readUpload(entry) : before.upload;
    const next = examine(before, topic, facts, route, upload);
    if (next.phase === "copying" && before.phase !== "copying") {
      const copy = next.route;
      entry.sink =
        copy.kind === "memory-tee" || copy.kind === "file-tee"
          ? startSink(entry, copy, id)
          : {
              result: { kind: "prepare-failed", why: "other" },
              bytes: null,
              output: null,
              part: null,
              cap: 0,
              cappedAt: null,
            };
    }
    entry.capture = next;
  };

  const onStop = (channel: HttpChannel): void => {
    const entry = live.get(channel.channelId);
    if (entry === undefined) return;
    entry.channel = channel;
    if (entry.capture.phase === "opened") entry.site = topSiteOfChannel(channel);
    entry.stop = stopFactsOf(channel);
    commit(entry);
  };

  const observer: Observer = {
    observe: (subject, topic) => {
      const startedAt = ChromeUtils.now();
      const channel = optional(() => (subject as HttpChannel).QueryInterface(Ci.nsIHttpChannel));
      if (channel === null) return;
      try {
        if (topic === OPENING) admit(channel);
        else if (topic === STOP) onStop(channel);
        else if (isExamineTopic(topic)) onExamine(channel, topic);
      } catch (error) {
        if (observerErrors.length < MAX_ERRORS_KEPT)
          observerErrors.push(`${topic}: ${String(error)}`);
      } finally {
        observerMs[topic] = (observerMs[topic] ?? 0) + ChromeUtils.now() - startedAt;
      }
    },
  };
  for (const topic of TOPICS) Services.obs.addObserver(observer, topic);

  return {
    setRoutes: (next) => {
      routes = next;
    },
    stop: (reason) => {
      if (stopped) return;
      stopped = true;
      for (const topic of TOPICS) optional(() => Services.obs.removeObserver(observer, topic));
      watchdog?.cancel();
      watchdog = null;
      const abandoned = [...live.values()].map((entry) => {
        optional(() => entry.sink?.output?.close());
        const { capture } = entry;
        const request =
          capture.phase === "opened"
            ? requestFacts(entry, capture.id, capture.startedAt)
            : capture.facts.request;
        const site = entry.site ?? optional(() => topSiteOfChannel(entry.channel));
        return { site, exchange: abandon(capture, request, reason) };
      });
      live.clear();
      store.commitAbandoned(abandoned);
    },
    counts: () => ({ live: live.size, overflow, observerErrors, observerMs }),
  };
}
