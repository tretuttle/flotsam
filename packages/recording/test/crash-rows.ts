// The crash table from the design (sketch/checks/crash-rows.ts, rendered into STORAGE.md), as typed fixtures. Each
// row is a point where the process can die, the directory it leaves, the plan the next start must make, and how the
// exchange reads in an export afterwards.

import type { ExchangeId, LogSegmentId, RunId, Site } from "../src/ids.ts";
import type {
  DirSnapshot,
  ReadsAs,
  ReconcileStep,
  SnapshotFile,
  SnapshotSegment,
} from "../src/reconcile.ts";

const OLD = "mhz01" as RunId;
const NOW = "mhz02" as RunId;
const SITE = "example.com" as Site;
const GONE = "excluded.example" as Site;
const SEG = `${SITE}/${OLD}-0` as LogSegmentId;
const SEG_GONE = `${GONE}/${OLD}-0` as LogSegmentId;
const X = `${OLD}.15032385539` as ExchangeId;
const Y = `${OLD}.15032385540` as ExchangeId;

const part = (id: ExchangeId, run: RunId): SnapshotFile => ({
  path: `incoming/${String(id)}.part`,
  bytes: 5_000_000,
  kind: "part",
  run,
  site: null,
  segment: null,
  id,
});
const body = (id: ExchangeId, site: Site = SITE): SnapshotFile => ({
  path: `sites/${String(site)}/bodies/${String(id)}.body`,
  bytes: 13_000_000,
  kind: "body",
  run: OLD,
  site,
  segment: null,
  id,
});
const log = (bytes: number, segment: LogSegmentId = SEG, site: Site = SITE): SnapshotFile => ({
  path: `sites/${String(segment)}.jsonl`,
  bytes,
  kind: "log",
  run: OLD,
  site,
  segment,
  id: null,
});
const summaryFile = (segment: LogSegmentId = SEG, site: Site = SITE): SnapshotFile => ({
  path: `sites/${String(segment)}.summary.json`,
  bytes: 1_777_664,
  kind: "summary",
  run: OLD,
  site,
  segment,
  id: null,
});
const pack = (site: Site = SITE): SnapshotFile => ({
  path: `sites/${String(site)}/packs/${OLD}-0.pack`,
  bytes: 67_160,
  kind: "pack",
  run: OLD,
  site,
  segment: null,
  id: null,
});
const tmp = (run: RunId | null, site: Site | null): SnapshotFile => ({
  path: run === null ? "settings.json.tmp" : `sites/${String(SEG)}.summary.json.tmp`,
  bytes: 812,
  kind: "tmp",
  run,
  site,
  segment: run === null ? null : SEG,
  id: null,
});
const seg = (
  bytes: number,
  validBytes: number,
  namesBodies: readonly ExchangeId[],
  segment: LogSegmentId = SEG,
  site: Site = SITE,
): SnapshotSegment => ({ segment, site, run: OLD, bytes, validBytes, namesBodies });

const dir = (over: Partial<DirSnapshot>): DirSnapshot => ({
  current: NOW,
  excluded: [],
  files: [],
  segments: [],
  summaries: [],
  unfinishedExports: [],
  ...over,
});
const openSegment = { files: [log(2_266)], segments: [seg(2_266, 2_266, [])] } as const;
const sealedSegment = {
  files: [log(2_266), summaryFile()],
  segments: [seg(2_266, 2_266, [])],
  summaries: [{ segment: SEG, valid: true }],
} as const;

export interface CrashRow {
  readonly n: number;
  readonly diedDuring: string;
  readonly onDisk: string;
  readonly snapshot: DirSnapshot;
  readonly plan: readonly ReconcileStep["kind"][];
  readonly readsAs: ReadsAs;
  /** Which finding or earlier row this row answers. */
  readonly source: string;
}

