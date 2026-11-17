import { describe, expect, it } from "vite-plus/test";
import { exposureProblems, schemaContexts, type ExposureEvidence } from "./exposure.ts";

const POPUP = "moz-extension://u/action/index.html";
const OPTIONS = "moz-extension://u/options/index.html";

// What Zen Twilight 1.25t read from the packed recorder in the baseline run.
const BASELINE: ExposureEvidence = {
  manifestKeys: [
    "manifest_version",
    "name",
    "version",
    "description",
    "browser_specific_settings",
    "icons",
    "action",
    "options_ui",
    "experiment_apis",
  ],
  experimentApis: {
    oneClickHar: {
      schema: "experiment/schema.json",
      parent: { scopes: ["addon_parent"], script: "experiment/parent.js", events: ["startup"] },
    },
  },
  schemaContexts: [],
  contentScripts: [],
  background: null,
  declaredWebAccessible: [],
  runtimeWebAccessible: [[], []],
  webAccessiblePaths: [],
  externalListeners: [],
  pages: [
    { href: POPUP, windowListeners: [], frames: 0, echo: null },
    { href: OPTIONS, windowListeners: [], frames: 0, echo: null },
  ],
  declaredPages: [POPUP, OPTIONS],
};

describe("recorder exposure", () => {
  it("allows the baseline recorder", () => {
    expect(exposureProblems(BASELINE)).toEqual([]);
  });

  it("names every surface outside the allowed set", () => {
    const wide: ExposureEvidence = {
      ...BASELINE,
      manifestKeys: [...BASELINE.manifestKeys, "content_scripts", "externally_connectable"],
      experimentApis: {
        oneClickHar: {
          schema: "s.json",
          parent: { scopes: ["addon_parent", "content_parent"] },
          child: { scopes: ["content_child"] },
        },
        other: "x",
        bare: { schema: "t.json" },
      },
      schemaContexts: ['s.json: $[0].allowedContexts = ["content"]'],
      contentScripts: [{ matches: ["<all_urls>"] }],
      background: { scripts: ["b.js"] },
      declaredWebAccessible: [{ resources: ["action/*"] }],
      runtimeWebAccessible: [[], [{ resources: ["/experiment/*"] }]],
      webAccessiblePaths: ["experiment/parent.js"],
      externalListeners: ["shared/commons.js: onMessageExternal"],
      pages: [
        {
          href: POPUP,
          windowListeners: ["message", "messageerror:capture", "click"],
          frames: 2,
          echo: '{"oneClickHar":1}',
        },
      ],
    };
    expect(exposureProblems(wide)).toEqual([
      "manifest key content_scripts",
      "manifest key externally_connectable",
      "experiment_apis.oneClickHar.child",
      'experiment_apis.oneClickHar.parent.scopes ["addon_parent","content_parent"]',
      "experiment_apis.other is not an object",
      "experiment_apis.bare.parent.scopes null",
      'schema s.json: $[0].allowedContexts = ["content"]',
      'content scripts [{"matches":["<all_urls>"]}]',
      'background {"scripts":["b.js"]}',
      'web_accessible_resources [{"resources":["action/*"]}]',
      'runtime webAccessibleResources [{"resources":["/experiment/*"]}]',
      "web accessible at runtime: experiment/parent.js",
      "external listener shared/commons.js: onMessageExternal",
      `${POPUP} listens for message`,
      `${POPUP} listens for messageerror:capture`,
      `${POPUP} holds 2 frames`,
      `${POPUP} answered postMessage: {"oneClickHar":1}`,
      `declared page ${OPTIONS} was not read`,
    ]);
  });

  it("finds allowedContexts at any depth of a schema, with its path", () => {
    const schema = [
      {
        namespace: "oneClickHar",
        allowedContexts: ["content"],
        functions: [{ name: "f", allowedContexts: ["devtools"] }],
      },
    ];
    expect(schemaContexts(schema)).toEqual([
      '$[0].allowedContexts = ["content"]',
      '$[0].functions[0].allowedContexts = ["devtools"]',
    ]);
    expect(schemaContexts([{ namespace: "x", functions: [] }])).toEqual([]);
    expect(schemaContexts("text")).toEqual([]);
  });
});

describe("exposure edge cases", () => {
  it("names an experiment API that is null, a single frame, and reads a null schema as nothing", () => {
    expect(exposureProblems({ ...BASELINE, experimentApis: { x: null } })).toEqual([
      "experiment_apis.x is not an object",
    ]);
    expect(
      exposureProblems({
        ...BASELINE,
        pages: [BASELINE.pages[0]!, { ...BASELINE.pages[1]!, frames: 1 }],
      }),
    ).toEqual([`${OPTIONS} holds 1 frames`]);
    expect(schemaContexts(null)).toEqual([]);
  });
});
