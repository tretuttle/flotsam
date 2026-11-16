import * as NodeCrypto from "node:crypto";

export const FIXTURE_SEED = "har-anytime-zen-harness-v1";
export const WEBSOCKET_PATH = "/fixtures/websocket";
export const SMALL_PER_KIND = 50;
export const SMALL_KINDS = ["css", "js", "image", "json"] as const;
export const BINARY_BYTE_LENGTH = 50_000_000;
export const GZIP_BYTE_LENGTH = 20_000_000;

export type SmallKind = (typeof SMALL_KINDS)[number];
export type FixtureMethod = "GET" | "POST";
export type TransferMode = "identity" | "chunked" | "gzip" | "range";

type BodySpec =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "prng"; readonly byteLength: number; readonly prefix: Uint8Array | null };

export type Fixture = {
  readonly id: string;
  readonly method: FixtureMethod;
  readonly path: string;
  readonly contentType: string;
  readonly cacheControl: string | null;
  readonly transfer: TransferMode;
  readonly body: BodySpec;
};

export type DigestEntry = {
  readonly id: string;
  readonly sha256: string;
  readonly byteLength: number;
};

const NO_STORE = "no-store";

const VIDEO_PREFIX = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x61, 0x76, 0x63, 0x31,
]);

const SMALL_CONTENT_TYPE: Record<SmallKind, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  image: "image/svg+xml",
  json: "application/json",
};

export function listFixtures(): readonly Fixture[] {
  return [...fixedFixtures(), pageFixture(), ...smallFixtures()];
}

export function buildBody(fixture: Fixture): Buffer {
  if (fixture.body.kind === "text") return Buffer.from(fixture.body.text, "utf8");
  const buffer = Buffer.allocUnsafe(fixture.body.byteLength);
  const prefix = fixture.body.prefix;
  if (prefix !== null) {
    if (prefix.byteLength > buffer.length) {
      throw new Error(`prefix longer than body for ${fixture.id}`);
    }
    Buffer.from(prefix).copy(buffer);
  }
  fillPrng(buffer, prefix?.byteLength ?? 0, prngKey(fixture.id));
  return buffer;
}

export function buildDigestTable(
  fixtures: readonly Fixture[] = listFixtures(),
): readonly DigestEntry[] {
  return fixtures.map((fixture) => {
    const bytes = buildBody(fixture);
    return { id: fixture.id, sha256: sha256Hex(bytes), byteLength: bytes.length };
  });
}

export function assertDigestMatch(id: string, expected: string, observed: string): void {
  if (expected !== observed) {
    throw new Error(`digest mismatch for ${id}: expected ${expected}, observed ${observed}`);
  }
}

export function expectedResourceCount(): number {
  return SMALL_KINDS.length * SMALL_PER_KIND;
}

export function smallResourcePaths(): readonly string[] {
  const paths: string[] = [];
  for (const kind of SMALL_KINDS) {
    for (let index = 0; index < SMALL_PER_KIND; index += 1) {
      paths.push(`/r/${kind}/${String(index)}`);
    }
  }
  return paths;
}

function fixedFixtures(): readonly Fixture[] {
  return [
    {
      id: "binary",
      method: "GET",
      path: "/fixtures/binary",
      contentType: "application/octet-stream",
      cacheControl: NO_STORE,
      transfer: "identity",
      body: { kind: "prng", byteLength: BINARY_BYTE_LENGTH, prefix: null },
    },
    {
      id: "chunked",
      method: "GET",
      path: "/fixtures/chunked",
      contentType: "application/octet-stream",
      cacheControl: NO_STORE,
      transfer: "chunked",
      body: { kind: "prng", byteLength: BINARY_BYTE_LENGTH, prefix: null },
    },
    {
      id: "gzip",
      method: "GET",
      path: "/fixtures/gzip",
      contentType: "application/octet-stream",
      cacheControl: NO_STORE,
      transfer: "gzip",
      body: { kind: "prng", byteLength: GZIP_BYTE_LENGTH, prefix: null },
    },
    {
      id: "video",
      method: "GET",
      path: "/fixtures/video",
      contentType: "video/mp4",
      cacheControl: NO_STORE,
      transfer: "identity",
      body: { kind: "prng", byteLength: 65_536, prefix: VIDEO_PREFIX },
    },
    {
      id: "range",
      method: "GET",
      path: "/fixtures/range",
      contentType: "application/octet-stream",
      cacheControl: NO_STORE,
      transfer: "range",
      body: { kind: "prng", byteLength: 65_536, prefix: null },
    },
    {
      id: "post-json",
      method: "POST",
      path: "/fixtures/post",
      contentType: "application/json",
      cacheControl: NO_STORE,
      transfer: "identity",
      body: {
        kind: "text",
        text: `${JSON.stringify({ fixture: "post-json", seed: FIXTURE_SEED })}\n`,
      },
    },
    {
      id: "no-store",
      method: "GET",
      path: "/fixtures/no-store",
      contentType: "text/plain; charset=utf-8",
      cacheControl: NO_STORE,
      transfer: "identity",
      body: { kind: "text", text: `no-store ${FIXTURE_SEED}\n` },
    },
  ];
}

