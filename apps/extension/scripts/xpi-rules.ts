// The rules an XPI must pass, as one table. A file's extension only says what it claims to be; the rules read its
// bytes to check the claim. Every row carries the planted archive that proves it, and check-xpi.test.ts runs them all.
import { experiments } from "@rspack/core";
import { transform as transformCss } from "lightningcss";
import {
  classifyComments,
  findComments,
  hasLineTerminator,
  lineBreaksOutsideData,
  lineOf,
  parseScript,
  readStyle,
  skipString,
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

// The only file types an XPI may ship. Matched by suffix, first hit wins. A path that matches none is a violation.
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((byte, i) => bytes[i] === byte);

// Byte signatures of containers the build never emits. A source map or a development build hidden in one of
// these is not the only problem: the container itself does not belong in a packed extension.
const FOREIGN_BYTES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["ZIP archive", [0x50, 0x4b, 0x03, 0x04]],
  ["ZIP archive", [0x50, 0x4b, 0x05, 0x06]],
  ["ZIP archive", [0x50, 0x4b, 0x07, 0x08]],
  ["gzip stream", [0x1f, 0x8b]],
  ["WebAssembly module", [0x00, 0x61, 0x73, 0x6d]],
  ["ELF binary", [0x7f, 0x45, 0x4c, 0x46]],
  ["Mach-O binary", [0xcf, 0xfa, 0xed, 0xfe]],
  ["Mach-O binary", [0xce, 0xfa, 0xed, 0xfe]],
  ["PDF document", [0x25, 0x50, 0x44, 0x46]],
  ["RAR archive", [0x52, 0x61, 0x72, 0x21]],
  ["7-Zip archive", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
];

/** What the bytes are, judged by their first bytes rather than by the path. */
const contentOf = (bytes: Uint8Array): string => {
  if (startsWith(bytes, PNG_SIGNATURE)) return "PNG image";
  const foreign = FOREIGN_BYTES.find(([, signature]) => startsWith(bytes, signature));
  return foreign?.[0] ?? "text";
};

const isText = (unit: Unit): boolean => contentOf(unit.bytes) === "text";

/** The bytes as text for a content scan. A PNG keeps the bytes it carries after its image data. */
const rawText = (unit: Unit): string =>
  unit.kind === "raster" ? new TextDecoder("latin1").decode(unit.bytes) : unit.text;

const TAG_NAME = /^[a-zA-Z][\w:-]*/;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const DATA_URL = /^data:([^,]*),(.*)$/s;

interface Attribute {
  readonly name: string;
  readonly value: string;
}

const decodeEntities = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const readAttributes = (text: string): readonly Attribute[] =>
  [...text.matchAll(ATTRIBUTE)].flatMap((match) => {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4];
    return name === undefined || value === undefined
      ? []
      : [{ name: name.toLowerCase(), value: decodeEntities(value) }];
  });

const endOfTag = (text: string, from: number): number => {
  for (let i = from; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === ">") return i + 1;
    if (char === '"' || char === "'") i = skipString(text, i) - 1;
  }
  return text.length;
};

const decodeDataUrl = (
  url: string,
): { readonly mime: string; readonly text: string } | undefined => {
  const match = DATA_URL.exec(url);
  if (match === null) return undefined;
  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  const mime = meta.split(";")[0] ?? "";
  if (/;base64/i.test(meta)) {
    try {
      return { mime, text: Buffer.from(payload, "base64").toString("utf8") };
    } catch {
      return undefined;
    }
  }
  try {
    return { mime, text: decodeURIComponent(payload) };
  } catch {
    return undefined;
  }
};

const kindFromMime = (mime: string): Kind => (mime.includes("css") ? "style" : "script");

const carried = (file: Unit, where: string, kind: Kind, text: string): Unit => ({
  path: file.path,
  where,
  kind,
  bytes: new TextEncoder().encode(text),
  text,
});

