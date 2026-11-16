import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { classifyEntryBodyState } from "@one-click-har/har/summarize";
import { describe, expect, it } from "vite-plus/test";
import {
  encodeChunk,
  encodeTextChunk,
  entryExtension,
  entryHead,
  entryTail,
  finishEncoder,
  startEncoder,
  textModeFor,
  type BodyEnd,
} from "../src/entry-writer.ts";
import { makeHarEntry } from "./fixtures.ts";
import { importMutated } from "./mutate.ts";

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function splitRandomChunks(bytes: Uint8Array, next: () => number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const remaining = bytes.length - pos;
    const size = Math.floor(next() * Math.min(remaining + 1, 7));
    chunks.push(bytes.subarray(pos, pos + size));
    pos += size;
  }
  if (next() < 0.3) chunks.push(new Uint8Array(0));
  return chunks;
}

describe("textModeFor", () => {
  it.each([
    ["text/html", null, "utf8-text"],
    ["text/plain; charset=utf-8", null, "utf8-text"],
    ["text/plain; charset=iso-8859-1", null, "base64"],
    ["text/html", "windows-1252", "base64"],
    ["application/json", null, "utf8-text"],
    ["application/problem+json", "UTF-8", "utf8-text"],
    ["application/xml", null, "utf8-text"],
    ["image/svg+xml", null, "utf8-text"],
    ["application/javascript", null, "utf8-text"],
    ["image/png", null, "base64"],
    ["application/octet-stream", null, "base64"],
    [null, null, "base64"],
  ] as const)("textModeFor(%j, %j) -> %s", (mime, charset, want) => {
    expect(textModeFor(mime, charset)).toBe(want);
  });
});