function pageFixture(): Fixture {
  return {
    id: "page",
    method: "GET",
    path: "/",
    contentType: "text/html; charset=utf-8",
    cacheControl: NO_STORE,
    transfer: "identity",
    body: { kind: "text", text: pageHtml() },
  };
}

function smallFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const kind of SMALL_KINDS) {
    for (let index = 0; index < SMALL_PER_KIND; index += 1) {
      fixtures.push({
        id: `r-${kind}-${String(index)}`,
        method: "GET",
        path: `/r/${kind}/${String(index)}`,
        contentType: SMALL_CONTENT_TYPE[kind],
        cacheControl: NO_STORE,
        transfer: "identity",
        body: { kind: "text", text: smallText(kind, index) },
      });
    }
  }
  return fixtures;
}

function pageHtml(): string {
  const tags: string[] = ['<link rel="icon" href="data:,">'];
  const jsonPaths: string[] = [];
  for (let index = 0; index < SMALL_PER_KIND; index += 1) {
    const name = String(index);
    tags.push(`<link rel="stylesheet" href="/r/css/${name}">`);
    tags.push(`<script src="/r/js/${name}"></script>`);
    tags.push(`<img src="/r/image/${name}" alt="">`);
    jsonPaths.push(`/r/json/${name}`);
  }
  const script = [
    "window.__zenReady = (async () => {",
    `  const jsonPaths = ${JSON.stringify(jsonPaths)};`,
    "  const jsonMissing = [];",
    "  let jsonOk = 0;",
    "  await Promise.all(jsonPaths.map(async (path) => {",
    "    try {",
    "      const response = await fetch(path);",
    "      if (!response.ok) jsonMissing.push(path);",
    "      else jsonOk += 1;",
    "      await response.arrayBuffer();",
    "    } catch {",
    "      jsonMissing.push(path);",
    "    }",
    "  }));",
    '  if (document.readyState !== "complete") {',
    '    await new Promise((resolve) => addEventListener("load", () => resolve(), { once: true }));',
    "  }",
    "  const cssMissing = [];",
    "  let cssOk = 0;",
    "  for (const link of document.querySelectorAll('link[rel=\"stylesheet\"]')) {",
    "    const path = new URL(link.href).pathname;",
    "    if (link.sheet === null) cssMissing.push(path);",
    "    else cssOk += 1;",
    "  }",
    "  const imageMissing = [];",
    "  let imageOk = 0;",
    "  await Promise.all([...document.images].map(async (image) => {",
    "    const path = new URL(image.currentSrc || image.src).pathname;",
    "    try {",
    "      await image.decode();",
    "      imageOk += 1;",
    "    } catch {",
    "      imageMissing.push(path);",
    "    }",
    "  }));",
    "  const jsOk = globalThis.__zenResources ?? 0;",
    "  const missing = cssMissing.concat(imageMissing, jsonMissing);",
    `  if (jsOk !== ${String(SMALL_PER_KIND)}) missing.push("js-executed:" + String(jsOk));`,
    '  const navigation = performance.getEntriesByType("navigation")[0];',
    "  return JSON.stringify({",
    "    loadTimeMs: navigation.loadEventEnd - navigation.startTime,",
    "    resourceCount: cssOk + jsOk + imageOk + jsonOk,",
    "    missing: missing,",
    "  });",
    "})();",
  ].join("");
  return `<!doctype html><html><head><meta charset="utf-8">${tags.join("")}</head><body><script>${script}</script></body></html>`;
}

function smallText(kind: SmallKind, index: number): string {
  const name = String(index);
  if (kind === "css") return `.r-${name}{color:#010101}\n`;
  if (kind === "js") return `globalThis.__zenResources=(globalThis.__zenResources??0)+1;\n`;
  if (kind === "image") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#${name.padStart(6, "0")}"/></svg>`;
  }
  return `${JSON.stringify({ index, seed: FIXTURE_SEED })}\n`;
}

function prngKey(id: string): string {
  return `${FIXTURE_SEED}\0${id}`;
}

function sha256Hex(bytes: Buffer): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function fillPrng(buffer: Buffer, offset: number, key: string): void {
  let state = NodeCrypto.createHash("sha256").update(key).digest().readUInt32LE(0);
  let cursor = offset;
  while (cursor + 4 <= buffer.length) {
    const step = advance(state);
    state = step.state;
    buffer.writeUInt32LE(step.value, cursor);
    cursor += 4;
  }
  if (cursor < buffer.length) {
    const step = advance(state);
    const tail = Buffer.allocUnsafe(4);
    tail.writeUInt32LE(step.value, 0);
    tail.copy(buffer, cursor, 0, buffer.length - cursor);
  }
}

function advance(state: number): { state: number; value: number } {
  const next = (state + 0x9e3779b9) >>> 0;
  let value = next;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return { state: next, value };
}
