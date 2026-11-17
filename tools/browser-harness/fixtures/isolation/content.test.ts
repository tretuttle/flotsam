import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  contentDigest,
  contentText,
  orderFreeDigest,
  entriesBeyond,
  lz4Block,
  readStructured,
  withRoles,
  type Entries,
  type Group,
} from "./content.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-content-"));
  made.push(dir);
  return dir;
};

const NAMES = [
  ["/w1", "{workspace}"],
  ["U1", "{recorder-uuid}"],
] as const;

describe("content digests", () => {
  it("replaces each run's names by their roles before digesting, and nothing else", () => {
    expect(withRoles("/w1/profile U1 U2", NAMES)).toBe("{workspace}/profile {recorder-uuid} U2");
    expect(contentDigest(Buffer.from("path=/w1/x id=U1"), NAMES)).toBe(
      contentDigest(Buffer.from("path=/w2/x id=C1"), [
        ["/w2", "{workspace}"],
        ["C1", "{recorder-uuid}"],
      ]),
    );
    expect(contentDigest(Buffer.from("a"), [])).not.toBe(contentDigest(Buffer.from("b"), []));
  });
});

describe("order-free digests", () => {
  it("matches the same printable records in another order, and nothing added or changed", () => {
    const free = (text: string): string => orderFreeDigest(Buffer.from(text, "latin1"), NAMES);
    expect(free("\u0002glean#dirty\u0000\u0005os#Linux")).toBe(
      free("\u0005os#Linux\u0002glean#dirty\u0000"),
    );
    expect(free("\u0002glean#dirty\u0000\u0005os#Linux")).not.toBe(
      free("\u0002glean#dirty\u0000\u0005os#Linux leak"),
    );
    expect(free("glean#dirty")).not.toBe(free("glean#dirtx"));
    expect(free("lastModified=1794914675890 id=x")).toBe(free("lastModified=1794914999123 id=x"));
    expect(free("lastModified=17 id=x")).toBe(free("lastModified=1794914999123 id=x"));
    expect(free("ab\u0000\u0000")).not.toBe(free("ab\u0000"));
    expect(free("/w1/x path")).toBe(
      orderFreeDigest(Buffer.from("/w2/x path"), [["/w2", "{workspace}"]]),
    );
  });
});

