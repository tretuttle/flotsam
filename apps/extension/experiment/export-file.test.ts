import { WriteRefused } from "@one-click-har/export/run";
import { describe, expect, it } from "vite-plus/test";
import {
  createPartSink,
  exportFiles,
  freeFileName,
  FS_ERROR_KINDS,
  journalLine,
  SINK_BATCH_UNITS,
  unfinishedExports,
  type ExportPlatform,
} from "./export-file.ts";

const FOLDER = "/home/someone/Downloads";
const PROFILE = "jar:file:///home/someone/.zen/abc.default/extensions/one-click-har.xpi!/parent.js";

/** A platform whose every call fails the same way, as a read-only or vanished folder makes them fail. */
const failing = (error: unknown, free: () => number = () => 1 << 30): ExportPlatform => {
  const fail = (): never => {
    throw error;
  };
  return {
    makeFolder: async () => fail(),
    exists: fail,
    create: fail,
    append: async () => fail(),
    rename: async () => fail(),
    remove: async () => fail(),
    freeBytes: free,
  };
};

const refusalOf = async (call: Promise<unknown>): Promise<unknown> => {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WriteRefused);
  return (error as WriteRefused).failure;
};

/** Every call of the boundary, each made to fail. */
const calls = (platform: ExportPlatform) => {
  const files = exportFiles(platform, FOLDER);
  return [
    files.makeFolder(),
    files.exists(`${FOLDER}/a.har`),
    files.create(`${FOLDER}/a.har.part`),
    files.append(`${FOLDER}/a.har.part`, "x", 1),
    files.rename(`${FOLDER}/a.har.part`, `${FOLDER}/a.har`),
    files.remove(`${FOLDER}/a.har.part`),
  ];
};

describe("the export file boundary", () => {
  it.each(Object.entries(FS_ERROR_KINDS).filter(([, kind]) => kind !== "disk-full"))(
    "maps %s to %s on every call, with no text in the failure",
    async (name, kind) => {
      const error = new DOMException(`Could not write \`${FOLDER}/a.har.part' (${PROFILE})`, name);
      for (const call of calls(failing(error))) expect(await refusalOf(call)).toEqual({ kind });
    },
  );

  it("maps an XPCOM exception by its nsresult name, not its message", async () => {
    const xpcom = {
      name: "NS_ERROR_FILE_ACCESS_DENIED",
      message: `Component returned failure code: 0x80520015 [nsIFileOutputStream.init] ${PROFILE}`,
    };
    for (const call of calls(failing(xpcom)))
      expect(await refusalOf(call)).toEqual({ kind: "access-denied" });
  });

  it("calls a refusal disk-full with the bytes it needed when the volume had less, whatever its name", async () => {
    const files = exportFiles(
      failing(new DOMException("no", "OperationError"), () => 4096),
      FOLDER,
    );
    expect(await refusalOf(files.append("p", "x", 10_000))).toEqual({
      kind: "disk-full",
      needBytes: 10_000,
      freeBytes: 4096,
    });
    const named = exportFiles(failing({ name: "NS_ERROR_FILE_NO_DEVICE_SPACE" }), FOLDER);
    expect(await refusalOf(named.create("p"))).toEqual({
      kind: "disk-full",
      needBytes: 0,
      freeBytes: 1 << 30,
    });
  });

  it("reports anything it cannot name as other, alone, even when the free space query fails too", async () => {
    const platform = failing(new Error(`boom at ${FOLDER} ${PROFILE}`), () => {
      throw new Error(PROFILE);
    });
    for (const call of calls(platform)) {
      const failure = await refusalOf(call);
      expect(failure).toEqual({ kind: "other" });
      expect(JSON.stringify(failure)).not.toContain("/home");
    }
  });
});

describe("the export's part sink", () => {
  const memory = () => {
    const appended: string[] = [];
    return { appended, append: async (text: string) => void appended.push(text) };
  };

  it("writes every piece in order and counts UTF-8 bytes as Node encodes them", async () => {
    const { appended, append } = memory();
    const pieces = ['{"a":"', "x".repeat(SINK_BATCH_UNITS), "é中😀", "\ud800", '"}'];
    const reported: number[] = [];
    const sink = createPartSink(append, (bytes) => reported.push(bytes));
    for (const piece of pieces) await sink.write(piece);
    await sink.close();
    const text = pieces.join("");
    expect(appended.join("")).toBe(text);
    expect(appended.length).toBeGreaterThan(1);
    expect(sink.bytesWritten()).toBe(Buffer.byteLength(text, "utf8"));
    expect(reported.at(-1)).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("asks the boundary for exactly the batch's UTF-8 bytes, and passes its refusal on", async () => {
    const files = exportFiles(
      failing(new DOMException("no", "OperationError"), () => 4096),
      FOLDER,
    );
    const sink = createPartSink(
      (text, need) => files.append("p", text, need),
      () => undefined,
    );
    await sink.write("é".repeat(SINK_BATCH_UNITS - 1));
    expect(await refusalOf(sink.write("ab"))).toEqual({
      kind: "disk-full",
      needBytes: 2 * (SINK_BATCH_UNITS - 1) + 2,
      freeBytes: 4096,
    });
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
  it("takes the planned name, or the first numbered one whose file and part are both free", async () => {
    expect(await freeFileName("site.har", async () => false)).toBe("site.har");
    const taken = new Set(["site.har", "site (2).har.part"]);
    expect(await freeFileName("site.har", async (name) => taken.has(name))).toBe("site (3).har");
  });
});
