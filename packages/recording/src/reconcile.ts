// Startup recovery as a pure plan over a directory snapshot. Every step is derived from what is on disk, never from
// what the previous run meant to do, and every step removes the condition that triggers it, so a second plan over
// the result is empty. test/reconcile tests prove that over the crash table and over generated crashes.

import type { ExchangeId, LogSegmentId, RunId, Site } from "./ids.ts";

export interface SnapshotFile {
  readonly path: string;
  readonly bytes: number;
  readonly kind: "site-dir" | "log" | "summary" | "pack" | "part" | "body" | "tmp" | "other";
  /** null for settings.json.tmp, which belongs to no run. */
  readonly run: RunId | null;
  readonly site: Site | null;
  readonly segment: LogSegmentId | null;
  readonly id: ExchangeId | null;
}

export interface SnapshotSegment {
  readonly segment: LogSegmentId;
  readonly site: Site;
  readonly run: RunId;
  readonly bytes: number;
  /** Bytes up to and including the last newline. Less than `bytes` when the last append was torn. */
  readonly validBytes: number;
  /** Body files named by the segment's whole lines. */
  readonly namesBodies: readonly ExchangeId[];
}

export interface SnapshotSummary {
  readonly segment: LogSegmentId;
  /** decodeSummary succeeded and its `bytes` equals the segment's current size. */
  readonly valid: boolean;
}

export interface DirSnapshot {
  readonly current: RunId;
  readonly excluded: readonly Site[];
  /** Every parseable name. Unparseable names are absent and never touched. */
  readonly files: readonly SnapshotFile[];
  readonly segments: readonly SnapshotSegment[];
  readonly summaries: readonly SnapshotSummary[];
  /** Unfinished export jobs from exports.jsonl. The path is the parent's; it never came from an extension page. */
  readonly unfinishedExports: readonly string[];
}

export type ReconcileStep =
  | { readonly kind: "delete-excluded-site"; readonly site: Site }
  | { readonly kind: "delete-part"; readonly path: string }
  | { readonly kind: "delete-tmp"; readonly path: string }
  | { readonly kind: "delete-orphan-body"; readonly path: string }
  | { readonly kind: "delete-invalid-summary"; readonly segment: LogSegmentId }
  | { readonly kind: "truncate-log"; readonly segment: LogSegmentId; readonly toBytes: number }
  | { readonly kind: "delete-export-part"; readonly path: string }
  | { readonly kind: "summarize-log"; readonly segment: LogSegmentId };

const isOld = (snapshot: DirSnapshot, run: RunId | null): boolean =>
  run === null || run !== snapshot.current;

/**
 * Each step kind and what triggers it, in the order a plan lists them. summarize-log is last, so a crash during
 * recovery reruns it; it is written through a .tmp and a rename.
 */
export const RECONCILE_STEPS: { readonly [K in ReconcileStep["kind"]]: string } = {
  "delete-excluded-site":
    "a site directory for a site in settings.excludedSites (an interrupted exclusion)",
  "delete-part": "an old run's .part: a tee that never closed, or closed before its rename",
  "delete-tmp": "an interrupted atomic write (settings, or a summary of an old run)",
  "delete-orphan-body": "an old run's body file that no whole line of its segments names",
  "delete-invalid-summary":
    "a summary that does not decode or no longer matches its segment's size",
  "truncate-log": "an old run's segment, without a valid summary, that ends mid-line",
  "delete-export-part": "a .har.part the export journal says was started and never finished",
  "summarize-log": "an old run's segment without a valid summary",
};

