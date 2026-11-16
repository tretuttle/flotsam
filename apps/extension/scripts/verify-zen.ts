// Installs the packed XPI into a fresh profile of a Gecko browser, opens the popup page in a tab, and reads
// getEnvironment() three times: before DevTools starts, with a toolbox open on that tab, and after it closes.
// Each reading is checked against the browser's application.ini and the toolbox state this script set.
// Usage: pnpm run verify:zen [--binary <path to zen.exe or firefox.exe>] [--xpi <path>]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { Environment, ToolboxState } from "../experiment/contract.ts";
import { extensionRoot, readManifest } from "./manifest.ts";

const builtManifest = readManifest(
  NodePath.join(extensionRoot, "dist", "firefox", "manifest.json"),
);
const { values: options } = NodeUtil.parseArgs({
  options: {
    binary: {
      type: "string",
      default: process.env.ZEN_BINARY ?? "C:\\Program Files\\Zen Twilight\\zen.exe",
    },
    xpi: {
      type: "string",
      default: NodePath.join(extensionRoot, "dist", `har-anytime-${builtManifest.version}.xpi`),
    },
  },
});

const PREFS: Record<string, string | number | boolean> = {
  "extensions.experiments.enabled": true,
  "xpinstall.signatures.required": false,
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "zen.welcome-screen.seen": true,
  "browser.startup.homepage_override.mstone": "ignore",
  "startup.homepage_welcome_url": "",
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.enabled": false,
  "app.update.auto": false,
  "app.normandy.enabled": false,
  "extensions.update.enabled": false,
  "extensions.getAddons.cache.enabled": false,
  "network.proxy.type": 1,
  "network.proxy.http": "127.0.0.1",
  "network.proxy.http_port": 9,
  "network.proxy.ssl": "127.0.0.1",
  "network.proxy.ssl_port": 9,
  "network.proxy.failover_direct": false,
  "network.trr.mode": 5,
  "network.captive-portal-service.enabled": false,
  "network.connectivity-service.enabled": false,
  "services.settings.server": "http://127.0.0.1:9/v1",
  "media.gmp-manager.updateEnabled": false,
  "browser.safebrowsing.malware.enabled": false,
  "browser.safebrowsing.phishing.enabled": false,
};

const applicationIni = (binary: string): Record<string, string> =>
  Object.fromEntries(
    NodeFS.readFileSync(NodePath.join(NodePath.dirname(binary), "application.ini"), "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^(\w+)=(.*)$/.exec(line);
        return match?.[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]]];
      }),
  );

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** A client for Marionette's framed JSON protocol: `<byte length>:<json>`. */
class Marionette {
  #socket: NodeNet.Socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #handshake: (value: unknown) => void = () => {};

  private constructor(socket: NodeNet.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => this.#receive(chunk));
  }

