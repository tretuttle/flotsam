// The export's Linux file calls, in a ChromeWorker so none of them can stall the parent's main thread: libc through
// js-ctypes. A folder is held as a directory descriptor, the export's file is created unnamed in it (O_TMPFILE), and
// the file is named by linking its own descriptor (linkat through /proc/self/fd), which never replaces anything.
// Nothing here renames or deletes a path. Every answer is a value or the errno's name.

/** The js-ctypes surface this worker uses. */
interface CType {
  readonly ptr: CType;
}
interface CFunction {
  (...args: readonly unknown[]): number | { toString(): string };
}
interface CLibrary {
  declare(name: string, abi: unknown, returns: CType, ...args: readonly CType[]): CFunction;
}
declare const ctypes: {
  readonly default_abi: unknown;
  readonly int: CType;
  readonly unsigned_int: CType;
  readonly size_t: CType;
  readonly ssize_t: CType;
  readonly int64_t: CType;
  readonly char: CType;
  readonly voidptr_t: CType;
  readonly errno: number;
  open(name: string): CLibrary;
};
declare function postMessage(message: unknown): void;
/** A worker has these; the parent script's sandbox does not, so the worker encodes. */
declare class TextEncoder {
  encode(text: string): Uint8Array;
}
declare class TextDecoder {
  decode(bytes: Uint8Array): string;
}

/** Flags that differ by architecture; everything else here is the same on x86-64 and aarch64. */
const ARCH_FLAGS = {
  "x86-64": { directory: 0o200000, noFollow: 0o400000 },
  aarch64: { directory: 0o40000, noFollow: 0o100000 },
} as const;
export type WorkerArch = keyof typeof ARCH_FLAGS;

const O_RDONLY = 0;
const O_RDWR = 2;
const O_CLOEXEC = 0o2000000;
const O_TMPFILE_BIT = 0o20000000;
const AT_FDCWD = -100;
const AT_SYMLINK_NOFOLLOW = 0x100;
const AT_SYMLINK_FOLLOW = 0x400;
const AT_EMPTY_PATH = 0x1000;
const STATX_BASIC = 0x7ff;
const S_IFMT = 0o170000;
const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** errno names, the same on x86-64 and aarch64 (asm-generic). */
const ERRNO: { readonly [code: number]: string } = {
  1: "EPERM",
  2: "ENOENT",
  5: "EIO",
  9: "EBADF",
  13: "EACCES",
  17: "EEXIST",
  18: "EXDEV",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  24: "EMFILE",
  27: "EFBIG",
  28: "ENOSPC",
  30: "EROFS",
  31: "EMLINK",
  36: "ENAMETOOLONG",
  40: "ELOOP",
  95: "EOPNOTSUPP",
  122: "EDQUOT",
};

/** A file's identity: the device and inode statx reports. */
export interface Identity {
  readonly dev: string;
  readonly ino: string;
  readonly kind: "file" | "folder" | "link" | "other";
}

export type WorkerRequest =
  | { readonly id: number; readonly op: "init"; readonly arch: WorkerArch }
  | { readonly id: number; readonly op: "hold-folder"; readonly path: string }
  | { readonly id: number; readonly op: "where"; readonly fd: number }
  | { readonly id: number; readonly op: "create"; readonly folder: number; readonly mode: number }
  | { readonly id: number; readonly op: "write"; readonly fd: number; readonly text: string }
  | { readonly id: number; readonly op: "identity"; readonly fd: number }
  | {
      readonly id: number;
      readonly op: "identity-at";
      readonly folder: number;
      readonly name: string;
    }
  | { readonly id: number; readonly op: "size"; readonly fd: number }
  | { readonly id: number; readonly op: "head"; readonly fd: number; readonly bytes: number }
  | {
      readonly id: number;
      readonly op: "link";
      readonly fd: number;
      readonly folder: number;
      readonly name: string;
    }
  | { readonly id: number; readonly op: "close"; readonly fd: number };

export type WorkerAnswer =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly errno: string };

/** A failed call: the errno's name, or the code when the table has none. */
class Errno extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const libc = ctypes.open("libc.so.6");
const { int, unsigned_int: uint, size_t, ssize_t, int64_t, voidptr_t: voidp } = ctypes;
const cstring = ctypes.char.ptr;
const call = {
  openat: libc.declare("openat", ctypes.default_abi, int, int, cstring, int, uint),
  linkat: libc.declare("linkat", ctypes.default_abi, int, int, cstring, int, cstring, int),
  write: libc.declare("write", ctypes.default_abi, ssize_t, int, voidp, size_t),
  pread: libc.declare("pread", ctypes.default_abi, ssize_t, int, voidp, size_t, int64_t),
  close: libc.declare("close", ctypes.default_abi, int, int),
  statx: libc.declare("statx", ctypes.default_abi, int, int, cstring, int, uint, voidp),
  readlink: libc.declare("readlink", ctypes.default_abi, ssize_t, cstring, voidp, size_t),
};
let flags: (typeof ARCH_FLAGS)[WorkerArch] | null = null;

