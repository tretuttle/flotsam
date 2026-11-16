// Opens a packed XPI and fails if anything in it is not production output: source files, source maps, a development
// build, or a script, style or vector that was not minified. The rules are the table in xpi-rules.ts.
// Usage: pnpm run check:xpi [path to xpi]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { unzipSync } from "fflate";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";
import {
  inlineBodies,
  kindOf,
  minifyMargin,
  minifySaving,
  RULES,
  syntaxOf,
  type Rule,
  type Unit,
} from "./xpi-rules.ts";
import {
  classifyComments,
  hasLineTerminator,
  lineBreaksOutsideData,
  parseScript,
  readStyle,
} from "./xpi-source.ts";

export interface Violation {
  readonly path: string;
  readonly rule: string;
  readonly detail: string;
}

const readXpi = (xpi: Uint8Array): readonly Unit[] =>
  Object.entries(unzipSync(xpi))
    .filter(([path]) => !path.endsWith("/"))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => {
      const kind = kindOf(path);
      return {
        path,
        where: undefined,
        kind,
        bytes,
        text: kind === "raster" ? "" : new TextDecoder().decode(bytes),
      };
    });

/**
 * A rule that throws on a file has not judged it, so the file fails. Without this a crash would end the run with a
 * stack trace and no line naming the file.
 */
export const judge = (check: Rule["check"], unit: Unit): string | undefined => {
  try {
    return check(unit);
  } catch (error) {
    return `the check could not judge this file: ${error instanceof Error ? error.message : String(error)}`;
  }
};

export const inspectXpi = (xpi: Uint8Array): readonly Violation[] =>
  readXpi(xpi).flatMap((file) => {
    const units = [file, ...inlineBodies(file)];
    return RULES.flatMap(({ id, inspects, check }) =>
      (inspects === "path" ? [file] : units).flatMap((unit) => {
        const detail = judge(check, unit);
        return detail === undefined
          ? []
          : [
              {
                path: file.path,
                rule: id,
                detail: (unit.where === undefined ? detail : `${unit.where}: ${detail}`).replaceAll(
                  /\s+/g,
                  " ",
                ),
              },
            ];
      }),
    );
  });

/** One line per file the minified rules judge, so a pass shows what was measured. */
export const describeMeasurements = (xpi: Uint8Array): readonly string[] =>
  readXpi(xpi).flatMap((file) => {
    const syntax = syntaxOf(file);
    if (syntax === undefined) return [];
    const { ordinary, legal } = classifyComments(file.text, syntax);
    const facts = syntax === "script" ? parseScript(file.text) : readStyle(file.text);
    const breaks = lineBreaksOutsideData(file.text, [...facts.data, ...facts.comments], legal);
    const counted =
      syntax === "vector" ? (hasLineTerminator(file.text.trim()) ? 1 : 0) : breaks.length;
    const minified = minifySaving(file);
    const saved =
      minified === undefined
        ? "has no minifier"
        : minified.ok
          ? `saves ${String(minified.saved).padStart(5)} B`
          : `FAILS (${minified.error})`;
    const margin = minifyMargin(file.text.length);
    return [
      `${file.path.padEnd(32)} ${String(file.bytes.length).padStart(7)} B  re-minify ${saved} (margin ${margin})  line breaks ${counted}  comments ${ordinary.length}  legal ${legal.length}`,
    ];
  });

if (import.meta.main) {
  const [argument] = process.argv.slice(2);
  const xpi = NodePath.resolve(
    argument ?? xpiPath(readManifest(NodePath.join(buildDir, "manifest.json")).version),
  );
  const bytes = NodeFS.readFileSync(xpi);
  for (const line of describeMeasurements(bytes)) console.log(line);
  const violations = inspectXpi(bytes);
  for (const { path, rule, detail } of violations)
    console.error(`FAIL ${path}: ${rule}: ${detail}`);
  console.log(
    `${violations.length === 0 ? "PASS" : "FAIL"} ${NodePath.basename(xpi)}: ${violations.length} violations`,
  );
  process.exitCode = violations.length === 0 ? 0 : 1;
}
