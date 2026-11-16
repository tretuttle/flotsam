// Opens a packed XPI and fails if anything in it is not production output: source files, source maps, a development
// build, or a script, style or vector that was not minified. Usage: pnpm run check:xpi [path to xpi]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { unzipSync } from "fflate";
import { buildDir, readManifest, xpiPath } from "./manifest.ts";

type Kind =
  | "script"
  | "style"
  | "vector"
  | "markup"
  | "data"
  | "raster"
  | "notice"
  | "source-map"
  | "source";

// The only file types an XPI may ship. Matched by suffix, first hit wins. A path that matches none is a violation,
// so a new file type needs a row here.
const KIND_BY_SUFFIX: ReadonlyArray<readonly [string, Kind]> = [
  [".js", "script"],
  [".css", "style"],
  [".svg", "vector"],
  [".html", "markup"],
  [".json", "data"],
  [".png", "raster"],
  [".LICENSE.txt", "notice"],
  [".map", "source-map"],
  ...[".ts", ".tsx", ".mts", ".cts", ".jsx", ".vue", ".svelte", ".scss", ".sass", ".less"].map(
    (suffix) => [suffix, "source"] as const,
  ),
];

const MINIFIABLE: ReadonlySet<Kind> = new Set(["script", "style", "vector"]);
const CARRIES_SOURCE_MAP_COMMENT: ReadonlySet<Kind> = new Set(["script", "style"]);

interface ShippedFile {
  readonly path: string;
  readonly kind: Kind | undefined;
  readonly size: number;
  readonly text: string;
}

interface Metrics {
  readonly bytesPerLine: number;
  readonly indentShare: number;
  readonly commentShare: number;
}

const share = (parts: readonly string[], whole: number): number =>
  whole === 0 ? 0 : parts.reduce((sum, part) => sum + part.length, 0) / whole;

