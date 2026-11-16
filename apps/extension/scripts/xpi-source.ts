// Reads a packed file the way the build's tools do: a real parser for scripts, a token walk for styles and vectors.
// Everything here is a pure function of the text, so a whole file and an inline <script> are judged alike.
import { parseSync } from "oxc-parser";

export type Syntax = "script" | "style" | "vector";

export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface TextValue {
  readonly span: Span;
  /** The value the runtime sees: escapes decoded, quotes and delimiters removed. */
  readonly value: string;
}

export interface ScriptFacts {
  /** Comments the parser found. A `/*` inside a string or a regular expression is data, not a comment. */
  readonly comments: readonly Span[];
  /** Spans a minifier cannot rewrite: strings, template quasis and regular expression literals. */
  readonly data: readonly Span[];
  readonly strings: readonly TextValue[];
  readonly errors: readonly string[];
}

const isLineTerminator = (char: string): boolean =>
  char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";

export const hasLineTerminator = (text: string): boolean => /[\n\r\u2028\u2029]/.test(text);

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** Parsed scripts keyed by their text. One archive holds a handful of scripts, and five rules read each one. */
const scriptCache = new Map<string, ScriptFacts>();

const walk = (node: unknown, visit: (node: AstNode) => void): void => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!isAstNode(node)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    walk(value, visit);
  }
};

const cookedValue = (element: AstNode): string | undefined => {
  const value = element.value;
  if (typeof value !== "object" || value === null) return undefined;
  const cooked = (value as { cooked?: unknown }).cooked;
  return typeof cooked === "string" ? cooked : undefined;
};

/** Parses a script with the same parser the build runs, and keeps what it saw. */
export const parseScript = (text: string): ScriptFacts => {
  const cached = scriptCache.get(text);
  if (cached !== undefined) return cached;
  const parsed = parseSync("packed.js", text);
  const data: Span[] = [];
  const strings: TextValue[] = [];
  walk(parsed.program, (node) => {
    if (node.type === "TemplateElement") {
      data.push({ start: node.start, end: node.end });
      const value = cookedValue(node);
      if (value !== undefined) strings.push({ span: { start: node.start, end: node.end }, value });
      return;
    }
    if (node.type !== "Literal") return;
    if (typeof node.value === "string") {
      data.push({ start: node.start, end: node.end });
      strings.push({ span: { start: node.start, end: node.end }, value: node.value });
    } else if (typeof node.regex === "object" && node.regex !== null) {
      data.push({ start: node.start, end: node.end });
    }
  });
  const facts: ScriptFacts = {
    comments: parsed.comments.map(({ start, end }) => ({ start, end })),
    data,
    strings,
    errors: parsed.errors.map(({ message }) => message),
  };
  if (scriptCache.size >= 8) scriptCache.clear();
  scriptCache.set(text, facts);
  return facts;
};

const endOfBlock = (text: string, start: number, close: string): number => {
  const end = text.indexOf(close, start);
  return end < 0 ? text.length : end + close.length;
};

export const skipString = (text: string, start: number): number => {
  const quote = text.charAt(start);
  for (let i = start + 1; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === "\\") i++;
    else if (char === quote) return i + 1;
    else if (isLineTerminator(char)) return i;
  }
  return text.length;
};

export interface StyleFacts {
  readonly comments: readonly Span[];
  readonly data: readonly Span[];
}

/** A stylesheet has quoted strings and comments; everything else is code the minifier rewrites. */
export const readStyle = (text: string): StyleFacts => {
  const comments: Span[] = [];
  const data: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);
    if (char === "/" && next === "*") {
      const end = endOfBlock(text, i + 2, "*/");
      comments.push({ start: i, end });
      i = end;
    } else if (char === '"' || char === "'") {
      const end = skipString(text, i);
      data.push({ start: i, end });
      i = end;
    } else i++;
  }
  return { comments, data };
};

const findVectorComments = (text: string): Span[] => {
  const comments: Span[] = [];
  let start = text.indexOf("<!--");
  while (start >= 0) {
    const end = endOfBlock(text, start + 4, "-->");
    comments.push({ start, end });
    start = text.indexOf("<!--", end);
  }
  return comments;
};

/** Every comment in `text`, found by the parser for scripts and by a token walk for styles and vectors. */
export const findComments = (text: string, syntax: Syntax): readonly Span[] => {
  if (syntax === "script") return parseScript(text).comments;
  if (syntax === "style") return readStyle(text).comments;
  return findVectorComments(text);
};

/** A comment that a license can require a bundle to keep. */
const LEGAL_MARKER = /^(?:\/\*!|\/\/!)|@license|@preserve/;
/** Punctuation and keywords that prose does not use and code does. `==` catches a comparison without an arrow. */
const CODE_IN_COMMENT =
  /[{};]|=>|==|[^=!<>]=[^=]|\b(?:function|return|const|let|var|class|import|export)\b/;
const LEGAL_COMMENT_MAX_CHARACTERS = 400;

export interface Comments {
  /** Comments with no legal marker. A minifier removes all of them. */
  readonly ordinary: readonly Span[];
  /** Legal comments short enough and free enough of code to stay. */
  readonly legal: readonly Span[];
  /** Comments that claim to be legal and are too long or carry code. */
  readonly rejected: ReadonlyArray<Span & { readonly reason: string }>;
}

export const classifyComments = (text: string, syntax: Syntax): Comments => {
  const ordinary: Span[] = [];
  const legal: Span[] = [];
  const rejected: Array<Span & { readonly reason: string }> = [];
  for (const span of findComments(text, syntax)) {
    const comment = text.slice(span.start, span.end);
    if (!LEGAL_MARKER.test(comment)) ordinary.push(span);
    else if (comment.length > LEGAL_COMMENT_MAX_CHARACTERS) {
      rejected.push({
        ...span,
        reason: `${comment.length} characters, a legal comment may have at most ${LEGAL_COMMENT_MAX_CHARACTERS}`,
      });
    } else {
      const code = CODE_IN_COMMENT.exec(comment);
      if (code === null) legal.push(span);
      else rejected.push({ ...span, reason: `carries code (\`${code[0].trim()}\`)` });
    }
  }
  return { ordinary, legal, rejected };
};

const inside = (spans: readonly Span[], offset: number): boolean =>
  spans.some((span) => span.start <= offset && offset < span.end);

/**
 * Line terminators a minifier would have removed. A minifier leaves every statement on one line, so a break
 * outside a string, a regular expression or a comment means the file was not minified. The line holding a kept
 * legal comment is the one exception: the build puts the license pointer on its own line.
 */
export const lineBreaksOutsideData = (
  text: string,
  data: readonly Span[],
  legal: readonly Span[],
): readonly number[] => {
  const breaks: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (!isLineTerminator(char)) continue;
    if (inside(data, i)) continue;
    const nearLegal = legal.some((span) => {
      if (span.end <= i) return /^[ \t]*$/.test(text.slice(span.end, i));
      if (span.start >= i) return /^[ \t]*$/.test(text.slice(i + 1, span.start));
      return false;
    });
    if (!nearLegal) breaks.push(i);
  }
  return breaks;
};

export const lineOf = (text: string, offset: number): number => {
  let line = 1;
  for (let i = 0; i < offset; i++) if (isLineTerminator(text.charAt(i))) line++;
  return line;
};
