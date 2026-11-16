import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { bundleParent } from "./build-experiment.ts";
import { extensionRoot } from "./manifest.ts";
import { renderPng } from "./write-icons.ts";

const checkScript = NodePath.join(extensionRoot, "scripts", "check-xpi.ts");
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

let workDir = "";
let files: Record<string, Uint8Array> = {};
let unminifiedParent = "";
let minifiedParent = "";
let reactDevelopment = "";

beforeAll(async () => {
  workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-xpi-"));
  // The real parent script, bundled by the real build with minify on and off, is the ground truth for both.
  await bundleParent(NodePath.join(workDir, "minified", "parent.js"), true);
  await bundleParent(NodePath.join(workDir, "unminified", "parent.js"), false);
  minifiedParent = NodeFS.readFileSync(NodePath.join(workDir, "minified", "parent.js"), "utf8");
  unminifiedParent = NodeFS.readFileSync(NodePath.join(workDir, "unminified", "parent.js"), "utf8");
  // React's own development build of react-dom, as published.
  const reactDom = NodePath.dirname(
    NodeModule.createRequire(import.meta.url).resolve("react-dom/package.json"),
  );
  reactDevelopment = NodeFS.readFileSync(
    NodePath.join(reactDom, "cjs", "react-dom-client.development.js"),
    "utf8",
  );
  const toolbar = NodeFS.readFileSync(
    NodePath.join(extensionRoot, "src", "icons", "toolbar-dark.svg"),
    "utf8",
  );
  const master = NodeFS.readFileSync(
    NodePath.join(extensionRoot, "src", "icons", "icon.svg"),
    "utf8",
  );
  files = {
    "manifest.json": encode('{"manifest_version":3}'),
    "action/index.html": encode('<!DOCTYPE html><html><body><div id="root"></div></body></html>'),
    "action/index.js": encode(minifiedParent),
    "action/index.css": encode("body{margin:0}h1{font-size:15px}"),
    "experiment/parent.js": encode(minifiedParent),
    "icons/toolbar-dark.svg": encode(toolbar),
    "icons/16.png": renderPng(master, 16),
  };
});

afterAll(() => {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
});

interface Failure {
  readonly path: string;
  readonly rule: string;
}

/** Packs `files` plus `changes` into an XPI and runs the check on it the way CI does. */
const check = (
  name: string,
  changes: Record<string, string | Uint8Array>,
): { status: number | null; failures: Failure[]; stderr: string } => {
  const entries = { ...files };
  for (const [path, content] of Object.entries(changes)) {
    entries[path] = typeof content === "string" ? encode(content) : content;
  }
  const xpi = NodePath.join(workDir, `${name}.xpi`);
  NodeFS.writeFileSync(xpi, zipSync(entries));
  const run = NodeChildProcess.spawnSync(process.execPath, [checkScript, xpi], {
    encoding: "utf8",
  });
  const failures = [...run.stderr.matchAll(/^FAIL (\S+): ([\w-]+): /gm)].map(([, path, rule]) => ({
    path: path ?? "",
    rule: rule ?? "",
  }));
  return { status: run.status, failures, stderr: run.stderr };
};

describe("check-xpi", () => {
  it("passes an archive of minified production output", () => {
    const result = check("clean", {});
    expect(result.failures).toEqual([]);
    expect(result.status).toBe(0);
  });

  const prettyCss = "body {\n  margin: 0;\n}\n\nh1 {\n  font-size: 15px;\n}\n";
  const prettySvg = NodeFS.readFileSync(
    NodePath.join(extensionRoot, "src", "icons", "toolbar-dark.svg"),
    "utf8",
  ).replace(/></g, ">\n  <");

  // One planted violation each. A plant that does not name its file and rule fails the test.
  const plants: ReadonlyArray<{
    readonly plant: string;
    readonly changes: () => Record<string, string | Uint8Array>;
    readonly expected: readonly Failure[];
  }> = [
    {
      plant: "an unminified script",
      changes: () => ({ "experiment/parent.js": unminifiedParent }),
      expected: [{ path: "experiment/parent.js", rule: "not-minified" }],
    },
    {
      plant: "a stray source map",
      changes: () => ({ "experiment/parent.js.map": '{"version":3,"sources":[]}' }),
      expected: [{ path: "experiment/parent.js.map", rule: "source-map-file" }],
    },
    {
      plant: "a TypeScript file",
      changes: () => ({ "experiment/parent.ts": "export const namespace = 1;\n" }),
      expected: [{ path: "experiment/parent.ts", rule: "source-file" }],
    },
    {
      plant: "a sourceMappingURL reference in a minified script",
      changes: () => ({
        "action/index.js": `${minifiedParent}\n//# sourceMappingURL=index.js.map\n`,
      }),
      expected: [{ path: "action/index.js", rule: "source-map-reference" }],
    },
    {
      plant: "a development build of React",
      changes: () => ({ "shared/framework.js": reactDevelopment }),
      expected: [
        { path: "shared/framework.js", rule: "development-build" },
        { path: "shared/framework.js", rule: "not-minified" },
      ],
    },
    {
      plant: "a minified script with an unfolded development branch",
      changes: () => ({
        "action/index.js": `${minifiedParent};"production"!==process.env.NODE_ENV&&console.log(1);`,
      }),
      expected: [{ path: "action/index.js", rule: "development-build" }],
    },
    {
      plant: "an unminified stylesheet",
      changes: () => ({ "action/index.css": prettyCss }),
      expected: [{ path: "action/index.css", rule: "not-minified" }],
    },
    {
      plant: "an unminified SVG",
      changes: () => ({ "icons/toolbar-dark.svg": prettySvg }),
      expected: [{ path: "icons/toolbar-dark.svg", rule: "not-minified" }],
    },
    {
      plant: "a file type an XPI does not ship",
      changes: () => ({ "NOTES.md": "# notes\n" }),
      expected: [{ path: "NOTES.md", rule: "unknown-file-type" }],
    },
    {
      plant: "a test fixture",
      changes: () => ({ "fixtures/capture.json": "{}" }),
      expected: [{ path: "fixtures/capture.json", rule: "dev-only-file" }],
    },
  ];

  it.each(plants)(
    "fails on $plant, naming the file and the rule",
    ({ plant, changes, expected }) => {
      const result = check(plant.replaceAll(" ", "-"), changes());
      expect(result.failures).toEqual(expected);
      expect(result.status).toBe(1);
    },
  );
});
