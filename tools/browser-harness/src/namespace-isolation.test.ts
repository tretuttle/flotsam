import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  judgeIsolation,
  LAUNCHER_MARKER,
  requireIsolatedPidNamespace,
  runNamespacedSuites,
} from "./namespace-isolation.ts";
import type { ProcessIdentity } from "./signal-policy.ts";
import { processIdentity } from "./simulated-process-io.ts";

const launcher = processIdentity(1, {
  parentPid: 0,
  args: ["sh", "-c", "script", LAUNCHER_MARKER, "prlimit", "--core=1:1", "--", "vp"],
});
const vitest = processIdentity(2, { parentPid: 1, args: ["node", "vp", "test"] });
const worker = processIdentity(9, { parentPid: 2, args: ["node", "worker"] });
const table = (...rows: ProcessIdentity[]) => new Map(rows.map((row) => [row.pid, row]));

describe("PID namespace isolation", () => {
  it("accepts a namespace whose PID 1 is the launcher and where the named host process is invisible", () => {
    expect(
      judgeIsolation({ table: table(launcher, vitest, worker), sentinel: "4242:777" }),
    ).toEqual({ isolated: true });
  });

  it.each([
    {
      name: "no host process was named",
      rows: [launcher, vitest],
      sentinel: undefined,
      reason: /no host process was named/,
    },
    {
      name: "PID 1 is the host's init (launcher ran without --pid --mount-proc)",
      rows: [processIdentity(1, { parentPid: 0, args: ["/sbin/init"] }), vitest],
      sentinel: "4242:777",
      reason: /PID 1 is not the namespace launcher \(\/sbin\/init\)/,
    },
    {
      name: "the named host process is visible",
      rows: [launcher, vitest, processIdentity(4242, { parentPid: 1, startTime: "777" })],
      sentinel: "4242:777",
      reason: /host process 4242 is visible/,
    },
    {
      name: "a process does not descend from the launcher",
      rows: [launcher, { ...vitest, parentPid: 0 }],
      sentinel: "4242:777",
      reason: /process 2 \(node vp test\) does not descend from the launcher/,
    },
  ])("refuses when $name", ({ rows, sentinel, reason }) => {
    const verdict = judgeIsolation({ table: table(...rows), sentinel });
    expect(verdict.isolated).toBe(false);
    expect(verdict.isolated ? "" : verdict.reason).toMatch(reason);
  });

  it("refuses to run real-signal tests in this test process, even when its environment claims a namespaced run", () => {
    const refusal = /refusing to run real-signal tests outside an isolated PID namespace/;
    expect(() => requireIsolatedPidNamespace()).toThrow(refusal);
    const claimed = ["ONE_CLICK_HAR_NAMESPACE_RUN", "ONE_CLICK_HAR_HOST_SENTINEL"] as const;
    const previous = claimed.map((name) => process.env[name]);
    process.env.ONE_CLICK_HAR_NAMESPACE_RUN = "1";
    process.env.ONE_CLICK_HAR_HOST_SENTINEL = "999999999:1";
    try {
      expect(() => requireIsolatedPidNamespace()).toThrow(refusal);
    } finally {
      claimed.forEach((name, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});

describe("namespaced real-signal suites", () => {
  it("run in a fresh PID and user namespace and pass", async (ctx) => {
    const run = await runNamespacedSuites(NodePath.resolve(import.meta.dirname, ".."));
    if (run.outcome === "unavailable") {
      const reason = `the *.namespace.test.ts suites need an unprivileged PID and user namespace, and this machine refused one: ${run.reason}`;
      if (process.env.CI) {
        throw new Error(`${reason}. CI must run them (see docs/internals/browser-harness.md).`);
      }
      process.stderr.write(`warning: skipping ${reason}\n`);
      ctx.skip(reason);
      return;
    }
    if (run.outcome === "failed") throw new Error(`namespaced suites failed: ${run.detail}`);
    process.stderr.write(`namespaced suites passed inside a PID namespace:\n${run.summary}\n`);
  });
});