const measure = (text: string): Metrics => {
  const lines = text.replace(/\n$/, "").split("\n").length;
  const comments = [
    ...(text.match(/\/\*[\s\S]*?\*\//g) ?? []),
    ...(text.match(/^[ \t]*\/\/.*$/gm) ?? []),
  ].filter((comment) => !/^\/\*!|@license|@preserve|sourceMappingURL=/.test(comment));
  return {
    bytesPerLine: text.length / lines,
    indentShare: share(text.match(/^[ \t]+/gm) ?? [], text.length),
    commentShare: share(comments, text.length),
  };
};

// Minified is decided from three measured properties, not from a tool's name. Measured on this repo's files:
//   minified (shared/framework.js, action/index.js, experiment/parent.js, action/index.css, toolbar-dark.svg):
//     533 to 109258 bytes per line, 0.00% leading whitespace, 0.00% comment bytes.
//   the same kind of code unminified (experiment/parent.ts bundled with minify off, React's own
//     react-dom-client.*.js, src/popup/main.tsx): 33 to 39 bytes per line, 7% to 28% leading whitespace, up to
//     11% comment bytes.
// Each limit sits in the gap between the two groups. Legal comments (`/*!`, `@license`, `@preserve`) are required
// by the licenses of bundled code, and a sourceMappingURL comment has its own rule, so neither is counted. A file under 256 bytes has too few lines to judge by
// line length, so only the two shares apply to it.
const MIN_BYTES_FOR_LINE_LENGTH = 256;
const MINIFIED_LIMITS: ReadonlyArray<{
  readonly name: string;
  readonly of: (metrics: Metrics) => number;
  readonly holds: (value: number, size: number) => boolean;
  readonly expected: string;
  readonly show: (value: number) => string;
}> = [
  {
    name: "bytes per line",
    of: (m) => m.bytesPerLine,
    holds: (value, size) => size < MIN_BYTES_FOR_LINE_LENGTH || value >= 200,
    expected: "at least 200",
    show: (value) => value.toFixed(1),
  },
  {
    name: "leading whitespace",
    of: (m) => m.indentShare,
    holds: (value) => value <= 0.01,
    expected: "at most 1%",
    show: (value) => `${(value * 100).toFixed(2)}%`,
  },
  {
    name: "comment bytes",
    of: (m) => m.commentShare,
    holds: (value) => value <= 0.02,
    expected: "at most 2%",
    show: (value) => `${(value * 100).toFixed(2)}%`,
  },
];

// Strings that only a development build keeps. `process.env.NODE_ENV` is a branch the bundler folds away in a
// production build, so one that survives means the build ran in development mode.
const DEVELOPMENT_MARKERS: ReadonlyArray<string> = [
  "process.env.NODE_ENV",
  "Download the React DevTools",
];

const DEV_ONLY_PATH =
  /(^|\/)(node_modules|__tests__|__mocks__|fixtures?|tests?)\/|\.(test|spec|stories)\.|(^|\/)(package|tsconfig[^/]*)\.json$/;

export interface Violation {
  readonly path: string;
  readonly rule: string;
  readonly detail: string;
}

interface Rule {
  readonly id: string;
  /** The reason the file fails the rule, or undefined when it passes. */
  readonly check: (file: ShippedFile) => string | undefined;
}

const RULES: readonly Rule[] = [
  {
    id: "source-map-file",
    check: (file) =>
      file.kind === "source-map" ? "a source map ships the original source" : undefined,
  },
  {
    id: "source-file",
    check: (file) => (file.kind === "source" ? "source files must not ship" : undefined),
  },
  {
    id: "unknown-file-type",
    check: (file) =>
      file.kind === undefined
        ? "not a file type an XPI ships; add it to KIND_BY_SUFFIX if it should"
        : undefined,
  },
  {
    id: "dev-only-file",
    check: (file) =>
      DEV_ONLY_PATH.test(file.path) ? "a test, fixture or tooling file must not ship" : undefined,
  },
  {
    id: "source-map-reference",
    check: (file) =>
      file.kind !== undefined &&
      CARRIES_SOURCE_MAP_COMMENT.has(file.kind) &&
      /[#@]\s*sourceMappingURL=/.test(file.text)
        ? "contains a sourceMappingURL comment"
        : undefined,
  },
  {
    id: "development-build",
    check: (file) => {
      const marker =
        file.kind === "script"
          ? DEVELOPMENT_MARKERS.find((candidate) => file.text.includes(candidate))
          : undefined;
      return marker === undefined
        ? undefined
        : `contains \`${marker}\`, which only a development build keeps`;
    },
  },
  {
    id: "not-minified",
    check: (file) => {
      if (file.kind === undefined || !MINIFIABLE.has(file.kind)) return undefined;
      const metrics = measure(file.text);
      return (
        MINIFIED_LIMITS.filter(({ of, holds }) => !holds(of(metrics), file.size))
          .map(
            ({ name, of, expected, show }) => `${name} ${show(of(metrics))}, expected ${expected}`,
          )
          .join("; ") || undefined
      );
    },
  },
];

const kindOf = (path: string): Kind | undefined =>
  KIND_BY_SUFFIX.find(([suffix]) => path.endsWith(suffix))?.[1];

const readXpi = (xpi: Uint8Array): readonly ShippedFile[] =>
  Object.entries(unzipSync(xpi))
    .filter(([path]) => !path.endsWith("/"))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => {
      const kind = kindOf(path);
      return {
        path,
        kind,
        size: bytes.length,
        text: kind === "raster" ? "" : new TextDecoder().decode(bytes),
      };
    });

export const inspectXpi = (xpi: Uint8Array): readonly Violation[] =>
  readXpi(xpi).flatMap((file) =>
    RULES.flatMap(({ id, check }) => {
      const detail = check(file);
      return detail === undefined ? [] : [{ path: file.path, rule: id, detail }];
    }),
  );

/** One line per file the minified limits judge, so a pass shows what was measured. */
export const describeMeasurements = (xpi: Uint8Array): readonly string[] =>
  readXpi(xpi)
    .filter((file) => file.kind !== undefined && MINIFIABLE.has(file.kind))
    .map((file) => {
      const m = measure(file.text);
      return `${file.path.padEnd(32)} ${String(file.size).padStart(7)} B  ${m.bytesPerLine.toFixed(0).padStart(7)} B/line  indent ${(m.indentShare * 100).toFixed(2)}%  comments ${(m.commentShare * 100).toFixed(2)}%`;
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
