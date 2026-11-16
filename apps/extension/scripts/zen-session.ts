// A fresh, isolated Gecko profile with Marionette, started and stopped by one pair of calls. Used by verify-zen.ts
// and screenshot-toolbar.ts. It touches only the process it spawns and a temp profile it creates.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
export class Marionette {
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

export interface ZenSession {
  readonly marionette: Marionette;
  readonly profile: string;
  readonly pid: number | undefined;
  stop(): Promise<void>;
}

/** Starts the browser on a new profile and connects to it. `headless` has no visible window. */
export const startZen = async (
  binary: string,
  { headless }: { headless: boolean },
): Promise<ZenSession> => {
  const profile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-verify-"));
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
      ...(headless ? ["-headless"] : []),
      "-wait-for-browser",
      "-marionette",
      "-profile",
      profile,
    ],
    // Chrome-context scripts open and close the toolbox. Set on this child process only.
    { stdio: "ignore", env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } },
  );
  console.log(`spawned ${binary} pid ${browser.pid}, profile ${profile}, marionette port ${port}`);
  const marionette = await Marionette.connect(port, Date.now() + 60_000);
  await marionette.command("WebDriver:NewSession", { strictFileInteractability: true });
  await marionette.command("WebDriver:SetTimeouts", { implicit: 15_000, script: 30_000 });

  const stop = async () => {
    const exited = new Promise((resolve) =>
      browser.exitCode === null ? browser.once("exit", resolve) : resolve(null),
    );
    await marionette.command("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => {});
    marionette.close();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
    if (browser.exitCode === null && browser.pid !== undefined) {
      // Only the process this function started, and its children.
      if (process.platform === "win32") {
        NodeChildProcess.execFileSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else browser.kill("SIGKILL");
      await exited;
    }
    NodeFS.rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
  };
  return { marionette, profile, pid: browser.pid, stop };
};
