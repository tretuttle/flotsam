import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeZlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  assertDigestMatch,
  BINARY_BYTE_LENGTH,
  buildDigestTable,
  expectedResourceCount,
  GZIP_BYTE_LENGTH,
  WEBSOCKET_PATH,
  type DigestEntry,
} from "./fixtures.ts";
import { checkBodies, formatHarCheck, parseHarEntries } from "./har.ts";
import { startFixtureServer, type FixtureServer } from "./server.ts";

let server: FixtureServer;
let digests: ReadonlyMap<string, DigestEntry>;

beforeAll(async () => {
  digests = new Map(buildDigestTable().map((entry) => [entry.id, entry]));
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

describe("fixture server", () => {
  it("binds only loopback", () => {
    expect(server.origin.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("serves the 50 MB fixture with Content-Length and the digest of those bytes", async () => {
    const response = await readHttp(server.port, "/fixtures/binary");
    const entry = digest("binary");
    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe(String(BINARY_BYTE_LENGTH));
    expect(response.headers["transfer-encoding"]).toBeUndefined();
    expect(response.body.length).toBe(BINARY_BYTE_LENGTH);
    assertDigestMatch("binary", entry.sha256, hashBuffer(response.body));
  });

  it("serves the chunked fixture with no Content-Length and the digest of the decoded bytes", async () => {
    const raw = await readRaw(server.port, "/fixtures/chunked");
    const entry = digest("chunked");
    expect(raw.status).toBe(200);
    expect(raw.headerText).not.toMatch(/^content-length:/imu);
    expect(raw.headerText).toMatch(/^transfer-encoding:\s*chunked/imu);
    const body = decodeChunked(raw.body);
    expect(body.length).toBe(BINARY_BYTE_LENGTH);
    assertDigestMatch("chunked", entry.sha256, hashBuffer(body));
  });

  it("serves gzip that decodes to the digest", async () => {
    const response = await readHttp(server.port, "/fixtures/gzip");
    const entry = digest("gzip");
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    const decoded = NodeZlib.gunzipSync(response.body);
    expect(decoded.length).toBeGreaterThanOrEqual(GZIP_BYTE_LENGTH);
    expect(decoded.length).toBe(entry.byteLength);
    assertDigestMatch("gzip", entry.sha256, hashBuffer(decoded));
  });

  it("returns 206 with the requested bytes", async () => {
    const full = await readHttp(server.port, "/fixtures/range");
    const entry = digest("range");
    assertDigestMatch("range", entry.sha256, hashBuffer(full.body));
    const partial = await readHttp(server.port, "/fixtures/range", {
      headers: { Range: "bytes=1000-1999" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers["content-range"]).toBe(`bytes 1000-1999/${String(full.body.length)}`);
    expect(Buffer.compare(partial.body, full.body.subarray(1000, 2000))).toBe(0);
  });

  it("returns JSON from POST", async () => {
    const response = await readHttp(server.port, "/fixtures/post", {
      method: "POST",
      body: Buffer.from("{}"),
    });
    const entry = digest("post-json");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ fixture: "post-json" });
    assertDigestMatch("post-json", entry.sha256, hashBuffer(response.body));
  });

  it("sends Cache-Control no-store", async () => {
    const response = await readHttp(server.port, "/fixtures/no-store");
    const entry = digest("no-store");
    expect(response.headers["cache-control"]).toBe("no-store");
    assertDigestMatch("no-store", entry.sha256, hashBuffer(response.body));
  });

  it("serves video bytes that match the digest", async () => {
    const response = await readHttp(server.port, "/fixtures/video");
    const entry = digest("video");
    expect(response.headers["content-type"]).toBe("video/mp4");
    assertDigestMatch("video", entry.sha256, hashBuffer(response.body));
  });

  it("fails when the expected digest does not match the bytes on the wire", async () => {
    const response = await readHttp(server.port, "/fixtures/no-store");
    const observed = hashBuffer(response.body);
    const wrong = observed.startsWith("0") ? `1${observed.slice(1)}` : `0${observed.slice(1)}`;
    expect(wrong).not.toBe(observed);
    expect(() => assertDigestMatch("no-store", wrong, observed)).toThrow(
      /digest mismatch for no-store/,
    );
  });

  it("echoes a websocket payload", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}${WEBSOCKET_PATH}`);
    const text = await new Promise<string>((resolve, reject) => {
      socket.addEventListener("open", () => socket.send("echo-me"));
      socket.addEventListener("message", (event) => resolve(String(event.data)));
      socket.addEventListener("error", () => reject(new Error("websocket failed")));
    });
    expect(text).toBe("echo-me");
    const binary = Uint8Array.from([1, 2, 3, 255]);
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      socket.binaryType = "arraybuffer";
      socket.addEventListener("message", (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) resolve(Buffer.from(new Uint8Array(data)));
        else resolve(Buffer.from(String(data)));
      });
      socket.addEventListener("error", () => reject(new Error("websocket failed")));
      socket.send(binary);
    });
    expect(Buffer.compare(echoed, Buffer.from(binary))).toBe(0);
    socket.close();
  });

  it("accepts a hand-built HAR of the bytes received over HTTP", async () => {
    const response = await readHttp(server.port, "/fixtures/no-store");
    const sha = hashBuffer(response.body);
    assertDigestMatch("no-store", digest("no-store").sha256, sha);
    const expected = [{ id: "no-store", method: "GET", path: "/fixtures/no-store", sha256: sha }];
    const passed = checkBodies(parseHarEntries(harDocument(response.body)), expected);
    expect(passed.ok).toBe(true);
    expect(passed.entryCount).toBe(1);
    expect(formatHarCheck(passed)).toBe("har-check passed, entry count 1");

    const flipped = Buffer.from(response.body);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const mismatched = checkBodies(parseHarEntries(harDocument(flipped)), expected);
    expect(mismatched.ok).toBe(false);
    expect(mismatched.problems.map((problem) => problem.kind)).toEqual(["mismatched"]);

    const missing = checkBodies([], expected);
    expect(missing.problems).toEqual([{ kind: "missing", id: "no-store" }]);
    expect(formatHarCheck(missing)).toContain("missing no-store");
  });

  it("serves a page that references 200 small resources with matching digests", async () => {
    const page = await readHttp(server.port, "/");
    expect(page.headers["content-type"]).toContain("text/html");
    const urls = page.body.toString("utf8").match(/\/r\/(?:css|js|image|json)\/\d+/gu);
    expect(urls?.length).toBe(expectedResourceCount());
    for (const kind of ["css", "js", "image", "json"]) {
      for (let index = 0; index < 50; index += 1) {
        const id = `r-${kind}-${String(index)}`;
        const response = await readHttp(server.port, `/r/${kind}/${String(index)}`);
        expect(response.status).toBe(200);
        assertDigestMatch(id, digest(id).sha256, hashBuffer(response.body));
      }
    }
  });
});

function harDocument(body: Buffer): unknown {
  return {
    log: {
      version: "1.2",
      entries: [
        {
          request: { method: "GET", url: "http://127.0.0.1/fixtures/no-store" },
          response: {
            content: {
              mimeType: "text/plain",
              text: body.toString("base64"),
              encoding: "base64",
            },
          },
        },
      ],
    },
  };
}

function digest(id: string): DigestEntry {
  const entry = digests.get(id);
  if (entry === undefined) throw new Error(`missing digest ${id}`);
  return entry;
}

function hashBuffer(bytes: Buffer): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function readHttp(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function readRaw(
  port: number,
  path: string,
): Promise<{ status: number; headerText: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const splitAt = raw.indexOf("\r\n\r\n");
      if (splitAt === -1) {
        reject(new Error("response headers did not end"));
        return;
      }
      const headerText = raw.toString("latin1", 0, splitAt);
      const status = Number(/^HTTP\/1\.[01] (\d+)/u.exec(headerText)?.[1]);
      resolve({ status, headerText, body: raw.subarray(splitAt + 4) });
    });
  });
}

function decodeChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) throw new Error("chunk size line missing");
    const size = Number.parseInt(body.toString("ascii", offset, lineEnd).split(";")[0] ?? "", 16);
    if (!Number.isInteger(size)) throw new Error("bad chunk size");
    offset = lineEnd + 2;
    if (size === 0) break;
    parts.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(parts);
}
