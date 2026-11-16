// The archive's single writer: every write runs on one promise chain, so commits, seals and exclusions never
// interleave. The line is the commit point. A memory body's pack append resolves before its line is appended; a file
// body's part is renamed into bodies/ before its line joins a batch. No line points at bytes not yet written.

import {
  settle,
  type AbandonedExchange,
  type BodyLocation,
  type SettledExchange,
  type SettleInput,
  type UnansweredExchange,
  type UploadOutcome,
} from "@one-click-har/recording/exchange";
import type {
  ByteCount,
  ExchangeId,
  LogSegmentId,
  PackId,
  RunId,
  Site,
} from "@one-click-har/recording/ids";
import {
  bodyFilePath,
  LAYOUT,
  LOG_SEAL_BYTES,
  logSegmentId,
  logSegmentPath,
  logSummaryPath,
  PACK_SEAL_BYTES,
  packId,
  packPath,
  partPath,
  ROTATE_IDLE_MS,
  siteDirName,
  type SafeFolder,
} from "@one-click-har/recording/layout";
import { encodeLine, encodeSummary, summarize } from "@one-click-har/recording/log";
import type { StoredSettings } from "@one-click-har/recording/settings";
import {
  appendStreams,
  appendText,
  makeDirectory,
  type Modes,
  type Timers,
  writeAtomic,
} from "./gecko-io.ts";

/** Flush every second, or at once when a site's pending pack bytes reach the memory tee cutoff. */
const FLUSH_MS = 1_000;
const PACK_PENDING_MAX = 1_048_576;

/** Points the harness can park the write chain at, to kill the browser there (crash rows 3, 6, 14, 16). */
export const HOLD_POINTS = [
  "before-line-append",
  "summary-tmp-written",
  "exclusion-mid-delete",
] as const;
export type HoldPoint = (typeof HOLD_POINTS)[number];

/** What a copy left when its sink closed: a memory tee's storage stream, or a file tee's closed part. */
export type CopiedBytes =
  | { readonly kind: "memory"; readonly stream: InputStream }
  | { readonly kind: "part"; readonly id: ExchangeId };

/** A request body read at examine, waiting for its range in the site's pack. */
export interface PendingUpload {
  readonly stream: InputStream;
  readonly length: ByteCount;
  readonly mimeType: string | null;
}

export interface AnsweredCommit {
  readonly site: Site | null;
  readonly input: SettleInput;
  readonly bytes: CopiedBytes | null;
  readonly upload: PendingUpload | null;
}

interface Segment {
  readonly id: LogSegmentId;
  readonly path: string;
  bytes: number;
  readonly exchanges: SettledExchange[];
}

interface SiteState {
  readonly site: Site;
  segmentSeq: number;
  /** Mutated only on the write chain. */
  segment: Segment | null;
  packSeq: number;
  /** Reserved synchronously at commit, so offsets follow commit order. Null after an idle rotation. */
  pack: { readonly id: PackId; readonly path: string; reserved: number } | null;
  streams: InputStream[];
  streamBytes: number;
  lines: string[];
  exchanges: SettledExchange[];
  lastCommitAt: number;
  open: boolean;
}

export interface StoreProblem {
  readonly kind: "write-failed";
  readonly detail: string;
}

export interface Store {
  readonly run: RunId;
  readonly settings: () => StoredSettings;
  commit(commit: AnsweredCommit): void;
  commitUnanswered(site: Site | null, exchange: UnansweredExchange): void;
  /** Lines for captures still live at shutdown. Their parts stay for recovery to delete (crash row 19). */
  commitAbandoned(
    entries: readonly { readonly site: Site | null; readonly exchange: AbandonedExchange }[],
  ): void;
  /** Settings first, so the gate stops new captures; then, on the chain, the site's directory is deleted. */
  excludeSite(site: Site): Promise<void>;
  /** Appends every pending batch and resolves when the chain is empty. */
  flush(): Promise<void>;
  /** Seals every open segment now, as an idle rotation would. */
  sealAll(): Promise<void>;
  /** Runs `step` on the write chain, after everything queued before it. */
  enqueue(step: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
  readonly problems: () => readonly StoreProblem[];
  arm(point: HoldPoint): void;
  reached(point: HoldPoint): boolean;
}

/** Where a body would go, to ask settle whether it is kept before any bytes are placed. */
const PROBE: BodyLocation = { kind: "pack", pack: "" as PackId, offset: 0, length: 0 as ByteCount };

const withUpload = (input: SettleInput, upload: UploadOutcome): SettleInput =>
  input.sink === null
    ? { ...input, capture: { ...input.capture, upload } }
    : { ...input, capture: { ...input.capture, upload } };

export function openStore(options: {
  readonly run: RunId;
  readonly root: SafeFolder;
  readonly modes: Modes;
  readonly settings: StoredSettings;
  readonly timers: Timers;
  readonly onSettings: (settings: StoredSettings) => void;
}): Store {
  const { run, root, modes, timers } = options;
  let settings = options.settings;
  let chain: Promise<void> = Promise.resolve();
  const problems: StoreProblem[] = [];
  const sites = new Map<Site, SiteState>();
  const excluded = new Set<Site>(settings.user.excludedSites);
  const madeDirs = new Set<string>();
  const armed = new Set<HoldPoint>();
  const reachedPoints = new Set<HoldPoint>();
  let ticker: { cancel(): void } | null = null;

  const at = (segments: readonly string[]): string => PathUtils.join(root, ...segments);
  const dirOf = (segments: readonly string[]): string => at(segments.slice(0, -1));

  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const next = chain.then(step).catch((error: unknown) => {
      problems.push({ kind: "write-failed", detail: String(error) });
    });
    chain = next;
    return next;
  };

