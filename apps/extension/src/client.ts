// The extension pages' one way to the experiment API and the tab they act on.

import { parseTabId, type TabId } from "@one-click-har/recording/ids";
import type { OneClickHarApi } from "../experiment/contract.ts";

/** null when the browser does not provide the experiment API (`extensions.experiments.enabled` is false). */
export const oneClickHar = (): OneClickHarApi | null => browser.oneClickHar ?? null;

/** The window's active tab. null when it has no usable id: Zen's empty tab reports -1. */
export async function activeTab(): Promise<TabId | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return parseTabId(tab?.id);
}

/** Opens the settings page at one of its sections. */
export async function openSettings(section: string): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(`options/index.html#${section}`) });
}