const failed = (): never => {
  const code = ctypes.errno;
  throw new Errno(ERRNO[code] ?? `errno ${String(code)}`);
};
const checked = (result: number | { toString(): string }): number => {
  const value = Number(result);
  return value < 0 ? failed() : value;
};

const kindOf = (mode: number): Identity["kind"] => {
  const type = mode & S_IFMT;
  if (type === S_IFREG) return "file";
  if (type === S_IFDIR) return "folder";
  return type === S_IFLNK ? "link" : "other";
};

/** statx of `name` relative to `dirfd`, never following a final link; null when nothing has the name. */
const statx = (
  dirfd: number,
  name: string,
  atFlags: number,
): { readonly identity: Identity; readonly size: number } | null => {
  const buffer = new ArrayBuffer(256);
  if (Number(call.statx(dirfd, name, atFlags, STATX_BASIC, buffer)) !== 0) {
    if (ctypes.errno === 2) return null;
    failed();
  }
  const view = new DataView(buffer);
  return {
    identity: {
      dev: `${String(view.getUint32(136, true))}:${String(view.getUint32(140, true))}`,
      ino: String(view.getBigUint64(32, true)),
      kind: kindOf(view.getUint16(28, true)),
    },
    size: Number(view.getBigUint64(40, true)),
  };
};
const ofDescriptor = (fd: number) => {
  const found = statx(fd, "", AT_EMPTY_PATH);
  if (found === null) throw new Errno("EBADF");
  return found;
};

/** The path the kernel gives an open descriptor now; null once what it names was deleted. */
const where = (fd: number): string | null => {
  const buffer = new Uint8Array(4096);
  const length = checked(call.readlink(`/proc/self/fd/${String(fd)}`, buffer, buffer.length));
  const path = new TextDecoder().decode(buffer.subarray(0, length));
  return path.endsWith(" (deleted)") ? null : path;
};

const need = () => {
  if (flags === null) throw new Errno("not initialized");
  return flags;
};

const ANSWERS: {
  readonly [Op in WorkerRequest["op"]]: (request: Extract<WorkerRequest, { op: Op }>) => unknown;
} = {
  init: ({ arch }) => {
    flags = ARCH_FLAGS[arch];
    return null;
  },
  "hold-folder": ({ path }) => {
    const { directory, noFollow } = need();
    const fd = checked(call.openat(AT_FDCWD, path, O_RDONLY | directory | noFollow | O_CLOEXEC, 0));
    return { fd, identity: ofDescriptor(fd).identity, at: where(fd) };
  },
  where: ({ fd }) => where(fd),
  create: ({ folder, mode }) => {
    const { directory } = need();
    const fd = checked(
      call.openat(folder, ".", O_TMPFILE_BIT | directory | O_RDWR | O_CLOEXEC, mode),
    );
    return { fd, identity: ofDescriptor(fd).identity };
  },
  write: ({ fd, text }) => {
    const all = new TextEncoder().encode(text);
    let done = 0;
    while (done < all.length) {
      const rest = all.subarray(done);
      done += checked(call.write(fd, rest, rest.length));
    }
    return done;
  },
  identity: ({ fd }) => ofDescriptor(fd).identity,
  "identity-at": ({ folder, name }) => statx(folder, name, AT_SYMLINK_NOFOLLOW)?.identity ?? null,
  size: ({ fd }) => ofDescriptor(fd).size,
  head: ({ fd, bytes }) => {
    const buffer = new Uint8Array(bytes);
    const read = checked(call.pread(fd, buffer, bytes, 0));
    return buffer.slice(0, read).buffer;
  },
  link: ({ fd, folder, name }) => {
    if (
      Number(
        call.linkat(AT_FDCWD, `/proc/self/fd/${String(fd)}`, folder, name, AT_SYMLINK_FOLLOW),
      ) === 0
    )
      return true;
    if (ctypes.errno === 17) return false;
    return failed();
  },
  close: ({ fd }) => checked(call.close(fd)),
};

declare const self: { onmessage: ((event: { readonly data: WorkerRequest }) => void) | null };
self.onmessage = ({ data }) => {
  try {
    const answer = (ANSWERS[data.op] as (request: WorkerRequest) => unknown)(data);
    postMessage({ id: data.id, ok: true, value: answer } satisfies WorkerAnswer);
  } catch (error) {
    const errno = error instanceof Errno ? error.code : `thrown ${String(error)}`;
    postMessage({ id: data.id, ok: false, errno } satisfies WorkerAnswer);
  }
};