/**
 * Every script and style the markup would run: a closed or unclosed `<script>` body, a `data:` URL in `src`,
 * an `on*` handler and a `style` attribute. The build emits none of them, so each one is judged like a file.
 */
export const inlineBodies = (file: Unit): readonly Unit[] => {
  if (file.kind !== "markup" && file.kind !== "vector") return [];
  const units: Unit[] = [];
  const text = file.text;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<", i);
    if (open < 0) break;
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    const name = TAG_NAME.exec(text.slice(open + 1, open + 41))?.[0];
    if (name === undefined) {
      i = open + 1;
      continue;
    }
    const tag = name.toLowerCase();
    const tagEnd = endOfTag(text, open + 1 + name.length);
    const attributes = readAttributes(text.slice(open + 1 + name.length, tagEnd - 1));
    for (const attribute of attributes) {
      if (attribute.name.startsWith("on")) {
        if (attribute.value.trim() !== "")
          units.push(carried(file, `inline handler ${attribute.name}`, "script", attribute.value));
      } else if (attribute.name === "style") {
        if (attribute.value.trim() !== "")
          units.push(carried(file, "inline style attribute", "style", attribute.value));
      }
    }
    if (tag === "script") {
      const source = attributes.find(({ name: attribute }) => attribute === "src");
      const data = source === undefined ? undefined : decodeDataUrl(source.value);
      if (data !== undefined && data.text.trim() !== "") {
        units.push(carried(file, "inline <script src>", kindFromMime(data.mime), data.text));
      }
    }
    if (tag === "script" || tag === "style") {
      const close = text.toLowerCase().indexOf(`</${tag}`, tagEnd);
      const body = text.slice(tagEnd, close < 0 ? text.length : close);
      if (body.trim() !== "") units.push(carried(file, `inline <${tag}>`, tag, body));
      i = close < 0 ? text.length : close + tag.length + 2;
    } else i = tagEnd;
  }
  return units;
};

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

const SOURCE_MAP_VERSION = /"version"\s*:\s*3/g;

const matchingBrace = (text: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === '"') i = skipString(text, i) - 1;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** A version 3 map object at any offset, not only as the whole file. */
const findSourceMap = (text: string): number | undefined => {
  for (const match of text.matchAll(SOURCE_MAP_VERSION)) {
    const open = text.lastIndexOf("{", match.index);
    if (open < 0) continue;
    const close = matchingBrace(text, open);
    if (close < 0 || close - open > 2_000_000) continue;
    const parsed = parseJson(text.slice(open, close + 1));
    if (parsed.ok && isSourceMap(parsed.value)) return open;
  }
  return undefined;
};

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

/** Saved bytes a minified file may still give up. Measured on the real build: 0, 3, 13 and 342 bytes. */
export const MINIFY_SAVED_BYTES = 32;
export const MINIFY_SAVED_FRACTION = 0.03;

export const minifyMargin = (length: number): number =>
  Math.max(MINIFY_SAVED_BYTES, Math.ceil(length * MINIFY_SAVED_FRACTION));

// The same minifier the extension build runs, with comments kept so the comment rules own them.
const reMinifyScript = (text: string): number => {
  try {
    const { code } = experiments.swc.minifySync(text, {
      mangle: true,
      compress: true,
      format: { comments: "all" },
    });
    return text.length - code.length;
  } catch {
    return 0;
  }
};

// The same minifier the build runs for stylesheets.
const reMinifyStyle = (text: string): number => {
  try {
    const { code } = transformCss({
      filename: "packed.css",
      code: Buffer.from(text),
      minify: true,
    });
    return text.length - code.length;
  } catch {
    return 0;
  }
};

/** Bytes the build's minifier would remove. Undefined for a file that has no minifier. */
export const minifySaving = (unit: Unit): number | undefined => {
  const syntax = syntaxOf(unit);
  if (syntax === "script") return reMinifyScript(unit.text);
  if (syntax === "style") return reMinifyStyle(unit.text);
  return undefined;
};