export const CRASH_ROWS: readonly CrashRow[] = [
  {
    n: 1,
    diedDuring: "a file tee, streaming (kill)",
    onDisk: "old-run part in incoming/, no line",
    snapshot: dir({ files: [part(X, OLD), ...openSegment.files], segments: openSegment.segments }),
    plan: ["delete-part", "summarize-log"],
    readsAs: "absent",
    source: "round 1 row 1",
  },
  {
    n: 2,
    diedDuring: "after the tee closed, before the rename",
    onDisk: "old-run part, no line",
    snapshot: dir({
      files: [part(X, OLD), ...sealedSegment.files],
      segments: sealedSegment.segments,
      summaries: sealedSegment.summaries,
    }),
    plan: ["delete-part"],
    readsAs: "absent",
    source: "round 1 row 2",
  },
  {
    n: 3,
    diedDuring: "after the rename, before the line flushed (kill)",
    onDisk: "old-run body file, no line names it",
    snapshot: dir({ files: [body(X), ...openSegment.files], segments: openSegment.segments }),
    plan: ["delete-orphan-body", "summarize-log"],
    readsAs: "absent",
    source: "round 1 row 3",
  },
  {
    n: 4,
    diedDuring: "after the line flushed",
    onDisk: "body file and its line",
    snapshot: dir({ files: [body(X), log(2_266)], segments: [seg(2_266, 2_266, [X])] }),
    plan: ["summarize-log"],
    readsAs: "available",
    source: "round 1 row 4",
  },
  {
    n: 5,
    diedDuring: "a memory sink, before its batch was appended",
    onDisk: "nothing for this exchange",
    snapshot: dir({ ...openSegment }),
    plan: ["summarize-log"],
    readsAs: "absent",
    source: "round 1 row 5",
  },
  {
    n: 6,
    diedDuring: "after the pack append, before the line append (kill)",
    onDisk: "unreferenced bytes at the pack's end",
    snapshot: dir({ files: [pack(), ...openSegment.files], segments: openSegment.segments }),
    plan: ["summarize-log"],
    readsAs: "absent",
    source: "round 1 row 6",
  },
  {
    n: 7,
    diedDuring: "a torn line append",
    onDisk: "segment ends mid-line",
    snapshot: dir({ files: [log(2_334)], segments: [seg(2_334, 2_266, [])] }),
    plan: ["truncate-log", "summarize-log"],
    readsAs: "lines-before-the-tear",
    source: "round 1 row 7",
  },
  {
    n: 8,
    diedDuring: "a power loss that kept a line but lost its pack bytes",
    onDisk: "pack shorter than a line's range",
    snapshot: dir({ files: [pack(), ...openSegment.files], segments: openSegment.segments }),
    plan: ["summarize-log"],
    readsAs: "interrupted-by-crash",
    source: "round 1 row 8",
  },
  {
    n: 9,
    diedDuring: "a clean seal, before its summary was written",
    onDisk: "old-run segment, no summary",
    snapshot: dir({ ...openSegment }),
    plan: ["summarize-log"],
    readsAs: "available",
    source: "round 1 row 9",
  },
  {
    n: 10,
    diedDuring: "with a pack open",
    onDisk: "old-run pack. Only the current run appends, so it is sealed by being old",
    snapshot: dir({
      files: [pack(), ...sealedSegment.files],
      segments: sealedSegment.segments,
      summaries: sealedSegment.summaries,
    }),
    plan: [],
    readsAs: "available",
    source: "deepseek F8: the seal-pack step is gone",
  },
  {
    n: 11,
    diedDuring: "a settings write",
    onDisk: "settings.json.tmp beside the old file",
    snapshot: dir({
      files: [tmp(null, null), ...sealedSegment.files],
      segments: sealedSegment.segments,
      summaries: sealedSegment.summaries,
    }),
    plan: ["delete-tmp"],
    readsAs: "not-applicable",
    source: "round 1 row 11",
  },
  {
    n: 12,
    diedDuring: "retention, mid-run",
    onDisk: "some planned files deleted",
    snapshot: dir({ ...sealedSegment }),
    plan: [],
    readsAs: "available",
    source: "round 1 row 12. The next retention pass recomputes",
  },
  {
    n: 13,
    diedDuring: "an export, mid-write (kill)",
    onDisk: "<folder>/<name>.har.part, journal says started",
    snapshot: dir({ ...sealedSegment, unfinishedExports: ["/home/u/Downloads/a.har.part"] }),
    plan: ["delete-export-part"],
    readsAs: "not-applicable",
    source: "round 1 row 13",
  },
  {
    n: 14,
    diedDuring: "an exclusion, after settings, during the directory delete (kill)",
    onDisk: "part of sites/<site>/, the site in excludedSites",
    snapshot: dir({
      excluded: [GONE],
      files: [log(900, SEG_GONE, GONE), body(Y, GONE), ...sealedSegment.files],
      segments: [seg(900, 900, [Y], SEG_GONE, GONE), ...sealedSegment.segments],
      summaries: sealedSegment.summaries,
    }),
    plan: ["delete-excluded-site"],
    readsAs: "site-gone",
    source: "round 1 row 16",
  },
  {
    n: 15,
    diedDuring: "an exclusion, before settings were written",
    onDisk: "everything as it was",
    snapshot: dir({ ...sealedSegment }),
    plan: [],
    readsAs: "available",
    source: "round 1 row 17. The options page shows the site as not excluded",
  },
  {
    n: 16,
    diedDuring: "a summary write (kill during the .tmp write)",
    onDisk: "<segment>.summary.json.tmp, no summary",
    snapshot: dir({
      files: [tmp(OLD, SITE), ...openSegment.files],
      segments: openSegment.segments,
    }),
    plan: ["delete-tmp", "summarize-log"],
    readsAs: "available",
    source: "opus 7: summaries go through .tmp and a rename",
  },
  {
    n: 17,
    diedDuring: "a summary that is present but unreadable, or no longer matches its segment",
    onDisk: "summary.json that does not decode",
    snapshot: dir({
      files: [summaryFile(), ...openSegment.files],
      segments: openSegment.segments,
      summaries: [{ segment: SEG, valid: false }],
    }),
    plan: ["delete-invalid-summary", "summarize-log"],
    readsAs: "available",
    source: "opus 7: presence alone no longer means summarized",
  },
  {
    n: 18,
    diedDuring: "an exclusion while a tee for that site streamed",
    onDisk: "old-run part in incoming/, the site partly deleted",
    snapshot: dir({
      excluded: [GONE],
      files: [part(Y, OLD), log(900, SEG_GONE, GONE), ...sealedSegment.files],
      segments: [seg(900, 900, [], SEG_GONE, GONE), ...sealedSegment.segments],
      summaries: sealedSegment.summaries,
    }),
    plan: ["delete-excluded-site", "delete-part"],
    readsAs: "site-gone",
    source: "argon 9: parts live outside site directories",
  },
  {
    n: 19,
    diedDuring: "a clean quit, disable or update with a tee streaming",
    onDisk: "the abandoned line (browser-closed or recording-stopped), its part, a sealed segment",
    snapshot: dir({
      files: [part(X, OLD), ...sealedSegment.files],
      segments: [seg(2_266, 2_266, [])],
      summaries: sealedSegment.summaries,
    }),
    plan: ["delete-part"],
    readsAs: "absent",
    source: "deepseek F5: the line names the true reason",
  },
  {
    n: 20,
    diedDuring: "nothing: this run's own part while recovery runs",
    onDisk: "a part of the current run",
    snapshot: dir({
      files: [part(`${NOW}.7` as ExchangeId, NOW), ...sealedSegment.files],
      segments: sealedSegment.segments,
      summaries: sealedSegment.summaries,
    }),
    plan: [],
    readsAs: "not-applicable",
    source: "files of the current run are never in a plan",
  },
];
