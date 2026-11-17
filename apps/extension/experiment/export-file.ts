// How an export reaches disk, without Gecko: the one boundary every export file call goes through, where a platform
// error becomes a WriteFailure, the sink that batches the document into `<name>.har.part`, and the journal that lets
// the next start delete a part a crash left.

import type { WriteFailure } from "@one-click-har/export/jobs";
import { WriteRefused, type HarSink } from "@one-click-har/export/run";
import type { AbortSignalLike } from "@one-click-har/export/source";
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
 * Platform errors by the identifier the platform gives: a DOMException `name` or an nsresult name, never message text,
 * which carries paths. Each row is a cause `export-failures` makes happen for real; a name no cause produces has no
 * row. A full disk is decided by free space, and a folder gone or replaced by `folderProblem`, both before this table.
 */
const FS_ERROR_KINDS: {
  readonly [name: string]: Exclude<WriteFailure["kind"], "other" | "disk-full" | "timed-out">;
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
  /** The rename found no part at its name, in a folder that is still the export's. */
  NotFoundError: "file-replaced",
};
const errorName = (error: unknown): string | null => {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : null;
  return typeof name === "string" ? name : null;
};

/** What is at a path, without following a link there. `size` is the size lstat gives, whatever the kind. */
export type PathState =
  | { readonly kind: "missing" }
  | { readonly kind: "file" | "link" | "folder" | "other"; readonly size: number };

/**
 * One open file, opened for reading and writing by its exclusive create. Every byte of a part goes through it, and it
 * is how the export knows its own file: what it reads back and the size it sets are that file's, whatever is at the
 * path.
 */
export interface FileHandle {
  /** Appends at the end. */
  readonly write: (text: string) => void;
  readonly flush: () => void;
  /** The file's length, through the handle. */
  readonly size: () => number;
  /** The file's first `bytes` bytes, through the handle. */
  readonly readHead: (bytes: number) => Uint8Array;
  /** Sets the file's length through the handle. */
  readonly resize: (bytes: number) => void;
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
  /**
   * Up to `bytes` first bytes of what is at `path`, opened so that the open never waits, a FIFO's included, and read
   * only when the opened file reports at least that many bytes. It follows a link, so a caller checks the kind first.
   */
  readonly readHead: (path: string, bytes: number) => Promise<Uint8Array>;
  /** Never overwrites. */
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly freeBytes: (folder: string) => number;
}

/** What bounds an export's file calls: a call still running after `stepMs` is `timed-out`, and cancel is honored. */
export interface ExportLimits {
  readonly stepMs: number;
  /** Settles `elapsed` after `ms`, unless `cancel` comes first. */
  readonly timer: (ms: number) => { readonly elapsed: Promise<void>; readonly cancel: () => void };
  readonly signal: AbortSignalLike;
}

