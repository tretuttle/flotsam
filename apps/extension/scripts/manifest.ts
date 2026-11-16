import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const extensionRoot = NodePath.resolve(import.meta.dirname, "..");
const publicDir = NodePath.join(extensionRoot, "public");

interface ExperimentApi {
  readonly schema: string;
  readonly parent: { readonly script: string };
}

export interface Manifest {
  readonly version: string;
  readonly icons: Readonly<Record<string, string>>;
  readonly action: {
    readonly default_popup: string;
    readonly default_icon: Readonly<Record<string, string>>;
  };
  readonly experiment_apis: Readonly<Record<string, ExperimentApi>>;
}

export const readManifest = (
  path = NodePath.join(extensionRoot, "src", "manifest.json"),
): Manifest => JSON.parse(NodeFS.readFileSync(path, "utf8")) as Manifest;

/** Where a manifest path lands in the generated `public` folder, which extension.js copies to the build root. */
export const publicPath = (manifestPath: string): string =>
  NodePath.join(publicDir, manifestPath.replace(/^\//, ""));
