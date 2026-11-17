import type { ExportId, ExportRequest } from "@one-click-har/export/jobs";
import type { ExportReport } from "@one-click-har/export/report";
import { parseExportRequest } from "@one-click-har/export/jobs";
import type { ByteCount, EpochMs } from "@one-click-har/recording/ids";
import { describe, expect, it } from "vite-plus/test";
import { createExportJobs, KEPT_JOBS, type ExportRun, type RunOutcome } from "./export-jobs.ts";

const request = parseExportRequest({
  selection: { scope: "everything", range: { kind: "everything" }, include: "all" },
  bodies: "include",
  redaction: "standard",
  packaging: "har",
  fileName: null,
}) as ExportRequest;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const done: RunOutcome = {
  kind: "done",
  fileName: "a.har",
  folderLabel: "Downloads",
  report: {} as ExportReport,
};

const slot = (run: ExportRun) => {
  let n = 0;
  return createExportJobs({
    run,
    now: () => 0 as EpochMs,
    newId: () => {
      n += 1;
      return `job-${String(n)}` as ExportId;
    },
    plannedName: () => "planned.har",
    onChange: () => undefined,
  });
};

describe("the export slot", () => {
  it("runs one job at a time, lists newest first, and a waiting job reads as writing with nothing done", async () => {
    const gates = [deferred<RunOutcome>(), deferred<RunOutcome>()];
    const started: string[] = [];
    const jobs = slot(async (job) => {
      started.push(job.id);
      return gates[started.length - 1]!.promise;
    });
    const first = jobs.start(request);
    const second = jobs.start(request);
    await Promise.resolve();
    expect(started).toEqual([first.id]);
    expect(jobs.list().map((job) => job.id)).toEqual([second.id, first.id]);
    expect(jobs.job(second.id)?.state).toEqual({ kind: "writing", done: 0, total: 0, bytes: 0 });
    gates[0]!.resolve(done);
    gates[1]!.resolve({ kind: "write-failed", failure: { kind: "folder-refused" } });
    await jobs.idle();
    expect(started).toEqual([first.id, second.id]);
    expect(jobs.job(first.id)?.state.kind).toBe("done");
    expect(jobs.job(second.id)?.state).toEqual({
      kind: "write-failed",
      failure: { kind: "folder-refused" },
    });
  });

  it("cancels a running job through its signal, records the bytes at cancel and at stop, and is idempotent", async () => {
    const chunk = 1000;
    const step = deferred<void>();
    const jobs = slot(async (_job, { signal, progress }) => {
      let bytes = 0;
      for (;;) {
        if (signal.aborted) return { kind: "cancelled" };
        bytes += chunk;
        progress({ done: 0, total: 1, bytes: bytes as ByteCount });
        if (bytes === 3 * chunk) await step.promise;
      }
    });
    const job = jobs.start(request);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(jobs.cancel(job.id)).toBe(true);
    expect(jobs.cancel(job.id)).toBe(true);
    step.resolve();
    await jobs.idle();
    expect(jobs.job(job.id)?.state).toEqual({ kind: "cancelled" });
    expect(jobs.audit(job.id)).toEqual({ bytesAtCancel: 3 * chunk, bytesAtStop: 3 * chunk });
    expect(jobs.cancel(job.id)).toBe(true);
  });

  it("never runs a job cancelled while it waited, and refuses to cancel a finished or unknown job", async () => {
    const gate = deferred<RunOutcome>();
    let runs = 0;
    const jobs = slot(async () => {
      runs += 1;
      return gate.promise;
    });
    const first = jobs.start(request);
    const waiting = jobs.start(request);
    expect(jobs.cancel(waiting.id)).toBe(true);
    gate.resolve(done);
    await jobs.idle();
    expect(runs).toBe(1);
    expect(jobs.job(waiting.id)?.state).toEqual({ kind: "cancelled" });
    expect(jobs.cancel(first.id)).toBe(false);
    expect(jobs.cancel("nope" as ExportId)).toBe(false);
  });

  it("turns a run that throws into write-failed, and keeps the newest jobs", async () => {
    const jobs = slot(async () => {
      throw new Error("boom");
    });
    for (let i = 0; i < KEPT_JOBS + 3; i += 1) jobs.start(request);
    await jobs.idle();
    const listed = jobs.list();
    expect(listed).toHaveLength(KEPT_JOBS);
    expect(listed[0]?.id).toBe(`job-${String(KEPT_JOBS + 3)}`);
    expect(listed[0]?.state).toEqual({
      kind: "write-failed",
      failure: { kind: "other", detail: "Error: boom" },
    });
  });
});
