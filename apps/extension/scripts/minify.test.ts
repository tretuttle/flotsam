// Honest output must pass check-xpi whatever library it bundles. Each library is built through both script build
// paths the product has, the rspack page build with pageMinimizers and the parent build with bundleScript, and the
// packed result is checked the way CI checks the real XPI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DefinePlugin, rspack } from "@rspack/core";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { bundleScript } from "./build-experiment.ts";
import { extensionRoot } from "./manifest.ts";
import { pageMinimizers } from "./minify.ts";

const checkScript = NodePath.join(extensionRoot, "scripts", "check-xpi.ts");

// The libraries round 2 of the review found failing the check through one build path or both.
const LIBRARIES: Readonly<Record<string, string>> = {
  react: 'import * as a from "react";import * as b from "react-dom/client";globalThis.lib=[a,b];',
  fflate: 'import * as a from "fflate";globalThis.lib=a;',
  zod: 'import * as a from "zod";globalThis.lib=a;',
  effect: 'import * as a from "effect/Effect";globalThis.lib=a;',
  vue: 'import * as a from "vue";globalThis.lib=a;',
  yaml: 'import * as a from "yaml";globalThis.lib=a;',
  "js-yaml": 'import * as a from "js-yaml";globalThis.lib=a;',
  acorn: 'import * as a from "acorn";globalThis.lib=a;',
};

/** The rspack production build of the pages, with the minimizers extension.config.js installs. */
const buildPage = (entry: string, outDir: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const compiler = rspack({
      mode: "production",
      target: "web",
      entry,
      output: { path: outDir, filename: "vendor.js" },
      plugins: [new DefinePlugin({ "process.env.NODE_ENV": JSON.stringify("production") })],
      optimization: { minimize: true, minimizer: pageMinimizers() },
    });
    compiler.run((error, stats) => {
      if (error !== null) reject(error);
      else if (stats?.hasErrors() === true)
        reject(new Error(stats.toString({ all: false, errors: true })));
      else compiler.close(() => resolve());
    });
  });

/** Every file under `dir`, keyed by the archive path it gets below `prefix`. */
const filesUnder = (dir: string, prefix: string): Record<string, Uint8Array> =>
  Object.fromEntries(
    NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = NodePath.join(entry.parentPath, entry.name);
        return [
          `${prefix}${NodePath.relative(dir, file).split(NodePath.sep).join("/")}`,
          NodeFS.readFileSync(file),
        ];
      }),
  );

const BUILD_PATHS = {
  page: async (entry: string, dir: string) => {
    await buildPage(entry, dir);
    return filesUnder(dir, "shared/");
  },
  parent: async (entry: string, dir: string) => {
    await bundleScript(entry, NodePath.join(dir, "parent.js"), true);
    return filesUnder(dir, "experiment/");
  },
  "parent, not minified": async (entry: string, dir: string) => {
    await bundleScript(entry, NodePath.join(dir, "parent.js"), false);
    return filesUnder(dir, "experiment/");
  },
} as const;

// Entries sit under node_modules so the bundlers resolve each library from this package.
let workDir = "";

beforeAll(() => {
  const cache = NodePath.join(extensionRoot, "node_modules", ".cache");
  NodeFS.mkdirSync(cache, { recursive: true });
  workDir = NodeFS.mkdtempSync(NodePath.join(cache, "minify-test-"));
});

afterAll(() => {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
});

const checkBuilt = async (
  library: string,
  path: keyof typeof BUILD_PATHS,
): Promise<{ status: number | null; stderr: string }> => {
  const dir = NodePath.join(workDir, `${library}-${path.replaceAll(/\W+/g, "-")}`);
  NodeFS.mkdirSync(dir, { recursive: true });
  const entry = NodePath.join(dir, "entry.js");
  NodeFS.writeFileSync(entry, LIBRARIES[library] ?? "");
  const out = NodePath.join(dir, "out");
  const xpi = NodePath.join(dir, "built.xpi");
  NodeFS.writeFileSync(xpi, zipSync(await BUILD_PATHS[path](entry, out)));
  const { NO_COLOR: _noColor, FORCE_COLOR: _forceColor, ...env } = process.env;
  const child = NodeChildProcess.spawn(process.execPath, [checkScript, xpi], { env });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stderr };
};

describe.concurrent("honest builds of popular libraries", () => {
  it.each(Object.keys(LIBRARIES))("pass through the page build: %s", async (library) => {
    const result = await checkBuilt(library, "page");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each(Object.keys(LIBRARIES))("pass through the parent build: %s", async (library) => {
    const result = await checkBuilt(library, "parent");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fail through the parent build with minify off, so this test can see a failure", async () => {
    const result = await checkBuilt("fflate", "parent, not minified");
    expect(result.stderr).toMatch(/^FAIL experiment\/parent\.js: not-minified: /m);
    expect(result.status).toBe(1);
  });
});
