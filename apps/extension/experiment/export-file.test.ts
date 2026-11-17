import { WriteRefused } from "@one-click-har/export/run";
import { describe, expect, it } from "vite-plus/test";
import {
  createPartSink,
  freeFileName,
  journalLine,
  SINK_BATCH_UNITS,
  unfinishedExports,
  type PartFile,
} from "./export-file.ts";

const memoryFile = (free: number | null = null) => {
  const appended: string[] = [];
  const file: PartFile = {
    append: async (text) => {
      appended.push(text);
    },
    freeBytes: async () => free,
  };
  return { file, appended };
};

const ENOSPC = new Error("Could not write: NS_ERROR_FILE_NO_DEVICE_SPACE");

describe("the export's part sink", () => {
  it("writes every piece in order and counts UTF-8 bytes as Node encodes them", async () => {
    const { file, appended } = memoryFile();
    const pieces = ['{"a":"', "x".repeat(SINK_BATCH_UNITS), "é中😀", "\ud800", '"}'];
    const reported: number[] = [];
    const sink = createPartSink(file, (bytes) => reported.push(bytes));
    for (const piece of pieces) await sink.write(piece);
    await sink.close();
    const text = pieces.join("");
    expect(appended.join("")).toBe(text);
    expect(appended.length).toBeGreaterThan(1);
    expect(sink.bytesWritten()).toBe(Buffer.byteLength(text, "utf8"));
    expect(reported.at(-1)).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("fails a refused append as disk-full with the bytes it needed and the volume's free bytes", async () => {
    const sink = createPartSink(
      { append: async () => Promise.reject(ENOSPC), freeBytes: async () => 4096 },
      () => undefined,
    );
    await sink.write("é".repeat(SINK_BATCH_UNITS - 1));
    const refused = await sink.write("ab").then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(WriteRefused);
    expect((refused as WriteRefused).failure).toEqual({
      kind: "disk-full",
      needBytes: 2 * (SINK_BATCH_UNITS - 1) + 2,
      freeBytes: 4096,
    });
  });

  it("does not call a refusal disk-full when the volume had room, whatever the error says", async () => {
    const sink = createPartSink(
      { append: async () => Promise.reject(ENOSPC), freeBytes: async () => 10 * SINK_BATCH_UNITS },
      () => undefined,
    );
    await sink.write("x");
    await expect(sink.close()).rejects.toMatchObject({ failure: { kind: "other" } });
    const denied = createPartSink(
      {
        append: async () => Promise.reject(new Error("NS_ERROR_FILE_ACCESS_DENIED")),
        freeBytes: async () => null,
      },
      () => undefined,
    );
    await denied.write("x");
    await expect(denied.close()).rejects.toMatchObject({ failure: { kind: "access-denied" } });
  });
});

describe("the export journal", () => {
  it("names the parts that started and never ended, and nothing else", () => {
    const journal = [
      journalLine("started", "/d/a.har.part"),
      journalLine("started", "/d/b.har.part"),
      journalLine("ended", "/d/a.har.part"),
      journalLine("started", "/home/user/.bashrc"),
      '{"started":"/d/torn.har.pa',
    ].join("");
    expect(unfinishedExports(journal)).toEqual(["/d/b.har.part"]);
    expect(unfinishedExports("")).toEqual([]);
  });
});

describe("export file names", () => {
  it("takes the planned name, or the first numbered one whose file and part are both free", () => {
    expect(freeFileName("site.har", () => false)).toBe("site.har");
    const taken = new Set(["site.har", "site (2).har.part"]);
    expect(freeFileName("site.har", (name) => taken.has(name))).toBe("site (3).har");
  });
});
