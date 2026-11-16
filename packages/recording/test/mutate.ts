import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface SourceMutation {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Imports a copy of a module from src/ with one planted change. The change must match exactly once, so a refactor
 * that moves the text fails loudly instead of planting nothing. The module may import only types from its siblings.
 */
export async function importMutated<T>(file: string, mutation: SourceMutation): Promise<T> {
  const source = NodeFS.readFileSync(
    NodePath.resolve(import.meta.dirname, "..", "src", file),
    "utf8",
  );
  const hits = source.split(mutation.from).length - 1;
  if (hits !== 1) throw new Error(`${mutation.id}: matched ${hits} times in ${file}`);
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `och-${mutation.id}-`));
  const copy = NodePath.join(dir, file);
  NodeFS.writeFileSync(copy, source.replace(mutation.from, mutation.to));
  try {
    return (await import(/* @vite-ignore */ NodeURL.pathToFileURL(copy).href)) as T;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
