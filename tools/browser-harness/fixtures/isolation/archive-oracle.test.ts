import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  judgeArchive,
  keyDerivations,
  type ArchiveEvidence,
  type KeySources,
  type WrittenEntry,
} from "./archive-oracle.ts";

const sources = (profileDir: string): KeySources => ({
  profileDir,
  userName: "trent",
  hostName: "omarchy",
  dataHome: "/home/trent/.local/share",
  addonId: "one-click-har@tretuttle.github.io",
  addonUuid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
});

const randomKey = (): string => NodeCrypto.randomBytes(16).toString("hex");
const sha = (hash: string, text: string): string =>
  NodeCrypto.createHash(hash).update(text).digest("hex");

const archive = (key: string): WrittenEntry[] => [
  { path: ".", kind: "directory" },
  { path: key, kind: "directory" },
  { path: `${key}/settings.json`, kind: "file" },
  { path: `${key}/sites`, kind: "directory" },
  { path: `${key}/sites/bank.example`, kind: "directory" },
  { path: `${key}/sites/bank.example/bodies`, kind: "directory" },
  { path: `${key}/sites/bank.example/bodies/r1.7.body`, kind: "file" },
  { path: `${key}/sites/bank.example/log`, kind: "directory" },
  { path: `${key}/sites/bank.example/log/r1-0.jsonl`, kind: "file" },
];

function evidence(
  first: string,
  second: string | null,
  change: Partial<ArchiveEvidence> = {},
): ArchiveEvidence {
  return {
    keyFileText: `${first}\n`,
    keyFileMode: 0o600,
    appFolderNames: [first],
    sources: sources("/home/trent/.mozilla/abc.default"),
    second:
      second === null
        ? { missing: "no key file after 20000 ms" }
        : { keyFileText: `${second}\n`, sources: sources("/home/trent/.mozilla/xyz.default") },
    planned: archive(first),
    final: archive(first),
    ...change,
  };
}

const failed = (e: ArchiveEvidence): readonly string[] =>
  judgeArchive(e)
    .filter((c) => !c.ok)
    .map((c) => c.id);

describe("archive key oracle", () => {
  it("guesses keys derived from the profile path, user, host and add-on uuid", () => {
    const guesses = new Set(keyDerivations(sources("/p/abc.default")).map((g) => g.key));
    expect(guesses.has(sha("sha256", "/p/abc.default").slice(0, 32))).toBe(true);
    expect(guesses.has(sha("sha256", "abc.default").slice(-32))).toBe(true);
    expect(guesses.has(sha("md5", "trent"))).toBe(true);
    expect(guesses.has(sha("sha1", "omarchy").slice(0, 32))).toBe(true);
    expect(guesses.has("0f1e2d3c4b5a69788796a5b4c3d2e1f0")).toBe(true);
    expect(guesses.has(randomKey())).toBe(false);
  });

  it("passes two random keys that name their archive folder", () => {
    expect(failed(evidence(randomKey(), randomKey()))).toEqual([]);
  });

  it("fails a constant key, whatever the constant, because two fresh profiles share it", () => {
    for (const constant of ["f".repeat(32), "5a".repeat(16), "0123456789abcdef".repeat(2)]) {
      expect(failed(evidence(constant, constant))).toEqual(["key-differs-across-profiles"]);
    }
  });

  it("fails a key derived from the profile path, even when each profile gets its own", () => {
    const first = sha("sha256", "/home/trent/.mozilla/abc.default").slice(0, 32);
    const second = sha("sha256", "/home/trent/.mozilla/xyz.default").slice(0, 32);
    expect(failed(evidence(first, second))).toEqual(["key-not-derived"]);
    const fromName = sha("md5", "abc.default");
    expect(failed(evidence(fromName, randomKey()))).toEqual(["key-not-derived"]);
  });

  it("fails without a second key, a wrong mode, a malformed key file or a folder the key does not name", () => {
    const key = randomKey();
    expect(failed(evidence(key, null))).toEqual(["key-differs-across-profiles", "key-not-derived"]);
    expect(failed(evidence(key, randomKey(), { keyFileMode: 0o644 }))).toEqual(["key-file-mode"]);
    expect(failed(evidence(key, randomKey(), { keyFileText: `${key.toUpperCase()}\n` }))).toContain(
      "key-file-format",
    );
    expect(failed(evidence(key, randomKey(), { appFolderNames: [randomKey()] }))).toEqual([
      "key-names-the-archive",
    ]);
  });
});

describe("written paths", () => {
  it("fails any path outside the key folder, planned or written later", () => {
    const key = randomKey();
    const outside = [...archive(key), { path: "sites", kind: "directory" as const }];
    expect(
      failed(
        evidence(key, randomKey(), {
          planned: outside,
          final: outside,
          appFolderNames: [key, "sites"],
        }),
      ),
    ).toEqual(["key-names-the-archive", "nothing-outside-key-folder"]);
    const late = [...archive(key), { path: "recent-sites.txt", kind: "file" as const }];
    expect(failed(evidence(key, randomKey(), { final: late }))).toEqual([
      "nothing-outside-key-folder",
      "written-paths-targeted",
    ]);
  });

  it("covers later writes of a kind already probed inside the key folder, and fails a new kind", () => {
    const key = randomKey();
    const traffic = [
      ...archive(key),
      { path: `${key}/sites/bank.example/bodies/r1.9.body`, kind: "file" as const },
      { path: `${key}/sites/attacker.example`, kind: "directory" as const },
    ];
    expect(failed(evidence(key, randomKey(), { final: traffic }))).toEqual([]);
    const newKind = [
      ...archive(key),
      { path: `${key}/sites/bank.example/index.sqlite`, kind: "file" as const },
    ];
    expect(failed(evidence(key, randomKey(), { final: newKind }))).toEqual([
      "written-paths-targeted",
    ]);
  });
});
