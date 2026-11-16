// The rules an XPI must pass, as one table. A file's extension only says what it claims to be; the rules read its
// bytes to check the claim. Every row carries the planted archive that proves it, and check-xpi.test.ts runs them all.
import {
  classifyComments,
  densestStretch,
  findComments,
  lineOf,
  MAX_BREAKS_IN_WINDOW,
  WINDOW_CHARACTERS,
  type Syntax,
} from "./xpi-source.ts";

export type Kind =
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

export const kindOf = (path: string): Kind | undefined =>
  KIND_BY_SUFFIX.find(([suffix]) => path.endsWith(suffix))?.[1];

/** Which comment syntax the text of a kind is read with. A kind not listed has no comments to judge. */
const SYNTAX_BY_KIND: Readonly<Partial<Record<Kind, Syntax>>> = {
  script: "script",
  style: "style",
  vector: "vector",
};

/** A file in the archive, or text carried inside one (the body of an inline `<script>`). */
export interface Unit {
  readonly path: string;
  /** Set for text carried inside the file at `path`. */
  readonly where: string | undefined;
  readonly kind: Kind | undefined;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export const syntaxOf = (unit: Unit): Syntax | undefined =>
  unit.kind === undefined ? undefined : SYNTAX_BY_KIND[unit.kind];

const INLINE_BODY = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

/** The scripts and styles written inside a page or a vector, which the page's extension would otherwise hide. */
export const inlineBodies = (file: Unit): readonly Unit[] =>
  file.kind === "markup" || file.kind === "vector"
    ? [...file.text.matchAll(INLINE_BODY)].flatMap(([, tag, body]) =>
        tag === undefined || body === undefined || body.trim() === ""
          ? []
          : [
              {
                path: file.path,
                where: `inline <${tag.toLowerCase()}>`,
                kind: tag.toLowerCase() === "script" ? ("script" as const) : ("style" as const),
                bytes: new TextEncoder().encode(body),
                text: body,
              },
            ],
      )
    : [];

type Parsed =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const parseJson = (text: string): Parsed => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSourceMap = (value: unknown): boolean =>
  isRecord(value) &&
  value.version === 3 &&
  ((typeof value.mappings === "string" && Array.isArray(value.sources)) ||
    Array.isArray(value.sections));

/** Every string in a parsed JSON value, with the path that reaches it. */
const jsonStrings = (value: unknown, at = "$"): ReadonlyArray<readonly [string, string]> => {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => jsonStrings(item, `${at}[${i}]`));
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => jsonStrings(item, `${at}.${key}`));
  }
  return [];
};

