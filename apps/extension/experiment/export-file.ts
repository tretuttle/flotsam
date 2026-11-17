// How an export reaches disk, without Gecko: the sink that batches the document into `<name>.har.part`, the one
// place a refused write becomes a WriteFailure, and the journal that lets the next start delete a part a crash left.

import type { WriteFailure } from "@one-click-har/export/jobs";
import { WriteRefused, type HarSink } from "@one-click-har/export/run";
import type { ByteCount } from "@one-click-har/recording/ids";

/** Text is handed to the file in batches of about this many UTF-16 code units. */
export const SINK_BATCH_UNITS = 1_048_576;
export const PART_SUFFIX = ".part";

/** UTF-8 length of a JavaScript string. A lone surrogate is written as U+FFFD, three bytes. */
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

/** Error names Gecko's file layer gives for a refusal, first match wins. Disk space is decided from the numbers. */
const REFUSALS: readonly { readonly pattern: RegExp; readonly failure: WriteFailure }[] = [
  {
    pattern: /ACCESS_DENIED|NotAllowedError|Permission denied/u,
    failure: { kind: "access-denied" },
  },
  { pattern: /READ_ONLY|read-only/iu, failure: { kind: "access-denied" } },
];

/**
 * A refused write as the popup reports it. Free space below what the write needed is a full disk whatever the error
 * text says; ENOSPC surfaces under several names, and the numbers are what the user can act on.
 */
const classifyWriteFailure = (
  detail: string,
  needBytes: number,
  freeBytes: number | null,
): WriteFailure => {
  if (freeBytes !== null && freeBytes < needBytes)
    return {
      kind: "disk-full",
      needBytes: needBytes as ByteCount,
      freeBytes: freeBytes as ByteCount,
    };
  return REFUSALS.find((row) => row.pattern.test(detail))?.failure ?? { kind: "other", detail };
};

/** What the sink needs from a file system. `append` resolves once the text is on disk or rejects with the refusal. */
export interface PartFile {
  readonly append: (text: string) => Promise<void>;
  /** Free bytes on the part's volume, or null when the platform cannot say. */
  readonly freeBytes: () => Promise<number | null>;
}

export type PartSink = HarSink & {
  /** Writes what is still batched. Throws WriteRefused like `write`. */
  readonly close: () => Promise<void>;
};

/**
 * The export's sink. A refused append is the only failure that fails an export: it is thrown as WriteRefused with the
 * bytes that append needed and the volume's free bytes, and nothing after it is written.
 */
export function createPartSink(file: PartFile, onBytes: (bytes: ByteCount) => void): PartSink {
  let pending: string[] = [];
  let pendingUnits = 0;
  let pendingBytes = 0;
  let written = 0;
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const text = pending.join("");
    const needBytes = pendingBytes;
    pending = [];
    pendingUnits = 0;
    pendingBytes = 0;
    try {
      await file.append(text);
    } catch (error) {
      const free = await file.freeBytes().catch(() => null);
      throw new WriteRefused(classifyWriteFailure(String(error), needBytes, free));
    }
    written += needBytes;
    onBytes(written as ByteCount);
  };
  return {
    write: async (text) => {
      pending.push(text);
      pendingUnits += text.length;
      pendingBytes += utf8Length(text);
      if (pendingUnits >= SINK_BATCH_UNITS) await flush();
    },
    bytesWritten: () => (written + pendingBytes) as ByteCount,
    close: flush,
  };
}

/**
 * `exports.jsonl` in the archive: a line naming a part before its first byte, and one when it was renamed or deleted.
 * A part named by a start line and no end line was left by a crash, and the next start deletes it (crash row 13).
 */
export const journalLine = (event: "started" | "ended", partPath: string): string =>
  `${JSON.stringify({ [event]: partPath })}\n`;

/** Only `.har.part` paths are ever deleted from the journal, so a damaged line cannot name another file. */
export const unfinishedExports = (journal: string): readonly string[] => {
  const open = new Set<string>();
  for (const line of journal.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const { started, ended } = parsed as { started?: unknown; ended?: unknown };
    if (typeof started === "string" && started.endsWith(`.har${PART_SUFFIX}`)) open.add(started);
    if (typeof ended === "string") open.delete(ended);
  }
  return [...open];
};

/** `name.har`, then `name (2).har` and on, the first that is free as both the file and its part. */
export const freeFileName = (planned: string, taken: (name: string) => boolean): string => {
  const dot = planned.endsWith(".har") ? planned.length - 4 : planned.length;
  const stem = planned.slice(0, dot);
  const extension = planned.slice(dot);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? planned : `${stem} (${String(n)})${extension}`;
    if (!taken(name) && !taken(`${name}${PART_SUFFIX}`)) return name;
  }
};