/** Thrown at a step boundary once the job's cancel was asked for. Not a WriteFailure: the job ends cancelled. */
export class ExportCancelled extends Error {
  override readonly name = "ExportCancelled";
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
  /** Confirms the part is this export's file holding what was written, renames it, and returns the name it got. */
  readonly finish: (planned: string) => Promise<string>;
  /** Deletes the part if it is still this export's file. Returns at once if a timed-out rename is still running. */
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
 * Whether the file at `path` is a regular file, not a link, whose first bytes are `head` (and, given `size`, of that
 * length). A head names one export, so this is the proof, without a handle, that a file is that export's own. The
 * kind is read before and after the read, and the read never waits on a FIFO.
 */
export const carriesHead = async (
  io: Pick<ExportPlatform, "state" | "readHead">,
  path: string,
  head: string,
  size?: number,
): Promise<boolean> => {
  const fits = (state: PathState): boolean =>
    state.kind === "file" && (size === undefined ? state.size >= head.length : state.size === size);
  if (head.length === 0 || !fits(io.state(path))) return false;
  return sameBytes(await io.readHead(path, head.length), head) && fits(io.state(path));
};

/**
 * The export's only way to the file system. Every call either succeeds or throws WriteRefused with a kind from
 * FS_ERROR_KINDS, or `timed-out` once a call has run `stepMs`. The folder is resolved to its real path once and must
 * stay that folder; a part is created exclusively, written only through its own handle, and renamed only after the
 * handle shows the path still names its file. `allowed` is the folder guard over a real path.
 */
export function exportFiles(
  platform: ExportPlatform,
  allowed: (realFolder: string) => boolean,
  limits: ExportLimits,
) {
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

  /** Why `folder` is no longer the real, unlinked folder it was resolved to, or null while it still is. */
  const folderProblem = (folder: string): WriteFailure["kind"] | null => {
    try {
      const state = platform.state(folder).kind;
      if (state === "missing") return "folder-missing";
      if (state === "link") return "folder-refused";
      if (state !== "folder") return "not-a-folder";
      return platform.realPath(folder) === folder ? null : "folder-refused";
    } catch {
      return null;
    }
  };
  const stillFolder = (folder: string): void => {
    const problem = folderProblem(folder);
    if (problem !== null) refuse(problem as Exclude<WriteFailure["kind"], "disk-full">);
  };

  /** Free space first, then a folder that is no longer the export's, then the error's name. */
  const classify = (
    error: unknown,
    folder: string,
    resolved: boolean,
    needBytes: number,
  ): WriteFailure => {
    const freeBytes = free(folder);
    if (freeBytes !== null && freeBytes < needBytes)
      return {
        kind: "disk-full",
        needBytes: needBytes as ByteCount,
        freeBytes: freeBytes as ByteCount,
      };
    const moved = resolved ? folderProblem(folder) : null;
    if (moved !== null) return { kind: moved } as WriteFailure;
    const name = errorName(error);
    const kind = name !== null && Object.hasOwn(FS_ERROR_KINDS, name) ? FS_ERROR_KINDS[name] : null;
    return { kind: kind ?? "other" } as WriteFailure;
  };
  const run = async <T>(
    folder: string,
    resolved: boolean,
    call: () => T | Promise<T>,
    needBytes = 0,
  ): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WriteRefused || error instanceof ExportCancelled) throw error;
      throw new WriteRefused(classify(error, folder, resolved, needBytes));
    }
  };

  /** `op`, or `timed-out` once it has run `stepMs`; `late` then gets the call, which may still settle. */
  const bounded = async <T>(op: Promise<T>, late?: (op: Promise<T>) => void): Promise<T> => {
    const timer = limits.timer(limits.stepMs);
    try {
      return await Promise.race([
        op,
        timer.elapsed.then((): never => {
          op.catch(() => undefined);
          late?.(op);
          return refuse("timed-out");
        }),
      ]);
    } finally {
      timer.cancel();
    }
  };
  const isTaken = (failure: unknown): boolean =>
    failure instanceof WriteRefused && failure.failure.kind === "name-taken";

  const openFolder = async (configured: string): Promise<ExportFolder> => {
    const folder = await run(configured, false, async () => {
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
      await bounded(platform.makeFolder(planned));
      stillFolder(planned);
      if (!allowed(platform.realPath(planned))) refuse("folder-refused");
      return planned;
    });
    const step = <T>(call: () => T | Promise<T>, needBytes = 0): Promise<T> =>
      run(folder, true, call, needBytes);

    const openPart = (path: string, journal: PartJournal): Part => {
      const handle = platform.createExclusive(path);
      let written = 0;
      /** The first write's ASCII start; once `journaled`, it is on disk and in the journal. */
      let head = "";
      let journaled = false;
      let open = true;
      /** The name this export's file has now: the part's, or the finished name once a rename lands. */
      let at = path;
      /** A rename that timed out and may still land, which moves the file to the finished name. */
      let late: Promise<void> | null = null;
      const close = (): void => {
        if (!open) return;
        open = false;
        handle.close();
      };
      /**
       * `target` names the handle's file: it is a regular file of the handle's length, and its length follows a change
       * made through the handle. A file of the same kind, size and bytes at another inode does not follow.
       */
      const follows = (target: string): boolean => {
        const size = handle.size();
        const before = platform.state(target);
        if (before.kind !== "file" || before.size !== size) return false;
        handle.resize(size + 1);
        try {
          const grown = platform.state(target);
          return grown.kind !== "missing" && grown.size === size + 1;
        } finally {
          handle.resize(size);
        }
      };
      /** The handle's file holds what this export wrote: its length, and its first bytes. */
      const holdsWritten = (): boolean =>
        handle.size() === written && sameBytes(handle.readHead(head.length), head);
      /**
       * After a rename to `target`: whether what it moved is a regular file of the written length. Anything else took
       * the part's name between the check and the rename, and goes back where it was found.
       */
      const landed = async (target: string): Promise<boolean> => {
        at = target;
        const state = platform.state(target);
        if (state.kind === "file" && state.size === written) return true;
        await bounded(platform.rename(target, path)).then(
          () => {
            at = path;
          },
          () => undefined,
        );
        return false;
      };
      const ended = async (): Promise<void> => {
        if (journaled) await bounded(journal.ended(path));
      };
      /** Deletes the file at `at` if it is this export's: through the handle while it is open, else by its head. */
      const cleanUp = async (): Promise<void> => {
        let ours = false;
        try {
          ours = open ? follows(at) : await carriesHead(platform, at, head, written);
        } catch {
          ours = false;
        }
        try {
          close();
        } catch {
          // The handle's last error is already the export's failure.
        }
        if (ours) {
          try {
            await bounded(platform.remove(at));
          } catch {
            // Still this export's file, and still journaled: the next start deletes it.
            return;
          }
        }
        await ended();
      };
      return {
        append: async (text, needBytes) => {
          const first = written === 0 && !journaled;
          await step(() => {
            if (first) head = asciiPrefix(text, HEAD_BYTES);
            handle.write(text);
            written += needBytes;
            if (!first) return;
            handle.flush();
            stillFolder(folder);
            if (!follows(path) || !holdsWritten()) refuse("file-replaced");
          }, needBytes);
          if (!first) return;
          journaled = true;
          await step(() => bounded(journal.started(path, head)));
        },
        finish: async (planned) => {
          await step(() => {
            handle.flush();
            stillFolder(folder);
            if (!follows(path) || !holdsWritten()) refuse("file-replaced");
            close();
          });
          for (let n = 1; n <= NAME_TRIES; n += 1) {
            if (limits.signal.aborted) throw new ExportCancelled();
            const name = numbered(planned, n);
            const target = platform.join(folder, name);
            const renamed = await step(() =>
              bounded(platform.rename(path, target), (op) => {
                late = op.then(
                  async () => {
                    await landed(target);
                  },
                  () => undefined,
                );
              }),
            ).then(
              () => true,
              (error: unknown) => {
                if (isTaken(error)) return false;
                throw error;
              },
            );
            if (!renamed) continue;
            if (!(await step(() => landed(target)))) refuse("file-replaced");
            if (limits.signal.aborted) throw new ExportCancelled();
            // Nothing is left at the part's path, so an end line that failed to land costs nothing.
            await ended().catch(() => undefined);
            return name;
          }
          return refuse("name-taken");
        },
        discard: async () => {
          if (late === null) return cleanUp();
          // The rename may land at any time: clean up once it has settled, whether or not the job waits.
          const settled = late.then(cleanUp);
          settled.catch(() => undefined);
          return undefined;
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
          const part = await step(() => {
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
