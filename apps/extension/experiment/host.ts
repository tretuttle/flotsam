// The experiment host: system principal, parent process. Tab ids from extension pages are looked up here and never
// throw; counts come from the activity index; an export reads the archive and writes one file through guardFolder.
// What returns to a page is counts, rows and job states. No path, body byte or HAR text crosses back.

import type {
  DevtoolsState,
  ExportId,
  ExportJob,
  ExportRequest,
  PopupTab,
  Preview,
} from "@one-click-har/export/jobs";
import { runExport, WriteRefused } from "@one-click-har/export/run";
import {
  inSelection,
  PRESETS,
  resolveSelection,
  type Selection,
  type SelectionContext,
} from "@one-click-har/export/selection";
import { formatHarFilename } from "@one-click-har/har/filename";
import {
  countWindows,
  firstMinuteOfTab,
  type ActivityIndex,
} from "@one-click-har/recording/activity";
import type { LiveExchange } from "@one-click-har/recording/exchange";
import {
  toMinute,
  type ByteCount,
  type EpochMs,
  type RunId,
  type Site,
  type TabId,
  type TabKey,
} from "@one-click-har/recording/ids";
import {
  ARCHIVE_ROOTS,
  guardFolder,
  LAYOUT,
  type SafeFolder,
} from "@one-click-har/recording/layout";
import type { StoredSettings } from "@one-click-har/recording/settings";
import { archiveBodies, archiveSource, decodeContent, itemOf } from "./archive-source.ts";
import type { PopupTabArgument, PopupView, ToolboxState } from "./contract.ts";
import { devtoolsSource, toolboxOf } from "./devtools.ts";
import { createPartSink, freeFileName, journalLine, PART_SUFFIX } from "./export-file.ts";
import { createExportJobs, type ExportJobs, type RunOutcome } from "./export-jobs.ts";
import { forbiddenRoots, platform } from "./files.ts";
import { appendText, localFile, openOutput, siteOfUri, type Modes } from "./gecko-io.ts";

/** What the host reads from a running recording. null while the archive could not be opened. */
export interface RecordingReads {
  readonly run: RunId;
  readonly root: SafeFolder;
  readonly modes: Modes;
  readonly activity: ActivityIndex;
  readonly settings: () => StoredSettings;
  /** Resolves when every line committed before the call is in a segment on disk. */
  readonly settle: () => Promise<void>;
  readonly live: () => readonly { readonly site: Site | null; readonly live: LiveExchange }[];
  /** Startup recovery, which reads and then clears the export journal. */
  readonly recovered: Promise<unknown>;
}

type TabLookup =
  | {
      readonly kind: "tab";
      readonly tabId: TabId;
      readonly tab: NativeTab;
      readonly browserId: number;
      readonly private: boolean;
      readonly site: Site | null;
    }
  | { readonly kind: "no-such-tab" };

/**
 * `tabManager.get` throws an ExtensionError for tab 0, a closed tab, an unknown id and a private tab this add-on may
 * not see (argon 12). That is one state, not an error.
 */
const lookupTab = (extension: ExtensionContext["extension"], tabId: TabId): TabLookup => {
  try {
    const tab = extension.tabManager.get(tabId).nativeTab;
    const browser = tab.linkedBrowser;
    return {
      kind: "tab",
      tabId,
      tab,
      browserId: browser.browserId,
      private: browser.browsingContext?.usePrivateBrowsing === true,
      site: siteOfUri(browser.currentURI),
    };
  } catch {
    return { kind: "no-such-tab" };
  }
};

const DEVTOOLS_STATES: { readonly [Reason: string]: DevtoolsState } = {
  "devtools-not-started": "not-started",
};

const devtoolsState = (toolbox: ToolboxState): DevtoolsState =>
  toolbox.open ? "open" : (DEVTOOLS_STATES[toolbox.reason] ?? "closed");

const gateOf = (
  found: TabLookup,
  settings: StoredSettings | null,
): "private-window" | "excluded-site" | null => {
  if (found.kind !== "tab") return null;
  if (found.private) return "private-window";
  const excluded = settings?.user.excludedSites ?? [];
  return found.site !== null && excluded.includes(found.site) ? "excluded-site" : null;
};

const localMidnight = (now: EpochMs): EpochMs => {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() as EpochMs;
};

const EMPTY_PREVIEW: Preview = {
  requests: 0,
  sources: { both: 0, recordingOnly: 0, devtoolsOnly: 0 },
  bodyBytesAtMost: 0 as ByteCount,
  first: null,
  gate: null,
  inProgress: 0,
};

const yieldNow = (): Promise<void> =>
  new Promise((resolve) => Services.tm.dispatchToMainThread(() => resolve()));

const SCOPE_NAMES = { tab: "tab", site: "site", everything: "all", sessions: "site" } as const;