// Strings that only a development build keeps. A production build folds these away.
const DEVELOPMENT_MARKERS: ReadonlyArray<string> = [
  "NODE_ENV",
  "jsxDEV",
  "__DEV__",
  "Download the React DevTools",
];

const DEV_ONLY_PATH =
  /(^|\/)(node_modules|__tests__|__mocks__|fixtures?|tests?|scripts)\/|\.(test|spec|stories)\.|(^|\/)(package|tsconfig[^/]*)\.json$/;

const NOTICE_CODE_LINE = /[{}]\s*$|=>|^\s*(?:function|const|let|var|import|export|return)\s+\S/;
const MAX_NOTICE_CODE_LINES = 2;

const SOURCE_MAP_REFERENCE = /[#@]\s*sourceMappingURL=/;

const READABLE_SOURCE = /\b(?:function|return|const|let|var|class|if|for|while)\b/;
const STRING_SOURCE_MIN_CHARACTERS = 120;
const STRING_SOURCE_MIN_LINE_BREAKS = 2;
const STRING_SOURCE_MIN_SAVED_FRACTION = 0.4;

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
  /** The real framework.js.LICENSE.txt. */
  readonly reactLicense: Uint8Array;
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

const padLines = (text: string, width: number): string =>
  text
    .split("\n")
    .map((line) => line.padEnd(width))
    .join("\n");

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
        alsoFails: ["source-map-signature"],
      },
      {
        name: "N12 a source map in a nested folder",
        changes: () => ({ "experiment/nested/deep/parent.js.map": SOURCE_MAP }),
        path: "experiment/nested/deep/parent.js.map",
        alsoFails: ["source-map-signature"],
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
      {
        name: "E24 a WebAssembly module saved with a .wasm suffix",
        changes: () => ({ "experiment/engine.wasm": WASM_MODULE }),
        path: "experiment/engine.wasm",
        alsoFails: ["foreign-content"],
      },
      {
        name: "E25 a nested XPI saved with an .xpi suffix",
        changes: () => ({ "vendor/inner.xpi": ZIP_ARCHIVE }),
        path: "vendor/inner.xpi",
        alsoFails: ["foreign-content"],
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
    id: "foreign-content",
    inspects: "contents",
    decides:
      "the first bytes are a container the build never emits: an archive, wasm or an executable",
    check: (file) => {
      if (isText(file)) return undefined;
      const content = contentOf(file.bytes);
      if (content === "PNG image") {
        return file.kind === "raster"
          ? undefined
          : "the bytes are a PNG image, not the text the path claims";
      }
      return `the bytes are a ${content}, which the build never emits`;
    },
    plants: [
      {
        name: "E10 a stored ZIP of source files named as a page",
        changes: () => ({ "vendor/payload.html": ZIP_ARCHIVE }),
        path: "vendor/payload.html",
      },
      {
        name: "E11 a WebAssembly module named as a script",
        changes: () => ({ "vendor/engine.js": WASM_MODULE }),
        path: "vendor/engine.js",
      },
      {
        name: "a PNG image named as a script",
        changes: () => ({ "experiment/parent.js": PNG_IMAGE }),
        path: "experiment/parent.js",
      },
    ],
  },
  {
    id: "not-a-png",
    inspects: "contents",
    decides: "a .png file does not start with the eight PNG signature bytes",
    check: (file) =>
      file.kind === "raster" && !startsWith(file.bytes, PNG_SIGNATURE)
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
    id: "not-vector",
    inspects: "contents",
    decides: "a .svg file's text holds no <svg element",
    check: (file) =>
      file.kind === "vector" && isText(file) && !/<svg[\s>]/i.test(file.text)
        ? "not an SVG image: the text holds no <svg element"
        : undefined,
    plants: [
      {
        name: "a script named as a vector image",
        changes: (fixtures) => ({ "icons/icon.svg": fixtures.minifiedParent }),
        path: "icons/icon.svg",
      },
    ],
  },
  {
    id: "not-markup",
    inspects: "contents",
    decides: "a .html file's text holds no <html> or <!doctype html>",
    check: (file) =>
      file.kind === "markup" && isText(file) && !/<(?:!doctype\s+html|html)\b/i.test(file.text)
        ? "not an HTML page: the text holds no html element or doctype"
        : undefined,
    plants: [
      {
        name: "a script named as a page",
        changes: (fixtures) => ({ "action/index.html": fixtures.minifiedParent }),
        path: "action/index.html",
      },
    ],
  },
  {
    id: "invalid-json",
    inspects: "contents",
    decides:
      "a .json file does not parse as JSON, which has no comments and no trailing commas, so no text hides in it",
    check: (file) => {
      if (file.kind !== "data" || !isText(file)) return undefined;
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
    id: "source-map-signature",
    inspects: "contents",
    decides:
      "a version 3 map object sits anywhere in the file's bytes or in a string it holds, not only as the whole file",
    check: (file) => {
      const raw = findSourceMap(rawText(file));
      if (raw !== undefined) return `bytes at offset ${raw} are a version 3 source map`;
      if (syntaxOf(file) === "script" && isText(file)) {
        for (const { span, value } of parseScript(file.text).strings) {
          const at = findSourceMap(value);
          if (at !== undefined)
            return `the string at line ${lineOf(file.text, span.start)} holds a version 3 source map`;
        }
      }
      if (file.kind === "data" && isText(file)) {
        const parsed = parseJson(file.text);
        if (parsed.ok) {
          for (const [path, value] of jsonStrings(parsed.value)) {
            if (findSourceMap(value) !== undefined) return `${path} holds a version 3 source map`;
          }
        }
      }
      return undefined;
    },
    plants: [
      {
        name: "N02 a source map named parent.map.json",
        changes: () => ({ "experiment/parent.map.json": SOURCE_MAP }),
        path: "experiment/parent.map.json",
      },
      {
        name: "a source map named like a script",
        changes: () => ({ "experiment/parent.js": SOURCE_MAP }),
        path: "experiment/parent.js",
        alsoFails: ["invalid-script"],
      },
      {
        name: "E07 a source map after a NUL byte on the parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\u0000${SOURCE_MAP}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["invalid-script"],
      },
      {
        name: "E08 a source map in a vector <desc>",
        changes: (fixtures) => ({
          "icons/icon.svg": fixtures.toolbarSvg.replace(
            "</svg>",
            `<desc>${SOURCE_MAP}</desc></svg>`,
          ),
        }),
        path: "icons/icon.svg",
      },
      {
        name: "E12 a source map appended after PNG image data",
        changes: () => ({
          "icons/16.png": new Uint8Array([...PNG_IMAGE, ...new TextEncoder().encode(SOURCE_MAP)]),
        }),
        path: "icons/16.png",
      },
      {
        name: "E21 a source map held in a JSON string",
        changes: () => ({
          "experiment/notes.json": JSON.stringify({ blob: SOURCE_MAP }),
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
      if ((syntax !== "script" && syntax !== "style") || !isText(file)) return undefined;
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
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "N03 an inline data: source map on the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "E17 a sourceMappingURL hidden after a division-looking comment opener",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}a++/2;//# sourceMappingURL=parent.js.map`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment"],
      },
      {
        name: "E18 an inline data: source map hidden after a division-looking comment opener",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}a++/2;/*# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ== */0`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "a sourceMappingURL comment on a stylesheet",
        changes: () => ({
          "action/index.css": "body{margin:0}\n/*# sourceMappingURL=index.css.map */",
        }),
        path: "action/index.css",
        alsoFails: ["comment", "not-minified"],
      },
    ],
  },
  {
    id: "development-build",
    inspects: "contents",
    decides: "the bytes or text hold a marker that only a development build keeps",
    check: (file) => {
      if (!isText(file)) return undefined;
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
      {
        name: "E09 a one-line development helper with a bracket environment lookup",
        changes: () => ({
          "experiment/dev.js": `var jsxDEV=(e,t)=>({type:e,props:t});if(process["env"]["NODE_ENV"]!=="production"){console.log("dev")}`,
        }),
        path: "experiment/dev.js",
      },
      {
        name: "E22 a bracket lookup alone on the minified parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};"production"!==process["env"]["NODE_ENV"]&&console.log(1);`,
        }),
        path: "experiment/parent.js",
      },
    ],
  },
  {
    id: "invalid-script",
    inspects: "contents",
    decides: "the same parser the build runs reports a syntax error in a script",
    check: (file) => {
      if (syntaxOf(file) !== "script" || !isText(file)) return undefined;
      const [error] = parseScript(file.text).errors;
      return error === undefined ? undefined : `does not parse: ${error}`;
    },
    plants: [
      {
        name: "a script the parser rejects",
        changes: () => ({ "experiment/broken.js": "function ({" }),
        path: "experiment/broken.js",
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
      if (syntax === undefined || !isText(file)) return undefined;
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
        alsoFails: ["not-minified"],
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
      {
        name: "E16 a readable function in a comment after an increment and a division",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}a++/2;/* function readHeaders(entries) { return entries.map((entry) => entry.name); } */0`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["not-minified"],
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
      if (syntax === undefined || !isText(file)) return undefined;
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
        alsoFails: ["not-minified"],
      },
      {
        name: "a /*! comment of prose over 400 characters",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! ${"This notice is far longer than a pointer to a license file needs to be. ".repeat(8)}*/\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["not-minified"],
      },
      {
        name: "a @license comment that assigns a value",
        changes: (fixtures) => ({
          "experiment/parent.js": `/** @license token = readHeaders(entries) */\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["not-minified"],
      },
      {
        name: "E20 a legal comment of calls and comparisons",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! ${"readHeaders(entries)===entries.length&&check(entries)===true&&".repeat(5)}*/\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["not-minified"],
      },
    ],
  },
  {
    id: "not-minified",
    inspects: "contents",
    decides:
      "re-minifying with the build's minifier saves more than the measured margin, a script or style has a line break between tokens, or a vector has any line break",
    check: (file) => {
      const syntax = syntaxOf(file);
      if (syntax === undefined || !isText(file)) return undefined;
      if (syntax === "vector")
        return hasLineTerminator(file.text.trim())
          ? "the vector has a line break; the build emits its icons on one line"
          : undefined;
      const { legal } = classifyComments(file.text, syntax);
      const facts = syntax === "script" ? parseScript(file.text) : readStyle(file.text);
      const data = [...facts.data, ...facts.comments];
      const [firstBreak] = lineBreaksOutsideData(file.text, data, legal);
      if (firstBreak !== undefined) {
        return `line ${lineOf(file.text, firstBreak)} has a line break between tokens; a minifier leaves none`;
      }
      const saved = minifySaving(file) ?? 0;
      const margin = minifyMargin(file.text.length);
      return saved > margin
        ? `re-minifying removes ${saved} bytes (${((saved / file.text.length) * 100).toFixed(1)}%), more than the ${margin} bytes a minified file may give up`
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
        alsoFails: ["invalid-script"],
      },
      {
        name: "a pretty script written inline in a page",
        changes: () => ({
          "action/index.html": `<!DOCTYPE html><html><body><div id="root"></div><script>\n${PRETTY_FUNCTION}</script></body></html>`,
        }),
        path: "action/index.html",
      },
      {
        name: "E01 readable source padded to 170-character lines",
        changes: () => ({ "experiment/readable.js": padLines(PRETTY_FUNCTION.repeat(6), 170) }),
        path: "experiment/readable.js",
      },
      {
        name: "E02 readable source written with carriage returns",
        changes: () => ({
          "experiment/parent.js": PRETTY_FUNCTION.repeat(8).replaceAll("\n", "\r"),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "E03 readable source written with U+2028 line separators",
        changes: () => ({
          "experiment/parent.js": PRETTY_FUNCTION.repeat(8).replaceAll("\n", "\u2028"),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "E04 readable source written with U+2029 paragraph separators",
        changes: () => ({
          "experiment/parent.js": PRETTY_FUNCTION.repeat(4).replaceAll("\n", "\u2029"),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "E13 an unclosed inline script through the end of the page",
        changes: () => ({
          "action/index.html": `<!DOCTYPE html><html><body><script>${PRETTY_FUNCTION.repeat(20)}`,
        }),
        path: "action/index.html",
      },
      {
        name: "E14 an inline script carried in a data: URL",
        changes: () => ({
          "action/index.html": `<!DOCTYPE html><html><body><script src="data:text/javascript;base64,${Buffer.from(PRETTY_FUNCTION).toString("base64")}"></script></body></html>`,
        }),
        path: "action/index.html",
      },
      {
        name: "E15 a readable function in an onclick handler",
        changes: () => ({
          "action/index.html": `<!DOCTYPE html><html><body><button onclick="${PRETTY_FUNCTION}">go</button></body></html>`,
        }),
        path: "action/index.html",
      },
      {
        name: "E19 stylesheet rules separated by U+2028",
        changes: () => ({
          "action/index.css": "body{margin:0}\u2028h1{font-size:15px}",
        }),
        path: "action/index.css",
      },
      {
        name: "E23 a closed inline script with a readable function",
        changes: () => ({
          "action/index.html": `<!DOCTYPE html><html><body><script>${PRETTY_FUNCTION}</script></body></html>`,
        }),
        path: "action/index.html",
      },
      {
        name: "E27 stylesheet rules padded to 170-character lines",
        changes: () => ({
          "action/index.css": padLines("body{margin:0}\nh1{font-size:15px}", 170),
        }),
        path: "action/index.css",
      },
    ],
  },
  {
    id: "string-holds-source",
    inspects: "contents",
    decides:
      "a string or template in a script decodes to text with readable source lines that the minifier shrinks by over 40%",
    check: (file) => {
      if (syntaxOf(file) !== "script" || !isText(file)) return undefined;
      for (const { span, value } of parseScript(file.text).strings) {
        const breaks = value.match(/[\n\r\u2028\u2029]/g)?.length ?? 0;
        if (
          breaks < STRING_SOURCE_MIN_LINE_BREAKS ||
          value.length < STRING_SOURCE_MIN_CHARACTERS ||
          !READABLE_SOURCE.test(value)
        )
          continue;
        const saved = reMinifyScript(value);
        if (saved > Math.max(64, Math.ceil(value.length * STRING_SOURCE_MIN_SAVED_FRACTION))) {
          return `the string at line ${lineOf(file.text, span.start)} holds readable source (re-minifying its value removes ${saved} bytes)`;
        }
      }
      return undefined;
    },
    plants: [
      {
        name: "E05 a readable function hidden in a template literal with escaped newlines",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};var worker=\`${PRETTY_FUNCTION.replaceAll("\n", "\\n")}\`;`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "E26 a readable function in a template literal with real newlines",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};var worker=\`${PRETTY_FUNCTION}\`;`,
        }),
        path: "experiment/parent.js",
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

const PNG_IMAGE = new Uint8Array([
  ...PNG_SIGNATURE,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
]);

const WASM_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03,
  0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x66, 0x6f, 0x6f, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04,
  0x00, 0x41, 0x01, 0x0b,
]);

const ZIP_ARCHIVE = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8e,
  0x08, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x70, 0x2e, 0x74, 0x73,
]);
