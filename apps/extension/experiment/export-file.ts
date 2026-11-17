// How an export reaches disk, without Gecko: the one boundary every export file call goes through, where a platform
// error becomes a WriteFailure, the sink that batches the document into `<name>.har.part`, and the journal that lets
// the next start delete a part a crash left.

import type { WriteFailure } from "@one-click-har/export/jobs";
import { WriteRefused, type HarSink } from "@one-click-har/export/run";
import type { ByteCount } from "@one-click-har/recording/ids";

/** Text is handed to the file in batches of about this many UTF-16 code units. */
export const SINK_BATCH_UNITS = 1_048_576;
const PART_SUFFIX = ".part";

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
 * nsresult name. Never by message text, which carries paths. Each row is a cause `export-failures` makes happen for
 * real, inside a user and mount namespace, on every browser it runs; a name no cause produces has no row. A full disk
 * has none either: it is decided by free space, which a full volume reports as below what the write needed.
 */
const FS_ERROR_KINDS: {
  readonly [name: string]: Exclude<WriteFailure["kind"], "other" | "disk-full">;
} = {
  /** A folder that must be created where this user may not write. */
  NotAllowedError: "access-denied",
  /** The part, in a folder this user may not write. */
  NS_ERROR_FILE_ACCESS_DENIED: "access-denied",
  /** A folder that must be created on a read-only mount. */
  ReadOnlyError: "read-only",
  /** The part, on a read-only mount. */
  NS_ERROR_FILE_READ_ONLY: "read-only",
  /** The folder is a file. */
  InvalidAccessError: "not-a-folder",
  NS_ERROR_FILE_NAME_TOO_LONG: "name-too-long",
  /** Something, a dangling link included, already has the part's name. */
  NS_ERROR_FILE_ALREADY_EXISTS: "name-taken",
  /** Something already has the finished file's name. */
  NoModificationAllowedError: "name-taken",
};
const errorName = (error: unknown): string | null => {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
  return typeof name === "string" ? name : null;
};

/** Free space below what the call needed is a full disk whatever the name. */
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
  return { kind: kind ?? "other" } as WriteFailure;
};

/** What is at a path, without following a link there. `size` is the size lstat gives, whatever the kind. */
export type PathState =
  | { readonly kind: "missing" }
  | { readonly kind: "file" | "link" | "folder" | "other"; readonly size: number };

/** One open file. Every byte of a part goes through the handle its exclusive create returned. */
export interface FileHandle {
  readonly write: (text: string) => void;
  readonly flush: () => void;
  readonly close: () => void;
}

/** The raw file calls an export makes, as a platform offers them. Any of them may throw anything. */
export interface ExportPlatform {
  readonly state: (path: string) => PathState;
  /** Every link resolved. A path that does not exist comes back as given. */
  readonly realPath: (path: string) => string;
  readonly parent: (path: string) => string | null;
  readonly join: (folder: string, name: string) => string;
  readonly filename: (path: string) => string;
  readonly makeFolder: (folder: string) => Promise<void>;
  /** Fails when anything, a dangling link included, is at the path. */
  readonly createExclusive: (path: string) => FileHandle;
  readonly readHead: (path: string, bytes: number) => Promise<Uint8Array>;
  /** Never overwrites. */
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly freeBytes: (folder: string) => number;
}

/**
 * Where a part is recorded so the next start can delete it after a crash. `started` comes only once the part exists
 * and holds `head`, its first bytes, which carry the export's random id; `ended` once the part is renamed, deleted,
 * or found to be no longer this export's.
 */
export interface PartJournal {
  readonly started: (path: string, head: string) => Promise<void>;
  readonly ended: (path: string) => Promise<void>;
}

/** A part being written: appended through its one handle, then confirmed and renamed, or discarded. */
export interface Part {
  readonly append: (text: string, needBytes: number) => Promise<void>;
  /** Closes the handle, confirms the part is still this export's file, and renames it. Returns the name it got. */
  readonly finish: (planned: string) => Promise<string>;
  /** Deletes the part if it is still this export's file. */
  readonly discard: () => Promise<void>;
}

export interface ExportFolder {
  readonly path: string;
  /** A free name for `planned` and its part, then the part, created exclusively. Nothing is journaled yet. */
  readonly createPart: (
    planned: string,
    journal: PartJournal,
  ) => Promise<{ readonly part: Part; readonly path: string }>;
}

