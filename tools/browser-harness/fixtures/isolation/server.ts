import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

export type IsolationReport =
  | {
      readonly kind: "row";
      readonly browser?: string;
      readonly position: string;
      readonly probe: string;
      readonly observed: unknown;
    }
  | {
      readonly kind: "position-done";
      readonly position: string;
      readonly href: string;
      readonly origin: string;
    }
  | { readonly kind: "cs-hello"; readonly href: string; readonly top: boolean }
  | {
      readonly kind: "cs-file-doc";
      readonly inArchive: boolean;
      readonly href: string;
      readonly text: string;
    }
  | { readonly kind: "bank-done"; readonly cookie: string }
  | { readonly kind: "bad-report"; readonly body: string };

export type IsolationServer = AsyncDisposable & {
  readonly port: number;
  readonly origin: string;
  readonly reports: readonly IsolationReport[];
  readonly setPlan: (plan: Record<string, unknown>) => void;
  /** Forgets every report and enabled position, so a second run of the same positions starts clean. */
  readonly clear: () => void;
  readonly enable: (position: string) => void;
  readonly waitFor: <T extends IsolationReport>(
    predicate: (report: IsolationReport) => report is T,
    timeoutMs: number,
  ) => Promise<T | null>;
  readonly close: () => Promise<void>;
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
} as const;

export async function startIsolationServer(options: {
  readonly marker: string;
  readonly probeHtml: string;
  readonly probesJs: string;
  readonly runnerJs: string;
}): Promise<IsolationServer> {
  let plan: Record<string, unknown> = { ready: false };
  const enabled = new Set<string>();
  const reports: IsolationReport[] = [];
  const waiters: Array<() => void> = [];

  const note = (entry: IsolationReport): void => {
    reports.push(entry);
    // A position runs once. The probe extension's background starts again in the later launches and would
    // otherwise run its position a second time against a different browser state.
    if (entry.kind === "position-done") enabled.delete(entry.position);
    for (const wake of waiters.splice(0)) wake();
  };

  const send = (
    res: NodeHttp.ServerResponse,
    status: number,
    contentType: string,
    body: string,
    extra: Record<string, string> = {},
  ): void => {
    const payload = Buffer.from(body, "utf8");
    res.writeHead(status, {
      "content-type": contentType,
      "content-length": String(payload.length),
      ...CORS_HEADERS,
      ...extra,
    });
    res.end(payload);
  };

  const bankHtml = `<!doctype html><meta charset="utf-8"><title>Bank</title>
<p>Account overview. Note for this session: ${options.marker}-in-html-body</p>
<script>
fetch("/api/account").then((r) => r.text()).then(() => fetch("/api/done"));
</script>`;

  const server = NodeHttp.createServer((req, res) => {
    let url: NodeURL.URL;
    try {
      url = new NodeURL.URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    } catch {
      send(res, 400, "text/plain", "bad url");
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const { host, pathname, searchParams } = url;

      if (pathname === "/report" && req.method === "POST") {
        try {
          note(JSON.parse(bodyText) as IsolationReport);
        } catch {
          note({ kind: "bad-report", body: bodyText.slice(0, 200) });
        }
        send(res, 200, "application/json", "{}");
        return;
      }
      if (pathname === "/plan") {
        send(res, 200, "application/json", JSON.stringify(plan));
        return;
      }
      if (pathname === "/go") {
        const pos = searchParams.get("pos") ?? "";
        send(res, 200, "application/json", JSON.stringify({ go: enabled.has(pos) }));
        return;
      }
      if (pathname === "/redir") {
        send(res, 302, "text/plain", "redirect", {
          location: searchParams.get("to") ?? "about:blank",
        });
        return;
      }
      if (host === "bank.example") {
        if (pathname === "/") {
          send(res, 200, "text/html; charset=utf-8", bankHtml, {
            "set-cookie": `och_session=${options.marker}-in-cookie; Path=/`,
          });
          return;
        }
        if (pathname === "/api/account") {
          // Omit Content-Length (Transfer-Encoding: chunked) so the recorder exercises its file-tee route.
          res.writeHead(200, { "content-type": "application/json", ...CORS_HEADERS });
          res.write(JSON.stringify({ owner: "test", note: `${options.marker}-in-json-body` }));
          res.end();
          return;
        }
        if (pathname === "/api/done") {
          note({ kind: "bank-done", cookie: req.headers.cookie ?? "" });
          send(res, 200, "text/plain", "ok");
          return;
        }
        send(res, 404, "text/plain", "no");
        return;
      }
      if (host === "attacker.example") {
        if (pathname === "/probe.html") {
          send(res, 200, "text/html; charset=utf-8", options.probeHtml);
          return;
        }
        if (pathname === "/probes.js") {
          send(res, 200, "text/javascript; charset=utf-8", options.probesJs);
          return;
        }
        if (pathname === "/runner.js") {
          send(res, 200, "text/javascript; charset=utf-8", options.runnerJs);
          return;
        }
        if (pathname === "/victim.html") {
          send(
            res,
            200,
            "text/html; charset=utf-8",
            "<!doctype html><title>victim</title><p>victim tab",
          );
          return;
        }
        if (pathname.startsWith("/wr-redirect")) {
          send(res, 200, "text/plain", "wr-redirect was not redirected by the test extension");
          return;
        }
        send(res, 404, "text/plain", "no");
        return;
      }
      send(res, 404, "text/plain", "no");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("isolation server failed to bind an ephemeral port");
  }
  const port = address.port;
  const origin = `http://127.0.0.1:${String(port)}`;

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });

  return {
    port,
    origin,
    reports,
    setPlan: (next) => {
      plan = { ...next, ready: true };
    },
    clear: () => {
      reports.length = 0;
      enabled.clear();
    },
    enable: (position) => {
      enabled.add(position);
    },
    waitFor: async <T extends IsolationReport>(
      predicate: (report: IsolationReport) => report is T,
      timeoutMs: number,
    ): Promise<T | null> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = reports.find(predicate);
        if (hit !== undefined) return hit;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(250, remaining));
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
