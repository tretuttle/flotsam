// What the XPI check measures in a text file: where its comments are, which of them may stay, and how densely it
// breaks into lines. Pure functions of the text, so they run the same on a whole file and on an inline <script>.

export type Syntax = "script" | "style" | "vector";

export interface Span {
  readonly start: number;
  readonly end: number;
}

const isWordCharacter = (char: string): boolean => /[\w$\u0080-￿]/.test(char);

/** A `/` after one of these starts a regular expression, not a division. */
const KEYWORDS_BEFORE_EXPRESSION: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const isLineTerminator = (char: string): boolean =>
  char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";

const endOfLine = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && !isLineTerminator(text.charAt(i))) i++;
  return i;
};

/** Index after the string that opens at `start`. A string cannot span lines, so a newline ends a broken one. */
const skipString = (text: string, start: number): number => {
  const quote = text.charAt(start);
  for (let i = start + 1; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === "\\") i++;
    else if (char === quote) return i + 1;
    else if (isLineTerminator(char)) return i;
  }
  return text.length;
};

/** Index after the regular expression that opens at `start`, or -1 when the `/` is a division. */
const skipRegex = (text: string, start: number): number => {
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    const char = text.charAt(i);
    if (isLineTerminator(char)) return -1;
    if (char === "\\") i++;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = i + 1;
      while (/[a-z]/i.test(text.charAt(end))) end++;
      return end;
    }
  }
  return -1;
};

const endOfBlock = (text: string, start: number, close: string): number => {
  const end = text.indexOf(close, start);
  return end < 0 ? text.length : end + close.length;
};

class ScriptScanner {
  readonly comments: Span[] = [];
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  /** Walks code from `from`. Inside a `${` of a template literal it returns at the matching `}`. */
  scanCode(from: number, nested: boolean): number {
    const text = this.#text;
    let depth = 0;
    let regexAllowed = true;
    let i = from;
    while (i < text.length) {
      const char = text.charAt(i);
      const next = text.charAt(i + 1);
      if (char === "/" && next === "/") {
        const end = endOfLine(text, i);
        this.comments.push({ start: i, end });
        i = end;
      } else if (char === "/" && next === "*") {
        const end = endOfBlock(text, i + 2, "*/");
        this.comments.push({ start: i, end });
        i = end;
      } else if (char === "/") {
        const end: number = regexAllowed ? skipRegex(text, i) : -1;
        regexAllowed = end < 0;
        i = end < 0 ? i + 1 : end;
      } else if (char === '"' || char === "'") {
        i = skipString(text, i);
        regexAllowed = false;
      } else if (char === "`") {
        i = this.#scanTemplate(i + 1);
        regexAllowed = false;
      } else if (isWordCharacter(char)) {
        let end = i + 1;
        while (isWordCharacter(text.charAt(end))) end++;
        regexAllowed = KEYWORDS_BEFORE_EXPRESSION.has(text.slice(i, end));
        i = end;
      } else if (/\s/.test(char)) {
        i++;
      } else {
        if (char === "{") depth++;
        if (char === "}") {
          if (nested && depth === 0) return i + 1;
          depth--;
        }
        regexAllowed = char !== ")" && char !== "]";
        i++;
      }
    }
    return text.length;
  }

  #scanTemplate(from: number): number {
    const text = this.#text;
    let i = from;
    while (i < text.length) {
      const char = text.charAt(i);
      if (char === "\\") i += 2;
      else if (char === "`") return i + 1;
      else if (char === "$" && text.charAt(i + 1) === "{") i = this.scanCode(i + 2, true);
      else i++;
    }
    return text.length;
  }
}

const findStyleComments = (text: string): Span[] => {
  const comments: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === "/" && text.charAt(i + 1) === "*") {
      const end = endOfBlock(text, i + 2, "*/");
      comments.push({ start: i, end });
      i = end;
    } else if (char === '"' || char === "'") i = skipString(text, i);
    else i++;
  }
  return comments;
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

/**
 * Every comment in `text`, found by walking its tokens. A `/*` inside a string, a template literal or a regular
 * expression is data, not a comment.
 */
export const findComments = (text: string, syntax: Syntax): readonly Span[] => {
  if (syntax === "style") return findStyleComments(text);
  if (syntax === "vector") return findVectorComments(text);
  const scanner = new ScriptScanner(text);
  scanner.scanCode(0, false);
  return scanner.comments;
};

/** A comment that a license can require a bundle to keep. */
const LEGAL_MARKER = /^(?:\/\*!|\/\/!)|@license|@preserve/;
/** Punctuation and keywords that prose does not use and code does. */
const CODE_IN_COMMENT =
  /[{};]|=>|[^=!<>]=[^=]|\b(?:function|return|const|let|var|class|import|export)\b/;
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

/** A window of this many characters may hold at most MAX_BREAKS_IN_WINDOW line breaks. */
export const WINDOW_CHARACTERS = 512;
export const MAX_BREAKS_IN_WINDOW = 3;

export interface Stretch {
  /** Line breaks inside the densest window. */
  readonly breaks: number;
  readonly firstLine: number;
  readonly lastLine: number;
  /** Characters from the first to the last of those breaks, not counting ignored spans. */
  readonly characters: number;
}

/**
 * The densest run of line breaks in `text`: the most breaks that fit inside any window of WINDOW_CHARACTERS.
 * A break inside an `ignored` span (a legal comment) is not counted, and the span's length is not either.
 * Window, not file, because one long line must not let the lines around it count as minified.
 */
export const densestStretch = (text: string, ignored: readonly Span[] = []): Stretch => {
  const spans = ignored.toSorted((a, b) => a.start - b.start);
  const breaks: Array<{ readonly offset: number; readonly line: number }> = [];
  let removed = 0;
  let line = 1;
  let next = 0;
  for (
    let at = text.indexOf("\n");
    at >= 0 && at < text.length - 1;
    at = text.indexOf("\n", at + 1)
  ) {
    line++;
    let span = spans[next];
    while (span !== undefined && span.end <= at) {
      removed += span.end - span.start;
      span = spans[++next];
    }
    if (span === undefined || at < span.start) breaks.push({ offset: at - removed, line });
  }
  let densest: Stretch = { breaks: 0, firstLine: 1, lastLine: 1, characters: 0 };
  let last = 0;
  for (let first = 0; first < breaks.length; first++) {
    const start = breaks[first];
    if (start === undefined) continue;
    last = Math.max(last, first);
    while (
      (breaks[last + 1]?.offset ?? Number.POSITIVE_INFINITY) - start.offset <
      WINDOW_CHARACTERS
    ) {
      last++;
    }
    const end = breaks[last];
    if (end !== undefined && last - first + 1 > densest.breaks) {
      densest = {
        breaks: last - first + 1,
        firstLine: start.line - 1,
        lastLine: end.line,
        characters: end.offset - start.offset,
      };
    }
  }
  return densest;
};

export const lineOf = (text: string, offset: number): number => {
  let line = 1;
  for (let at = text.indexOf("\n"); at >= 0 && at < offset; at = text.indexOf("\n", at + 1)) line++;
  return line;
};