let exportCounter = 0;

export function createGeckoHost(options: {
  readonly reads: () => RecordingReads | null;
  readonly creator: { readonly name: string; readonly version: string };
  /** The add-on's own tab manager answers for every page. */
  readonly extension: ExtensionContext["extension"];
}) {
  const { reads, creator } = options;
  const finished = new Map<ExportId, string>();

  const lookup = (tabId: TabId): TabLookup => lookupTab(options.extension, tabId);

  /** Tab scope resolves the tab id to this run's TabKey once, here. With no recording there is no key to match. */
  const selectionContext = (rec: RecordingReads | null, selection: Selection): SelectionContext => {
    const now = Date.now() as EpochMs;
    const found = selection.scope === "tab" ? lookup(selection.tabId) : null;
    const tab: TabKey | null =
      rec !== null && found?.kind === "tab" ? { run: rec.run, browserId: found.browserId } : null;
    return {
      now: toMinute(now),
      localMidnight: toMinute(localMidnight(now)),
      tab,
      tabFirstSeen: rec === null || tab === null ? null : firstMinuteOfTab(rec.activity, tab),
      devtoolsFirst: null,
    };
  };

  const preview = async (selection: Selection): Promise<Preview> => {
    const rec = reads();
    const gate =
      selection.scope === "tab" ? gateOf(lookup(selection.tabId), rec?.settings() ?? null) : null;
    if (rec === null) return { ...EMPTY_PREVIEW, gate };
    await rec.settle();
    const resolved = resolveSelection(selection, selectionContext(rec, selection));
    const counts = countWindows(rec.activity, resolved.windows);
    const recorded = resolved.include === "fetch-and-xhr" ? counts.fetchOrXhr : counts.requests;
    const inProgress = rec
      .live()
      .filter(({ site, live }) =>
        inSelection(resolved, itemOf(live.request, site, true, 0)),
      ).length;
    return {
      requests: recorded + inProgress,
      sources: { both: 0, recordingOnly: recorded + inProgress, devtoolsOnly: 0 },
      bodyBytesAtMost: counts.bodyBytesAtMost,
      first: counts.first,
      gate,
      inProgress,
    };
  };

  const popup = async (argument: PopupTabArgument): Promise<Omit<PopupView, "problems">> => {
    const found: TabLookup =
      argument.tabId === null ? { kind: "no-such-tab" } : lookup(argument.tabId);
    const tab: PopupTab =
      argument.tabId === null
        ? { kind: "no-tab" }
        : found.kind === "tab"
          ? { kind: "tab", tabId: found.tabId }
          : { kind: "no-such-tab", tabId: argument.tabId };
    const tabId = found.kind === "tab" ? found.tabId : null;
    const site = found.kind === "tab" ? found.site : null;
    const settings = reads()?.settings() ?? null;
    const rows = [];
    for (const preset of PRESETS) {
      const selection = preset.selection(tabId, site);
      rows.push({ id: preset.id, preview: selection === null ? null : await preview(selection) });
    }
    const all = jobs.list();
    const defaults = settings?.user.exportDefaults ?? { bodies: "include", secrets: "remove" };
    return {
      tab,
      site,
      devtools: found.kind === "tab" ? devtoolsState(toolboxOf(found.tab)) : "closed",
      gate: gateOf(found, settings),
      rows,
      running: all.find((job) => job.state.kind === "writing") ?? null,
      last: all.find((job) => job.state.kind !== "writing") ?? null,
      defaults: {
        bodies: defaults.bodies,
        redaction: defaults.secrets === "remove" ? "standard" : "none",
      },
    };
  };

  const siteOf = (selection: Selection): Site | null => {
    if (selection.scope === "site") return selection.site;
    if (selection.scope === "sessions") return selection.sessions[0].site;
    if (selection.scope === "tab") {
      const found = lookup(selection.tabId);
      return found.kind === "tab" ? found.site : null;
    }
    return null;
  };

  const plannedName = (request: ExportRequest): string => {
    if (request.fileName !== null)
      return request.fileName.endsWith(".har") ? request.fileName : `${request.fileName}.har`;
    return formatHarFilename({
      host: siteOf(request.selection),
      timeRange: { start: Date.now() },
      scope: SCOPE_NAMES[request.selection.scope],
      includeBodies: request.bodies === "include",
      redacted: request.redaction !== "none",
      extension: "har",
    });
  };

  /** The folder settings name, or the browser's Downloads folder, through the same guard as the archive. */
  const exportFolder = async (
    settings: StoredSettings | null,
  ): Promise<{ readonly folder: SafeFolder; readonly label: string } | null> => {
    const chosen = settings?.exportFolder;
    let path: string;
    if (chosen?.kind === "chosen") path = chosen.path;
    else {
      const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
      path = await Downloads.getPreferredDownloadsDirectory();
    }
    const guarded = guardFolder(path, forbiddenRoots(), platform());
    if (!guarded.ok) return null;
    await IOUtils.makeDirectory(guarded.folder, { createAncestors: true, ignoreExisting: true });
    return {
      folder: guarded.folder,
      label: chosen?.kind === "chosen" ? chosen.label : PathUtils.filename(guarded.folder),
    };
  };

  const run = async (
    job: { readonly id: ExportId; readonly request: ExportRequest },
    control: Parameters<Parameters<typeof createExportJobs>[0]["run"]>[1],
  ): Promise<RunOutcome> => {
    const rec = reads();
    await rec?.recovered;
    const modes: Modes = rec?.modes ?? {
      dir: ARCHIVE_ROOTS[platform()].dirMode,
      file: ARCHIVE_ROOTS[platform()].fileMode,
    };
    let target: Awaited<ReturnType<typeof exportFolder>>;
    try {
      target = await exportFolder(rec?.settings() ?? null);
    } catch (error) {
      return { kind: "write-failed", failure: { kind: "other", detail: String(error) } };
    }
    if (target === null) return { kind: "write-failed", failure: { kind: "folder-refused" } };
    const { folder, label } = target;
    const plan = jobs.job(job.id)?.fileName ?? plannedName(job.request);
    const name = freeFileName(plan, (candidate) =>
      localFile(PathUtils.join(folder, candidate)).exists(),
    );
    const final = PathUtils.join(folder, name);
    const part = `${final}${PART_SUFFIX}`;
    const journal = rec === null ? null : PathUtils.join(rec.root, LAYOUT.exportsJournal);
    const note = async (event: "started" | "ended"): Promise<void> => {
      if (journal !== null) await appendText(journal, journalLine(event, part), modes);
    };
    let last = { done: 0, total: 0 };
    const sink = createPartSink(
      {
        append: async (text) => {
          await IOUtils.writeUTF8(part, text, { mode: "append" });
        },
        freeBytes: async () => localFile(folder).diskSpaceAvailable,
      },
      (bytes) => control.progress({ ...last, bytes }),
    );
    try {
      await note("started");
      openOutput(part, false, modes).close();
      const report = await runExport(
        job.request,
        resolveSelection(job.request.selection, selectionContext(rec, job.request.selection)),
        {
          recording:
            rec === null
              ? { ...devtoolsSource, name: "recording" }
              : archiveSource({
                  root: rec.root,
                  activity: rec.activity,
                  settle: rec.settle,
                  live: rec.live,
                }),
          devtools: devtoolsSource,
          bodies: archiveBodies(rec?.root ?? folder),
          sink,
          creator,
          decode: decodeContent,
          yieldNow,
          onProgress: (p) => {
            last = { done: p.done, total: p.total };
            control.progress(p);
          },
          signal: control.signal,
        },
      );
      await sink.close();
      await IOUtils.move(part, final, { noOverwrite: true });
      await note("ended");
      finished.set(job.id, final);
      return { kind: "done", fileName: name, folderLabel: label, report };
    } catch (error) {
      await IOUtils.remove(part, { ignoreAbsent: true }).catch(() => undefined);
      await note("ended").catch(() => undefined);
      if (error instanceof WriteRefused) return { kind: "write-failed", failure: error.failure };
      if (control.signal.aborted) return { kind: "cancelled" };
      return { kind: "write-failed", failure: { kind: "other", detail: String(error) } };
    }
  };

  const jobs: ExportJobs = createExportJobs({
    run,
    now: () => Date.now() as EpochMs,
    newId: () => {
      exportCounter += 1;
      return `${Date.now().toString(36)}-${String(exportCounter)}` as ExportId;
    },
    plannedName,
    onChange: () => undefined,
  });

  const existing = (id: ExportId): string | null => {
    const path = finished.get(id);
    return path !== undefined && localFile(path).exists() ? path : null;
  };

  return {
    jobs,
    lookup,
    popup,
    preview,
    exports: {
      start: (request: ExportRequest): ExportJob => jobs.start(request),
      list: () => jobs.list(),
      cancel: (id: ExportId) => jobs.cancel(id),
      reveal: async (id: ExportId): Promise<boolean> => {
        const path = existing(id);
        if (path === null) return false;
        try {
          localFile(path).reveal();
        } catch {
          // Linux file managers may not support reveal (row P4); opening the folder is the fallback.
          localFile(PathUtils.parent(path) ?? path).launch();
        }
        return true;
      },
      copyPath: (id: ExportId): boolean => {
        const path = existing(id);
        if (path === null) return false;
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(path);
        return true;
      },
    },
  };
}

export type GeckoHost = ReturnType<typeof createGeckoHost>;
