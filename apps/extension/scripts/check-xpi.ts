// Opens a packed XPI and fails if anything in it is not production output: source files, source maps, a development
// build, or a script, style or vector that was not minified. The rules are the table in xpi-rules.ts.
// Usage: pnpm run check:xpi [path to xpi]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { unzipSync } from "fflate";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";
import { inlineBodies, kindOf, RULES, syntaxOf, type Unit } from "./xpi-rules.ts";
import { classifyComments, densestStretch } from "./xpi-source.ts";

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

export const inspectXpi = (xpi: Uint8Array): readonly Violation[] =>
  readXpi(xpi).flatMap((file) => {
    const units = [file, ...inlineBodies(file)];
    return RULES.flatMap(({ id, inspects, check }) =>
      (inspects === "path" ? [file] : units).flatMap((unit) => {
        const detail = check(unit);
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
    const stretch = densestStretch(file.text, legal);
    return [
      `${file.path.padEnd(32)} ${String(file.bytes.length).padStart(7)} B  densest ${stretch.breaks} breaks in ${stretch.characters} chars  comments ${ordinary.length}  legal ${legal.length}`,
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
