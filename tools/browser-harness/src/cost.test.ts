import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  COST_ARMS,
  computeBudget,
  costBaselineFileName,
  detectSlowArm,
  rotateArms,
  runCostArm,
  summarizeCostSamples,
  writeCostBaselines,
  type CostBaselineFile,
  type CostSample,
  type CostScenarioResult,
} from "./cost.ts";
import { getCostScenario } from "./scenarios.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("three-arm cost measurement", () => {
  it("rotates arms across rounds", () => {
    expect(COST_ARMS).toEqual(["off", "extension", "panel"]);
    expect(rotateArms(0)).toEqual(["off", "extension", "panel"]);
    expect(rotateArms(1)).toEqual(["extension", "panel", "off"]);
    expect(rotateArms(2)).toEqual(["panel", "off", "extension"]);
    expect(rotateArms(3)).toEqual(["off", "extension", "panel"]);
  });

  it("drops round 0 warmup and computes median and spread over scored rounds", () => {
    const samples: CostSample[] = [
      sample(0, "off", 999),
      sample(1, "off", 40),
      sample(2, "off", 50),
      sample(3, "off", 45),
      sample(0, "extension", 888),
      sample(1, "extension", 42),
      sample(2, "extension", 54),
      sample(3, "extension", 48),
    ];
    const offSummary = summarizeCostSamples(samples, "off");
    expect(offSummary.scoredRunCount).toBe(3);
    expect(offSummary.parentCpuMs).toEqual({
      median: 45,
      spread: 10,
      min: 40,
      max: 50,
      runCount: 3,
    });
    const extSummary = summarizeCostSamples(samples, "extension");
    expect(extSummary.parentCpuMs).toEqual({
      median: 48,
      spread: 12,
      min: 42,
      max: 54,
      runCount: 3,
    });
  });

  it("detects a planted slow arm exceeding off + half(panel - off)", () => {
    expect(computeBudget(40, 120)).toBe(80);
    expect(
      detectSlowArm({
        arm: "extension",
        observedMedianMs: 65,
        offMedianMs: 40,
        panelMedianMs: 120,
      }),
    ).toMatchObject({ ok: true, budgetMs: 80, reason: null });

    const planted = detectSlowArm({
      arm: "extension",
      observedMedianMs: 95,
      offMedianMs: 40,
      panelMedianMs: 120,
    });
    expect(planted.ok).toBe(false);
    expect(planted.reason).toMatch(/extension median 95\.0 ms exceeded budget 80\.0 ms/);
  });

  it("drives the panel arm through chrome toolbox open, navigate, and close", async () => {
    const scenario = getCostScenario("cost-images");
    const calls: string[] = [];
    let cpu = 100;
    const result = await runCostArm({
      session: {
        browserPid: 4242,
        openTab: async (url) => {
          calls.push(`open:${url}`);
          return "tab-1";
        },
        navigateTab: async (_ctx, url) => {
          calls.push(`nav:${url}`);
        },
        evaluate: async (_ctx, expr) => {
          calls.push(`eval:${expr}`);
          return JSON.stringify({
            lastResourceFinishedMs: 55,
            finished: scenario.responses
              .map((r) => r.path)
              .filter((path) => path !== scenario.pagePath),
            failed: [],
          });
        },
        evaluateChrome: async (script) => {
          calls.push(
            script.includes("showToolboxForTab") ? "chrome:openPanel" : "chrome:closePanel",
          );
          return true;
        },
        closeTab: async () => {
          calls.push("closeTab");
        },
      },
      server: {
        origin: "http://127.0.0.1:1234",
        takeRequests: () =>
          scenario.responses.map((r, index) => ({
            seq: index + 1,
            method: r.method,
            path: r.path,
            url: r.path,
            status: 200,
          })),
      },
      scenario,
      round: 1,
      arm: "panel",
      inspect: () => {
        cpu += 25;
        return { parentPid: 1, workingSetBytes: 500_000_000, cpuTimeMs: cpu };
      },
      signal: new AbortController().signal,
    });

    expect(calls).toEqual([
      "open:about:blank",
      "chrome:openPanel",
      "nav:http://127.0.0.1:1234/cost/images",
      "eval:window.__harnessReady",
      "chrome:closePanel",
      "closeTab",
    ]);
    expect(result.parentCpuMs).toBe(25);
    expect(result.lastResourceFinishedMs).toBe(55);
  });

  it("refuses to write cost baselines when errors > 0 and writes off and panel when errors === 0", async () => {
    const outDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "one-click-har-cost-"));
    cleanupDirs.push(outDir);
    const failed = costResultStub(1);
    await expect(writeCostBaselines(failed, outDir)).rejects.toThrow(
      /refusing to write cost baselines with 1 failed runs/,
    );
    expect(NodeFS.readdirSync(outDir)).toEqual([]);

    const ok = costResultStub(0);
    const written = await writeCostBaselines(ok, outDir);
    expect(written).toHaveLength(2);
    for (const filePath of written) {
      const parsed = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as CostBaselineFile;
      expect(parsed.errors).toBe(0);
      expect(parsed.warmupDropped).toBe(1);
      expect(parsed.runCount).toBe(1);
    }
  });
});

