import type { ExportId, ExportJob, Preview } from "@one-click-har/export/jobs";
import type { ExportRequest } from "@one-click-har/export/jobs";
import type { Selection } from "@one-click-har/export/selection";
import type { TabId } from "@one-click-har/recording/ids";
import {
  namespace,
  oneClickHarApi,
  type Environment,
  type OneClickHarApi,
  type PopupTabArgument,
  type PopupView,
  type RecordingProblem,
  type RecordingStatus,
  type ToolboxState,
} from "./contract.ts";
import { parseArguments } from "./gecko-schema.ts";

/** What the recorder and the store report about themselves, read when an extension page asks. */
export interface RecordingFacts {
  /** null when observers are running. */
  readonly archive: "refused" | "unwritable" | null;
  readonly strictOriginPolicy: boolean;
  readonly settingsRejected: boolean;
  readonly writeFailures: number;
  readonly liveOverflow: number;
}

/** One row per problem, in the order the status lists them. */
const PROBLEM_RULES: readonly {
  readonly problem: RecordingProblem;
  readonly when: (f: RecordingFacts) => boolean;
}[] = [
  { problem: "archive-refused", when: (f) => f.archive === "refused" },
  { problem: "archive-unwritable", when: (f) => f.archive === "unwritable" },
  { problem: "file-pages-can-read-files", when: (f) => !f.strictOriginPolicy },
  { problem: "settings-unreadable", when: (f) => f.settingsRejected },
  { problem: "write-failed", when: (f) => f.writeFailures > 0 },
  { problem: "too-many-live-requests", when: (f) => f.liveOverflow > 0 },
];

export const recordingStatus = (facts: RecordingFacts): RecordingStatus => ({
  recording: facts.archive === null,
  problems: PROBLEM_RULES.filter((rule) => rule.when(facts)).map((rule) => rule.problem),
});

/**
 * What a host can do, after its input is parsed. A tab id that names no tab is a state of the result here, never a
 * throw: tab 0, a closed tab and a private tab without permission all come back as `no-such-tab`.
 */
export interface Host {
  readonly identity: () => Environment["browser"];
  readonly toolbox: (tabId: TabId) => ToolboxState;
  readonly recording: () => RecordingFacts;
  readonly popup: (tab: PopupTabArgument) => Promise<Omit<PopupView, "problems">>;
  readonly preview: (selection: Selection) => Promise<Preview>;
  readonly exports: {
    readonly start: (request: ExportRequest) => ExportJob;
    readonly list: () => readonly ExportJob[];
    readonly cancel: (id: ExportId) => boolean;
    readonly reveal: (id: ExportId) => Promise<boolean>;
    readonly copyPath: (id: ExportId) => boolean;
  };
}

/**
 * The handlers, written once against `Host`. The explicit `Promise<...>` return types make a fresh result literal with
 * an extra property fail typecheck; the contract test compares the runtime keys of values held in variables.
 */
const handlers = (host: Host): OneClickHarApi => ({
  getEnvironment: async (tabId): Promise<Environment> => {
    const identity = host.identity();
    return {
      browser: { name: identity.name, version: identity.version, buildId: identity.buildId },
      toolbox: host.toolbox(tabId),
    };
  },
  getRecordingStatus: async (): Promise<RecordingStatus> => {
    const status = recordingStatus(host.recording());
    return { recording: status.recording, problems: status.problems };
  },
  getPopup: async (tab): Promise<PopupView> => ({
    ...(await host.popup(tab)),
    problems: recordingStatus(host.recording()).problems,
  }),
  preview: (selection) => host.preview(selection),
  startExport: async (request) => host.exports.start(request),
  listExports: async () => host.exports.list(),
  cancelExport: async (id) => host.exports.cancel(id),
  revealExport: (id) => host.exports.reveal(id),
  copyExportPath: async (id) => host.exports.copyPath(id),
});

/** The API as a page's caller reaches it: raw arguments in, each one parsed before its handler runs. */
export type RawApi = {
  readonly [Name in keyof OneClickHarApi]: (
    ...raw: readonly unknown[]
  ) => ReturnType<OneClickHarApi[Name]>;
};

/**
 * The API object a host exposes. Every argument goes through its parameter's parser first, in both hosts, because the
 * standard host's port has no Gecko schema in front of it. A refused argument rejects with `refuse`'s error.
 */
export const createOneClickHarApi = (host: Host, refuse: (message: string) => Error): RawApi => {
  const typed = handlers(host) as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const entries = Object.entries(oneClickHarApi).map(([name, fn]) => {
    const call = (...raw: readonly unknown[]): Promise<unknown> => {
      const parsed = parseArguments(fn, raw);
      if (!parsed.ok)
        return Promise.reject(refuse(`Invalid ${parsed.refused} for ${namespace}.${name}.`));
      return typed[name]!(...parsed.values);
    };
    return [name, call] as const;
  });
  return Object.fromEntries(entries) as unknown as RawApi;
};