  const hold = async (point: HoldPoint): Promise<void> => {
    if (!armed.has(point)) return;
    armed.delete(point);
    reachedPoints.add(point);
    await new Promise<never>(() => undefined);
  };

  const ensureDir = async (path: string): Promise<void> => {
    if (madeDirs.has(path)) return;
    await makeDirectory(path, modes);
    madeDirs.add(path);
  };

  const stateOf = (site: Site): SiteState => {
    const existing = sites.get(site);
    if (existing !== undefined) return existing;
    const created: SiteState = {
      site,
      segmentSeq: 0,
      segment: null,
      packSeq: 0,
      pack: null,
      streams: [],
      streamBytes: 0,
      lines: [],
      exchanges: [],
      lastCommitAt: 0,
      open: false,
    };
    sites.set(site, created);
    return created;
  };

  const seal = async (state: SiteState): Promise<void> => {
    const segment = state.segment;
    if (segment === null) return;
    state.segment = null;
    const summary = summarize(
      segment.id,
      segment.exchanges.map((exchange) => ({ v: 2, exchange }) as const),
      segment.bytes as ByteCount,
    );
    await writeAtomic(at(logSummaryPath(segment.id)), encodeSummary(summary), modes, () =>
      hold("summary-tmp-written"),
    );
  };

  const flushSite = (state: SiteState): void => {
    if (state.streams.length === 0 && state.lines.length === 0) return;
    const streams = state.streams;
    const lines = state.lines;
    const exchanges = state.exchanges;
    const pack = state.pack;
    state.streams = [];
    state.streamBytes = 0;
    state.lines = [];
    state.exchanges = [];
    void enqueue(async () => {
      if (excluded.has(state.site)) return;
      if (streams.length > 0 && pack !== null) {
        await ensureDir(dirOf(packPath(pack.id)));
        await appendStreams(pack.path, streams, modes);
      }
      await hold("before-line-append");
      if (lines.length === 0) return;
      if (state.segment === null) {
        const id = logSegmentId(state.site, run, state.segmentSeq);
        state.segmentSeq += 1;
        state.segment = { id, path: at(logSegmentPath(id)), bytes: 0, exchanges: [] };
      }
      const segment = state.segment;
      const text = lines.join("");
      await ensureDir(dirOf(logSegmentPath(segment.id)));
      await appendText(segment.path, text, modes);
      segment.bytes += text.length;
      segment.exchanges.push(...exchanges);
      if (segment.bytes >= LOG_SEAL_BYTES) await seal(state);
    });
  };

  const tick = (): void => {
    const now = Date.now();
    let busy = false;
    for (const state of sites.values()) {
      if (state.streams.length > 0 || state.lines.length > 0) {
        flushSite(state);
        busy = true;
      } else if (state.open && now - state.lastCommitAt >= ROTATE_IDLE_MS) {
        state.open = false;
        state.pack = null;
        state.packSeq += 1;
        void enqueue(() => seal(state));
      } else if (state.open) busy = true;
    }
    if (!busy && ticker !== null) {
      ticker.cancel();
      ticker = null;
    }
  };

  const queueLine = (state: SiteState, exchange: SettledExchange): void => {
    state.lines.push(encodeLine({ v: 2, exchange }));
    state.exchanges.push(exchange);
    state.lastCommitAt = Date.now();
    state.open = true;
    ticker ??= timers.repeat(FLUSH_MS, tick);
  };

