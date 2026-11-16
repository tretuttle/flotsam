import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  checkBodies,
  checkHarFile,
  formatHarCheck,
  parseHarEntries,
  type ExpectedBody,
} from "./har.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("har-check", () => {
  it("passes a hand-built HAR and names a flipped byte and a missing entry", async () => {
    const alpha = Buffer.from("alpha body\n");
    const beta = Buffer.from("beta body\n");
    const expected = [body("alpha", "/a", alpha), body("beta", "/b", beta)];
    const passed = checkBodies(
      parseHarEntries(
        document([
          entry("GET", "http://127.0.0.1/a", alpha, "base64"),
          entry("GET", "http://127.0.0.1/b", beta, "text"),
        ]),
      ),
      expected,
    );
    expect(passed.ok).toBe(true);
    expect(passed.entryCount).toBe(2);
    expect(passed.expectedCount).toBe(2);
    expect(formatHarCheck(passed)).toBe("har-check passed, entry count 2");

    const flipped = Buffer.from(alpha);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const mismatched = await checkFile(
      document([
        entry("GET", "http://127.0.0.1/a", flipped, "base64"),
        entry("GET", "http://127.0.0.1/b", beta, "text"),
      ]),
      expected,
    );
    expect(mismatched.ok).toBe(false);
    expect(mismatched.problems).toEqual([
      {
        kind: "mismatched",
        id: "alpha",
        expected: sha256(alpha),
        observed: sha256(flipped),
      },
    ]);
    expect(formatHarCheck(mismatched)).toContain("mismatched alpha");

    const missing = checkBodies(
      parseHarEntries(document([entry("GET", "http://127.0.0.1/b", beta, "text")])),
      expected,
    );
    expect(missing.ok).toBe(false);
    expect(missing.problems).toEqual([{ kind: "missing", id: "alpha" }]);
    expect(formatHarCheck(missing)).toContain("missing alpha");
    expect(missing.entryCount).toBe(1);
  });
});

function body(id: string, path: string, bytes: Buffer): ExpectedBody {
  return { id, method: "GET", path, sha256: sha256(bytes) };
}

function sha256(bytes: Buffer): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function document(entries: readonly unknown[]): unknown {
  return { log: { version: "1.2", entries } };
}

function entry(method: string, url: string, bytes: Buffer, encoding: "base64" | "text"): unknown {
  const content =
    encoding === "base64"
      ? { mimeType: "application/octet-stream", text: bytes.toString("base64"), encoding: "base64" }
      : { mimeType: "text/plain", text: bytes.toString("utf8") };
  return { request: { method, url }, response: { content } };
}

async function checkFile(value: unknown, expected: readonly ExpectedBody[]) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "har-anytime-har-"));
  directories.push(directory);
  const file = NodePath.join(directory, "capture.har");
  await NodeFSP.writeFile(file, JSON.stringify(value), "utf8");
  return checkHarFile(file, expected);
}
