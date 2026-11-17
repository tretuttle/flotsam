import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { WorkerAnswer, WorkerRequest } from "./file-worker.ts";

/**
 * libc as js-ctypes hands it to file-worker.ts, replaced by a shim: each call is recorded with a copy of the bytes it
 * was given, and answers what the test scripts, setting errno as the kernel would.
 */
type Call = { readonly fn: string; readonly args: readonly unknown[]; readonly bytes: number[] };
const calls: Call[] = [];
/** What the next call of each function answers. */
const answerOf = new Map<string, () => number>();
let errno = 0;
const answers: WorkerAnswer[] = [];
let answer: ((request: WorkerRequest) => void) | null = null;

/** The next calls of `fn` answer these, in order: a count, or -1 with an errno. */
const script = (fn: string, ...results: readonly (number | { readonly errno: number })[]) => {
  const queue = [...results];
  answerOf.set(fn, () => {
    const next = queue.shift() ?? 0;
    if (typeof next === "number") return next;
    errno = next.errno;
    return -1;
  });
};

const ask = (request: WorkerRequest): WorkerAnswer => {
  answer?.(request);
  const last = answers.at(-1);
  if (last?.id !== request.id) throw new Error(`no answer to ${request.op}`);
  return last;
};

beforeAll(async () => {
  const type = { ptr: {} };
  Object.assign(globalThis, {
    ctypes: {
      default_abi: "default",
      int: type,
      unsigned_int: type,
      size_t: type,
      ssize_t: type,
      int64_t: type,
      char: { ptr: type },
      voidptr_t: type,
      get errno() {
        return errno;
      },
      open: () => ({
        declare:
          (fn: string) =>
          (...args: readonly unknown[]) => {
            const buffer = args.find((arg) => arg instanceof Uint8Array);
            calls.push({ fn, args, bytes: buffer === undefined ? [] : [...buffer] });
            return answerOf.get(fn)?.() ?? 0;
          },
      }),
    },
    postMessage: (message: WorkerAnswer) => answers.push(message),
    self: {},
  });
  await import("./file-worker.ts");
  const self = (globalThis as unknown as { self: { onmessage: (event: object) => void } }).self;
  answer = (request) => self.onmessage({ data: request });
  ask({ id: 1, op: "init", arch: "x86-64" });
});

beforeEach(() => {
  calls.length = 0;
  answerOf.clear();
  errno = 0;
});

describe("the file worker's calls into libc", () => {
  const text = '{"log":"héllo, wörld"}';
  const all = [...new TextEncoder().encode(text)];

  it("retries a short write with exactly the bytes not yet written, and answers ENOSPC after it", () => {
    script("write", 5, { errno: 28 });
    expect(ask({ id: 2, op: "write", fd: 7, text })).toEqual({ id: 2, ok: false, errno: "ENOSPC" });
    const writes = calls.filter((call) => call.fn === "write");
    expect(writes.map((call) => call.bytes)).toEqual([all, all.slice(5)]);
    // Each call's length is its buffer's: no call reaches past the bytes it was given.
    expect(writes.map((call) => call.args[2])).toEqual([all.length, all.length - 5]);
    expect(writes.map((call) => call.args[0])).toEqual([7, 7]);
  });

  it("writes everything through several short writes and answers the whole length", () => {
    script("write", 3, 4, all.length - 7);
    expect(ask({ id: 3, op: "write", fd: 7, text })).toEqual({
      id: 3,
      ok: true,
      value: all.length,
    });
    const writes = calls.filter((call) => call.fn === "write");
    expect(writes.map((call) => call.bytes)).toEqual([all, all.slice(3), all.slice(7)]);
  });

  it("reads on after a short read, from where it stopped, until the file ends", () => {
    script("pread", 4, 6, 0);
    const read = ask({ id: 4, op: "read", fd: 9, offset: 100, bytes: 32 });
    expect(read).toMatchObject({ id: 4, ok: true });
    expect(new Uint8Array((read as { value: ArrayBuffer }).value).length).toBe(10);
    const preads = calls.filter((call) => call.fn === "pread");
    expect(preads.map((call) => [call.args[2], call.args[3]])).toEqual([
      [32, 100],
      [28, 104],
      [22, 110],
    ]);
  });
});
