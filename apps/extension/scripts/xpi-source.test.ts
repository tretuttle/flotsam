import { describe, expect, it } from "vite-plus/test";
import {
  classifyComments,
  findComments,
  lineBreaksOutsideData,
  parseScript,
  type Syntax,
} from "./xpi-source.ts";

const commentTexts = (text: string, syntax: Syntax): string[] =>
  findComments(text, syntax).map(({ start, end }) => text.slice(start, end));

describe("findComments", () => {
  const cases: ReadonlyArray<readonly [string, Syntax, string, string[]]> = [
    ["a line comment", "script", "a();// note\nb();", ["// note"]],
    ["a line comment ended by a carriage return", "script", "a();// note\r\nb();", ["// note"]],
    ["a block comment", "script", "a();/* note */b();", ["/* note */"]],
    ["a comment delimiter in a double quoted string", "script", 'a="/* x */";', []],
    ["a line comment marker in a single quoted string", "script", "a='http://x';", []],
    [
      "an escaped quote that does not end the string",
      "script",
      'a="\\"/* x */";/* y */',
      ["/* y */"],
    ],
    ["a delimiter in a template literal", "script", "a=`/* x */ // y`;", []],
    [
      "a delimiter in a nested template expression",
      "script",
      "a=`${`/* x */`}`;/* y */",
      ["/* y */"],
    ],
    ["a comment inside a template expression", "script", "a=`${b/* y */}`;", ["/* y */"]],
    ["a delimiter in a regular expression class", "script", "a=/[/*]/g;/* y */", ["/* y */"]],
    ["a regular expression after return", "script", 'return /"/.test(a);/* y */', ["/* y */"]],
    ["a division, then a string with a delimiter", "script", 'a=b/2;c="/* x */";', []],
    ["a division after a closing paren", "script", 'a=(b)/2;c="/* x */";', []],
    ["a comment after an increment and a division", "script", "a++/2;/* y */0", ["/* y */"]],
    [
      "an unterminated block comment is a parse error, not a comment",
      "script",
      "a();/* never closed",
      [],
    ],
    ["a comment in a stylesheet", "style", "a{}/* x */b{}", ["/* x */"]],
    ["a delimiter in a stylesheet string", "style", 'a{content:"/* x */"}', []],
    ["a line comment marker in a stylesheet", "style", "a{background:url(//x/y.png)}", []],
    ["a comment in a vector", "vector", "<svg><!-- x --><g/></svg>", ["<!-- x -->"]],
  ];

  it.each(cases)("%s", (_name, syntax, text, expected) => {
    expect(commentTexts(text, syntax)).toEqual(expected);
  });
});

describe("parseScript", () => {
  it("reports a syntax error instead of guessing", () => {
    expect(parseScript("function ({").errors).not.toEqual([]);
  });

  it("does not report a comment the script never closes as a comment", () => {
    expect(parseScript("a();/* never closed").errors).not.toEqual([]);
  });

  it("keeps the decoded value of a template literal", () => {
    const strings = parseScript("var t=`a\\nb`;").strings.map(({ value }) => value);
    expect(strings).toEqual(["a\nb"]);
  });

  it("does not treat a regular expression as a string", () => {
    expect(parseScript("var r=/function f(){}/;").strings).toEqual([]);
  });
});

describe("classifyComments", () => {
  const classify = (text: string) => {
    const { ordinary, legal, rejected } = classifyComments(text, "script");
    return { ordinary: ordinary.length, legal: legal.length, rejected: rejected.length };
  };

  it("keeps a short legal pointer and drops an ordinary comment", () => {
    expect(classify("/*! LICENSE: a.LICENSE.txt */\n/* note */a();")).toEqual({
      ordinary: 1,
      legal: 1,
      rejected: 0,
    });
  });

  it("rejects a legal comment that carries code", () => {
    expect(classify("/*! function f() { return 1; } */a();")).toEqual({
      ordinary: 0,
      legal: 0,
      rejected: 1,
    });
  });

  it("rejects a legal comment of calls and comparisons", () => {
    expect(classify("/*! read(a)===b(c)&&check(a)===true */a();")).toEqual({
      ordinary: 0,
      legal: 0,
      rejected: 1,
    });
  });

  it("rejects a legal comment over the size cap", () => {
    expect(classify(`/*! ${"license text ".repeat(40)}*/a();`)).toEqual({
      ordinary: 0,
      legal: 0,
      rejected: 1,
    });
  });
});

describe("lineBreaksOutsideData", () => {
  it("finds a break between tokens", () => {
    expect(lineBreaksOutsideData("a();\nb();", [], [])).toHaveLength(1);
  });

  it("finds a carriage return, U+2028 and U+2029 between tokens", () => {
    expect(lineBreaksOutsideData("a();\rb();", [], [])).toHaveLength(1);
    expect(lineBreaksOutsideData("a();\u2028b();", [], [])).toHaveLength(1);
    expect(lineBreaksOutsideData("a();\u2029b();", [], [])).toHaveLength(1);
  });

  it("ignores breaks inside a string, a template and a regular expression", () => {
    const text = 'a="x\\ny";b=`x\\ny`;c=/x\\ny/;';
    expect(lineBreaksOutsideData(text, parseScript(text).data, [])).toEqual([]);
  });

  it("allows the line holding a kept legal comment", () => {
    const text = "/*! LICENSE: a.LICENSE.txt */\na();";
    const legal = findComments(text, "script");
    expect(lineBreaksOutsideData(text, legal, legal)).toEqual([]);
  });

  it("does not allow a break two lines below a kept legal comment", () => {
    const text = "/*! LICENSE: a.LICENSE.txt */\n\na();";
    const legal = findComments(text, "script");
    expect(lineBreaksOutsideData(text, legal, legal)).toHaveLength(1);
  });
});
