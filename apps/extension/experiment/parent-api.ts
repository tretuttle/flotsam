import type { Environment, OneClickHarApi, ToolboxState } from "./contract.ts";

/** What the parent script can read from Gecko. Passed in so the contract test can run the handler in Node. */
export interface ParentReads {
  readonly identity: () => {
    readonly name: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly toolbox: (tabId: number) => ToolboxState;
}

/**
 * The API object the experiment namespace exposes. The explicit `Promise<Environment>` return type makes a fresh
 * result literal with an extra property fail typecheck, and the contract test compares the runtime keys of a value
 * held in a variable, which TypeScript cannot check.
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
});
