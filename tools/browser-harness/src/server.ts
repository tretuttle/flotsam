import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";
import { buildBody, listFixtures, WEBSOCKET_PATH, type Fixture } from "./fixtures.ts";

const CHUNK_BYTES = 64 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type FixtureServer = {
  readonly origin: string;
  readonly port: number;
  readonly requestCount: () => number;
  readonly requestPaths: () => readonly string[];
  readonly resetRequestCount: () => void;
  readonly close: () => Promise<void>;
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, Fixture>();
  for (const fixture of listFixtures()) {
    routes.set(routeKey(fixture.method, fixture.path), fixture);
  }
  let requests = 0;
  let paths: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    requests += 1;
    paths.push(request.url?.split("?")[0] ?? "/");
    void handle(routes, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on("upgrade", (request, socket, head) => {
    acceptWebSocket(request, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    requestCount: () => requests,
    requestPaths: () => paths.slice(),
    resetRequestCount: () => {
      requests = 0;
      paths = [];
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(
  routes: ReadonlyMap<string, Fixture>,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const path = request.url?.split("?")[0] ?? "/";
  await drainRequest(request);
  const fixture = routes.get(routeKey(method, path));
  if (fixture === undefined) {
    const otherMethod = method === "GET" ? "POST" : "GET";
    const status = routes.has(routeKey(otherMethod, path)) ? 405 : 404;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(status === 405 ? "method not allowed\n" : "not found\n");
    return;
  }
  const bytes = buildBody(fixture);
  const headers: Record<string, string> = { "content-type": fixture.contentType };
  if (fixture.cacheControl !== null) headers["cache-control"] = fixture.cacheControl;
  if (fixture.transfer === "chunked") {
    await writeChunked(response, headers, bytes);
    return;
  }
  if (fixture.transfer === "gzip") {
    const compressed = NodeZlib.gzipSync(bytes);
    response.writeHead(200, {
      ...headers,
      "content-encoding": "gzip",
      "content-length": String(compressed.length),
    });
    response.end(compressed);
    return;
  }
  if (fixture.transfer === "range") {
    writeRange(response, headers, bytes, request.headers.range);
    return;
  }
  response.writeHead(200, { ...headers, "content-length": String(bytes.length) });
  response.end(bytes);
}

async function writeChunked(
  response: NodeHttp.ServerResponse,
  headers: Record<string, string>,
  bytes: Buffer,
): Promise<void> {
  response.writeHead(200, headers);
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
    if (!response.write(chunk)) await waitForDrain(response);
  }
  response.end();
}

function waitForDrain(response: NodeHttp.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    response.once("drain", () => resolve());
  });
}

function writeRange(
  response: NodeHttp.ServerResponse,
  headers: Record<string, string>,
  bytes: Buffer,
  header: string | undefined,
): void {
  const range = header === undefined ? null : parseByteRange(header, bytes.length);
  if (header !== undefined && range === null) {
    response.writeHead(416, {
      ...headers,
      "content-range": `bytes */${String(bytes.length)}`,
    });
    response.end();
    return;
  }
  if (range === null) {
    response.writeHead(200, { ...headers, "content-length": String(bytes.length) });
    response.end(bytes);
    return;
  }
  const slice = bytes.subarray(range.start, range.end + 1);
  response.writeHead(206, {
    ...headers,
    "content-length": String(slice.length),
    "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(bytes.length)}`,
  });
  response.end(slice);
}

function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(header.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= size || start > end) return null;
  return { start, end: Math.min(end, size - 1) };
}

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

async function drainRequest(request: NodeHttp.IncomingMessage): Promise<void> {
  if (request.readableEnded) return;
  request.resume();
  await new Promise<void>((resolve, reject) => {
    request.on("end", () => resolve());
    request.on("error", reject);
  });
}

function acceptWebSocket(
  request: NodeHttp.IncomingMessage,
  socket: NodeStream.Duplex,
  head: Buffer,
): void {
  socket.on("error", () => undefined);
  const path = request.url?.split("?")[0] ?? "/";
  const key = request.headers["sec-websocket-key"];
  if (path !== WEBSOCKET_PATH || typeof key !== "string" || key.length === 0) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = NodeCrypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffer: Buffer<ArrayBufferLike> = Buffer.from(head);
  const consume = (): void => {
    while (true) {
      const parsed = readClientFrame(buffer);
      if (parsed === null) return;
      buffer = parsed.rest;
      if (parsed.opcode === 0x8) {
        socket.end(encodeServerFrame(0x8, Buffer.alloc(0)));
        return;
      }
      if (parsed.opcode === 0x9) {
        socket.write(encodeServerFrame(0xa, parsed.payload));
        continue;
      }
      if (parsed.opcode === 0x1 || parsed.opcode === 0x2) {
        socket.write(encodeServerFrame(parsed.opcode, parsed.payload));
      }
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    consume();
  });
  consume();
}

function readClientFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; rest: Buffer<ArrayBufferLike> } | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  if (first === undefined || second === undefined) return null;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const wide = buffer.readBigUInt64BE(2);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(wide);
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  const dataStart = offset + maskLength;
  const payload = Buffer.from(buffer.subarray(dataStart, dataStart + length));
  if (masked) {
    const mask = buffer.subarray(offset, dataStart);
    for (let index = 0; index < payload.length; index += 1) {
      const maskByte = mask[index % 4];
      const dataByte = payload[index];
      if (maskByte === undefined || dataByte === undefined) break;
      payload[index] = dataByte ^ maskByte;
    }
  }
  return { opcode, payload, rest: buffer.subarray(dataStart + length) };
}

function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const head =
    payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.alloc(4);
  if (payload.length >= 126) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([head, payload]);
}
