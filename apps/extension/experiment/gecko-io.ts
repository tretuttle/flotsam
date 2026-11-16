// Native helpers more than one experiment file needs. Nothing here reads a body into script.

import { parseSite, type Site } from "@one-click-har/recording/ids";

/** POSIX modes the archive uses on Linux and macOS (rows P2). Windows ignores them and keeps the inherited ACL. */
export interface Modes {
  readonly dir: number | null;
  readonly file: number | null;
}

const PR_WRONLY = 0x02;
const PR_CREATE_FILE = 0x08;
const PR_APPEND = 0x10;
const PR_TRUNCATE = 0x20;
const COPY_CHUNK = 65_536;

export const localFile = (path: string): LocalFile => {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
};

/** Creates the file with its final mode, so it is never readable by others, not even for a moment. */
export const openOutput = (path: string, append: boolean, modes: Modes): FileOutputStream => {
  const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
    Ci.nsIFileOutputStream,
  );
  const flags = PR_WRONLY | PR_CREATE_FILE | (append ? PR_APPEND : PR_TRUNCATE);
  stream.init(localFile(path), flags, modes.file ?? 0o644, 0);
  return stream;
};

export const makeDirectory = async (path: string, modes: Modes): Promise<void> => {
  await IOUtils.makeDirectory(path, {
    createAncestors: true,
    ignoreExisting: true,
    ...(modes.dir === null ? {} : { permissions: modes.dir }),
  });
  if (modes.dir !== null) await IOUtils.setPermissions(path, modes.dir);
};

/** IOUtils creates files 0644 on Linux (opus), so a new file is created here with its mode before any byte. */
export const appendText = async (path: string, text: string, modes: Modes): Promise<void> => {
  if (modes.file !== null && !(await IOUtils.exists(path))) openOutput(path, true, modes).close();
  await IOUtils.writeUTF8(path, text, { mode: "appendOrCreate" });
};

/** Write to `<path>.tmp`, set its mode, then rename over the target: a reader sees the old file or the new one. */
export const writeAtomic = async (
  path: string,
  text: string,
  modes: Modes,
  beforeRename: () => Promise<void> = async () => undefined,
): Promise<void> => {
  const tmp = `${path}.tmp`;
  await IOUtils.writeUTF8(tmp, text, { mode: "overwrite" });
  if (modes.file !== null) await IOUtils.setPermissions(tmp, modes.file);
  await beforeRename();
  await IOUtils.move(tmp, path);
};

const streamTransport = (): unknown =>
  Cc["@mozilla.org/network/stream-transport-service;1"].getService(Ci.nsIEventTarget);

/**
 * Appends every stream, in order, to the end of `path` on a stream transport thread (proto-premise: no body byte
 * enters script). Resolves when the last byte is written and the file is closed.
 */
export const appendStreams = (
  path: string,
  streams: readonly InputStream[],
  modes: Modes,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const all = Cc["@mozilla.org/io/multiplex-input-stream;1"].createInstance(
      Ci.nsIMultiplexInputStream,
    );
    for (const stream of streams) all.appendStream(stream);
    const copier = Cc["@mozilla.org/network/async-stream-copier;1"].createInstance(
      Ci.nsIAsyncStreamCopier,
    );
    copier.init(
      all,
      openOutput(path, true, modes),
      streamTransport(),
      true,
      false,
      COPY_CHUNK,
      true,
      true,
    );
    copier.asyncCopy(
      {
        onStartRequest: () => undefined,
        onStopRequest: (_request, status) =>
          Components.isSuccessCode(status)
            ? resolve()
            : reject(new Error(`pack append failed: ${errorName(status)}`)),
      },
      null,
    );
  });

export const errorName = (status: number): string => {
  try {
    return ChromeUtils.getXPCOMErrorName(status);
  } catch {
    return `0x${(status >>> 0).toString(16)}`;
  }
};

const SITE_CACHE_MAX = 4_096;
const siteCache = new Map<string, Site | null>();

const lookupSite = (host: string): Site | null => {
  try {
    return parseSite(Services.eTLD.getBaseDomainFromHost(host));
  } catch {
    return parseSite(host);
  }
};

/**
 * Registrable domain through Services.eTLD; IP hosts and single-label hosts are their own site. Each request asks for
 * up to three hosts that repeat, and the lookup was the largest part of examine on 2000 requests, so answers are kept.
 */
export const siteOfHost = (host: string): Site | null => {
  if (host === "") return null;
  const known = siteCache.get(host);
  if (known !== undefined) return known;
  if (siteCache.size >= SITE_CACHE_MAX) siteCache.clear();
  const site = lookupSite(host);
  siteCache.set(host, site);
  return site;
};

export const siteOfUri = (uri: Uri | null | undefined): Site | null =>
  uri !== null && uri !== undefined && (uri.schemeIs("http") || uri.schemeIs("https"))
    ? siteOfHost(uri.asciiHost)
    : null;

/**
 * Every timer this add-on starts. Timers outlive a disabled add-on (proto-gecko Q5), so onShutdown cancels them all,
 * the cap watchdog included.
 */
export class Timers {
  readonly #live = new Set<Timer>();

  repeat(ms: number, tick: () => void): { cancel(): void } {
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.#live.add(timer);
    timer.initWithCallback({ notify: tick }, ms, Ci.nsITimer.TYPE_REPEATING_SLACK);
    return {
      cancel: () => {
        timer.cancel();
        this.#live.delete(timer);
      },
    };
  }

  cancelAll(): void {
    for (const timer of this.#live) timer.cancel();
    this.#live.clear();
  }
}

export const randomBytes = (length: number): Uint8Array =>
  Uint8Array.from(
    Cc["@mozilla.org/security/random-generator;1"]
      .getService(Ci.nsIRandomGenerator)
      .generateRandomBytes(length),
  );