/** Files of `current` are never in the plan. Recovery runs first on the store's write chain, before this run writes. */
export function planReconcile(snapshot: DirSnapshot): readonly ReconcileStep[] {
  const excluded = new Set(snapshot.excluded);
  const steps: ReconcileStep[] = [];
  const alive = (site: Site | null): boolean => site === null || !excluded.has(site);

  for (const site of snapshot.excluded) {
    if (snapshot.files.some((f) => f.site === site))
      steps.push({ kind: "delete-excluded-site", site });
  }
  for (const f of snapshot.files) {
    if (f.kind === "part" && isOld(snapshot, f.run))
      steps.push({ kind: "delete-part", path: f.path });
  }
  for (const f of snapshot.files) {
    if (f.kind === "tmp" && alive(f.site) && isOld(snapshot, f.run))
      steps.push({ kind: "delete-tmp", path: f.path });
  }
  const named = new Set(
    snapshot.segments.filter((s) => alive(s.site)).flatMap((s) => s.namesBodies),
  );
  for (const f of snapshot.files) {
    if (
      f.kind === "body" &&
      alive(f.site) &&
      isOld(snapshot, f.run) &&
      f.id !== null &&
      !named.has(f.id)
    ) {
      steps.push({ kind: "delete-orphan-body", path: f.path });
    }
  }
  const validSummary = new Set(snapshot.summaries.filter((s) => s.valid).map((s) => s.segment));
  for (const s of snapshot.summaries) {
    const seg = snapshot.segments.find((g) => g.segment === s.segment);
    if (!s.valid && (seg === undefined || alive(seg.site)))
      steps.push({ kind: "delete-invalid-summary", segment: s.segment });
  }
  const oldUnsummarized = snapshot.segments.filter(
    (s) => alive(s.site) && isOld(snapshot, s.run) && !validSummary.has(s.segment),
  );
  for (const s of oldUnsummarized) {
    if (s.validBytes < s.bytes)
      steps.push({ kind: "truncate-log", segment: s.segment, toBytes: s.validBytes });
  }
  for (const path of snapshot.unfinishedExports) steps.push({ kind: "delete-export-part", path });
  for (const s of oldUnsummarized) steps.push({ kind: "summarize-log", segment: s.segment });
  return steps;
}

/** The plan's effect on a snapshot, as the store's executor performs it on disk: planReconcile(applyPlan(s, plan)) is []. */
export function applyPlan(snapshot: DirSnapshot, steps: readonly ReconcileStep[]): DirSnapshot {
  let files = snapshot.files;
  let segments = snapshot.segments;
  let summaries = snapshot.summaries;
  let unfinishedExports = snapshot.unfinishedExports;
  for (const step of steps) {
    switch (step.kind) {
      case "delete-excluded-site":
        files = files.filter((f) => f.site !== step.site);
        summaries = summaries.filter(
          (s) => segments.find((g) => g.segment === s.segment)?.site !== step.site,
        );
        segments = segments.filter((s) => s.site !== step.site);
        break;
      case "delete-part":
      case "delete-tmp":
      case "delete-orphan-body":
        files = files.filter((f) => f.path !== step.path);
        break;
      case "delete-invalid-summary":
        files = files.filter((f) => !(f.kind === "summary" && f.segment === step.segment));
        summaries = summaries.filter((s) => s.segment !== step.segment);
        break;
      case "truncate-log":
        segments = segments.map((s) =>
          s.segment === step.segment ? { ...s, bytes: step.toBytes, validBytes: step.toBytes } : s,
        );
        files = files.map((f) =>
          f.kind === "log" && f.segment === step.segment ? { ...f, bytes: step.toBytes } : f,
        );
        break;
      case "delete-export-part":
        unfinishedExports = unfinishedExports.filter((p) => p !== step.path);
        break;
      case "summarize-log": {
        const seg = segments.find((s) => s.segment === step.segment);
        if (seg === undefined) break;
        summaries = [
          ...summaries.filter((s) => s.segment !== step.segment),
          { segment: step.segment, valid: true },
        ];
        files = [
          ...files.filter((f) => !(f.kind === "summary" && f.segment === step.segment)),
          {
            path: `${String(step.segment)}.summary.json`,
            bytes: 1,
            kind: "summary",
            run: seg.run,
            site: seg.site,
            segment: step.segment,
            id: null,
          },
        ];
        break;
      }
    }
  }
  return { ...snapshot, files, segments, summaries, unfinishedExports };
}

/** What an exchange reads as after recovery, for the crash table's last column. Bytes are those the segment keeps. */
export type ReadsAs =
  | "absent"
  | "available"
  | "interrupted-by-crash"
  | "lines-before-the-tear"
  | "site-gone"
  | "not-applicable";