  /** Reserves `length` bytes at the end of the site's open pack. A full pack is flushed and the next one started. */
  const reserve = (state: SiteState, stream: InputStream, length: ByteCount): BodyLocation => {
    if (
      state.pack !== null &&
      state.pack.reserved > 0 &&
      state.pack.reserved + length > PACK_SEAL_BYTES
    ) {
      flushSite(state);
      state.pack = null;
      state.packSeq += 1;
    }
    if (state.pack === null) {
      const id = packId(state.site, run, state.packSeq);
      state.pack = { id, path: at(packPath(id)), reserved: 0 };
    }
    const location: BodyLocation = {
      kind: "pack",
      pack: state.pack.id,
      offset: state.pack.reserved,
      length,
    };
    state.pack.reserved += length;
    state.streams.push(stream);
    state.streamBytes += length;
    return location;
  };

  const removePart = (id: ExchangeId): void => {
    void enqueue(() => IOUtils.remove(at(partPath(id)), { ignoreAbsent: true }));
  };

  const commit = ({ site, input, bytes, upload }: AnsweredCommit): void => {
    if (site === null || excluded.has(site)) {
      if (bytes?.kind === "part") removePart(bytes.id);
      return;
    }
    const state = stateOf(site);
    const settling =
      upload === null
        ? input
        : withUpload(input, {
            kind: "stored",
            at: reserve(state, upload.stream, upload.length),
            mimeType: upload.mimeType,
          });
    const length = (settling.sink?.kind === "closed" ? settling.sink.bytes : 0) as ByteCount;
    if (bytes === null || settle(settling, PROBE).body.kind !== "stored") {
      if (bytes?.kind === "part") removePart(bytes.id);
      queueLine(state, settle(settling, null));
    } else if (bytes.kind === "memory") {
      queueLine(state, settle(settling, reserve(state, bytes.stream, length)));
    } else {
      const settled = settle(settling, { kind: "file", site, id: bytes.id, length });
      void enqueue(async () => {
        if (excluded.has(site)) {
          await IOUtils.remove(at(partPath(bytes.id)), { ignoreAbsent: true });
          return;
        }
        const target = bodyFilePath(site, bytes.id);
        await ensureDir(dirOf(target));
        await IOUtils.move(at(partPath(bytes.id)), at(target));
        queueLine(state, settled);
      });
    }
    if (state.streamBytes >= PACK_PENDING_MAX) flushSite(state);
  };

  const store: Store = {
    run,
    settings: () => settings,
    commit,
    commitUnanswered: (site, exchange) => {
      if (site === null || excluded.has(site)) return;
      queueLine(stateOf(site), exchange);
    },
    commitAbandoned: (entries) => {
      for (const { site, exchange } of entries) {
        if (site !== null && !excluded.has(site)) queueLine(stateOf(site), exchange);
      }
    },
    excludeSite: (site) => {
      if (excluded.has(site)) return enqueue(async () => undefined);
      excluded.add(site);
      sites.delete(site);
      return enqueue(async () => {
        const next: StoredSettings = {
          ...settings,
          user: { ...settings.user, excludedSites: [...settings.user.excludedSites, site] },
        };
        await writeAtomic(at([LAYOUT.settings]), JSON.stringify(next), modes);
        settings = next;
        options.onSettings(next);
        const dir = at([LAYOUT.sitesDir, siteDirName(site)]);
        for (const [index, sub] of [LAYOUT.logDir, LAYOUT.packDir, LAYOUT.bodyDir].entries()) {
          await IOUtils.remove(PathUtils.join(dir, sub), { recursive: true, ignoreAbsent: true });
          if (index === 0) await hold("exclusion-mid-delete");
        }
        await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
        for (const made of madeDirs) if (made.startsWith(dir)) madeDirs.delete(made);
      });
    },
    flush: () => {
      for (const state of sites.values()) flushSite(state);
      return enqueue(async () => undefined);
    },
    sealAll: () => {
      for (const state of sites.values()) {
        flushSite(state);
        state.open = false;
        state.pack = null;
        state.packSeq += 1;
        void enqueue(() => seal(state));
      }
      return enqueue(async () => undefined);
    },
    enqueue,
    close: async () => {
      ticker?.cancel();
      ticker = null;
      await store.sealAll();
    },
    problems: () => problems,
    arm: (point) => {
      armed.add(point);
    },
    reached: (point) => reachedPoints.has(point),
  };
  return store;
}
