import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface SourceMutation {
  readonly id: string;
  readonly from: string | RegExp;
  readonly to: string;
}

const SRC = NodePath.resolve(import.meta.dirname, "..", "src");
// Inside the package (and gitignored by `.vitest-*`), so a copy resolves the workspace's packages the way src/ does,
// in Vitest and in plain Node, which strips types only outside node_modules.
const MUTANTS = NodePath.resolve(import.meta.dirname, "..", ".vitest-mutants");

/**
 * Imports a module (`entry`, by default the changed file) from a copy of src/ with one planted change in `file`, so
 * sibling imports resolve to the copy.
 */
export async function importMutated<T>(
  file: string,
  mutation: SourceMutation,
  entry: string = file,
): Promise<T> {
  const source = NodeFS.readFileSync(NodePath.join(SRC, file), "utf8");
  const hits =
    typeof mutation.from === "string"
      ? source.split(mutation.from).length - 1
      : (source.match(new RegExp(mutation.from.source, `${mutation.from.flags}g`)) ?? []).length;
  if (hits !== 1) throw new Error(`${mutation.id}: matched ${String(hits)} times in ${file}`);
  NodeFS.mkdirSync(MUTANTS, { recursive: true });
  const dir = NodeFS.mkdtempSync(NodePath.join(MUTANTS, `${mutation.id}-`));
  NodeFS.cpSync(SRC, dir, { recursive: true });
  const copy = NodePath.join(dir, file);
  NodeFS.writeFileSync(copy, source.replace(mutation.from, mutation.to));
  try {
    return (await import(
      /* @vite-ignore */ NodeURL.pathToFileURL(NodePath.join(dir, entry)).href
    )) as T;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
