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

    it("keeps security.fileuri.strict_origin_policy true under real-defaults and false under planted recommended", async () => {
      await using realDefaults = await launchBrowser({
        binaryPath: binary ?? "",
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        launchMode: "real-defaults",
        allowSystemAccess: true,
        signal: new AbortController().signal,
      });
      const realStrict = await realDefaults.evaluateChrome(
        `const done = arguments[arguments.length - 1];
         done(Services.prefs.getBoolPref("security.fileuri.strict_origin_policy"));`,
      );
      expect(realStrict).toBe(true);

      await using recommended = await launchBrowser({
        binaryPath: binary ?? "",
        extensionPath: null,
        display: "headless",
        protocol: "marionette",
        launchMode: "recommended",
        allowSystemAccess: true,
        signal: new AbortController().signal,
      });
      const recommendedStrict = await recommended.evaluateChrome(
        `const done = arguments[arguments.length - 1];
         done(Services.prefs.getBoolPref("security.fileuri.strict_origin_policy"));`,
      );
      expect(recommendedStrict).toBe(false);
    });

    it("launches an untouched browser with no remote agent under launchMode none", async () => {
      await using session = await launchBrowser({
        binaryPath: binary ?? "",
        extensionPath: null,
        display: "headless",
        launchMode: "none",
        urls: ["about:blank"],
        signal: new AbortController().signal,
      });
      expect(session.launchMode).toBe("none");
      expect(session.spawnedPid).toBeGreaterThan(0);
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
