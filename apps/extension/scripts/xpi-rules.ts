// What may ship in an XPI, as tables: the kind of each file, the build step that writes it with the minifier that
// step runs, and the rules. A file's suffix only says what it claims to be; a reader parses its bytes into facts and
// the rules judge the facts. Every rule carries the planted archive that proves it, and check-xpi.test.ts runs them.
import * as NodeZlib from "node:zlib";
import { experiments } from "@rspack/core";
import { CANNOT_JUDGE } from "./check-xpi.ts";
import { minifyScript, minifyStyle, minifyStyleAttribute, reminifyScript } from "./minify.ts";
import { readMarkup, type BodyKind, type Markup } from "./xpi-markup.ts";
import { classifyComments, lineOf, parseScript, type ScriptFacts } from "./xpi-source.ts";

export type Kind = BodyKind | "notice" | "source-map" | "source";

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

interface Producer {
  readonly builtBy: string;
  /** The producer's minifier, run again by the check. A minified file comes back at most `margin` bytes smaller. */
  readonly minifier?: { readonly run: (text: string) => string; readonly margin: number };
}

// What a second run of the build's own minifier still saves on honest output, measured: 0 bytes on every packed
// script but 1 on shared/framework.js, and at most 7 (vue) on the eight libraries minify.test.ts builds through both
// script build paths. 16 is about twice that. One 210 byte readable function saves 89.
const SCRIPT_MARGIN_BYTES = 16;
// lightningcss reaches a fixed point in one run: 0 bytes on both packed stylesheets and on real 13 and 90 KB sheets.
const STYLE_MARGIN_BYTES = 0;

/** Which build step writes each kind of file, and so which minifier a packed file of that kind must survive. */
export const PRODUCERS: Readonly<Record<Kind, Producer>> = {
  script: {
    builtBy:
      "rspack's SwcJsMinimizerRspackPlugin for the pages and build-experiment.ts for the parent, both with minify.ts",
    minifier: { run: reminifyScript, margin: SCRIPT_MARGIN_BYTES },
  },
  style: {
    builtBy: "the minify.ts style minimizer in the rspack page build",
    minifier: { run: minifyStyle, margin: STYLE_MARGIN_BYTES },
  },
  "style-attribute": {
    builtBy: "nothing; the build writes no style attribute, so one is judged like a stylesheet",
    minifier: { run: minifyStyleAttribute, margin: STYLE_MARGIN_BYTES },
  },
  vector: { builtBy: "extension.js, which copies src/icons as written, on one line" },
  markup: { builtBy: "extension.js, which writes each page shell and loads every script by src" },
  data: {
    builtBy: "JSON.stringify: the manifest by extension.js, the schema by build-experiment.ts",
  },
  raster: { builtBy: "write-icons.ts, which renders the SVG master with resvg" },
  notice: {
    builtBy: "SwcJsMinimizerRspackPlugin, which extracts legal comments into <chunk>.LICENSE.txt",
  },
  "source-map": { builtBy: "nothing; the build writes no source map" },
  source: { builtBy: "nothing; the build ships no source file" },
};

/** A file in the archive, or a body carried inside one (an inline `<script>`, a `srcdoc` page). */
export interface Unit {
  readonly path: string;
  /** Set for a body carried inside the file at `path`. */
  readonly where: string | undefined;
  readonly kind: Kind | undefined;
  readonly bytes: Uint8Array;
  /** How many archive entries have this path. */
  readonly entries: number;
}

/** What reading a unit found, by how it was read. */
export type Facts =
  | {
      readonly form: "script";
      readonly text: string;
      readonly script: ScriptFacts;
      readonly saved: number;
    }
  | { readonly form: "style"; readonly text: string; readonly saved: number }
  | { readonly form: "markup"; readonly text: string; readonly markup: Markup }
  | { readonly form: "data"; readonly text: string; readonly value: unknown }
  | { readonly form: "text"; readonly text: string }
  | { readonly form: "raster" };

export type Read =
  | { readonly unit: Unit; readonly facts: Facts }
  | { readonly unit: Unit; readonly failure: string; readonly text: string | undefined };

const textOf = (read: Read): string | undefined =>
  "facts" in read ? ("text" in read.facts ? read.facts.text : undefined) : read.text;

class Unreadable extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true });

const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  // swc throws a debug dump that repeats the whole source; its `message` field is the part worth reading.
  return (/message: "((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? text)
    .slice(0, 200)
    .replaceAll(/\s+/g, " ");
};

/** Runs the producer's minifier. A file it cannot read, or one it reduces to nothing, is not minified output. */
const measure = (unit: Unit, text: string): number => {
  const minifier = PRODUCERS[unit.kind ?? "source"].minifier;
  if (minifier === undefined) throw new Error(`no minifier for ${String(unit.kind)}`);
  let minified: string;
  try {
    minified = minifier.run(text);
  } catch (error) {
    throw new Unreadable(`the build's minifier fails on it: ${messageOf(error)}`);
  }
  if (unit.where === undefined && minified.trim() === "")
    throw new Unreadable("the build's minifier reduces it to nothing, so it does no work");
  return text.length - minified.length;
};

