// The parent's side of file-worker.ts: one ChromeWorker per held folder, so a call stuck in the kernel stalls only
// that export's worker, never the main thread, and the export's step limit still ends it. A refused call rejects with
// `{ name: <errno name> }`, which exportFiles classifies like any platform error.

import type { FileIdentity, HeldFolder, UnnamedFile } from "./export-file.ts";
import type { Identity, WorkerAnswer, WorkerArch, WorkerRequest } from "./file-worker.ts";

/** What O_TMPFILE answers on a file system that cannot make an unnamed file: the export then names a part instead. */
const NO_UNNAMED_FILES = new Set(["EOPNOTSUPP", "EISDIR", "EINVAL"]);

type Ask = {
  [Op in WorkerRequest["op"]]: Omit<Extract<WorkerRequest, { op: Op }>, "id">;
}[WorkerRequest["op"]];

class FileWorker {
  readonly #worker: ChromeWorker;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }
  >();
  #next = 1;

  constructor(url: string, arch: WorkerArch) {
    this.#worker = new ChromeWorker(url);
    this.#worker.onmessage = ({ data }: { readonly data: WorkerAnswer }) => {
      const waiting = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      if (data.ok) waiting?.resolve(data.value);
      else waiting?.reject({ name: data.errno });
    };
    this.#worker.onerror = () => {
      for (const waiting of this.#pending.values()) waiting.reject({ name: "worker-error" });
      this.#pending.clear();
    };
    void this.ask({ op: "init", arch }).catch(() => undefined);
  }

  ask<T>(request: Ask): Promise<T> {
    const id = this.#next;
    this.#next += 1;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage takes no origin
      this.#worker.postMessage({ ...request, id });
    });
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

const sameIdentity = (identity: Identity): FileIdentity => ({
  dev: identity.dev,
  ino: identity.ino,
});

/** Holds `realFolder` open in a new worker. The worker ends once the folder and its file are closed. */
export const holdFolderIn =
  (url: string, arch: WorkerArch, mode: number) =>
  async (realFolder: string): Promise<HeldFolder> => {
    const worker = new FileWorker(url, arch);
    const held = await worker
      .ask<{ readonly fd: number }>({ op: "hold-folder", path: realFolder })
      .catch((error: unknown) => {
        worker.terminate();
        throw error;
      });
    const folder = held.fd;
    /** Closed in order once nothing needs them, and the worker ended after the last close answered. */
    const open = new Set<number>([folder]);
    const closeFd = (fd: number): void => {
      if (!open.delete(fd)) return;
      const closing = worker.ask({ op: "close", fd }).catch(() => undefined);
      if (open.size === 0) void closing.then(() => worker.terminate());
    };
    const unnamed = (fd: number, identity: Identity): UnnamedFile => {
      open.add(fd);
      return {
        identity: sameIdentity(identity),
        write: async (text) => {
          await worker.ask({ op: "write", fd, text });
        },
        size: () => worker.ask<number>({ op: "size", fd }),
        readHead: async (bytes) =>
          new Uint8Array(await worker.ask<ArrayBuffer>({ op: "head", fd, bytes })),
        link: (name) => worker.ask<boolean>({ op: "link", fd, folder, name }),
        close: () => closeFd(fd),
      };
    };
    return {
      where: () => worker.ask<string | null>({ op: "where", fd: folder }),
      createUnnamed: async () => {
        try {
          const made = await worker.ask<{ readonly fd: number; readonly identity: Identity }>({
            op: "create",
            folder,
            mode,
          });
          return unnamed(made.fd, made.identity);
        } catch (error) {
          const name = (error as { readonly name?: unknown }).name;
          if (typeof name === "string" && NO_UNNAMED_FILES.has(name)) return null;
          throw error;
        }
      },
      identityOf: async (name) => {
        const found = await worker.ask<Identity | null>({ op: "identity-at", folder, name });
        return found === null ? null : sameIdentity(found);
      },
      close: () => closeFd(folder),
    };
  };