describe("structured files", () => {
  it("reads a prefs file as one group per pref, its value digested with names replaced", () => {
    const text = 'user_pref("a.b", true);\nuser_pref("c\\"d", "/w1/x");\n// comment\n';
    const read = readStructured("prefs.js", Buffer.from(text), NAMES);
    expect(read?.format).toBe("prefs");
    expect(Object.keys(read?.entries ?? {})).toEqual(["pref a.b", 'pref c\\"d']);
    const again = readStructured("prefs.js", Buffer.from(text.replace("/w1", "/w9")), [
      ["/w9", "{workspace}"],
    ]);
    expect(again?.entries).toEqual(read?.entries);
    expect(readStructured("x", Buffer.from("plain text\n"), NAMES)).toBeNull();
  });

  it("reads a JSON array as a set, in the order of its items' content", () => {
    const read = (text: string) => readStructured("x.json", Buffer.from(text), NAMES)?.entries;
    const addons = (...ids: string[]) =>
      JSON.stringify({
        addons: ids.map((id, i) => ({ id, installDate: 1000 + i, tags: ["b", "a"] })),
      });
    expect(read(addons("z@x", "a@x", "m@x"))).toEqual(read(addons("a@x", "m@x", "z@x")));
    expect(read(addons("z@x", "a@x"))).not.toEqual(read(addons("z@x", "a@x", "leak@x")));
    expect(read('{"a":[{"k":"x","n":{"y":1,"x":[2,1]}}]}')).toEqual(
      read('{"a":[{"n":{"x":[9,8],"y":3},"k":"x"}]}'),
    );
    expect(Object.keys(read('{"a":["b","a",true,null]}') ?? {})).toEqual([
      "$.a[0]",
      "$.a[1]",
      "$.a[2]",
      "$.a[3]",
    ]);
    expect(read('{"a":["b","a"]}')).toEqual(read('{"a":["a","b"]}'));
  });

  it("compares a number by its kind alone, and text by its value", () => {
    const counted = (text: string) => readStructured("x.json", Buffer.from(text), NAMES)?.entries;
    expect(counted('{"docIdentifier":7,"t":1.5e3}')).toEqual(
      counted('{"docIdentifier":12,"t":-2}'),
    );
    expect(counted('{"title":"a"}')).not.toEqual(counted('{"title":"b"}'));
    expect(counted('{"n":"7"}')).not.toEqual(counted('{"n":7}'));
    const pref = (v: string) =>
      readStructured("prefs.js", Buffer.from(`user_pref("x", ${v});\n`), NAMES)?.entries;
    expect(pref("1794914675")).toEqual(pref("1794914999"));
    expect(pref('"leak"')).not.toEqual(pref('"other"'));
    expect(pref("true")).not.toEqual(pref("false"));
  });

  it("reads JSON as one group per leaf path, and mozlz4 JSON through its LZ4 block", () => {
    const json = readStructured("x.json", Buffer.from('{"a":[1,{"b":"U1"}],"c":null}'), NAMES);
    expect(json?.format).toBe("json");
    expect(Object.keys(json?.entries ?? {})).toEqual(["$.a[0]", "$.a[1].b", "$.c"]);
    // A hand-made LZ4 block: 13 literals, then a match of 4 bytes 13 back, then the last literal.
    const text = '{"k":"vvvv"} ';
    const block = Buffer.concat([
      Buffer.from([0xd0]),
      Buffer.from(text),
      Buffer.from([0x0d, 0x00]),
      Buffer.from([0x10]),
      Buffer.from(" "),
    ]);
    expect(lz4Block(block, 64).toString()).toBe(`${text}{"k" `);
    const plain = Buffer.from('{"k":"v"}');
    const literal = Buffer.concat([Buffer.from([plain.length << 4]), plain]);
    const header = Buffer.alloc(12);
    header.write("mozLz40\0", 0, "latin1");
    header.writeUInt32LE(plain.length, 8);
    const moz = readStructured("x.jsonlz4", Buffer.concat([header, literal]), NAMES);
    expect(moz?.entries).toEqual(readStructured("x.json", plain, NAMES)?.entries);
    expect(readStructured("x", Buffer.from("{ not json"), NAMES)).toBeNull();
  });

  it("reads a long literal and a long match through their extra length bytes", () => {
    const literals = Buffer.alloc(20, 0x61);
    const block = Buffer.concat([
      Buffer.from([0xff, 20 - 15]),
      literals,
      Buffer.from([0x01, 0x00, 30 - 19]),
      Buffer.from([0x00]),
    ]);
    expect(lz4Block(block, 100).toString()).toBe("a".repeat(50));
  });

  it("reads a mozlz4 file's text decompressed, and any other file's as it is", () => {
    const plain = Buffer.from("OCHMARK");
    const header = Buffer.alloc(12);
    header.write("mozLz40\0", 0, "latin1");
    header.writeUInt32LE(plain.length, 8);
    const moz = Buffer.concat([header, Buffer.from([plain.length << 4]), plain]);
    expect(contentText(moz)).toBe("OCHMARK");
    expect(contentText(Buffer.from("mozLz40"))).toBe("mozLz40");
    expect(contentText(Buffer.from("plain"))).toBe("plain");
  });

  it("reads every row of every table of a SQLite database, write-ahead log included, and counts stray bytes", () => {
    const dir = scratch();
    const path = NodePath.join(dir, "x.sqlite");
    const db = new NodeSqlite.DatabaseSync(path);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE t (k TEXT, v BLOB, n INTEGER); INSERT INTO t VALUES ('a', 'U1', 5), ('b', x'00', 6);",
    );
    const live = readStructured(path, NodeFS.readFileSync(path), NAMES);
    db.close();
    expect(live?.format).toBe("sqlite");
    expect(live?.entries["table t"]?.fields).toEqual(["k", "v", "n"]);
    expect(live?.entries["table t"]?.rows.map((row) => row[2])).toEqual(["#", "#"]);
    expect(live?.entries["table t"]?.rows).toHaveLength(2);
    const bytes = NodeFS.readFileSync(path);
    expect(readStructured(path, bytes, NAMES)?.unaccounted).toBe(0);
    NodeFS.appendFileSync(path, "leaked log line\n");
    const padded = readStructured(path, NodeFS.readFileSync(path), NAMES);
    expect(padded?.unaccounted).toBe(16);
    expect(padded?.entries).toEqual(live?.entries);
    expect(readStructured(path, Buffer.from("SQLite format 3\0"), NAMES)).toBeNull();
  });
});