/** Reads a unit into facts, or throws `Unreadable` with the reason it cannot be judged. */
const read = (unit: Unit): Facts => {
  if (unit.kind === "raster") return { form: "raster" };
  let text: string;
  try {
    text = utf8.decode(unit.bytes);
  } catch {
    throw new Unreadable("is not valid UTF-8");
  }
  const isScriptOrStyle =
    unit.kind === "script" || unit.kind === "style" || unit.kind === "style-attribute";
  if (unit.where === undefined && isScriptOrStyle && text.trim() === "")
    throw new Unreadable("is empty; the build writes no empty script or stylesheet");
  switch (unit.kind) {
    case "script": {
      const script = parseScript(text);
      const [error] = script.errors;
      if (error !== undefined) throw new Unreadable(`does not parse: ${error}`);
      return { form: "script", text, script, saved: measure(unit, text) };
    }
    case "style":
    case "style-attribute":
      return { form: "style", text, saved: measure(unit, text) };
    case "markup":
    case "vector":
      return {
        form: "markup",
        text,
        markup: readMarkup(text, unit.kind === "markup" ? "page" : "vector"),
      };
    case "data":
      try {
        return { form: "data", text, value: JSON.parse(text) };
      } catch (error) {
        throw new Unreadable(`is not valid JSON: ${messageOf(error)}`);
      }
    default:
      return { form: "text", text };
  }
};

export const readUnit = (unit: Unit): Read => {
  try {
    return { unit, facts: read(unit) };
  } catch (error) {
    let text: string | undefined;
    try {
      text = utf8.decode(unit.bytes);
    } catch {
      text = undefined;
    }
    return {
      unit,
      failure: error instanceof Unreadable ? error.message : `reading threw: ${messageOf(error)}`,
      text,
    };
  }
};

/** The bodies a page or vector carries, as units of their own. */
export const carriedUnits = (read: Read): readonly Unit[] =>
  "facts" in read && read.facts.form === "markup"
    ? read.facts.markup.bodies.map((body) => ({
        path: read.unit.path,
        where: read.unit.where === undefined ? body.where : `${read.unit.where} > ${body.where}`,
        kind: body.kind,
        bytes: body.bytes,
        entries: 1,
      }))
    : [];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// The chunks resvg writes. A text chunk could carry anything, and bytes after IEND are not image data.
const PNG_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((byte, i) => bytes[i] === byte);

/** Why the bytes are not a PNG built from image chunks alone, or undefined when they are. */
const pngProblem = (bytes: Uint8Array): string | undefined => {
  if (!startsWith(bytes, PNG_SIGNATURE)) return "does not start with the PNG signature";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = PNG_SIGNATURE.length;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (end > bytes.length) return `the ${type} chunk runs past the end of the file`;
    if (NodeZlib.crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4))
      return `the ${type} chunk fails its checksum`;
    if (!PNG_CHUNKS.has(type)) return `has a ${type} chunk, which the icon renderer never writes`;
    if (type === "IEND")
      return end === bytes.length ? undefined : `${bytes.length - end} bytes follow the IEND chunk`;
    at = end;
  }
  return "ends without an IEND chunk";
};

// Byte signatures of containers the build never emits. The container itself does not belong in a packed extension.
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
  ["PNG image", PNG_SIGNATURE],
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: unknown): boolean => Array.isArray(value) || value === "array";

/** A version 3 source map, recognised by its keys in any order. Takes a parsed JSON object or an object literal. */
const isSourceMap = (value: Readonly<Record<string, unknown>>): boolean =>
  value.version === 3 &&
  ((typeof value.mappings === "string" && isList(value.sources)) || isList(value.sections));

/** The JSON value a text holds: all of it, or the span from its first `{` to its last `}`. */
const jsonIn = (text: string): unknown => {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (candidate.length < 2) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Not JSON; try the next span.
    }
  }
  return undefined;
};

/** Where in a JSON value a source map sits, following strings that hold JSON of their own. */
const sourceMapIn = (root: unknown): string | undefined => {
  const pending: Array<readonly [string, unknown]> = [["$", root]];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const [at, value] = next;
    if (typeof value === "string") {
      if (value.includes("{")) pending.push([`${at} (as JSON)`, jsonIn(value)]);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => pending.push([`${at}[${i}]`, item]));
    } else if (isRecord(value)) {
      if (isSourceMap(value)) return at;
      for (const [key, item] of Object.entries(value)) pending.push([`${at}.${key}`, item]);
    }
  }
  return undefined;
};

