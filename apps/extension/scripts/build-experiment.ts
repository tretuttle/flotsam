// Writes the experiment's schema.json and parent script to the paths the manifest names, under the folder given
// as the first argument. extension.js minifies every script it copies in production, so `build` runs this on its
// output afterwards and `dev` runs it on `public`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { build } from "vite-plus/pack";
import { harAnytimeApi, namespace } from "../experiment/contract.ts";
import { toGeckoSchema } from "../experiment/gecko-schema.ts";
import { extensionRoot, readManifest } from "./manifest.ts";

const [outRoot] = process.argv.slice(2);
if (outRoot === undefined)
  throw new Error("Usage: node scripts/build-experiment.ts <output folder>");

const experiment = readManifest().experiment_apis[namespace];
if (experiment === undefined) {
  throw new Error(
    `src/manifest.json declares no experiment_apis.${namespace}, the namespace in experiment/contract.ts`,
  );
}

const schemaFile = NodePath.resolve(extensionRoot, outRoot, experiment.schema);
NodeFS.mkdirSync(NodePath.dirname(schemaFile), { recursive: true });
NodeFS.writeFileSync(
  schemaFile,
  `${JSON.stringify(toGeckoSchema(namespace, harAnytimeApi), null, 2)}\n`,
);

const scriptFile = NodePath.resolve(extensionRoot, outRoot, experiment.parent.script);
await build({
  config: false,
  entry: {
    [NodePath.basename(scriptFile, ".js")]: NodePath.join(extensionRoot, "experiment", "parent.ts"),
  },
  outDir: NodePath.dirname(scriptFile),
  format: "iife",
  platform: "neutral",
  // Dead-code removal only, so the privileged script ships readable.
  minify: "dce-only",
  clean: false,
  report: false,
  logLevel: "warn",
  outputOptions: { entryFileNames: "[name].js" },
});