  static async connect(port: number, deadline: number): Promise<Marionette> {
    while (true) {
      try {
        const socket = await new Promise<NodeNet.Socket>((resolve, reject) => {
          const attempt = NodeNet.connect(port, "127.0.0.1", () => resolve(attempt));
          attempt.once("error", reject);
        });
        const client = new Marionette(socket);
        await new Promise((resolve) => (client.#handshake = resolve));
        return client;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  #receive(chunk: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const colon = this.#buffer.indexOf(":");
      if (colon < 0) return;
      const length = Number(this.#buffer.subarray(0, colon).toString());
      if (this.#buffer.length < colon + 1 + length) return;
      const message: unknown = JSON.parse(
        this.#buffer.subarray(colon + 1, colon + 1 + length).toString(),
      );
      this.#buffer = this.#buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) {
        this.#handshake(message);
        continue;
      }
      const [, id, error, result] = message as [
        1,
        number,
        { error: string; message: string } | null,
        unknown,
      ];
      const waiter = this.#pending.get(id);
      this.#pending.delete(id);
      if (error) waiter?.reject(new Error(`${error.error}: ${error.message}`));
      else waiter?.resolve(result);
    }
  }

  command<T = unknown>(name: string, params: object = {}): Promise<T> {
    const id = this.#nextId++;
    const body = Buffer.from(JSON.stringify([0, id, name, params]));
    this.#socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
    return new Promise<T>((resolve, reject) =>
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
  }

  async script<T>(
    context: "chrome" | "content",
    script: string,
    args: ReadonlyArray<unknown> = [],
  ): Promise<T> {
    await this.command("Marionette:SetContext", { value: context });
    const { value } = await this.command<{ value: T }>("WebDriver:ExecuteAsyncScript", {
      script,
      args,
    });
    return value;
  }

  close() {
    this.#socket.destroy();
  }
}

const DEVTOOLS = `
  const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
  const { gDevTools } = require("resource://devtools/client/framework/devtools.js");
  const tab = window.gBrowser.selectedTab;
  const done = arguments[arguments.length - 1];
`;

// The first step must not touch DevTools: loading its framework starts it.
const STEPS: ReadonlyArray<{
  step: string;
  act?: string;
  toolbox: (host: string) => ToolboxState;
  text: (host: string) => string;
}> = [
  {
    step: "before DevTools starts",
    toolbox: () => ({ open: false, reason: "devtools-not-started" }),
    text: () => "Not opened since the browser started",
  },
  {
    step: "toolbox open on the tab",
    act: `gDevTools.showToolboxForTab(tab, { toolId: "netmonitor" }).then((toolbox) => done(toolbox.hostType));`,
    toolbox: (host) => ({ open: true, host }),
    text: (host) => `Open on this tab (${host})`,
  },
  {
    step: "toolbox closed again",
    act: `gDevTools.closeToolboxForTab(tab).then(() => done(null));`,
    toolbox: () => ({ open: false, reason: "no-toolbox-for-tab" }),
    text: () => "Not open on this tab",
  },
];

/** Calls the API from the popup page in the current tab, for the active tab or for the given tab ID. */
const getEnvironment = (marionette: Marionette, tabId: number | null = null) =>
  marionette.script<Environment | { error: string }>(
    "content",
    `const [tabId, done] = arguments;
     const tab = tabId === null ? browser.tabs.query({ active: true, currentWindow: true }).then(([active]) => active.id) : Promise.resolve(tabId);
     tab.then((id) => browser.harAnytime.getEnvironment(id))
       .then((environment) => done(JSON.parse(JSON.stringify(environment))), (error) => done({ error: String(error) }));`,
    [tabId],
  );

const readPopup = async (marionette: Marionette) => {
  await marionette.command("Marionette:SetContext", { value: "content" });
  await marionette.command("WebDriver:Refresh");
  const facts = await marionette.command<{ value: Record<string, string> }>(
    "WebDriver:FindElement",
    {
      using: "css selector",
      value: "dl.facts, p.facts",
    },
  );
  const { value: popupText } = await marionette.command<{ value: string }>(
    "WebDriver:GetElementText",
    {
      id: Object.values(facts.value)[0],
    },
  );
  const environment = await getEnvironment(marionette);
  return { popupText, environment };
};

const binary = NodePath.resolve(options.binary);
const xpi = NodePath.resolve(options.xpi);
const ini = applicationIni(binary);
const profile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "har-anytime-verify-"));
const port = await freePort();
NodeFS.writeFileSync(
  NodePath.join(profile, "user.js"),
  Object.entries({ ...PREFS, "marionette.port": port })
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
    .join("\n"),
);

const browser = NodeChildProcess.spawn(
  binary,
  [
    "-no-remote",
    "-new-instance",
    "-headless",
    "-wait-for-browser",
    "-marionette",
    "-profile",
    profile,
  ],
  // Chrome-context scripts open and close the toolbox. Set on this child process only.
  { stdio: "ignore", env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } },
);
console.log(`spawned ${binary} pid ${browser.pid}, profile ${profile}, marionette port ${port}`);

const failures: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = NodeUtil.isDeepStrictEqual(actual, expected);
  if (!pass) failures.push(label);
  console.log(
    `${pass ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${pass ? "" : ` expected ${JSON.stringify(expected)}`}`,
  );
};

const marionette = await Marionette.connect(port, Date.now() + 60_000);
try {
  await marionette.command("WebDriver:NewSession", { strictFileInteractability: true });
  await marionette.command("WebDriver:SetTimeouts", { implicit: 15_000, script: 30_000 });
  const { value: addonId } = await marionette.command<{ value: string }>("Addon:Install", {
    path: xpi,
    temporary: false,
  });
  console.log(`installed ${xpi} (${NodeFS.statSync(xpi).size} bytes) as ${addonId}`);

  const popupUrl = await marionette.script<string>(
    "chrome",
    `const done = arguments[arguments.length - 1];
     const policy = WebExtensionPolicy.getByID(arguments[0]);
     done(policy.getURL(arguments[1]));`,
    [addonId, builtManifest.action.default_popup],
  );
  // Zen hides its initial empty tab from extensions (ext-browser.js, `zen-empty-tab`), so use a new tab.
  await marionette.command("Marionette:SetContext", { value: "content" });
  const { handle } = await marionette.command<{ handle: string }>("WebDriver:NewWindow", {
    type: "tab",
    focus: true,
  });
  await marionette.command("WebDriver:SwitchToWindow", { handle, focus: true });
  await marionette.command("WebDriver:Navigate", { url: popupUrl });

  const expectedBrowser = { name: ini.Name, version: ini.Version, buildId: ini.BuildID };
  const unknownTab = await getEnvironment(marionette, 2_147_483_647);
  console.log(`
unknown tab ID
getEnvironment(2147483647) -> ${JSON.stringify(unknownTab)}`);
  check("unknown tab ID: toolbox", "toolbox" in unknownTab ? unknownTab.toolbox : unknownTab, {
    open: false,
    reason: "no-such-tab",
  });

  let host = "";
  for (const { step, act, toolbox, text } of STEPS) {
    if (act !== undefined)
      host = (await marionette.script<string | null>("chrome", DEVTOOLS + act)) ?? host;
    const { popupText, environment } = await readPopup(marionette);
    console.log(
      `\n${step}\ngetEnvironment() -> ${JSON.stringify(environment, null, 2)}\npopup:\n${popupText}`,
    );
    check(
      `${step}: browser`,
      "browser" in environment ? environment.browser : environment,
      expectedBrowser,
    );
    check(
      `${step}: toolbox`,
      "toolbox" in environment ? environment.toolbox : environment,
      toolbox(host),
    );
    check(`${step}: popup DevTools line`, popupText.split("\n").at(-1), text(host));
  }
} finally {
  const exited = new Promise((resolve) =>
    browser.exitCode === null ? browser.once("exit", resolve) : resolve(null),
  );
  await marionette.command("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => {});
  marionette.close();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
  if (browser.exitCode === null && browser.pid !== undefined) {
    // Only the process this script started, and its children.
    if (process.platform === "win32") {
      NodeChildProcess.execFileSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else browser.kill("SIGKILL");
    await exited;
  }
  NodeFS.rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
}

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} checks failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
