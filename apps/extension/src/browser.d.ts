/// <reference types="firefox-webext-browser" />

import type { OneClickHarApi } from "../experiment/contract.ts";

declare global {
  namespace browser {
    /** Undefined when the browser has `extensions.experiments.enabled` set to false. */
    const oneClickHar: OneClickHarApi | undefined;
  }
}