describe("entry-writer streaming property and round-trip tests", () => {
  it("property test (10,000 cases): random chunk splits equal JSON.stringify of the whole entry", () => {
    const seed = 20261116;
    console.log(`entry-writer property seed: ${String(seed)}`);
    const rand = xorshift32(seed);
    const validTextDecoder = new TextDecoder("utf-8", { fatal: false });
    const baseEntry = makeHarEntry({ mimeType: "text/plain" });

    for (let c = 0; c < 10_000; c += 1) {
      const mode = rand() < 0.5 ? "utf8-text" : "base64";
      const len = Math.floor(rand() * 48);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        const roll = rand();
        if (roll < 0.25) {
          // Control characters, quotes, backslashes, ASCII
          bytes[i] = Math.floor(rand() * 128);
        } else if (roll < 0.65) {
          // Valid multi-byte UTF-8 prefixes and continuations
          bytes[i] = 0xc0 + Math.floor(rand() * 0x38);
        } else {
          bytes[i] = Math.floor(rand() * 256);
        }
      }

      const chunks = splitRandomChunks(bytes, rand);
      let state = startEncoder(mode);
      let streamedBodyJson = "";
      for (const chunk of chunks) {
        const step = encodeChunk(state, chunk);
        state = step.state;
        streamedBodyJson += step.json;
      }
      const fin = finishEncoder(state);
      state = fin.state;
      streamedBodyJson += fin.json;

      const end: BodyEnd = {
        kind: "complete",
        encoder: state,
        wireBytes: bytes.length,
        check: "length-matched",
        from: "stored",
      };
      const ext = entryExtension(end, "both", false);
      const bodySegment =
        mode === "base64"
          ? `,"encoding":"base64","text":"${streamedBodyJson}"`
          : `,"text":"${streamedBodyJson}"`;
      const streamedEntryJson = `${entryHead(baseEntry)}${bodySegment}${entryTail(end, ext)}`;

      const expectedText =
        mode === "base64" ? Buffer.from(bytes).toString("base64") : validTextDecoder.decode(bytes);
      const { response: baseResponse, ...entryRest } = baseEntry;
      const { content: baseContent, ...responseRest } = baseResponse;
      const wholeEntry = {
        ...entryRest,
        response: {
          ...responseRest,
          content: {
            mimeType: baseContent.mimeType,
            ...(mode === "base64" ? { encoding: "base64" } : {}),
            text: expectedText,
            size: bytes.length,
          },
        },
        _harExport: ext,
      };

      expect(streamedEntryJson, `case ${String(c)} (${mode})`).toBe(JSON.stringify(wholeEntry));
      expect(state.bytes).toBe(bytes.length);
    }
  });

  it("round-trips base64 and utf8-text encodings byte-exact against SHA-256", () => {
    const binaryPayload = NodeCrypto.randomBytes(65_537);
    const binaryHash = sha256(binaryPayload);
    let bState = startEncoder("base64");
    let b64 = "";
    for (let i = 0; i < binaryPayload.length; i += 777) {
      const step = encodeChunk(bState, binaryPayload.subarray(i, i + 777));
      bState = step.state;
      b64 += step.json;
    }
    b64 += finishEncoder(bState).json;
    const decodedBinary = new Uint8Array(Buffer.from(b64, "base64"));
    expect(sha256(decodedBinary)).toBe(binaryHash);

    const textString = 'Hello, "world"!\nLine2\t\\slash 🚀 café 日本語 €\uD83D\uDE80';
    const textBytes = new TextEncoder().encode(textString);
    const textHash = sha256(textBytes);
    let tState = startEncoder("utf8-text");
    let tJson = "";
    for (let i = 0; i < textBytes.length; i += 3) {
      const step = encodeChunk(tState, textBytes.subarray(i, i + 3));
      tState = step.state;
      tJson += step.json;
    }
    tJson += finishEncoder(tState).json;
    const parsedText = JSON.parse(`"${tJson}"`) as string;
    expect(sha256(new TextEncoder().encode(parsedText))).toBe(textHash);
  });

  it("writes decoded length in content.size and compression delta for a gzip body", () => {
    const decoded = new TextEncoder().encode('{"items":[' + '"x",'.repeat(500) + '"end"]}');
    const gz = NodeZlib.gzipSync(decoded);
    expect(gz.length).toBeLessThan(decoded.length);

    const ungz = NodeZlib.gunzipSync(gz);
    let state = startEncoder("utf8-text");
    const step = encodeChunk(state, ungz);
    state = finishEncoder(step.state).state;

    const end: BodyEnd = {
      kind: "complete",
      encoder: state,
      wireBytes: gz.length,
      check: "length-matched",
      from: "stored",
    };
    const ext = entryExtension(end, "recording-only", false);
    const entry = makeHarEntry({ mimeType: "application/json", bodySize: gz.length });
    const parsed = JSON.parse(
      `${entryHead(entry)},"text":"${step.json}"${entryTail(end, ext)}`,
    ) as {
      response: { bodySize: number; content: { size: number; compression: number; text: string } };
    };
    expect(parsed.response.bodySize).toBe(gz.length);
    expect(parsed.response.content.size).toBe(decoded.length);
    expect(parsed.response.content.compression).toBe(decoded.length - gz.length);
    expect(sha256(new TextEncoder().encode(parsed.response.content.text))).toBe(sha256(decoded));
  });

  it("marks cut-short bodies as incomplete and counts lossy UTF-8 replacements", () => {
    const invalid = new Uint8Array([0x41, 0xff, 0xfe, 0x42]);
    let state = startEncoder("utf8-text");
    const s1 = encodeChunk(state, invalid.subarray(0, 2));
    const s2 = encodeChunk(s1.state, invalid.subarray(2));
    const fin = finishEncoder(s2.state);
    state = fin.state;
    expect(state.replaced).toBe(2);

    const end: BodyEnd = { kind: "cut-short", encoder: state, reason: "source-error" };
    const ext = entryExtension(end, "recording-only", false);
    expect(ext.bodyIncomplete).toBe(true);
    expect(ext.bodyState).toBe("unavailable");
    expect(ext.lossyText).toBe(2);

    const parsed = JSON.parse(
      `${entryHead(makeHarEntry())},"text":"${s1.json}${s2.json}${fin.json}"${entryTail(end, ext)}`,
    ) as Parameters<typeof classifyEntryBodyState>[0];
    expect(classifyEntryBodyState(parsed)).toEqual({ state: "incomplete", reason: "unavailable" });
  });

  it("handles encodeTextChunk for both utf8-text and base64 DevTools slices", () => {
    let txt = startEncoder("utf8-text");
    const a = encodeTextChunk(txt, 'a"b');
    const b = encodeTextChunk(a.state, "€");
    txt = b.state;
    expect(a.json + b.json).toBe('a\\"b€');
    expect(txt.bytes).toBe(6);

    let b64 = startEncoder("base64");
    const c1 = encodeTextChunk(b64, "AQI");
    const c2 = encodeTextChunk(c1.state, "DBA==");
    b64 = c2.state;
    expect(b64.bytes).toBe(4);
  });

  it("planted: wrong content.size (wireBytes), missing bodyIncomplete, or base64 textModeFor regression fails tests", async () => {
    const wireSizeBug = await importMutated<{ entryTail: typeof entryTail }>("entry-writer.ts", {
      id: "content-size-uses-wire-bytes",
      from: '    case "complete":\n      size = end.encoder.bytes;',
      to: '    case "complete":\n      size = end.wireBytes;',
    });
    let state = startEncoder("utf8-text");
    state = encodeChunk(state, new Uint8Array(1000)).state;
    const end: BodyEnd = {
      kind: "complete",
      encoder: state,
      wireBytes: 250,
      check: "length-matched",
      from: "stored",
    };
    const tail = wireSizeBug.entryTail(end, entryExtension(end, "recording-only", false));
    expect(tail).not.toContain('"size":1000');

    const missingIncomplete = await importMutated<{ entryExtension: typeof entryExtension }>(
      "entry-writer.ts",
      {
        id: "cut-short-marked-present",
        from: '        bodyState: "unavailable",\n        bodyMissing: end.reason,\n        bodyIncomplete: true,',
        to: '        bodyState: "present",\n        bodyMissing: end.reason,',
      },
    );
    const badExt = missingIncomplete.entryExtension(
      { kind: "cut-short", encoder: state, reason: "source-error" },
      "recording-only",
      false,
    );
    expect(badExt.bodyIncomplete).not.toBe(true);

    const latin1AsText = await importMutated<{ textModeFor: typeof textModeFor }>(
      "entry-writer.ts",
      {
        id: "latin1-treated-as-utf8",
        from: '  if (!isUtf8OrAbsent(effectiveCharset)) return "base64";',
        to: "",
      },
    );
    expect(latin1AsText.textModeFor("text/plain; charset=iso-8859-1", null)).toBe("utf8-text");
  });
});
