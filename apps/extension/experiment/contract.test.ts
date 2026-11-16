import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { oneClickHarApi, namespace, type Environment, type OneClickHarApi } from "./contract.ts";
import { toGeckoSchema } from "./gecko-schema.ts";

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
