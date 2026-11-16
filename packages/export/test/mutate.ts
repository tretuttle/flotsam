import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface SourceMutation {
  readonly id: string;
  readonly from: string | RegExp;
  readonly to: string;
}

const SRC = NodePath.resolve(import.meta.dirname, "..", "src");

/**
 * Imports a module from a copy of src/ with one planted change, so sibling imports resolve to the real code.
 */
export async function importMutated<T>(file: string, mutation: SourceMutation): Promise<T> {
  const source = NodeFS.readFileSync(NodePath.join(SRC, file), "utf8");
  const hits =
    typeof mutation.from === "string"
      ? source.split(mutation.from).length - 1
      : (source.match(new RegExp(mutation.from.source, `${mutation.from.flags}g`)) ?? []).length;
  if (hits !== 1) throw new Error(`${mutation.id}: matched ${String(hits)} times in ${file}`);
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `och-export-${mutation.id}-`));
  NodeFS.cpSync(SRC, dir, { recursive: true });
  const copy = NodePath.join(dir, file);
  NodeFS.writeFileSync(copy, source.replace(mutation.from, mutation.to));
  try {
    return (await import(/* @vite-ignore */ NodeURL.pathToFileURL(copy).href)) as T;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
