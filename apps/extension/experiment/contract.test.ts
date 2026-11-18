import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { ExportJob, Preview } from "@one-click-har/export/jobs";
import type { Site } from "@one-click-har/recording/ids";
import type { StoredSettings } from "@one-click-har/recording/settings";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  environmentKeys,
  oneClickHarApi,
  namespace,
  type Environment,
  type OneClickHarApi,
  type RecordingStatus,
} from "./contract.ts";
import {
  asyncFunction,
  returns,
  toGeckoSchema,
  type ApiParameters,
  type ApiResults,
  type AsyncFunction,
  type ApiTable,
} from "./gecko-schema.ts";
import {
  createOneClickHarApi,
  recordingStatus,
  type Host,
  type RecordingFacts,
} from "./parent-api.ts";

const healthy: RecordingFacts = {
  archive: null,
  strictOriginPolicy: true,
  settingsRejected: false,
  writeFailures: 0,
  liveOverflow: 0,
};

const preview: Preview = {
  requests: 3,
  sources: { both: 0, recordingOnly: 3, devtoolsOnly: 0 },
  bodyBytesAtMost: 10 as Preview["bodyBytesAtMost"],
  first: null,
  gate: null,
  inProgress: 0,
};

const host: Host = {
  identity: () => ({ name: "Zen", version: "1.25t", buildId: "20261115114312" }),
  toolbox: (tabId) =>
    tabId === 1 ? { open: true, host: "bottom" } : { open: false, reason: "no-such-tab" },
  recording: () => healthy,
  popup: async (tab) => ({
    tab: tab.tabId === null ? { kind: "no-tab" } : { kind: "no-such-tab", tabId: tab.tabId },
    site: null,
    devtools: "closed",
    gate: null,
    rows: [],
    running: null,
    last: null,
    defaults: { bodies: "include", redaction: "standard" },
  }),
  preview: async () => preview,
  exports: {
    start: () => {
      throw new Error("not started in this test");
    },
    list: () => [],
    cancel: () => false,
    reveal: async () => false,
    copyPath: () => false,
  },
};

const api = createOneClickHarApi(host, (message) => new TypeError(message));

/** The contract test's own check, so the planted negative case proves it can see an extra key. */
const assertKeys = (value: object, expected: readonly string[]): void => {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
};

type Step = readonly unknown[];
/** T's named members. An index signature's key is `string`, which would swallow every literal key in a union. */
type Named<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]-?: T[K];
};
/** What T's string index signature holds, when it has one. */
type Indexed<T> = string extends keyof T ? T[keyof T & string] : never;
/** Every named key at any depth of T, through arrays, unions and index signatures. */
type DeepKeys<T, D extends Step = []> = D["length"] extends 10
  ? never
  : T extends readonly (infer Item)[]
    ? DeepKeys<Item, [...D, 0]>
    : T extends object
      ?
          | { [K in keyof Named<T>]-?: K | DeepKeys<Named<T>[K], [...D, 0]> }[keyof Named<T>]
          | DeepKeys<Indexed<T>, [...D, 0]>
      : never;
/** Every value type at any depth of T. */
type DeepValues<T, D extends Step = []> = D["length"] extends 10
  ? T
  : T extends readonly (infer Item)[]
    ? DeepValues<Item, [...D, 0]>
    : T extends Uint8Array | ArrayBuffer
      ? T
      : T extends object
        ?
            | { [K in keyof Named<T>]-?: DeepValues<Named<T>[K], [...D, 0]> }[keyof Named<T>]
            | DeepValues<Indexed<T>, [...D, 0]>
        : T;

/** Keys that would hold a file path or HAR or body text. A label or a file's base name is not one of them. */
type PathOrBodyKey = "path" | "paths" | "folder" | "directory" | "text" | "content" | "har";
/** What crosses between a page and the host, both directions, for every row of a table. */
type Crossing<Table extends ApiTable> =
  | ApiResults<Table>[keyof Table]
  | ApiParameters<Table>[keyof Table][number];
