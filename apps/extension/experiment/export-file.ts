// How an export reaches disk, without Gecko: the one boundary every export file call goes through, where a platform
// error becomes a WriteFailure, the sink that batches the document into `<name>.har.part`, and the journal that lets
// the next start delete a part a crash left.

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

/**
 * Platform errors by the identifier the platform gives them: an IOUtils DOMException's `name`, or an XPCOM exception's
 * nsresult name. Never by message text, which carries paths. Free space below what the call needed is a full disk
 * whatever the name, because ENOSPC reaches IOUtils under a generic name.
 */
export const FS_ERROR_KINDS: {
  readonly [name: string]: "access-denied" | "folder-missing" | "disk-full";
} = {
  NotAllowedError: "access-denied",
  NS_ERROR_FILE_ACCESS_DENIED: "access-denied",
  NS_ERROR_FILE_READ_ONLY: "access-denied",
  NS_ERROR_FILE_IS_LOCKED: "access-denied",
  NotFoundError: "folder-missing",
  NS_ERROR_FILE_NOT_FOUND: "folder-missing",
  NS_ERROR_FILE_TARGET_DOES_NOT_EXIST: "folder-missing",
  NS_ERROR_FILE_NO_DEVICE_SPACE: "disk-full",
};

const errorName = (error: unknown): string | null => {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
  return typeof name === "string" ? name : null;
};

const classifyFsError = (
  error: unknown,
  needBytes: number,
  freeBytes: number | null,
): WriteFailure => {
  const full: WriteFailure = {
    kind: "disk-full",
    needBytes: needBytes as ByteCount,
    freeBytes: (freeBytes ?? 0) as ByteCount,
  };
  if (freeBytes !== null && freeBytes < needBytes) return full;
  const name = errorName(error);
  const kind = name !== null && Object.hasOwn(FS_ERROR_KINDS, name) ? FS_ERROR_KINDS[name] : null;
  if (kind === "disk-full") return full;
  return { kind: kind ?? "other" };
};

/** The raw file calls an export makes, as a platform offers them. Any of them may throw anything. */
export interface ExportPlatform {
  readonly makeFolder: (folder: string) => Promise<void>;
  readonly exists: (path: string) => boolean;
  /** Creates the file empty, with its final mode. */
  readonly create: (path: string) => void;
  readonly append: (path: string, text: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly freeBytes: (folder: string) => number;
}

/** The export's only way to the file system. Every call throws WriteRefused with a classified failure, or succeeds. */
export interface ExportFiles {
  readonly makeFolder: () => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly create: (path: string) => Promise<void>;
  readonly append: (path: string, text: string, needBytes: number) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

export function exportFiles(platform: ExportPlatform, folder: string): ExportFiles {
  const free = (): number | null => {
    try {
      return platform.freeBytes(folder);
    } catch {
      return null;
    }
  };
  const guard = async <T>(call: () => T | Promise<T>, needBytes = 0): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw new WriteRefused(classifyFsError(error, needBytes, free()));
    }
  };
  return {
    makeFolder: () => guard(() => platform.makeFolder(folder)),
    exists: (path) => guard(() => platform.exists(path)),
    create: (path) => guard(() => platform.create(path)),
    append: (path, text, needBytes) => guard(() => platform.append(path, text), needBytes),
    rename: (from, to) => guard(() => platform.rename(from, to)),
    remove: (path) => guard(() => platform.remove(path)),
  };
}

export type PartSink = HarSink & {
  /** Writes what is still batched. Throws WriteRefused like `write`. */
  readonly close: () => Promise<void>;
};

/**
 * The export's sink. A refused append is the only failure that fails an export: `append` throws WriteRefused with
 * the bytes it needed, and nothing after it is written.
 */
export function createPartSink(
  append: (text: string, needBytes: number) => Promise<void>,
  onBytes: (bytes: ByteCount) => void,
): PartSink {
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
    await append(text, needBytes);
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
export const freeFileName = async (
  planned: string,
  taken: (name: string) => Promise<boolean>,
): Promise<string> => {
  const dot = planned.endsWith(".har") ? planned.length - 4 : planned.length;
  const stem = planned.slice(0, dot);
  const extension = planned.slice(dot);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? planned : `${stem} (${String(n)})${extension}`;
    if (!(await taken(name)) && !(await taken(`${name}${PART_SUFFIX}`))) return name;
  }
};
