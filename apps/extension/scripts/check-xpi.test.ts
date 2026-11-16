import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Zip, ZipDeflate } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { oneClickHarApi, namespace } from "../experiment/contract.ts";
import { toGeckoSchema } from "../experiment/gecko-schema.ts";
import { bundleParent } from "./build-experiment.ts";
import { CANNOT_JUDGE } from "./check-xpi.ts";
import { extensionRoot } from "./manifest.ts";
import { minifyScript } from "./minify.ts";
import { RULES, type Changes, type Fixtures } from "./xpi-rules.ts";
import { renderPng } from "./write-icons.ts";

const checkScript = NodePath.join(extensionRoot, "scripts", "check-xpi.ts");
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const inertPage = `<!DOCTYPE html><html><body><a href="#top" onclick="a()" style="margin:0">go</a><a href="javascript:void(0)">x</a><iframe srcdoc="&lt;p&gt;hi&lt;/p&gt;"></iframe></body></html>`;

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
    framework: `/*! LICENSE: framework.js.LICENSE.txt */\n${minifyScript(
      NodeFS.readFileSync(NodePath.join(reactDom, "cjs", "react-dom-client.production.js"), "utf8"),
    )}`,
    reactLicense: NodeFS.readFileSync(NodePath.join(reactDom, "LICENSE")),
    png: renderPng(
      NodeFS.readFileSync(NodePath.join(extensionRoot, "src", "icons", "icon.svg"), "utf8"),
      16,
    ),
  };
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
    "icons/16.png": fixtures.png,
  };
});

afterAll(() => {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
});

interface Failure {
  readonly path: string;
  readonly rule: string;
}

/** Writes the clean archive plus `changes`; a `DUPLICATE_OF` key adds a second entry under the same path. */
const writeXpi = (file: string, changes: Changes): void => {
  const entries = new Map<string, Uint8Array>(Object.entries(cleanFiles));
  const duplicates: Array<readonly [string, Uint8Array]> = [];
  for (const [key, content] of Object.entries(changes)) {
    const bytes = typeof content === "string" ? encode(content) : content;
    const [path, duplicate] = key.split("\u0000");
    if (path !== undefined && duplicate === undefined) entries.set(path, bytes);
    else if (path !== undefined) duplicates.push([path, bytes]);
  }
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error !== null) throw error;
    chunks.push(chunk);
  });
  for (const [path, bytes] of [...entries, ...duplicates]) {
    const entry = new ZipDeflate(path, { level: 1 });
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  NodeFS.writeFileSync(file, Buffer.concat(chunks));
};

/** Packs the clean archive plus `changes` into an XPI and runs the check on it the way CI does. */
const check = async (
  name: string,
  changes: Changes,
  args: readonly string[] = [],
): Promise<{ status: number | null; failures: Failure[]; stderr: string }> => {
  const xpi = NodePath.join(workDir, `${name.replaceAll(/\W+/g, "-").slice(0, 80)}.xpi`);
  writeXpi(xpi, changes);
  // Node warns on stderr when both NO_COLOR and FORCE_COLOR are set, and the test counts stderr lines.
  const { NO_COLOR: _noColor, FORCE_COLOR: _forceColor, ...env } = process.env;
  const child = NodeChildProcess.spawn(process.execPath, [checkScript, xpi, ...args], { env });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  NodeFS.rmSync(xpi, { force: true });
  const failures = [...stderr.matchAll(/^FAIL (\S+): ([\w-]+): /gm)].map(([, path, rule]) => ({
    path: path ?? "",
    rule: rule ?? "",
  }));
  return { status, failures, stderr };
};

const bySortKey = (a: Failure, b: Failure): number =>
  `${a.path}:${a.rule}`.localeCompare(`${b.path}:${b.rule}`);

