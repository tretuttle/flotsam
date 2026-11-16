import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  environmentKeys,
  oneClickHarApi,
  namespace,
  type Environment,
  type OneClickHarApi,
} from "./contract.ts";
import { toGeckoSchema } from "./gecko-schema.ts";
import { createOneClickHarApi } from "./parent-api.ts";

const api = createOneClickHarApi({
  identity: () => ({ name: "Zen", version: "1.25t", buildId: "20261115114312" }),
  toolbox: (tabId) =>
    tabId === 1 ? { open: true, host: "bottom" } : { open: false, reason: "no-such-tab" },
});

/** The contract test's own check, so the planted negative case proves it can see an extra key. */
const assertKeys = (value: object, expected: readonly string[]): void => {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
};

describe("oneClickHar contract", () => {
  it("generates the schema.json Gecko loads: async functions, validated parameters, no return schema", () => {
    expect(toGeckoSchema(namespace, oneClickHarApi)).toEqual([
      {
        namespace: "oneClickHar",
        functions: [
          {
            name: "getEnvironment",
            type: "function",
            async: true,
            parameters: [{ name: "tabId", type: "integer", minimum: 0 }],
          },
        ],
      },
    ]);
  });

  it("types exactly the functions in the table, for callers and for the parent script", () => {
    expectTypeOf<keyof OneClickHarApi>().toEqualTypeOf<"getEnvironment">();
    expectTypeOf<OneClickHarApi["getEnvironment"]>().toEqualTypeOf<
      (tabId: number) => Promise<Environment>
    >();
  });

  it("returns exactly the contract's keys at run time, whatever the toolbox state", async () => {
    const closed = await api.getEnvironment(0);
    assertKeys(closed, environmentKeys.result);
    assertKeys(closed.browser, environmentKeys.browser);
    if (closed.toolbox.open) throw new Error("tab 0 has no toolbox");
    assertKeys(closed.toolbox, environmentKeys.toolboxClosed);

    const open = await api.getEnvironment(1);
    assertKeys(open, environmentKeys.result);
    assertKeys(open.browser, environmentKeys.browser);
    if (!open.toolbox.open) throw new Error("tab 1 has a toolbox");
    assertKeys(open.toolbox, environmentKeys.toolboxOpen);
  });

  it("fails the key comparison when a returned variable carries an extra property", async () => {
    const withExtra = { ...(await api.getEnvironment(0)), extra: true };
    expect(() => assertKeys(withExtra, environmentKeys.result)).toThrow();
  });

  it("is declared in the manifest as an addon_parent experiment under the same namespace", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", "src", "manifest.json"), "utf8"),
    );
    expect(manifest.experiment_apis[namespace].parent).toMatchObject({
      scopes: ["addon_parent"],
      paths: [[namespace]],
    });
  });
});
