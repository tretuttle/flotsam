import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { buildDigestTable, listFixtures, type Fixture } from "./fixtures.ts";

export type ExpectedBody = {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly sha256: string;
};

export type HarEntryBytes = {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly bytes: Buffer;
};

export type HarProblem =
  | { readonly kind: "missing"; readonly id: string }
  | {
      readonly kind: "mismatched";
      readonly id: string;
      readonly expected: string;
      readonly observed: string;
    }
  | { readonly kind: "unexpected"; readonly method: string; readonly url: string };

export type HarCheckResult = {
  readonly ok: boolean;
  readonly entryCount: number;
  readonly expectedCount: number;
  readonly problems: readonly HarProblem[];
};

export function expectedBodies(
  fixtures: readonly Fixture[] = listFixtures(),
  digests: ReadonlyMap<string, string> = digestMap(fixtures),
): readonly ExpectedBody[] {
  return fixtures.map((fixture) => {
    const sha256 = digests.get(fixture.id);
    if (sha256 === undefined) throw new Error(`missing digest for ${fixture.id}`);
    return { id: fixture.id, method: fixture.method, path: fixture.path, sha256 };
  });
}

export function parseHarEntries(value: unknown): readonly HarEntryBytes[] {
  if (!isRecord(value) || !isRecord(value.log) || !Array.isArray(value.log.entries)) {
    throw new Error("HAR is missing log.entries");
  }
  return value.log.entries.map((entry) => parseEntry(entry));
}

export function checkBodies(
  entries: readonly HarEntryBytes[],
  expected: readonly ExpectedBody[],
): HarCheckResult {
  const problems: HarProblem[] = [];
  const used = new Set<number>();
  for (const item of expected) {
    const index = entries.findIndex(
      (entry, entryIndex) =>
        !used.has(entryIndex) && entry.method === item.method && entry.path === item.path,
    );
    if (index === -1) {
      problems.push({ kind: "missing", id: item.id });
      continue;
    }
    used.add(index);
    const entry = entries[index];
    if (entry === undefined) throw new Error(`missing HAR entry ${String(index)}`);
    const observed = sha256Hex(entry.bytes);
    if (observed !== item.sha256) {
      problems.push({ kind: "mismatched", id: item.id, expected: item.sha256, observed });
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (used.has(index)) continue;
    const entry = entries[index];
    if (entry === undefined) continue;
    problems.push({ kind: "unexpected", method: entry.method, url: entry.url });
  }
  return {
    ok: problems.length === 0,
    entryCount: entries.length,
    expectedCount: expected.length,
    problems,
  };
}

export async function checkHarFile(
  file: string,
  expected: readonly ExpectedBody[],
): Promise<HarCheckResult> {
  const text = await NodeFSP.readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`HAR is not JSON: ${file}`);
  }
  return checkBodies(parseHarEntries(parsed), expected);
}

export function formatHarCheck(result: HarCheckResult): string {
  if (result.ok) return `har-check passed, entry count ${String(result.entryCount)}`;
  const lines = [
    `har-check failed, entry count ${String(result.entryCount)}, expected ${String(result.expectedCount)}`,
  ];
  for (const problem of result.problems) {
    if (problem.kind === "missing") lines.push(`missing ${problem.id}`);
    else if (problem.kind === "mismatched") {
      lines.push(
        `mismatched ${problem.id} expected ${problem.expected} observed ${problem.observed}`,
      );
    } else lines.push(`unexpected ${problem.method} ${problem.url}`);
  }
  return lines.join("\n");
}

function digestMap(fixtures: readonly Fixture[]): Map<string, string> {
  return new Map(buildDigestTable(fixtures).map((entry) => [entry.id, entry.sha256]));
}

function parseEntry(value: unknown): HarEntryBytes {
  if (!isRecord(value) || !isRecord(value.request))
    throw new Error("HAR entry is missing a request");
  const method = value.request.method;
  const url = value.request.url;
  if (typeof method !== "string" || method.length === 0) {
    throw new Error("HAR entry is missing a request method");
  }
  if (typeof url !== "string" || url.length === 0)
    throw new Error("HAR entry is missing a request url");
  const response = isRecord(value.response) ? value.response : {};
  return {
    method: method.toUpperCase(),
    url,
    path: pathname(url),
    bytes: contentBytes(response.content),
  };
}

function pathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function contentBytes(content: unknown): Buffer {
  if (!isRecord(content) || typeof content.text !== "string") return Buffer.alloc(0);
  if (content.encoding === "base64") return Buffer.from(content.text, "base64");
  return Buffer.from(content.text, "utf8");
}

function sha256Hex(bytes: Buffer): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
