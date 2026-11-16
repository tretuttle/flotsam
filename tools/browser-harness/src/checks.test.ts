import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { runEnvironmentVerification, verifyBrowserIdentity } from "../checks/environment.ts";
import { runRestartVerification } from "../checks/restart.ts";
import { discoverChecks, runDiscoveredChecks } from "./checks.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("check discovery", () => {
  it("discovers environment, restart, and cost-baseline checks", async () => {
    const checks = await discoverChecks();
    expect(checks.map((item) => item.name)).toEqual(["cost-baseline", "environment", "restart"]);
  });

  it("discovers new check files without editing a shared registry and reports planted failures", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-checks-"));
    cleanupDirs.push(dir);
    await NodeFSP.writeFile(
      NodePath.join(dir, "alpha.ts"),
      `export const check = {
        name: "alpha",
        description: "passing check",
        run: async () => ({ name: "alpha", ok: true, durationMs: 1, detail: "ok" }),
      };\n`,
      "utf8",
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "beta.ts"),
      `export const check = {
        name: "beta",
        description: "planted failing check",
        run: async () => ({ name: "beta", ok: false, durationMs: 1, detail: "planted mismatch" }),
      };\n`,
      "utf8",
    );

    const outDir = NodePath.join(dir, "out");
    const run = await runDiscoveredChecks({
      checksDir: dir,
      context: {
        binaryPath: process.execPath,
        extensionPath: null,
        display: "headless",
        short: true,
        outDir,
        signal: new AbortController().signal,
        log: () => undefined,
      },
    });
    expect(run.ok).toBe(false);
    expect(run.results.map((r) => ({ name: r.name, ok: r.ok }))).toEqual([
      { name: "alpha", ok: true },
      { name: "beta", ok: false },
    ]);
    const saved = JSON.parse(
      await NodeFSP.readFile(NodePath.join(outDir, "check-results.json"), "utf8"),
    ) as { ok: boolean };
    expect(saved.ok).toBe(false);
  });

  it("rejects a check file whose exported name does not match its filename", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-checks-"));
    cleanupDirs.push(dir);
    await NodeFSP.writeFile(
      NodePath.join(dir, "wrong.ts"),
      `export const check = { name: "other", description: "bad", run: async () => ({ name: "other", ok: true, durationMs: 0, detail: "" }) };\n`,
      "utf8",
    );
    await expect(discoverChecks(dir)).rejects.toThrow(/must match filename wrong/);
  });

  it("verifies browser identity against session capabilities and catches planted mismatches", async () => {
    expect(
      verifyBrowserIdentity(
        { name: "Zen", version: "1.25t", buildId: "20261115114312" },
        { name: "zen", version: "1.25t", buildId: "20261115114312" },
      ),
    ).toBeNull();
    expect(
      verifyBrowserIdentity(
        { name: "Zen", version: "1.25t", buildId: "20261115114312" },
        { name: "zen", version: "9.99z", buildId: "20261115114312" },
      ),
    ).toMatch(/version expected 9\.99z got 1\.25t/);
    expect(
      verifyBrowserIdentity(
        { name: "Firefox", version: "161.0", buildId: "20261113104103" },
        { name: "zen", version: "161.0", buildId: "20261113104103" },
      ),
    ).toMatch(/name expected zen got Firefox/);
    expect(
      verifyBrowserIdentity(
        { name: "Zen", version: "1.25t", buildId: "0000" },
        { name: "zen", version: "1.25t", buildId: "20261115114312" },
      ),
    ).toMatch(/buildId expected 20261115114312 got 0000/);
    await expect(
      runEnvironmentVerification({
        binaryPath: process.execPath,
        extensionPath: null,
        display: "headless",
        short: true,
        outDir: null,
        signal: new AbortController().signal,
        log: () => undefined,
      }),
    ).resolves.toMatchObject({ name: "environment", ok: false });
    await expect(
      runRestartVerification({
        binaryPath: process.execPath,
        extensionPath: null,
        display: "headless",
        short: true,
        outDir: null,
        signal: new AbortController().signal,
        log: () => undefined,
      }),
    ).resolves.toMatchObject({ name: "restart", ok: false });
  });
});
