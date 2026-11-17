import { describe, expect, it } from "vite-plus/test";
import {
  exposureProblems,
  schemaContexts,
  surfaceChanges,
  type ExposureEvidence,
  type RuntimeSurface,
} from "./exposure.ts";

const POPUP = "moz-extension://u/action/index.html";
const OPTIONS = "moz-extension://u/options/index.html";

// What Zen Twilight 1.25t read from the packed recorder in the baseline run.
const SURFACE: RuntimeSurface = {
  webAccessibleResources: [],
  webAccessiblePaths: [],
  substitutions: ["resource://gre/ -> jar:file:///opt/zen/omni.ja!/"],
  chromePackages: ["chrome://global/ -> jar:file:///opt/zen/omni.ja!/content/global/"],
  pages: [
    { href: POPUP, windowListeners: [], frames: 0, echo: null },
    { href: OPTIONS, windowListeners: [], frames: 0, echo: null },
  ],
};
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
  externalListeners: [],
  pageUrls: [POPUP, OPTIONS],
  start: SURFACE,
  end: SURFACE,
};

describe("recorder exposure", () => {
  it("allows the baseline recorder", () => {
    expect(exposureProblems(BASELINE)).toEqual([]);
  });

  it("names every surface outside the allowed set, at the moment it was seen", () => {
    const wideSurface: RuntimeSurface = {
      ...SURFACE,
      webAccessibleResources: [{ resources: ["/experiment/*"] }],
      webAccessiblePaths: ["experiment/parent.js"],
      pages: [
        {
          href: POPUP,
          windowListeners: ["message", "messageerror:capture", "click"],
          frames: 2,
          echo: '{"oneClickHar":1}',
        },
      ],
    };
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
      externalListeners: ["shared/commons.js: onMessageExternal"],
      start: wideSurface,
      end: wideSurface,
    };
    const runtime = [
      'runtime webAccessibleResources [{"resources":["/experiment/*"]}]',
      "web accessible at runtime: experiment/parent.js",
      `${POPUP} listens for message`,
      `${POPUP} listens for messageerror:capture`,
      `${POPUP} holds 2 frames`,
      `${POPUP} answered postMessage: {"oneClickHar":1}`,
      `page ${OPTIONS} was not read`,
    ];
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
      "external listener shared/commons.js: onMessageExternal",
      ...runtime.map((line) => `at start: ${line}`),
      ...runtime.map((line) => `at end: ${line}`),
    ]);
  });

  it("fails anything that changed between the start and the end of the run", () => {
    const end: RuntimeSurface = {
      webAccessibleResources: [{ resources: ["/action/*"] }],
      webAccessiblePaths: ["action/index.html"],
      substitutions: [
        ...SURFACE.substitutions,
        "resource://one-click-har/ -> file:///w/data/one-click-har/k/",
      ],
      chromePackages: [],
      pages: [{ ...SURFACE.pages[0]!, frames: 1 }, SURFACE.pages[1]!],
    };
    expect(surfaceChanges(SURFACE, end)).toEqual([
      'during the run, webAccessibleResources gained {"resources":["/action/*"]}',
      'during the run, webAccessiblePaths gained "action/index.html"',
      'during the run, substitutions gained "resource://one-click-har/ -> file:///w/data/one-click-har/k/"',
      'during the run, chromePackages lost "chrome://global/ -> jar:file:///opt/zen/omni.ja!/content/global/"',
      `during the run, pages gained {"href":"${POPUP}","windowListeners":[],"frames":1,"echo":null}`,
      `during the run, pages lost {"href":"${POPUP}","windowListeners":[],"frames":0,"echo":null}`,
    ]);
    expect(surfaceChanges(SURFACE, SURFACE)).toEqual([]);
    expect(exposureProblems({ ...BASELINE, end: { ...SURFACE, chromePackages: [] } })).toEqual([
      'during the run, chromePackages lost "chrome://global/ -> jar:file:///opt/zen/omni.ja!/content/global/"',
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
    const oneFrame: RuntimeSurface = {
      ...SURFACE,
      pages: [SURFACE.pages[0]!, { ...SURFACE.pages[1]!, frames: 1 }],
    };
    expect(exposureProblems({ ...BASELINE, start: oneFrame, end: oneFrame })).toEqual([
      `at start: ${OPTIONS} holds 1 frames`,
      `at end: ${OPTIONS} holds 1 frames`,
    ]);
    expect(schemaContexts(null)).toEqual([]);
  });
});