const NAME_TRIES = 100;
/** How much of the part's first write is its identity: the document's opening, with the export's random id. */
const HEAD_BYTES = 128;

/** `name.har`, `name (2).har`, and on. */
const numbered = (planned: string, n: number): string => {
  const dot = planned.endsWith(".har") ? planned.length - 4 : planned.length;
  return n === 1 ? planned : `${planned.slice(0, dot)} (${String(n)})${planned.slice(dot)}`;
};

const asciiPrefix = (text: string, max: number): string => {
  let end = 0;
  while (end < text.length && end < max && text.charCodeAt(end) < 0x80) end += 1;
  return text.slice(0, end);
};

const sameBytes = (found: Uint8Array, text: string): boolean =>
  found.length === text.length && found.every((byte, index) => byte === text.charCodeAt(index));

/**
 * Whether the file at `path` is a regular file, not a link, whose first bytes are `head`. A head names one export,
 * so this is the proof that a part is that export's own. Its kind is read before any byte, so a FIFO is never opened.
 */
export const carriesHead = async (
  io: Pick<ExportPlatform, "state" | "readHead">,
  path: string,
  head: string,
): Promise<boolean> => {
  const state = io.state(path);
  if (head.length === 0 || state.kind !== "file" || state.size < head.length) return false;
  return sameBytes(await io.readHead(path, head.length), head);
};

/**
 * The export's only way to the file system. Every call either succeeds or throws WriteRefused with a kind from
 * FS_ERROR_KINDS. The folder is resolved to its real path once and must stay that folder; a part is created
 * exclusively, written only through its own handle, and renamed only after it is confirmed to still be that file.
 * `allowed` is the folder guard over a real path.
 */
export function exportFiles(platform: ExportPlatform, allowed: (realFolder: string) => boolean) {
  const free = (folder: string): number | null => {
    try {
      return platform.freeBytes(folder);
    } catch {
      return null;
    }
  };
  const refuse = (kind: Exclude<WriteFailure["kind"], "disk-full">): never => {
    throw new WriteRefused({ kind } as WriteFailure);
  };
  const run = async <T>(folder: string, call: () => T | Promise<T>, needBytes = 0): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WriteRefused) throw error;
      throw new WriteRefused(classifyFsError(error, needBytes, free(folder)));
    }
  };
  const isTaken = (failure: unknown): boolean =>
    failure instanceof WriteRefused && failure.failure.kind === "name-taken";

  /** The folder is still the real, unlinked folder it was resolved to. */
  const stillFolder = (folder: string): void => {
    const state = platform.state(folder).kind;
    if (state === "missing") refuse("folder-missing");
    if (state === "link") refuse("folder-refused");
    if (state !== "folder") refuse("not-a-folder");
    if (platform.realPath(folder) !== folder) refuse("folder-refused");
  };

  const openFolder = async (configured: string): Promise<ExportFolder> => {
    const folder = await run(configured, async () => {
      if (platform.state(configured).kind === "link") refuse("folder-refused");
      const missing: string[] = [];
      let existing = configured;
      while (platform.state(existing).kind === "missing") {
        const up = platform.parent(existing);
        if (up === null || up === existing) refuse("folder-missing");
        missing.unshift(platform.filename(existing));
        existing = up as string;
      }
      const planned = missing.reduce(platform.join, platform.realPath(existing));
      if (!allowed(planned)) refuse("folder-refused");
      await platform.makeFolder(planned);
      stillFolder(planned);
      if (!allowed(platform.realPath(planned))) refuse("folder-refused");
      return planned;
    });

    const openPart = (path: string, journal: PartJournal): Part => {
      const handle = platform.createExclusive(path);
      let written = 0;
      /** The first write's ASCII start; once `journaled`, it is on disk and in the journal. */
      let head = "";
      let journaled = false;
      let open = true;
      const close = (): void => {
        if (!open) return;
        open = false;
        handle.close();
      };
      const confirm = async (): Promise<void> => {
        stillFolder(folder);
        const state = platform.state(path);
        if (state.kind !== "file" || state.size !== written) refuse("file-replaced");
        const found = await platform.readHead(path, head.length);
        if (!sameBytes(found, head)) refuse("file-replaced");
      };
      /** Journaled, the part must carry its whole head; before that, as much of it as reached the file. */
      const stillOurs = async (): Promise<boolean> => {
        if (platform.state(folder).kind !== "folder" || platform.realPath(folder) !== folder)
          return false;
        const state = platform.state(path);
        if (state.kind !== "file") return false;
        const length = Math.min(state.size, head.length);
        if (journaled && length < head.length) return false;
        return sameBytes(await platform.readHead(path, length), head.slice(0, length));
      };
      return {
        append: async (text, needBytes) => {
          const first = written === 0 && !journaled;
          await run(
            folder,
            async () => {
              if (first) head = asciiPrefix(text, HEAD_BYTES);
              handle.write(text);
              written += needBytes;
              if (!first) return;
              handle.flush();
              stillFolder(folder);
              if (!(await carriesHead(platform, path, head))) refuse("file-replaced");
            },
            needBytes,
          );
          if (!first) return;
          await journal.started(path, head);
          journaled = true;
        },
        finish: async (planned) => {
          const name = await run(folder, async () => {
            close();
            await confirm();
            for (let n = 1; n <= NAME_TRIES; n += 1) {
              const name = numbered(planned, n);
              const target = platform.join(folder, name);
              const renamed = await run(folder, () => platform.rename(path, target)).then(
                () => true,
                (error: unknown) => {
                  if (isTaken(error)) return false;
                  throw error;
                },
              );
              if (renamed) return name;
            }
            return refuse("name-taken");
          });
          // Nothing is left at the part's path, so an end line that failed to land costs nothing.
          if (journaled) await journal.ended(path).catch(() => undefined);
          return name;
        },
        discard: async () => {
          try {
            close();
          } catch {
            // The handle's last error is already the export's failure.
          }
          const ours = await stillOurs().catch(() => false);
          if (ours) {
            try {
              await platform.remove(path);
            } catch {
              // Still this export's file, and still journaled: the next start deletes it.
              return;
            }
          }
          if (journaled) await journal.ended(path);
        },
      };
    };

    return {
      path: folder,
      createPart: async (planned, journal) => {
        for (let n = 1; n <= NAME_TRIES; n += 1) {
          const name = numbered(planned, n);
          const final = platform.join(folder, name);
          const path = `${final}${PART_SUFFIX}`;
          const part = await run(folder, () => {
            stillFolder(folder);
            return openPart(path, journal);
          }).catch((error: unknown) => {
            if (isTaken(error)) return null;
            throw error;
          });
          if (part !== null) return { part, path };
        }
        return refuse("name-taken");
      },
    };
  };

  return { openFolder };
}

