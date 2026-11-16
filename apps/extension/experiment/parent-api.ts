import type {
  Environment,
  OneClickHarApi,
  RecordingProblem,
  RecordingStatus,
  ToolboxState,
} from "./contract.ts";

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

/** What the parent script can read from Gecko. Passed in so the contract test can run the handler in Node. */
export interface ParentReads {
  readonly identity: () => {
    readonly name: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly toolbox: (tabId: number) => ToolboxState;
  readonly recording: () => RecordingFacts;
}

/**
 * The API object the experiment namespace exposes. The explicit `Promise<...>` return types make a fresh result
 * literal with an extra property fail typecheck, and the contract test compares the runtime keys of a value held in a
 * variable, which TypeScript cannot check.
 */
export const createOneClickHarApi = (reads: ParentReads): OneClickHarApi => ({
  getEnvironment: async (tabId): Promise<Environment> => {
    const identity = reads.identity();
    return {
      browser: {
        name: identity.name,
        version: identity.version,
        buildId: identity.buildId,
      },
      toolbox: reads.toolbox(tabId),
    };
  },
  getRecordingStatus: async (): Promise<RecordingStatus> => {
    const status = recordingStatus(reads.recording());
    return { recording: status.recording, problems: status.problems };
  },
});