/** A group from records written out field by field. */
const g = (...records: Readonly<Record<string, string>>[]): Group => {
  const fields = [...new Set(records.flatMap((r) => Object.keys(r)))].sort();
  return { fields, rows: records.map((r) => fields.map((f) => r[f] ?? "")) };
};

describe("entries beyond the control runs", () => {
  const rows = (...values: string[]): Group => g(...values.map((v) => ({ k: v, t: "same" })));

  it("finds a group neither control run has, and a record beyond both", () => {
    const control: Entries = { "pref a": g({ value: "1" }), "table t": rows("x", "y") };
    expect(
      entriesBeyond({ ...control, "pref leaked": g({ value: "9" }) }, [control, control]),
    ).toEqual(["pref leaked: in neither control run"]);
    expect(
      entriesBeyond({ ...control, "table t": rows("x", "y", "z") }, [control, control]),
    ).toEqual(["table t: 1 records in neither control run"]);
    expect(
      entriesBeyond({ ...control, "table t": rows("x", "y", "y") }, [control, control]),
    ).toEqual(["table t: 1 records in neither control run"]);
    expect(entriesBeyond({ "pref a": g({ value: "2" }) }, [control, control])).toEqual([
      "pref a: 1 records in neither control run",
    ]);
    expect(entriesBeyond(control, [control, control])).toEqual([]);
  });

  it("judges keys a container names at random by their count, and keeps a stable container exact", () => {
    const scores = (...ids: string[]): Entries =>
      Object.fromEntries(
        ids.flatMap((id) => [
          [`$.score_map.${id}.freq`, g({ value: "1" })],
          [`$.score_map.${id}.ctr`, g({ value: "2" })],
        ]),
      );
    const [a, b] = [scores("A1", "x"), scores("B1", "x")];
    expect(entriesBeyond(scores("C1", "x"), [a, b])).toEqual([]);
    expect(entriesBeyond(scores("C1", "C2", "x"), [a, b])).toEqual([
      "$.score_map.C1.freq: in neither control run",
      "$.score_map.C1.ctr: in neither control run",
      "$.score_map.C2.freq: in neither control run",
      "$.score_map.C2.ctr: in neither control run",
    ]);
    const stable = scores("x");
    expect(
      entriesBeyond({ ...stable, "$.score_map.x.leak": g({ value: "9" }) }, [stable, stable]),
    ).toEqual(["$.score_map.x.leak: in neither control run"]);
    expect(entriesBeyond({ "$.other[0]": g({ value: "1" }) }, [stable, stable])).toEqual([
      "$.other[0]: in neither control run",
    ]);
    const prefsA: Entries = { "pref a": g({ value: "1" }), "pref noisy1": g({ value: "1" }) };
    const prefsB: Entries = { "pref a": g({ value: "1" }), "pref noisy2": g({ value: "1" }) };
    expect(
      entriesBeyond({ "pref a": g({ value: "1" }), "pref noisy3": g({ value: "1" }) }, [
        prefsA,
        prefsB,
      ]),
    ).toEqual([]);
    expect(
      entriesBeyond(
        { "pref a": g({ value: "1" }), "pref n3": g({ value: "1" }), "pref n4": g({ value: "1" }) },
        [prefsA, prefsB],
      ),
    ).toEqual(["pref n3: in neither control run", "pref n4: in neither control run"]);
  });

  it("leaves out a field the two control runs fill differently, and a group only one of them has", () => {
    const first: Entries = {
      "table t": g({ k: "x", at: "1" }),
      "pref a": g({ value: "1" }),
      "pref once": g(),
    };
    const second: Entries = { "table t": g({ k: "x", at: "2" }), "pref a": g({ value: "2" }) };
    expect(
      entriesBeyond(
        {
          "table t": g({ k: "x", at: "3" }),
          "pref a": g({ value: "3" }),
          "pref once": g({ value: "1" }),
        },
        [first, second],
      ),
    ).toEqual([]);
    expect(entriesBeyond({ "table t": g({ k: "y", at: "3" }) }, [first, second])).toEqual([
      "table t: 1 records in neither control run",
    ]);
    expect(
      entriesBeyond({ "table t": g({ k: "x", at: "3" }, { k: "x", at: "4" }) }, [first, second]),
    ).toEqual(["table t: 1 records in neither control run"]);
  });
});