/** Every text in a unit where JSON could sit, by how the unit was read. */
const jsonPlaces = (facts: Facts): ReadonlyArray<readonly [string, unknown]> => {
  switch (facts.form) {
    case "data":
      return [["$", facts.value]];
    case "script":
      return facts.script.strings.map(({ span, value }) => [
        `the string at line ${lineOf(facts.text, span.start)}`,
        value,
      ]);
    case "markup":
      return facts.markup.texts.map((text) => ["a text or attribute value", text]);
    case "text":
      return [["the text", facts.text]];
    default:
      return [];
  }
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

const CODE_LINE = /[{}]\s*$|=>|^\s*(?:function|const|let|var|import|export|return)\s+\S/;
const MAX_CODE_LINES = 2;

interface CodeLine {
  readonly number: number;
  readonly text: string;
}

/** The lines that look like code rather than prose. */
const codeLines = (text: string): readonly CodeLine[] =>
  text
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .flatMap((line, i) => (CODE_LINE.test(line) ? [{ number: i + 1, text: line }] : []));

// Text in a string that parses as no script is judged by its lines. zod's code generator ships template fragments
// of real code: at most 4 such lines and 85 bytes in one string, the most across the eight libraries in
// minify.test.ts. 512 bytes is six times that, and about two and a half readable functions.
const STRING_CODE_LINE_BYTES = 512;

const SOURCE_MAP_REFERENCE = /[#@]\s*sourceMappingURL=/;

// How a string's text is read as code: names shortened and spaces dropped, nothing removed as dead. A string is
// data the minifier never touched, so dead-code removal would count a table of numbers as savings.
const readable = (code: string): number =>
  code.length -
  experiments.swc.minifySync(code, {
    compress: false,
    mangle: true,
    ecma: 2022,
    module: false,
    format: { comments: "all" },
  }).code.length;

/**
 * Why the text of a string is source code, or undefined when it is data. Prose never declares a binding, so only a
 * string that parses and declares a function, class, variable or parameter is measured. Text that parses only as
 * TypeScript is source. Text that parses as neither is judged by how many of its lines look like code.
 */
const sourceInString = (value: string): string | undefined => {
  const script = parseScript(value);
  if (script.errors.length === 0) {
    if (!script.declaresBinding) return undefined;
    const saved = readable(value);
    return saved > SCRIPT_MARGIN_BYTES
      ? `it is a script that declares names, and minifying it saves ${saved} bytes`
      : undefined;
  }
  const typed = parseScript(value, "ts");
  if (typed.errors.length === 0 && typed.declaresBinding) return "it is TypeScript source";
  const lines = codeLines(value);
  const bytes = lines.reduce((total, line) => total + line.text.length, 0);
  return bytes > STRING_CODE_LINE_BYTES
    ? `it does not parse (${script.errors[0]}), and ${plural(lines.length, "line")} holding ${bytes} bytes look like code, from line ${lines[0]?.number}`
    : undefined;
};

const excerpt = (text: string): string => {
  const line = text.split("\n")[0] ?? "";
  return line.length > 48 ? `${line.slice(0, 48)}...` : line;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

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
  /** The shape of shared/framework.js: a legal pointer line, then React's production react-dom minified by the build. */
  readonly framework: string;
  /** The real framework.js.LICENSE.txt. */
  readonly reactLicense: Uint8Array;
  /** A real 16 pixel icon, rendered by write-icons.ts. */
  readonly png: Uint8Array;
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
  /** A path rule judges only the archive entry, not the bodies it carries. */
  readonly inspects: "path" | "contents";
  readonly decides: string;
  /** The reason the unit fails the rule, or undefined when it passes. */
  readonly check: (read: Read) => string | undefined;
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

/** The same function on one line: no line break to find, so only re-minifying can tell it is not minified. */
const ONE_LINE_FUNCTION =
  "function collectHeaders(entries) { const result = []; for (const entry of entries) { if (entry.name === undefined) { continue; } result.push({ name: entry.name, value: String(entry.value) }); } return result; }";

/** A table of numbers that a minifier cannot shrink, to put readable source beside. */
const NUMBER_TABLE = `var table=[${Array.from({ length: 2000 }, (_, i) => i).join(",")}];\n`;

/** The same function in TypeScript, with comments after its braces and lines that start with a keyword. */
const TYPESCRIPT_FUNCTION = `async function collectHeaders(entries: Array<HeaderEntry>): Promise<Array<HeaderEntry>>
{ // collect all valid headers
  for (const entry of entries)
  { // check each entry
    if (entry.name !== undefined)
    { // keep valid entry
      entries.push({ name: entry.name, value: String(entry.value) });
    } // end if
  } // end for
} // end collectHeaders
`;

const evalOf = (fixtures: Fixtures, source: string): string =>
  `${fixtures.minifiedParent};eval(${JSON.stringify(source)});`;

const inPage = (body: string): string => `<!DOCTYPE html><html><body>${body}</body></html>`;

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

/** The same map with its version key last, so the first `{` before `"version"` is inside `sourcesContent`. */
const SOURCE_MAP_VERSION_LAST = JSON.stringify({
  file: "parent.js",
  sources: ["../parent.ts"],
  sourcesContent: [`{${PRETTY_FUNCTION}`],
  mappings: "AAAA;AACA",
  version: 3,
});

const SOURCE_MAP_ESCAPED_VERSION = `{"\\u0076ersion":3,"file":"parent.js","sources":["../parent.ts"],"sourcesContent":[${JSON.stringify(PRETTY_FUNCTION)}],"mappings":"AAAA"}`;

const prettySvg = (fixtures: Fixtures): string => fixtures.toolbarSvg.replace(/></g, ">\n  <");

const nested = (open: string, close: string, depth: number): string =>
  `var a=${open.repeat(depth)}1${close.repeat(depth)};`;

/** 50 MB of one-line readable functions: the parser cannot hand an AST that large back to JavaScript. */
const fiftyMegabytes = (): string => {
  const block = `${ONE_LINE_FUNCTION} `;
  return block.repeat(Math.ceil((50 * 1024 * 1024) / block.length));
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

export const RULES: readonly Rule[] = [
  {
    id: CANNOT_JUDGE,
    inspects: "contents",
    decides:
      "the check cannot decode, parse or minify the file, a rule throws on it, the judge process crashes or times out on it, or it is an empty script or stylesheet",
    check: (read) => ("failure" in read ? read.failure : undefined),
    plants: [
      {
        name: "A07 a script the parser rejects",
        changes: () => ({ "experiment/broken.js": "function ({" }),
        path: "experiment/broken.js",
      },
      {
        name: "FC01 a script the parser accepts and the minifier rejects",
        changes: () => ({ "experiment/parent.js": `using x=a();${ONE_LINE_FUNCTION.repeat(10)}` }),
        path: "experiment/parent.js",
      },
      {
        name: "FC03 a TypeScript annotation in a script",
        changes: () => ({ "experiment/parent.js": "const x: number = 1;console.log(x);" }),
        path: "experiment/parent.js",
      },
      {
        name: "FC04 JSX in a script",
        changes: () => ({
          "experiment/parent.js": 'const el=<div className="app">hi</div>;console.log(el);',
        }),
        path: "experiment/parent.js",
      },
      {
        name: "FC05 an unterminated block comment",
        changes: () => ({ "experiment/parent.js": "a();/* never closed" }),
        path: "experiment/parent.js",
      },
      {
        name: "FC06 a stylesheet the minifier rejects",
        changes: () => ({ "action/index.css": "a{color:red}}}" }),
        path: "action/index.css",
      },
      {
        name: "FC07 an at-rule in a style attribute",
        changes: () => ({
          "action/index.html": inPage('<div style="@media screen{color:red}">x</div>'),
        }),
        path: "action/index.html",
      },
      {
        name: "FC09 a module export with a sloppy-mode with statement",
        changes: () => ({ "experiment/parent.js": "export const x=1;with(a)b();" }),
        path: "experiment/parent.js",
      },
      {
        name: "FC10 a module import with a legacy octal escape",
        changes: () => ({ "experiment/parent.js": 'import"./a.js";var x="\\101";console.log(x);' }),
        path: "experiment/parent.js",
      },
      {
        name: "FC11 a module export with an HTML comment",
        changes: () => ({ "experiment/parent.js": "export const x=1;<!-- comment" }),
        path: "experiment/parent.js",
      },
      {
        name: "FC12 a JSON object saved as a script",
        changes: () => ({
          "experiment/parent.js": '{"name":"one-click-har","version":"0.1.0","items":[1,2,3]}',
        }),
        path: "experiment/parent.js",
      },
      {
        name: "FC13a a JSON array saved as a script, which minifies to nothing",
        changes: () => ({
          "experiment/parent.js": JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i }))),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "FC13b an empty object saved as a script",
        changes: () => ({ "experiment/parent.js": "{}" }),
        path: "experiment/parent.js",
      },
      {
        name: "FC13c a small array saved as a script",
        changes: () => ({ "experiment/parent.js": "[1,2,3,4,5]" }),
        path: "experiment/parent.js",
      },
      {
        name: "FC14a a script of bytes that are not UTF-8",
        changes: () => ({
          "experiment/parent.js": new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81]),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "FC14b bytes that are not UTF-8 inside a script string",
        changes: () => ({
          "experiment/parent.js": new Uint8Array([
            ...encode('var a="'),
            0xff,
            0xfe,
            ...encode('";console.log(a);'),
          ]),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "FC14c bytes that are not UTF-8 inside a JSON string",
        changes: () => ({
          "experiment/schema.json": new Uint8Array([
            ...encode('{"a":"'),
            0xff,
            0xfe,
            ...encode('"}'),
          ]),
        }),
        path: "experiment/schema.json",
      },
      {
        name: "FC15a an empty script",
        changes: () => ({ "experiment/parent.js": new Uint8Array(0) }),
        path: "experiment/parent.js",
      },
      {
        name: "FC15b a script of 20 spaces",
        changes: () => ({ "experiment/parent.js": " ".repeat(20) }),
        path: "experiment/parent.js",
      },
      {
        name: "FC15c an empty stylesheet",
        changes: () => ({ "action/index.css": new Uint8Array(0) }),
        path: "action/index.css",
      },
      {
        name: "FC16 a 50 MB one-line script",
        changes: () => ({ "experiment/huge.js": fiftyMegabytes() }),
        path: "experiment/huge.js",
      },
      {
        name: "FC17b an array nested 5000 deep, which crashes the minifier",
        changes: () => ({ "experiment/parent.js": nested("[", "]", 5000) }),
        path: "experiment/parent.js",
      },
      {
        name: "FC17c parentheses nested 5000 deep",
        changes: () => ({ "experiment/parent.js": nested("(", ")", 5000) }),
        path: "experiment/parent.js",
      },
      {
        name: "FC17d an array nested 20000 deep, which crashes the parser",
        changes: () => ({ "experiment/parent.js": nested("[", "]", 20_000) }),
        path: "experiment/parent.js",
      },
      {
        name: "E07 a source map after a NUL byte on the parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}\u0000${SOURCE_MAP}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a source map named like a script",
        changes: () => ({ "experiment/parent.js": SOURCE_MAP }),
        path: "experiment/parent.js",
      },
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
      {
        name: "A04e a script the parser accepts and the minifier rejects, then 250 readable functions on one line",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};using x=a;${ONE_LINE_FUNCTION.repeat(250)}`,
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
    ],
  },
  {
    id: "source-map-file",
    inspects: "path",
    decides: "the path ends in .map, a file that ships the original source",
    check: ({ unit }) =>
      unit.kind === "source-map" ? "a source map ships the original source" : undefined,
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
    check: ({ unit }) => (unit.kind === "source" ? "source files must not ship" : undefined),
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
    check: ({ unit }) =>
      unit.kind === undefined
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
        name: "A08 a font the allowlist does not name",
        changes: () => ({ "fonts/icon.woff2": "wOF2" }),
        path: "fonts/icon.woff2",
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
        alsoFails: ["foreign-content", CANNOT_JUDGE],
      },
    ],
  },
  {
    id: "dev-only-file",
    inspects: "path",
    decides:
      "the path is under a test, fixture or tooling folder, or is a package or tsconfig file",
    check: ({ unit }) =>
      DEV_ONLY_PATH.test(unit.path) ? "a test, fixture or tooling file must not ship" : undefined,
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
    id: "duplicate-entry",
    inspects: "path",
    decides:
      "the archive holds more than one entry with this path, so what Gecko loads is not what was judged",
    check: ({ unit }) =>
      unit.entries > 1 ? `the archive has ${unit.entries} entries with this path` : undefined,
    plants: [
      {
        name: "A11 a second, unminified copy of the parent script under the same path",
        changes: (fixtures) => ({
          [DUPLICATE_OF("experiment/parent.js")]: fixtures.unminifiedParent,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
    ],
  },
  {
    id: "foreign-content",
    inspects: "contents",
    decides:
      "the first bytes are a container the build never emits: an archive, wasm, an executable, or a PNG outside a .png",
    check: ({ unit }) => {
      const foreign = FOREIGN_BYTES.find(([, signature]) => startsWith(unit.bytes, signature))?.[0];
      if (foreign === undefined || (foreign === "PNG image" && unit.kind === "raster"))
        return undefined;
      return `the bytes are a ${foreign}, which the build never emits here`;
    },
    plants: [
      {
        name: "E10 a stored ZIP of source files named as a page",
        changes: () => ({ "vendor/payload.html": ZIP_ARCHIVE }),
        path: "vendor/payload.html",
        alsoFails: [CANNOT_JUDGE],
      },
      {
        name: "E11 a WebAssembly module named as a script",
        changes: () => ({ "vendor/engine.js": WASM_MODULE }),
        path: "vendor/engine.js",
        alsoFails: [CANNOT_JUDGE],
      },
      {
        name: "a PNG image named as a script",
        changes: (fixtures) => ({ "experiment/parent.js": fixtures.png }),
        path: "experiment/parent.js",
        alsoFails: [CANNOT_JUDGE],
      },
    ],
  },
  {
    id: "not-a-png",
    inspects: "contents",
    decides:
      "a .png is not the PNG signature followed by image chunks with valid checksums, ending at IEND",
    check: ({ unit }) => {
      if (unit.kind !== "raster") return undefined;
      const problem = pngProblem(unit.bytes);
      return problem === undefined ? undefined : `not a PNG of image data alone: ${problem}`;
    },
    plants: [
      {
        name: "a script named like an icon",
        changes: (fixtures) => ({ "icons/16.png": fixtures.unminifiedParent }),
        path: "icons/16.png",
      },
      {
        name: "E12 a source map appended after PNG image data",
        changes: (fixtures) => ({
          "icons/16.png": new Uint8Array([...fixtures.png, ...encode(SOURCE_MAP)]),
        }),
        path: "icons/16.png",
      },
      {
        name: "M19 a source map with its version key last, appended after PNG image data",
        changes: (fixtures) => ({
          "icons/16.png": new Uint8Array([...fixtures.png, ...encode(SOURCE_MAP_VERSION_LAST)]),
        }),
        path: "icons/16.png",
      },
      {
        name: "a source map in a PNG text chunk",
        changes: (fixtures) => ({ "icons/16.png": withTextChunk(fixtures.png, SOURCE_MAP) }),
        path: "icons/16.png",
      },
    ],
  },
  {
    id: "not-vector",
    inspects: "contents",
    decides: "a .svg file parses to no <svg> element",
    check: (read) =>
      read.unit.kind === "vector" &&
      read.unit.where === undefined &&
      "facts" in read &&
      read.facts.form === "markup" &&
      !read.facts.markup.hasRoot
        ? "not an SVG image: it parses to no svg element"
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
    decides: "a .html file has no doctype and no <html> tag",
    check: (read) =>
      read.unit.kind === "markup" &&
      read.unit.where === undefined &&
      "facts" in read &&
      read.facts.form === "markup" &&
      !read.facts.markup.hasRoot
        ? "not an HTML page: it has no doctype and no html tag"
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
    id: "source-map-signature",
    inspects: "contents",
    decides:
      "a version 3 source map, found by JSON.parse and recognised by its keys in any order, is the file, a value in it, a JSON string in it, a script string or object literal, or a page or vector text or attribute",
    check: (read) => {
      if (!("facts" in read)) return undefined;
      if (read.facts.form === "script") {
        if (read.facts.script.objects.some(isSourceMap))
          return "an object literal is a version 3 source map";
      }
      for (const [place, text] of jsonPlaces(read.facts)) {
        const value = typeof text === "string" ? jsonIn(text) : text;
        const at = sourceMapIn(value);
        if (at !== undefined) return `${place} holds a version 3 source map at ${at}`;
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
        name: "A05b a source map whose version key is written with a unicode escape",
        changes: () => ({ "experiment/notes.json": SOURCE_MAP_ESCAPED_VERSION }),
        path: "experiment/notes.json",
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
        name: "E21 a source map held in a JSON string",
        changes: () => ({ "experiment/notes.json": JSON.stringify({ blob: SOURCE_MAP }) }),
        path: "experiment/notes.json",
      },
      {
        name: "M19 a source map with its version key last in a vector <desc>",
        changes: (fixtures) => ({
          "icons/icon.svg": fixtures.toolbarSvg.replace(
            "</svg>",
            `<desc>${SOURCE_MAP_VERSION_LAST}</desc></svg>`,
          ),
        }),
        path: "icons/icon.svg",
      },
      {
        name: "M19 a source map with its version key last in a JSON string",
        changes: () => ({
          "experiment/notes.json": JSON.stringify({ blob: SOURCE_MAP_VERSION_LAST }),
        }),
        path: "experiment/notes.json",
      },
      {
        name: "M19 a source map with its version key last in a script string",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};${minifyScript(`console.log(${JSON.stringify(SOURCE_MAP_VERSION_LAST)})`)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "M20 a source map with an escaped version key in a vector <desc>",
        changes: (fixtures) => ({
          "icons/icon.svg": fixtures.toolbarSvg.replace(
            "</svg>",
            `<desc>${SOURCE_MAP_ESCAPED_VERSION}</desc></svg>`,
          ),
        }),
        path: "icons/icon.svg",
      },
      {
        name: "M20 a source map with an escaped version key in a script string",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};${minifyScript(`console.log(${JSON.stringify(SOURCE_MAP_ESCAPED_VERSION)})`)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a source map as an object literal in a script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};var m={sourcesContent:[],mappings:"AAAA",sources:["a.ts"],version:3};console.log(m);`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "a source map after prose in a license notice",
        changes: () => ({ "shared/framework.js.LICENSE.txt": `MIT License\n\n${SOURCE_MAP}\n` }),
        path: "shared/framework.js.LICENSE.txt",
      },
    ],
  },
  {
    id: "source-map-reference",
    inspects: "contents",
    decides: "a comment the script parser found names a sourceMappingURL",
    check: (read) => {
      if (!("facts" in read) || read.facts.form !== "script") return undefined;
      const { text, script } = read.facts;
      const reference = script.comments.find((span) =>
        SOURCE_MAP_REFERENCE.test(text.slice(span.start, span.end)),
      );
      return reference === undefined
        ? undefined
        : `line ${lineOf(text, reference.start)} has a sourceMappingURL comment`;
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
        alsoFails: ["comment", "not-minified"],
      },
      {
        name: "E18 an inline data: source map hidden after a division-looking comment opener",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent}a++/2;/*# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ== */0`,
        }),
        path: "experiment/parent.js",
        alsoFails: ["comment", "not-minified"],
      },
    ],
  },
  {
    id: "development-build",
    inspects: "contents",
    decides: "the text holds a marker that only a development build keeps",
    check: (read) => {
      const text = textOf(read);
      const marker = DEVELOPMENT_MARKERS.find((candidate) => text?.includes(candidate) === true);
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
        alsoFails: [CANNOT_JUDGE],
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
    id: "comment",
    inspects: "contents",
    decides:
      "the script parser finds a comment that is not a legal notice, or the HTML parser finds a comment in a page or vector",
    check: (read) => {
      if (!("facts" in read)) return undefined;
      const { facts } = read;
      if (facts.form === "markup") {
        const [first] = facts.markup.comments;
        return first === undefined
          ? undefined
          : `${plural(facts.markup.comments.length, "comment")}; the first is <!--${excerpt(first)}-->`;
      }
      if (facts.form !== "script") return undefined;
      const { ordinary } = classifyComments(facts.text, facts.script.comments);
      const first = ordinary[0];
      return first === undefined
        ? undefined
        : `${plural(ordinary.length, "comment")}, a minifier removes them all; first at line ${lineOf(facts.text, first.start)}: ${excerpt(facts.text.slice(first.start, first.end))}`;
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
      {
        name: "A13 an HTML comment holding readable source 30 times",
        changes: () => ({ "action/index.html": inPage(`<!--${PRETTY_FUNCTION.repeat(30)}-->`) }),
        path: "action/index.html",
      },
    ],
  },
  {
    id: "legal-comment",
    inspects: "contents",
    decides:
      "a script comment with a legal marker is over 400 characters or has code punctuation or keywords",
    check: (read) => {
      if (!("facts" in read) || read.facts.form !== "script") return undefined;
      const { text, script } = read.facts;
      const [first] = classifyComments(text, script.comments).rejected;
      return first === undefined
        ? undefined
        : `the legal comment at line ${lineOf(text, first.start)} ${first.reason}`;
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
      {
        name: "E20 a legal comment of calls and comparisons",
        changes: (fixtures) => ({
          "experiment/parent.js": `/*! ${"readHeaders(entries)===entries.length&&check(entries)===true&&".repeat(5)}*/\n${fixtures.minifiedParent}`,
        }),
        path: "experiment/parent.js",
      },
    ],
  },
  {
    id: "not-minified",
    inspects: "contents",
    decides:
      "running the producer's minifier again on a script or style saves more than its margin, or a vector has layout whitespace between elements",
    check: (read) => {
      if (!("facts" in read)) return undefined;
      const { facts, unit } = read;
      if (facts.form === "markup") {
        return unit.kind === "vector" && facts.markup.layoutBreaks > 0
          ? "the vector has line breaks between elements; the build ships its icons on one line"
          : undefined;
      }
      if (facts.form !== "script" && facts.form !== "style") return undefined;
      const margin = PRODUCERS[unit.kind ?? "source"].minifier?.margin ?? 0;
      return facts.saved > margin
        ? `the build's minifier removes ${facts.saved} more bytes (${((facts.saved / facts.text.length) * 100).toFixed(1)}%); minified output gives up at most ${margin}`
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
        name: "a block comment before a stylesheet",
        changes: () => ({ "action/index.css": "/* popup styles */body{margin:0}" }),
        path: "action/index.css",
      },
      {
        name: "a sourceMappingURL comment on a stylesheet",
        changes: () => ({
          "action/index.css": "body{margin:0}\n/*# sourceMappingURL=index.css.map */",
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
        name: "a pretty script written inline in a page",
        changes: () => ({
          "action/index.html": inPage(`<div id="root"></div><script>\n${PRETTY_FUNCTION}</script>`),
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
        name: "E14 an inline script carried in a base64 data: URL",
        changes: () => ({
          "action/index.html": inPage(
            `<script src="data:text/javascript;base64,${Buffer.from(PRETTY_FUNCTION).toString("base64")}"></script>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "E15 a readable function in an onclick handler",
        changes: () => ({
          "action/index.html": inPage(`<button onclick="${PRETTY_FUNCTION}">go</button>`),
        }),
        path: "action/index.html",
      },
      {
        name: "E23 a closed inline script with a readable function",
        changes: () => ({ "action/index.html": inPage(`<script>${PRETTY_FUNCTION}</script>`) }),
        path: "action/index.html",
      },
      {
        name: "E27 stylesheet rules padded to 170-character lines",
        changes: () => ({
          "action/index.css": padLines("body{margin:0}\nh1{font-size:15px}", 170),
        }),
        path: "action/index.css",
      },
      {
        name: "A06b a spaced statement repeated 5000 times on one line",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};${"var veryReadableName = 1; ".repeat(5000)}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "A02 one readable function on one line appended to the parent script",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};${ONE_LINE_FUNCTION}`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "A02b one readable function on one line appended to the large bundle",
        changes: ({ framework }) => ({
          "shared/framework.js": `${framework};${ONE_LINE_FUNCTION}`,
        }),
        path: "shared/framework.js",
      },
      {
        name: "M02 two readable functions on one line appended to the large bundle",
        changes: ({ framework }) => ({
          "shared/framework.js": `${framework};${ONE_LINE_FUNCTION.repeat(2)}`,
        }),
        path: "shared/framework.js",
      },
      {
        name: "A09 a readable script under a path that climbs out of the archive",
        changes: () => ({ "../../../../escaped.js": PRETTY_FUNCTION }),
        path: "../../../../escaped.js",
      },
      {
        name: "A09b a readable script under an absolute path",
        changes: () => ({ "/absolute.js": PRETTY_FUNCTION }),
        path: "/absolute.js",
      },
      {
        name: "A12 a readable function in a javascript: URL",
        changes: () => ({
          "action/index.html": inPage(`<a href="javascript:${PRETTY_FUNCTION}">go</a>`),
        }),
        path: "action/index.html",
      },
      {
        name: "A12b a percent-encoded readable function in a javascript: URL with a tab in the scheme",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="java&#9;script:${encodeURIComponent(PRETTY_FUNCTION)}">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "CM11 a javascript: URL with a line feed and a carriage return in the scheme",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="jav&#10;asc&#13;ript:${encodeURIComponent(PRETTY_FUNCTION)}">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "CM13 a javascript: URL spelled with &Tab; and &NewLine;, holding &apos; quotes",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="java&Tab;scr&NewLine;ipt:${encodeURIComponent(PRETTY_FUNCTION).replaceAll("'", "&apos;")}&apos;&apos;">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "M11 a mixed-case javascript: URL with an encoded tab and line feed",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="&#x09;JaVaScRiPt&#x0a;:${encodeURIComponent(PRETTY_FUNCTION)}">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "M13 a multi-line javascript: URL with > inside it",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="javascript:\nif (1 > 0) {\n${PRETTY_FUNCTION.repeat(10)}\n}">go</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "M15 a javascript: URL spelled with a zero-padded character reference",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="&#00000106;avascript:${encodeURIComponent(PRETTY_FUNCTION)}">a</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "M15 a javascript: URL spelled with a character reference that has no semicolon",
        changes: () => ({
          "action/index.html": inPage(
            `<a href="&#106avascript:${encodeURIComponent(PRETTY_FUNCTION)}">b</a>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "A14 a readable script in an iframe srcdoc",
        changes: () => ({
          "action/index.html": inPage(
            `<iframe srcdoc="&lt;script&gt;${PRETTY_FUNCTION}&lt;/script&gt;"></iframe>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "A14b a readable handler in an iframe srcdoc whose markup is entity-encoded twice",
        changes: () => ({
          "action/index.html": inPage(
            `<iframe srcdoc="&lt;img onerror=&quot;${PRETTY_FUNCTION.replaceAll("\n", "&amp;#10;")}&quot;&gt;"></iframe>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "M12 a readable script in an iframe srcdoc inside an iframe srcdoc",
        changes: () => ({
          "action/index.html": inPage(
            `<iframe srcdoc="&lt;iframe srcdoc=&quot;&amp;lt;script&amp;gt;${PRETTY_FUNCTION.replaceAll('"', "&quot;")}&amp;lt;/script&amp;gt;&quot;&gt;&lt;/iframe&gt;"></iframe>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "M14 a srcdoc with a line break and a raw <script> inside the attribute",
        changes: () => ({
          "action/index.html": inPage(
            `<iframe srcdoc="\n<script>\n${PRETTY_FUNCTION.repeat(10)}</script>"></iframe>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "M16 an inline script with </script_len before readable source",
        changes: () => ({
          "action/index.html": inPage(
            `<script>1</script_len/g;\n${PRETTY_FUNCTION.repeat(20)}</script>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "A15 a readable script in a percent-encoded data: URL",
        changes: () => ({
          "action/index.html": inPage(
            `<script src="data:text/javascript,${encodeURIComponent(PRETTY_FUNCTION)}"></script>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a pretty stylesheet in a data: URL on a link",
        changes: () => ({
          "action/index.html": inPage(
            `<link rel="stylesheet" href="data:text/css,${encodeURIComponent("body {\n  margin: 0;\n}\n")}">`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "a spaced declaration list in a style attribute",
        changes: () => ({
          "action/index.html": inPage(
            `<p style="margin : 0px ;   padding : 0px ;   color : red ;   background : blue ;   border : 1px solid black ;">x</p>`,
          ),
        }),
        path: "action/index.html",
      },
      {
        name: "A16 a readable function in a script of type text/plain",
        changes: () => ({
          "action/index.html": inPage(`<script type="text/plain">${PRETTY_FUNCTION}</script>`),
        }),
        path: "action/index.html",
      },
      {
        name: "a readable script inside a vector image",
        changes: (fixtures) => ({
          "icons/icon.svg": fixtures.toolbarSvg.replace(
            "</svg>",
            `<script>${ONE_LINE_FUNCTION}</script></svg>`,
          ),
        }),
        path: "icons/icon.svg",
      },
    ],
  },
  {
    id: "string-holds-source",
    inspects: "contents",
    decides:
      "a script string or template quasi parses as a script that declares names and minifying it saves more than the script margin, parses only as TypeScript, or parses as neither and has more than 512 bytes of lines that look like code",
    check: (read) => {
      if (!("facts" in read) || read.facts.form !== "script") return undefined;
      const { text, script } = read.facts;
      for (const { span, value } of script.strings) {
        if (value.length <= SCRIPT_MARGIN_BYTES) continue;
        const reason = sourceInString(value);
        if (reason !== undefined)
          return `the string at line ${lineOf(text, span.start)} holds readable source: ${reason}`;
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
      {
        name: "A03 eval of a number table followed by 40 readable functions",
        changes: (fixtures) => ({
          "experiment/parent.js": evalOf(fixtures, NUMBER_TABLE + PRETTY_FUNCTION.repeat(40)),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "A03b eval of a number table followed by 80 readable functions (20320 bytes)",
        changes: (fixtures) => ({
          "experiment/parent.js": evalOf(fixtures, NUMBER_TABLE + PRETTY_FUNCTION.repeat(80)),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "M07 eval of a number table followed by one readable function",
        changes: (fixtures) => ({
          "experiment/parent.js": evalOf(fixtures, NUMBER_TABLE + PRETTY_FUNCTION),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "A04b new Function of a readable function alone",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};new Function(${JSON.stringify(PRETTY_FUNCTION)});`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "A04d eval of text the minifier cannot parse, then 200 readable functions",
        changes: (fixtures) => ({
          "experiment/parent.js": evalOf(fixtures, `<<<<\n${PRETTY_FUNCTION.repeat(200)}`),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "M08 readable functions split across the quasis of one template literal",
        changes: (fixtures) => ({
          "experiment/parent.js": `${fixtures.minifiedParent};var s=\`${PRETTY_FUNCTION.repeat(3)}\${1}${PRETTY_FUNCTION.repeat(3)}\`;console.log(s);`,
        }),
        path: "experiment/parent.js",
      },
      {
        name: "M09 eval of TypeScript with comments after its braces",
        changes: (fixtures) => ({
          "experiment/parent.js": evalOf(fixtures, TYPESCRIPT_FUNCTION.repeat(20)),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "M10 eval of 100 readable functions on one line",
        changes: (fixtures) => ({
          "experiment/parent.js": evalOf(fixtures, ONE_LINE_FUNCTION.repeat(100)),
        }),
        path: "experiment/parent.js",
      },
      {
        name: "M17 eval of a readable function after an array nested 2000 deep",
        changes: () => ({
          "experiment/parent.js": `${nested("[", "]", 2000)}eval(${JSON.stringify(PRETTY_FUNCTION)});`,
        }),
        path: "experiment/parent.js",
      },
    ],
  },
  {
    id: "notice-carries-code",
    inspects: "contents",
    decides: `a .LICENSE.txt file has more than ${MAX_CODE_LINES} lines that look like code`,
    check: (read) => {
      if (read.unit.kind !== "notice") return undefined;
      const lines = codeLines(textOf(read) ?? "");
      return lines.length > MAX_CODE_LINES
        ? `${plural(lines.length, "line")} look like code, the first is line ${lines[0]?.number}; a notice is prose`
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

/** A change key that adds a second archive entry under `path` instead of replacing the first. */
export const DUPLICATE_OF = (path: string): string => `${path}\u0000duplicate`;

/** The PNG with a tEXt chunk before IEND, checksummed so only the chunk type is wrong. */
const withTextChunk = (png: Uint8Array, text: string): Uint8Array => {
  const body = new Uint8Array([...encode("tEXt"), ...encode("Comment\u0000"), ...encode(text)]);
  const chunk = new Uint8Array(body.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length - 4);
  chunk.set(body, 4);
  view.setUint32(body.length + 4, NodeZlib.crc32(body));
  const iend = png.length - 12;
  return new Uint8Array([...png.subarray(0, iend), ...chunk, ...png.subarray(iend)]);
};

const WASM_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03,
  0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x66, 0x6f, 0x6f, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04,
  0x00, 0x41, 0x01, 0x0b,
]);

const ZIP_ARCHIVE = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8e,
  0x08, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x70, 0x2e, 0x74, 0x73,
]);
