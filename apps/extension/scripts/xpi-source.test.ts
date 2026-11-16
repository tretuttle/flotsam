import { describe, expect, it } from "vite-plus/test";
import { classifyComments, densestStretch, findComments, type Syntax } from "./xpi-source.ts";

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
    ["an unterminated block comment", "script", "a();/* never closed", ["/* never closed"]],
    ["a comment in a stylesheet", "style", "a{}/* x */b{}", ["/* x */"]],
    ["a delimiter in a stylesheet string", "style", 'a{content:"/* x */"}', []],
    ["a line comment marker in a stylesheet", "style", "a{background:url(//x/y.png)}", []],
    ["a comment in a vector", "vector", "<svg><!-- x --><g/></svg>", ["<!-- x -->"]],
  ];

  it.each(cases)("%s", (_name, syntax, text, expected) => {
    expect(commentTexts(text, syntax)).toEqual(expected);
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

  it("rejects a legal comment over the size cap", () => {
    expect(classify(`/*! ${"license text ".repeat(40)}*/a();`)).toEqual({
      ordinary: 0,
      legal: 0,
      rejected: 1,
    });
  });
});

describe("densestStretch", () => {
  it("counts the breaks inside one window, wherever they sit in a long file", () => {
    const pretty = "a();\n".repeat(10);
    const stretch = densestStretch(`${"x".repeat(5000)}\n${pretty}${"y".repeat(5000)}`);
    expect(stretch.breaks).toBe(11);
  });

  it("does not count breaks that are far apart", () => {
    expect(densestStretch(`${"x".repeat(600)}\n`.repeat(10)).breaks).toBe(1);
  });

  it("ignores breaks inside an ignored span", () => {
    const text = "/*!\n\n\n\n\n\n*/\na();";
    expect(densestStretch(text, [{ start: 0, end: 11 }]).breaks).toBe(1);
  });
});
