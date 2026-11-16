import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { oneClickHarApi, namespace } from "../experiment/contract.ts";
import { toGeckoSchema } from "../experiment/gecko-schema.ts";
import { bundleParent } from "./build-experiment.ts";
import { extensionRoot } from "./manifest.ts";
import { RULES, type Changes, type Fixtures } from "./xpi-rules.ts";
import { renderPng } from "./write-icons.ts";

const checkScript = NodePath.join(extensionRoot, "scripts", "check-xpi.ts");
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const REAL_PAGE = `<!DOCTYPE html><html lang="en"><head>
    <meta charset="utf-8">
    <title>One-Click HAR</title>
  <link rel="stylesheet" href="/action/index.css"></head>
  <body>
    <div id="root"></div>

  <script src="/shared/framework.js"></script><script src="/shared/commons.js"></script><script src="/action/index.js"></script>

</body></html>`;

let workDir = "";
let fixtures: Fixtures;
let cleanFiles: Record<string, Uint8Array> = {};

beforeAll(async () => {
  workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-xpi-"));
  // The real parent script, bundled by the real build with minify on and off, is the ground truth for both.
  await bundleParent(NodePath.join(workDir, "minified", "parent.js"), true);
  await bundleParent(NodePath.join(workDir, "unminified", "parent.js"), false);
  const minifiedParent = NodeFS.readFileSync(
    NodePath.join(workDir, "minified", "parent.js"),
    "utf8",
  );
  const reactDom = NodePath.dirname(
    NodeModule.createRequire(import.meta.url).resolve("react-dom/package.json"),
  );
  const toolbarSvg = NodeFS.readFileSync(
    NodePath.join(extensionRoot, "src", "icons", "toolbar.svg"),
    "utf8",
  );
  fixtures = {
    minifiedParent,
    unminifiedParent: NodeFS.readFileSync(
      NodePath.join(workDir, "unminified", "parent.js"),
      "utf8",
    ),
    // React's own development build of react-dom, as published.
    reactDevelopment: NodeFS.readFileSync(
      NodePath.join(reactDom, "cjs", "react-dom-client.development.js"),
      "utf8",
    ),
    toolbarSvg,
    framework: `/*! LICENSE: framework.js.LICENSE.txt */\n${Array.from({ length: 250 }, () => minifiedParent.trim()).join(";")}`,
    reactLicense: NodeFS.readFileSync(NodePath.join(reactDom, "LICENSE")),
  };
  const master = NodeFS.readFileSync(
    NodePath.join(extensionRoot, "src", "icons", "icon.svg"),
    "utf8",
  );
  // The shape of the real XPI: pretty manifest and schema, indented page, one-line scripts and styles.
  cleanFiles = {
    "manifest.json": NodeFS.readFileSync(NodePath.join(extensionRoot, "src", "manifest.json")),
    "experiment/schema.json": encode(
      `${JSON.stringify(toGeckoSchema(namespace, oneClickHarApi), null, 2)}\n`,
    ),
    "action/index.html": encode(REAL_PAGE),
    "action/index.js": encode(minifiedParent),
    "action/index.css": encode("body{margin:0}h1{font-size:15px}"),
    "experiment/parent.js": encode(minifiedParent),
    "shared/framework.js": encode(fixtures.framework),
    "shared/framework.js.LICENSE.txt": fixtures.reactLicense,
    "icons/toolbar.svg": encode(toolbarSvg),
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

/** Packs the clean archive plus `changes` into an XPI and runs the check on it the way CI does. */
const check = (
  name: string,
  changes: Changes,
): { status: number | null; failures: Failure[]; stderr: string } => {
  const entries = { ...cleanFiles };
  for (const [path, content] of Object.entries(changes)) {
    entries[path] = typeof content === "string" ? encode(content) : content;
  }
  const xpi = NodePath.join(workDir, `${name.replaceAll(/\W+/g, "-").slice(0, 80)}.xpi`);
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

const bySortKey = (a: Failure, b: Failure): number =>
  `${a.path}:${a.rule}`.localeCompare(`${b.path}:${b.rule}`);

describe("check-xpi", () => {
  it("passes an archive shaped like the real XPI", () => {
    const result = check("clean", {});
    expect(result.failures).toEqual([]);
    expect(result.status).toBe(0);
  });

  // Production output that looks like what a rule hunts for. Each must pass, or a build would fail on valid output.
  const legitimate: ReadonlyArray<{
    readonly name: string;
    readonly changes: (fixtures: Fixtures) => Changes;
  }> = [
    {
      name: "F02 one minified line of data over 100 KB",
      changes: () => ({
        "shared/payload.js": `var d=[${Array.from({ length: 30_000 }, (_, i) => i * 7).join(",")}];`,
      }),
    },
    {
      name: "one minified line holding two 100 KB strings",
      changes: () => ({
        "shared/payload.js": `var a="${"a".repeat(100_000)}",b="${"b".repeat(100_000)}";`,
      }),
    },
    {
      name: "F03 a string that contains /* and */",
      changes: () => ({ "shared/payload.js": 'var s="/* not a comment */",t=1;console.log(s,t);' }),
    },
    {
      name: "a string that holds a line comment and a sourceMappingURL",
      changes: () => ({
        "shared/payload.js": `var u="http://example.test/a",m="//# sourceMappingURL=x.map";console.log(u,m);`,
      }),
    },
    {
      name: "a regular expression with quotes and /* in a class, then a division",
      changes: () => ({
        "shared/payload.js": `var r=/["'/*]+/g,q=a/2/3;var s="/* x */";console.log(r,q,s);`,
      }),
    },
    {
      name: "a template literal with //, /* and a nested template",
      changes: () => ({
        "shared/payload.js": "var t=`a // b ${`/* ${1} */`} c /* d`;console.log(t);",
      }),
    },
    {
      name: "a quote after a division that follows a closing paren",
      changes: () => ({
        "shared/payload.js": `var a=(b+c)/2,s="/* kept */";console.log(a,s);`,
      }),
    },
    {
      name: "a legal pointer line above one long line",
      changes: (fixtures) => ({
        "shared/payload.js": `/*! LICENSE: payload.js.LICENSE.txt */\n${fixtures.minifiedParent}`,
      }),
    },
    {
      name: "a React style multi-line @license comment above one long line",
      changes: (fixtures) => ({
        "shared/payload.js": `/**\n * @license React v19.3.1\n * react.production.js\n *\n * Copyright (c) Meta Platforms, Inc. and affiliates.\n *\n * This source code is licensed under the MIT license found in the\n * LICENSE file in the root directory of this source tree.\n */\n${fixtures.minifiedParent}`,
      }),
    },
    {
      name: "E06 a regular expression literal that contains the characters of a function",
      changes: (fixtures) => ({
        "experiment/parent.js": `${fixtures.minifiedParent};var r=/function collectHeaders\\(entries\\)\\{return entries\\.map\\(\\(e\\)=>e\\.name\\)\\}/;`,
      }),
    },
    {
      name: "F04 a 400-entry string table whose values hold comment delimiters",
      changes: () => ({
        "shared/payload.js": `var rows=[${Array.from({ length: 400 }, (_, i) => JSON.stringify(`/* row ${i} */`)).join(",")}];var lookup=(i)=>rows[i];console.log(lookup(0));`,
      }),
    },
    {
      name: "a stylesheet with a url that holds //",
      changes: () => ({
        "action/index.css": "a{background:url(http://example.test/a.png)}b{content:'/* x */'}",
      }),
    },
    {
      name: "pretty JSON with a two line string",
      changes: () => ({ "experiment/info.json": '{\n  "description": "line one\\nline two"\n}\n' }),
    },
    {
      name: "a page that loads its script by src",
      changes: () => ({
        "options/index.html":
          '<!DOCTYPE html><html><body><script src="/options/index.js"></script></body></html>',
      }),
    },
  ];

  it.each(legitimate)("passes $name", ({ name, changes }) => {
    const result = check(name, changes(fixtures));
    expect(result.failures).toEqual([]);
    expect(result.status).toBe(0);
  });

  describe.each(RULES)("rule $id", (rule) => {
    it("is proven by at least one planted archive", () => {
      expect(rule.plants.length).toBeGreaterThan(0);
    });

    it.each(rule.plants)("fails on $name, naming the file and the rule", (plant) => {
      const result = check(plant.name, plant.changes(fixtures));
      const expected = [rule.id, ...(plant.alsoFails ?? [])]
        .map((id) => ({ path: plant.path, rule: id }))
        .toSorted(bySortKey);
      expect(result.failures.toSorted(bySortKey)).toEqual(expected);
      expect(result.status).toBe(1);
      expect(result.stderr.trim().split("\n")).toHaveLength(expected.length);
      expect(result.stderr).toMatch(new RegExp(`^FAIL ${plant.path}: ${rule.id}: .+`, "m"));
    });
  });

  it("lists each rule once, and every extra rule a plant expects is a rule", () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const extra of RULES.flatMap((rule) => rule.plants.flatMap((p) => p.alsoFails ?? []))) {
      expect(ids).toContain(extra);
    }
  });
});
