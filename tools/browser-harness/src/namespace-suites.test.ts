import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { runNamespacedSuites } from "./namespace-isolation.ts";

describe("namespaced real-signal suites", () => {
  it("run in a fresh PID and user namespace, pass, and leave no private TMPDIR behind", async (ctx) => {
    // The run makes its private TMPDIR inside this one, which must be empty again afterwards.
    const outer = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "one-click-har-ns-outer-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = outer;
    let leftover: string[] = [];
    const run = await runNamespacedSuites(NodePath.resolve(import.meta.dirname, "..")).finally(
      () => {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        leftover = NodeFS.readdirSync(outer);
        NodeFS.rmSync(outer, { recursive: true, force: true });
      },
    );
    if (run.outcome === "unavailable") {
      const reason = `the *.namespace.test.ts suites need an unprivileged user namespace, and this machine refused one: ${run.reason}`;
      if (process.env.CI) {
        throw new Error(`${reason}. CI must run them (see docs/internals/browser-harness.md).`);
      }
      process.stderr.write(`warning: skipping ${reason}\n`);
      ctx.skip(reason);
      return;
    }
    if (run.outcome === "failed") throw new Error(`namespaced suites failed: ${run.detail}`);
    expect(leftover).toEqual([]);
    expect(run.summary).toMatch(/^\s*Test Files\s.*passed.*\n\s*Tests\s.*passed/u);
    process.stderr.write(`namespaced suites passed inside a PID namespace:\n${run.summary}\n`);
  });
});
