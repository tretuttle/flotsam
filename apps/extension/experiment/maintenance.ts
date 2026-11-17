// Startup recovery: a snapshot of the archive, the pure plan from @one-click-har/recording/reconcile, and the effect
// of each step. Retention and pins belong to a later pull request; this file runs no retention.

import type { ByteCount, ExchangeId, RunId, Site } from "@one-click-har/recording/ids";
import {
  LAYOUT,
  logSegmentPath,
  logSummaryPath,
  parseArchiveName,
  siteDirName,
  type ArchiveName,
  type SafeFolder,
} from "@one-click-har/recording/layout";
import {
  decodeLine,
  decodeSummary,
  encodeSummary,
  summarize,
  type LogLine,
} from "@one-click-har/recording/log";
import {
  planReconcile,
  type DirSnapshot,
  type ReconcileStep,
  type SnapshotEntry,
} from "@one-click-har/recording/reconcile";
import { type Modes, writeAtomic } from "./gecko-io.ts";

const relative = (root: string, path: string): readonly string[] =>
  path.slice(root.length + 1).split(/[\\/]/);

const children = (path: string): Promise<string[]> =>
  IOUtils.getChildren(path, { ignoreAbsent: true });

const isDirectory = async (path: string): Promise<boolean> =>
  (await IOUtils.stat(path)).type === "directory";

/** settings.json.tmp, every file in incoming/, and every file in each site's log/, packs/ and bodies/. */
async function listFiles(root: string): Promise<string[]> {
  const settingsTmp = PathUtils.join(root, `${LAYOUT.settings}${LAYOUT.tmpSuffix}`);
  const found = (await IOUtils.exists(settingsTmp)) ? [settingsTmp] : [];
  found.push(...(await children(PathUtils.join(root, LAYOUT.incomingDir))));
  for (const site of await children(PathUtils.join(root, LAYOUT.sitesDir))) {
    if (!(await isDirectory(site))) continue;
    found.push(site);
    for (const folder of await children(site)) {
      if (await isDirectory(folder)) found.push(...(await children(folder)));
    }
  }
  return found;
}

const wholeLines = (text: string): LogLine[] =>
  text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .map(decodeLine)
    .filter((line): line is LogLine => line !== null);

const bodiesNamed = (lines: readonly LogLine[]): ExchangeId[] =>
  lines.flatMap(({ exchange }) =>
    exchange.kind === "answered" &&
    exchange.body.kind === "stored" &&
    exchange.body.at.kind === "file"
      ? [exchange.body.at.id]
      : [],
  );

type Named<K extends ArchiveName["kind"]> = Extract<ArchiveName, { readonly kind: K }>;

/**
 * Every log is stat'ed; its lines are read only where the plan needs them: an old run's segment with no valid summary
 * (it may end mid-line), or one beside body files of its own run (the orphan check). A body's line is always written
 * by the run that wrote the body.
 */
async function snapshotArchive(
  root: SafeFolder,
  run: RunId,
  excluded: readonly Site[],
): Promise<DirSnapshot> {
  const entries: SnapshotEntry[] = [];
  const logs: { readonly path: string; readonly name: Named<"log">; readonly bytes: number }[] = [];
  const summaries: { readonly path: string; readonly name: Named<"summary"> }[] = [];
  const bodyRuns = new Set<string>();
  for (const path of await listFiles(root)) {
    const segments = relative(root, path);
    const name = parseArchiveName(segments);
    if (name === null) continue;
    const key = segments.join("/");
    if (name.kind === "log") logs.push({ path: key, name, bytes: (await IOUtils.stat(path)).size });
    else if (name.kind === "summary") summaries.push({ path: key, name });
    else entries.push({ path: key, name });
    if (name.kind === "body") bodyRuns.add(`${name.dir}/${name.run}`);
  }
  const bytesOf = new Map(logs.map((log) => [log.name.segment, log.bytes]));
  const summarized = new Set<string>();
  for (const { path, name } of summaries) {
    const bytes = bytesOf.get(name.segment);
    const valid =
      bytes !== undefined &&
      decodeSummary(
        await IOUtils.readUTF8(PathUtils.join(root, ...path.split("/"))),
        bytes as ByteCount,
      ) !== null;
    if (valid) summarized.add(name.segment);
    entries.push({ path, name, valid });
  }
  for (const { path, name, bytes } of logs) {
    const needsLines =
      name.run !== run &&
      (!summarized.has(name.segment) || bodyRuns.has(`${name.dir}/${name.run}`));
    const text = needsLines
      ? await IOUtils.readUTF8(PathUtils.join(root, ...path.split("/")))
      : null;
    entries.push({
      path,
      name,
      bytes,
      validBytes: text === null ? bytes : text.lastIndexOf("\n") + 1,
      namesBodies: text === null ? [] : bodiesNamed(wholeLines(text)),
    });
  }
  return { current: run, excluded, entries, unfinishedExports: [] };
}

async function execute(root: SafeFolder, modes: Modes, step: ReconcileStep): Promise<void> {
  const at = (segments: readonly string[]): string => PathUtils.join(root, ...segments);
  switch (step.kind) {
    case "delete-excluded-site":
      return IOUtils.remove(at([LAYOUT.sitesDir, siteDirName(step.site)]), {
        recursive: true,
        ignoreAbsent: true,
      });
    case "delete-part":
    case "delete-tmp":
    case "delete-orphan-body":
      return IOUtils.remove(at(step.path.split("/")), { ignoreAbsent: true });
    case "delete-invalid-summary":
      return IOUtils.remove(at(logSummaryPath(step.segment)), { ignoreAbsent: true });
    case "truncate-log": {
      const path = at(logSegmentPath(step.segment));
      const text = await IOUtils.readUTF8(path);
      return writeAtomic(path, text.slice(0, step.toBytes), modes);
    }
    case "delete-export-part":
      return IOUtils.remove(step.path, { ignoreAbsent: true });
    case "summarize-log": {
      const text = await IOUtils.readUTF8(at(logSegmentPath(step.segment)));
      const summary = summarize(step.segment, wholeLines(text), text.length as ByteCount);
      return writeAtomic(at(logSummaryPath(step.segment)), encodeSummary(summary), modes);
    }
  }
}

/** Runs first on the store's write chain, before this run writes anything. Returns the steps it carried out. */
export async function recover(
  root: SafeFolder,
  modes: Modes,
  run: RunId,
  excluded: readonly Site[],
): Promise<readonly ReconcileStep[]> {
  const steps = planReconcile(await snapshotArchive(root, run, excluded));
  for (const step of steps) await execute(root, modes, step);
  return steps;
}