export type PartSink = HarSink & {
  /** Writes what is still batched. Throws WriteRefused like `write`. */
  readonly close: () => Promise<void>;
};

/**
 * The export's sink. A refused append is the only failure that fails an export: `append` throws WriteRefused with
 * the bytes it needed, and nothing after it is written. The first piece, the document's opening with the export's
 * random id, is appended alone and at once, so the part is journaled before the rest is written.
 */
export function createPartSink(
  append: (text: string, needBytes: number) => Promise<void>,
  onBytes: (bytes: ByteCount) => void,
): PartSink {
  let pending: string[] = [];
  let pendingUnits = 0;
  let pendingBytes = 0;
  let written = 0;
  let opened = false;
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
      if (opened && pendingUnits < SINK_BATCH_UNITS) return;
      opened = true;
      await flush();
    },
    bytesWritten: () => (written + pendingBytes) as ByteCount,
    close: flush,
  };
}

/** One line of `exports.jsonl` in the archive. */
export type JournalEntry =
  | { readonly started: string; readonly head: string }
  | { readonly ended: string };

export const journalLine = (entry: JournalEntry): string => `${JSON.stringify(entry)}\n`;

/** A part the journal says started and never ended, with the first bytes that prove a file at its path is it. */
export interface JournaledPart {
  readonly path: string;
  readonly head: string;
}

/**
 * Started and never ended, so left by a crash (crash row 13). Only `.har.part` paths with a head are listed: a damaged
 * line cannot name another file, and a line with no head proves nothing about the file at its path.
 */
export const unfinishedExports = (journal: string): readonly JournaledPart[] => {
  const open = new Map<string, string>();
  for (const line of journal.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const { started, head, ended } = parsed as {
      started?: unknown;
      head?: unknown;
      ended?: unknown;
    };
    if (
      typeof started === "string" &&
      started.endsWith(`.har${PART_SUFFIX}`) &&
      typeof head === "string" &&
      head.length > 0
    )
      open.set(started, head);
    if (typeof ended === "string") open.delete(ended);
  }
  return [...open].map(([path, head]) => ({ path, head }));
};