describe("committed cost baselines", () => {
  const directory = NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
    "baselines",
    "cost",
  );
  const files = NodeFS.existsSync(directory)
    ? NodeFS.readdirSync(directory).filter((name) => name.endsWith(".json"))
    : [];

  it("validates every committed off/panel cost baseline file", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const name of files) {
      const baseline = JSON.parse(
        NodeFS.readFileSync(NodePath.join(directory, name), "utf8"),
      ) as CostBaselineFile;
      expect(["off", "panel"]).toContain(baseline.arm);
      expect(baseline.errors).toBe(0);
      expect(baseline.failures).toEqual([]);
      expect(baseline.warmupDropped).toBe(1);
      expect(baseline.samples).toHaveLength(baseline.runCount);
      expect(baseline.parentCpuMs?.runCount).toBe(baseline.runCount);
      expect(baseline.lastResourceFinishedMs?.runCount).toBe(baseline.runCount);
      expect(baseline.load.before).toBeDefined();
      expect(baseline.load.after).toBeDefined();
    }
  });
});

function sample(round: number, arm: CostSample["arm"], cpuMs: number): CostSample {
  return {
    round,
    arm,
    lastResourceFinishedMs: cpuMs + 5,
    parentWorkingSetBytes: 600_000_000,
    parentCpuMs: cpuMs,
    wallMs: cpuMs + 20,
    requestCount: 201,
  };
}

function costResultStub(errors: number): CostScenarioResult {
  const offSample = sample(1, "off", 40);
  const extSample = sample(1, "extension", 42);
  const panelSample = sample(1, "panel", 120);
  const all = [offSample, extSample, panelSample];
  return {
    scenario: "cost-images",
    rounds: 2,
    warmupDropped: 1,
    errors,
    failures: errors === 0 ? [] : [{ run: 1, reason: "planted failure" }],
    warmupSamples: [],
    scoredSamples: all,
    arms: {
      off: summarizeCostSamples(all, "off"),
      extension: summarizeCostSamples(all, "extension"),
      panel: summarizeCostSamples(all, "panel"),
    },
    budget: { parentCpuMs: 80, lastResourceFinishedMs: 85 },
    browser: {
      binaryPath: "/zen",
      name: "zen",
      version: "1.25t",
      buildId: "20261115114312",
      userAgent: "Mozilla",
      remoteProtocol: "marionette",
      headless: true,
    },
    machine: {
      platform: "linux",
      release: "1",
      arch: "x64",
      cpuModel: "test",
      cpuCount: 1,
      totalMemoryBytes: 1,
    },
    load: {
      before: { cpuBusyPercent: 1, loadAverage: [0.1, 0.1, 0.1] },
      after: { cpuBusyPercent: 1, loadAverage: [0.1, 0.1, 0.1] },
    },
  };
}

void costBaselineFileName;