const excerpt = (text: string): string => {
  const line = text.split("\n")[0] ?? "";
  return line.length > 48 ? `${line.slice(0, 48)}...` : line;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

// Strings that only a development build keeps. `process.env.NODE_ENV` is a branch the bundler folds away in a
// production build, so one that survives means the build ran in development mode.
const DEVELOPMENT_MARKERS: ReadonlyArray<string> = [
  "process.env.NODE_ENV",
  "Download the React DevTools",
];

const DEV_ONLY_PATH =
  /(^|\/)(node_modules|__tests__|__mocks__|fixtures?|tests?|scripts)\/|\.(test|spec|stories)\.|(^|\/)(package|tsconfig[^/]*)\.json$/;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const NOTICE_CODE_LINE = /[{}]\s*$|=>|^\s*(?:function|const|let|var|import|export|return)\s+\S/;
const MAX_NOTICE_CODE_LINES = 2;

const SOURCE_MAP_REFERENCE = /[#@]\s*sourceMappingURL=/;

/** What a plant needs from the real build, supplied by the test. */
export interface Fixtures {
  /** The real parent script, bundled by the real build with minify on. */
  readonly minifiedParent: string;
  /** The same bundle with minify off. */
  readonly unminifiedParent: string;
  /** React's own react-dom-client.development.js, as published. */
  readonly reactDevelopment: string;
  /** The real toolbar icon, as shipped. */
  readonly toolbarSvg: string;
  /** The shape of shared/framework.js: a legal pointer line, then one very long minified line. */
  readonly framework: string;
}

export type Changes = Readonly<Record<string, string | Uint8Array>>;

/** One archive that must fail: the clean archive with `changes` applied. */
export interface Plant {
  /** The verifier's case id when it came from a report, then what is planted. */
  readonly name: string;
  readonly changes: (fixtures: Fixtures) => Changes;
  /** The file that must fail. */
  readonly path: string;
  /** Every other rule that file must fail, besides the row's own. */
  readonly alsoFails?: readonly string[];
}

export interface Rule {
  readonly id: string;
  readonly inspects: "path" | "contents";
  readonly decides: string;
  /** The reason the unit fails the rule, or undefined when it passes. */
  readonly check: (unit: Unit) => string | undefined;
  /** At least one, so a rule that nothing proves cannot be added. */
  readonly plants: readonly [Plant, ...Plant[]];
}

const PRETTY_FUNCTION = `function collectHeaders(entries) {
  const result = [];
  for (const entry of entries) {
    if (entry.name === undefined) {
      continue;
    }
    result.push({
      name: entry.name,
      value: String(entry.value),
    });
  }
  return result;
}
`;

const SOURCE_MAP = JSON.stringify({
  version: 3,
  file: "parent.js",
  sources: ["../parent.ts"],
  sourcesContent: [PRETTY_FUNCTION],
  mappings: "AAAA;AACA",
});

const prettySvg = (fixtures: Fixtures): string => fixtures.toolbarSvg.replace(/></g, ">\n  <");

export const RULES: readonly Rule[] = [
  {
    id: "source-map-file",
    inspects: "path",
    decides: "the path ends in .map, a file that ships the original source",
    check: (file) =>
      file.kind === "source-map" ? "a source map ships the original source" : undefined,
    plants: [
      {
        name: "V02 a stray source map next to the parent script",
        changes: () => ({ "experiment/parent.js.map": SOURCE_MAP }),
        path: "experiment/parent.js.map",
        alsoFails: ["source-map-content"],
      },
      {
        name: "N12 a source map in a nested folder",
        changes: () => ({ "experiment/nested/deep/parent.js.map": SOURCE_MAP }),
        path: "experiment/nested/deep/parent.js.map",
        alsoFails: ["source-map-content"],
      },
    ],
  },
  {
    id: "source-file",
    inspects: "path",
    decides: "the path ends in a source suffix such as .ts, .tsx or .jsx",
    check: (file) => (file.kind === "source" ? "source files must not ship" : undefined),
    plants: [
      {
        name: "V03 a TypeScript file",
        changes: () => ({ "experiment/parent.ts": "export const namespace = 1;\n" }),
        path: "experiment/parent.ts",
      },
      {
        name: "V04 a TSX file",
        changes: () => ({ "src/popup/main.tsx": "export const Popup = () => null;\n" }),
        path: "src/popup/main.tsx",
      },
      {
        name: "V05 a JSX file",
        changes: () => ({ "components/Button.jsx": "export const Button = () => null;\n" }),
        path: "components/Button.jsx",
      },
      {
        name: "N11 a TypeScript file in a nested folder",
        changes: () => ({ "experiment/nested/deep/parent.ts": "export const namespace = 1;\n" }),
        path: "experiment/nested/deep/parent.ts",
      },
    ],
  },
  {
    id: "unknown-file-type",
    inspects: "path",
    decides: "the path ends in no suffix of KIND_BY_SUFFIX, so the file's kind cannot be checked",
    check: (file) =>
      file.kind === undefined
        ? "not a file type an XPI ships; add it to KIND_BY_SUFFIX if it should"
        : undefined,
    plants: [
      {
        name: "V14 a notes file",
        changes: () => ({ "NOTES.md": "# notes\n" }),
        path: "NOTES.md",
      },
      {
        name: "N04 an unminified module with an .mjs suffix",
        changes: (fixtures) => ({ "experiment/api.mjs": fixtures.unminifiedParent }),
        path: "experiment/api.mjs",
      },
      {
        name: "N05 an unminified script with a .cjs suffix",
        changes: (fixtures) => ({ "experiment/api.cjs": fixtures.unminifiedParent }),
        path: "experiment/api.cjs",
      },
      {
        name: "N06 one long readable function in an .mjs file",
        changes: () => ({
          "experiment/api.mjs": `export function readHeaders(entries) { const result = []; for (const entry of entries) { if (entry.name !== undefined) { result.push({ name: entry.name, value: String(entry.value) }); } } return result; } export default readHeaders;`,
        }),
        path: "experiment/api.mjs",
      },
    ],
  },
  {
    id: "dev-only-file",
    inspects: "path",
    decides:
      "the path is under a test, fixture or tooling folder, or is a package or tsconfig file",
    check: (file) =>
      DEV_ONLY_PATH.test(file.path) ? "a test, fixture or tooling file must not ship" : undefined,
    plants: [
      {
        name: "V11 a minified script under tests/",
        changes: (fixtures) => ({ "tests/helper.js": fixtures.minifiedParent }),
        path: "tests/helper.js",
      },
      {
        name: "a tooling script that extension.js bundled from scripts/",
        changes: (fixtures) => ({ "scripts/xpi-rules.js": fixtures.minifiedParent }),
        path: "scripts/xpi-rules.js",
      },
      {
        name: "V12 package.json",
        changes: () => ({ "package.json": '{"name":"extension"}' }),
        path: "package.json",
      },
      {
        name: "V13 a fixture capture",
        changes: () => ({ "fixtures/capture.json": "{}" }),
        path: "fixtures/capture.json",
      },
    ],
  },
  {
    id: "not-a-png",
    inspects: "contents",
    decides: "a .png file does not start with the eight PNG signature bytes",
    check: (file) =>
      file.kind === "raster" && !PNG_SIGNATURE.every((byte, i) => file.bytes[i] === byte)
        ? "not a PNG image: the file does not start with the PNG signature"
        : undefined,
    plants: [
      {
        name: "a script named like an icon",
        changes: (fixtures) => ({ "icons/16.png": fixtures.unminifiedParent }),
        path: "icons/16.png",
      },
    ],
  },
  {
    id: "invalid-json",
    inspects: "contents",
    decides:
      "a .json file does not parse as JSON, which has no comments and no trailing commas, so no text hides in it",
    check: (file) => {
      if (file.kind !== "data") return undefined;
      const parsed = parseJson(file.text);
      return parsed.ok ? undefined : `not valid JSON (${parsed.error})`;
    },
    plants: [
      {
        name: "N08 pretty JSON with a // comment and a readable function in a string",
        changes: () => ({
          "experiment/config.json": `{\n  // build notes\n  "snippet": ${JSON.stringify(PRETTY_FUNCTION)}\n}\n`,
        }),
        path: "experiment/config.json",
      },
      {
        name: "a JSON file with a trailing comma",
        changes: () => ({ "manifest.json": '{"manifest_version":3,}' }),
        path: "manifest.json",
      },
    ],
  },
  {
    id: "source-map-content",
    inspects: "contents",
    decides: "the text parses as a JSON object with version 3 and a mappings string or sections",
    check: (file) => {
      if (file.kind === "raster" || !file.text.trimStart().startsWith("{")) return undefined;
      const parsed = parseJson(file.text);
      return parsed.ok && isSourceMap(parsed.value)
        ? "the text is a source map, which ships the original source whatever the file is called"
        : undefined;
    },
    plants: [
      {
        name: "N02 a source map named parent.map.json",
        changes: () => ({ "experiment/parent.map.json": SOURCE_MAP }),
        path: "experiment/parent.map.json",
        alsoFails: ["json-embeds-source"],
      },
      {
        name: "a source map named like a script",
        changes: () => ({ "experiment/parent.js": SOURCE_MAP }),
        path: "experiment/parent.js",
      },
    ],
  },
  {
    id: "json-embeds-source",
    inspects: "contents",
    decides: `a string inside a .json file breaks across more than ${MAX_BREAKS_IN_WINDOW} lines in ${WINDOW_CHARACTERS} characters`,
    check: (file) => {
      if (file.kind !== "data") return undefined;
      const parsed = parseJson(file.text);
      if (!parsed.ok) return undefined;
      const readable = jsonStrings(parsed.value).find(
        ([, text]) => densestStretch(text).breaks > MAX_BREAKS_IN_WINDOW,
      );
      return readable === undefined
        ? undefined
        : `${readable[0]} is a string that holds readable lines of source`;
    },
    plants: [
      {
        name: "pretty valid JSON with a readable function in a string",
        changes: () => ({
          "experiment/notes.json": JSON.stringify({ snippet: PRETTY_FUNCTION }, null, 2),
        }),
        path: "experiment/notes.json",
      },
    ],
  },
  {
    id: "source-map-reference",
    inspects: "contents",
    decides: "a comment in a script or style, found by tokenizing, names a sourceMappingURL",
    check: (file) => {
      const syntax = syntaxOf(file);
      if (syntax !== "script" && syntax !== "style") return undefined;
      const reference = findComments(file.text, syntax).find((span) =>
        SOURCE_MAP_REFERENCE.test(file.text.slice(span.start, span.end)),
      );
      return reference === undefined
        ? undefined
        : `line ${lineOf(file.text, reference.start)} has a sourceMappingURL comment`;
    },
    plants: [
      {
        name: "V06 a sourceMappingURL comment on the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n//# sourceMappingURL=parent.js.map\n`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "N03 an inline data: source map on the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "a sourceMappingURL comment on a stylesheet",
        changes: () => ({
          "action/index.css": "body{margin:0}\n/*# sourceMappingURL=index.css.map */",
        }),
        path: "action/index.css",
        alsoFails: ["comment"],
      },
    ],
  },
  {
    id: "development-build",
    inspects: "contents",
    decides: "the text of any file holds a string that only a development build keeps",
    check: (file) => {
      const marker = DEVELOPMENT_MARKERS.find((candidate) => file.text.includes(candidate));
      return marker === undefined
        ? undefined
        : `contains \`${marker}\`, which only a development build keeps`;
    },
    plants: [
      {
        name: "V07 a minified script with an unfolded development branch",
        changes: (fixtures) => ({
          "action/index.js": `${fixtures.minifiedParent};"production"!==process.env.NODE_ENV&&console.log(1);`,
        }),
        path: "action/index.js",
      },
      {
        name: "V08 the React DevTools banner in a minified script",
        changes: (fixtures) => ({
          "shared/commons.js": `${fixtures.minifiedParent};console.info("Download the React DevTools");`,
        }),
        path: "shared/commons.js",
      },
      {
        name: "V15 React's development build named like the bundle",
        changes: (fixtures) => ({ "vendor/react.js": fixtures.reactDevelopment }),
        path: "vendor/react.js",
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "N07 React's development build renamed to a .json file",
        changes: (fixtures) => ({
          "vendor/react-dom-client.production.json": fixtures.reactDevelopment,
        }),
        path: "vendor/react-dom-client.production.json",
        alsoFails: ["invalid-json"],
      },
      {
        name: "a development marker in valid JSON",
        changes: () => ({ "experiment/mode.json": '{"mode":"process.env.NODE_ENV"}' }),
        path: "experiment/mode.json",
      },
    ],
  },
  {
    id: "comment",
    inspects: "contents",
    decides:
      "tokenizing a script, style or vector finds a comment that is not a short legal notice",
    check: (file) => {
      const syntax = syntaxOf(file);
      if (syntax === undefined) return undefined;
      const { ordinary } = classifyComments(file.text, syntax);
      const first = ordinary[0];
      return first === undefined
        ? undefined
        : `${plural(ordinary.length, "comment")}, a minifier removes them all; first at line ${lineOf(file.text, first.start)}: ${excerpt(file.text.slice(first.start, first.end))}`;
    },
    plants: [
      {
        name: "a line comment after the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n// tidy this up later\n`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a block comment before a stylesheet",
        changes: () => ({ "action/index.css": "/* popup styles */body{margin:0}" }),
        path: "action/index.css",
      },
      {
        name: "a comment in a vector image",
        changes: (fixtures) => ({
          "icons/toolbar.svg": fixtures.toolbarSvg.replace("<rect", "<!-- bars --><rect"),
        }),
        path: "icons/toolbar.svg",
      },
    ],
  },
  {
    id: "legal-comment",
    inspects: "contents",
    decides:
      "a comment with a legal marker is over 400 characters or has code punctuation or keywords",
    check: (file) => {
      const syntax = syntaxOf(file);
      if (syntax === undefined) return undefined;
      const [first] = classifyComments(file.text, syntax).rejected;
      return first === undefined
        ? undefined
        : `the legal comment at line ${lineOf(file.text, first.start)} ${first.reason}`;
    },
    plants: [
      {
        name: "N01 a readable function inside a one-line /*! comment",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! function readHeaders(entries) { return entries.map((entry) => entry.name); } */\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a /*! comment of prose over 400 characters",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! ${"This notice is far longer than a pointer to a license file needs to be. ".repeat(8)}*/\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a @license comment that assigns a value",
        changes: (fixtures) => ({
          "experiment/parent.js": `/** @license token = readHeaders(entries) */\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
      },
    ],
  },
  {
    id: "not-minified",
    inspects: "contents",
    decides: `a script, style or vector has more than ${MAX_BREAKS_IN_WINDOW} line breaks inside any ${WINDOW_CHARACTERS} characters, so a long line cannot carry the lines around it`,
    check: (file) => {
      const syntax = syntaxOf(file);
      if (syntax === undefined) return undefined;
      const stretch = densestStretch(file.text, classifyComments(file.text, syntax).legal);
      return stretch.breaks > MAX_BREAKS_IN_WINDOW
        ? `lines ${stretch.firstLine} to ${stretch.lastLine} have ${stretch.breaks} line breaks within ${stretch.characters} characters; a minifier leaves at most ${MAX_BREAKS_IN_WINDOW} in ${WINDOW_CHARACTERS}`
        : undefined;
    },
    plants: [
      {
        name: "V01 an unminified parent script",
        changes: (fixtures) => ({ "experiment/parent.js": fixtures.unminifiedParent }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "V09 a pretty stylesheet",
        changes: () => ({
          "action/index.css": "body {\n  margin: 0;\n}\n\nh1 {\n  font-size: 15px;\n}\n",
        }),
        path: "action/index.css",
      },
      {
        name: "V10 a pretty vector image",
        changes: (fixtures) => ({ "icons/toolbar.svg": prettySvg(fixtures) }),
        path: "icons/toolbar.svg",
      },
      {
        name: "N09 a pretty function repeated 8 times after the large bundle",
        changes: (fixtures) => ({
          "shared/framework.js": `${fixtures.framework}\n${PRETTY_FUNCTION.repeat(8)}`,
        }),
        path: "shared/framework.js",
      },
      {
        name: "N10 a pretty function repeated 8 times after the parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n${PRETTY_FUNCTION.repeat(8)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a pretty function in the middle of the large bundle",
        changes: ({ framework }) => {
          const middle = Math.floor(framework.length / 2);
          return {
            "shared/framework.js": `${framework.slice(0, middle)};\n${PRETTY_FUNCTION}${framework.slice(middle)}`,
          };
        },
        path: "shared/framework.js",
      },
      {
        name: "a pretty function inside a template literal",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};var worker=\`${PRETTY_FUNCTION}\`;`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a pretty script written inline in a page",
        changes: () => ({
          "action/index.html": `<!DOCTYPE html><html><body><div id="root"></div><script>\n${PRETTY_FUNCTION}</script></body></html>`,
        }),
        path: "action/index.html",
      },
    ],
  },
  {
    id: "notice-carries-code",
    inspects: "contents",
    decides: `a .LICENSE.txt file has more than ${MAX_NOTICE_CODE_LINES} lines that look like code`,
    check: (file) => {
      if (file.kind !== "notice") return undefined;
      const codeLines = file.text
        .split("\n")
        .flatMap((line, i) => (NOTICE_CODE_LINE.test(line) ? [i + 1] : []));
      return codeLines.length > MAX_NOTICE_CODE_LINES
        ? `${plural(codeLines.length, "line")} look like code, the first is line ${codeLines[0]}; a notice is prose`
        : undefined;
    },
    plants: [
      {
        name: "a function in a license notice",
        changes: () => ({ "shared/framework.js.LICENSE.txt": PRETTY_FUNCTION }),
        path: "shared/framework.js.LICENSE.txt",
      },
    ],
  },
];