type Leaks<Table extends ApiTable> =
  | Extract<DeepKeys<Crossing<Table>>, PathOrBodyKey>
  | Extract<DeepValues<Crossing<Table>>, Uint8Array | ArrayBuffer>;

/** How a failed export reaches a page, read from the table's own listExports row. */
type FailureOf<Table extends ApiTable> = Extract<
  Extract<ApiResults<Table>[keyof Table], readonly unknown[]>[number] extends infer Job
    ? Job extends { readonly state: infer State }
      ? State
      : never
    : never,
  { readonly kind: "write-failed" }
>["failure"];
/** Every field of a failure but its kind. A platform error's text names folders and the profile. */
type FailureFields<T> = T extends object
  ? { [K in Exclude<keyof T, "kind">]-?: T[K] }[Exclude<keyof T, "kind">]
  : never;
/**
 * Text anywhere in a failure: a field that is not a number, or a kind that is not a fixed word. Never for a contract
 * whose failures cannot carry a path.
 */
type FailureText<F> =
  | Exclude<FailureFields<F>, number>
  | (F extends { readonly kind: infer K } ? (string extends K ? K : never) : never);

describe("oneClickHar contract", () => {
  it("generates the schema.json Gecko loads: async functions, schema types, no parser and no return schema", () => {
    const [schema] = toGeckoSchema(namespace, oneClickHarApi);
    expect(schema?.namespace).toBe("oneClickHar");
    expect(schema?.functions.map((fn) => fn.name)).toEqual(Object.keys(oneClickHarApi));
    expect(schema?.functions[0]).toEqual({
      name: "getEnvironment",
      type: "function",
      async: true,
      parameters: [{ name: "tabId", type: "integer", minimum: 0 }],
    });
    expect(schema?.functions.find((fn) => fn.name === "startExport")?.parameters).toEqual([
      { name: "request", type: "any" },
    ]);
    expect(JSON.stringify(schema)).not.toContain("parse");
  });

  it("gives every parameter of every row a parser", () => {
    for (const [name, fn] of Object.entries(oneClickHarApi))
      for (const parameter of fn.parameters)
        expect(typeof parameter.parse, `${name}(${parameter.name})`).toBe("function");
  });

  it("types the functions in the table, for callers and for hosts", () => {
    expectTypeOf<OneClickHarApi["getRecordingStatus"]>().toEqualTypeOf<
      () => Promise<RecordingStatus>
    >();
    expectTypeOf<ReturnType<OneClickHarApi["getEnvironment"]>>().toEqualTypeOf<
      Promise<Environment>
    >();
    expectTypeOf<ReturnType<OneClickHarApi["listExports"]>>().toEqualTypeOf<
      Promise<readonly ExportJob[]>
    >();
  });

  it("carries no file path, body byte or HAR text in any row, in either direction", () => {
    expectTypeOf<Leaks<typeof oneClickHarApi>>().toEqualTypeOf<never>();
    const planted = {
      settings: asyncFunction([], returns<StoredSettings>()),
      body: asyncFunction([], returns<{ readonly chunk: Uint8Array }>()),
    };
    expectTypeOf<Extract<DeepKeys<StoredSettings>, "path">>().toEqualTypeOf<"path">();
    expectTypeOf<
      Extract<DeepKeys<{ readonly [scheme: string]: { readonly path: string } }>, "path">
    >().toEqualTypeOf<"path">();
    // @ts-expect-error -- planted: a row that returns settings, whose chosen folder has a path, must fail
    expectTypeOf<Leaks<Pick<typeof planted, "settings">>>().toEqualTypeOf<never>();
    // @ts-expect-error -- planted: a row that returns body bytes must fail
    expectTypeOf<Leaks<Pick<typeof planted, "body">>>().toEqualTypeOf<never>();
  });

  it("lets a failed export carry only a fixed kind and numbers, never text", () => {
    expectTypeOf<FailureOf<typeof oneClickHarApi>["kind"]>().toEqualTypeOf<
      | "disk-full"
      | "access-denied"
      | "read-only"
      | "not-a-folder"
      | "folder-missing"
      | "folder-refused"
      | "file-replaced"
      | "name-too-long"
      | "name-taken"
      | "io-error"
      | "copy-mismatch"
      | "timed-out"
      | "other"
    >();
    expectTypeOf<FailureText<FailureOf<typeof oneClickHarApi>>>().toEqualTypeOf<never>();
    type Planted<Failure> = {
      listExports: AsyncFunction<
        [],
        readonly { readonly state: { readonly kind: "write-failed"; readonly failure: Failure } }[]
      >;
    };
    type OldDetail = FailureText<FailureOf<Planted<{ kind: "other"; detail: string }>>>;
    type BrandedText = FailureText<FailureOf<Planted<{ kind: "other"; site: Site }>>>;
    // @ts-expect-error -- planted: the old { kind: "other", detail: String(error) } must fail
    expectTypeOf<OldDetail>().toEqualTypeOf<never>();
    // @ts-expect-error -- planted: a branded string field must fail
    expectTypeOf<BrandedText>().toEqualTypeOf<never>();
    // @ts-expect-error -- planted: a kind widened to string must fail
    expectTypeOf<FailureText<FailureOf<Planted<{ kind: string }>>>>().toEqualTypeOf<never>();
  });

  it("parses every argument before a handler runs, and rejects a negative or fractional tab id", async () => {
    await expect(api.getEnvironment(-1)).rejects.toThrow(
      "Invalid tabId for oneClickHar.getEnvironment.",
    );
    await expect(api.getEnvironment(1.5)).rejects.toThrow(TypeError);
    await expect(api.getEnvironment("1")).rejects.toThrow(TypeError);
    await expect(api.getPopup({ tabId: -1 })).rejects.toThrow(
      "Invalid tab for oneClickHar.getPopup.",
    );
    await expect(api.getPopup({})).rejects.toThrow(TypeError);
    await expect(
      api.preview({ scope: "tab", tabId: -1, range: { kind: "everything" }, include: "all" }),
    ).rejects.toThrow(TypeError);
    await expect(api.cancelExport("../x")).rejects.toThrow(TypeError);
    await expect(api.listExports("extra")).rejects.toThrow(TypeError);
  });

  it("answers tab 0, an unknown tab and no tab with states, never an error", async () => {
    expect((await api.getEnvironment(0)).toolbox).toEqual({ open: false, reason: "no-such-tab" });
    expect((await api.getPopup({ tabId: 0 })).tab).toEqual({ kind: "no-such-tab", tabId: 0 });
    expect((await api.getPopup({ tabId: 999999 })).tab).toEqual({
      kind: "no-such-tab",
      tabId: 999999,
    });
    expect((await api.getPopup({ tabId: null })).tab).toEqual({ kind: "no-tab" });
    expect(
      await api.preview({ scope: "everything", range: { kind: "everything" }, include: "all" }),
    ).toBe(preview);
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

    assertKeys(await api.getRecordingStatus(), environmentKeys.recordingStatus);
  });

  it("reports a file:// page's way into the archive as a problem, and recording as on while the archive opened", async () => {
    expect(recordingStatus(healthy)).toEqual({ recording: true, problems: [] });
    expect(recordingStatus({ ...healthy, strictOriginPolicy: false })).toEqual({
      recording: true,
      problems: ["file-pages-can-read-files"],
    });
    expect(recordingStatus({ ...healthy, archive: "refused", writeFailures: 2 })).toEqual({
      recording: false,
      problems: ["archive-refused", "write-failed"],
    });
    expect((await api.getPopup({ tabId: null })).problems).toEqual([]);
    expect(recordingStatus({ ...healthy, overCapWhileExporting: true })).toEqual({
      recording: true,
      problems: ["over-cap-while-exporting"],
    });
    expect(recordingStatus({ ...healthy, unreadableEntries: 2 })).toEqual({
      recording: true,
      problems: ["archive-entries-unreadable"],
    });
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