describe.concurrent("check-xpi", () => {
  it("passes an archive shaped like the real XPI", async () => {
    const result = await check("clean", {});
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
        "shared/payload.js": minifyScript(
          `var d=[${Array.from({ length: 30_000 }, (_, i) => i * 7).join(",")}];console.log(d);`,
        ),
      }),
    },
    {
      // CSS reads U+2028 as part of a name, not as a line break, so lightningcss writes these bytes back unchanged.
      name: "E19 a stylesheet whose second selector starts with U+2028",
      changes: () => ({ "action/index.css": "body{margin:0}\u2028h1{font-size:15px}" }),
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
      name: "A06 a script with an array nested 2000 deep on one line",
      changes: () => ({
        "shared/payload.js": `var a=${"[".repeat(2000)}1${"]".repeat(2000)};console.log(a);`,
      }),
    },
    {
      name: "FC17a a script with an array nested 4500 deep, which the minifier still reads",
      changes: () => ({
        "shared/payload.js": `var a=${"[".repeat(4500)}1${"]".repeat(4500)};console.log(a);`,
      }),
    },
    {
      name: "strings that parse as scripts but declare nothing: a URL, prose, a list of globals",
      changes: () => ({
        "shared/payload.js": `var a=["javascript:throw new Error('A React form was unexpectedly submitted.')","Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI","\u0e1b\u0e23\u0e30\u0e40\u0e20\u0e17 \u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25: \u0e04\u0e27\u0e23"];console.log(a);`,
      }),
    },
    {
      name: "a two line string of short generated code",
      changes: () => ({
        "shared/payload.js": 'var f=new Function("a","return a+1;\\nreturn a");f(1);',
      }),
    },
    {
      name: "three lines of prose with code keywords in one string",
      changes: () => ({
        "shared/payload.js":
          'var t="If you return the form, the class starts at nine.\\nFor the second week, while the lab is open, bring a laptop.\\nYou may leave when it is done, if you wish.";console.log(t);',
      }),
    },
    {
      name: "a minified link, handler and style in a page",
      changes: () => ({
        "options/index.html": inertPage,
      }),
    },
    {
      name: "a page that loads its script by src",
      changes: () => ({
        "options/index.html":
          '<!DOCTYPE html><html><body><script src="/options/index.js"></script></body></html>',
      }),
    },
  ];

  it.each(legitimate)("passes $name", async ({ name, changes }) => {
    const result = await check(name, changes(fixtures));
    expect(result.failures).toEqual([]);
    expect(result.status).toBe(0);
  });

  describe.each(RULES)("rule $id", (rule) => {
    it("is proven by at least one planted archive", () => {
      expect(rule.plants.length).toBeGreaterThan(0);
    });

    it.each(rule.plants)("fails on $name, naming the file and the rule", async (plant) => {
      const result = await check(plant.name, plant.changes(fixtures));
      const expected = [rule.id, ...(plant.alsoFails ?? [])]
        .map((id) => ({ path: plant.path, rule: id }))
        .toSorted(bySortKey);
      expect(result.failures.toSorted(bySortKey)).toEqual(expected);
      expect(result.status).toBe(1);
      expect(result.stderr.trim().split("\n")).toHaveLength(expected.length);
      expect(result.stderr).toMatch(new RegExp(`^FAIL ${plant.path}: ${rule.id}: .+`, "m"));
    });
  });

  it("fails naming the archive when the judge runs out of time before judging a file", async () => {
    const result = await check("timeout", {}, ["--timeout-ms", "1"]);
    expect(result.failures).toEqual([{ path: "timeout.xpi", rule: CANNOT_JUDGE }]);
    expect(result.status).toBe(1);
  });

  it("fails naming the archive when it is not a ZIP", async () => {
    const xpi = NodePath.join(workDir, "not-a-zip.xpi");
    NodeFS.writeFileSync(xpi, "not a zip");
    const run = NodeChildProcess.spawnSync(process.execPath, [checkScript, xpi], {
      encoding: "utf8",
    });
    expect(run.stderr).toMatch(new RegExp(`^FAIL not-a-zip.xpi: ${CANNOT_JUDGE}: .+`, "m"));
    expect(run.status).toBe(1);
  });

  it("lists each rule once, and every extra rule a plant expects is a rule", () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const extra of RULES.flatMap((rule) => rule.plants.flatMap((p) => p.alsoFails ?? []))) {
      expect(ids).toContain(extra);
    }
  });
});
