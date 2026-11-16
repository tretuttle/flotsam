import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { launchBrowser, type BrowserSession } from "./browser.ts";

const binary = process.env.BROWSER_HARNESS_BINARY;

describe.runIf(binary !== undefined && binary.length > 0 && NodeFS.existsSync(binary))(
  "real browser",
  () => {
    it.each(["bidi", "marionette"] as const)("drives %s through two tabs", async (protocol) => {
      await using session = await launchBrowser({
        binaryPath: binary ?? "",
        extensionPath: null,
        display: "headless",
        protocol,
        signal: new AbortController().signal,
      });
      expect(session.identity.remoteProtocol).toBe(protocol);
      const first = await roundTrip(session);
      const second = await roundTrip(session);
      expect(first).toContain("Gecko");
      expect(second).toBe(first);
    });
  },
);

async function roundTrip(session: BrowserSession): Promise<string> {
  const context = await session.openTab("about:blank");
  try {
    return await session.evaluate(context, "navigator.userAgent");
  } finally {
    await session.closeTab(context);
  }
}
