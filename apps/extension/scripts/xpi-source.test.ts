import { describe, expect, it } from "vite-plus/test";
import { classifyComments, lineOf, parseScript } from "./xpi-source.ts";

const commentTexts = (text: string): string[] =>
  parseScript(text).comments.map(({ start, end }) => text.slice(start, end));

describe("parseScript comments", () => {
  const cases: ReadonlyArray<readonly [string, string, string[]]> = [
    ["a line comment", "a();// note\nb();", ["// note"]],
    ["a block comment", "a();/* note */b();", ["/* note */"]],
    ["a comment delimiter in a double quoted string", 'a="/* x */";', []],
    ["a line comment marker in a single quoted string", "a='http://x';", []],
    ["an escaped quote that does not end the string", 'a="\\"/* x */";/* y */', ["/* y */"]],
    ["a delimiter in a template literal", "a=`/* x */ // y`;", []],
    ["a delimiter in a nested template expression", "a=`${`/* x */`}`;/* y */", ["/* y */"]],
    ["a comment inside a template expression", "a=`${b/* y */}`;", ["/* y */"]],
    ["a delimiter in a regular expression class", "a=/[/*]/g;/* y */", ["/* y */"]],
    ["a division, then a string with a delimiter", 'a=b/2;c="/* x */";', []],
    ["a comment after an increment and a division", "a++/2;/* y */0", ["/* y */"]],
  ];

  it.each(cases)("%s", (_name, text, expected) => {
    expect(commentTexts(text)).toEqual(expected);
  });
});

describe("parseScript", () => {
  it("reports a syntax error instead of guessing", () => {
    expect(parseScript("function ({").errors).not.toEqual([]);
    expect(parseScript("a();/* never closed").errors).not.toEqual([]);
  });

  it("keeps the decoded value of a template literal and a string, in source order", () => {
    const strings = parseScript('var t=`a\\nb`,s="c\\u0064";').strings.map(({ value }) => value);
    expect(strings).toEqual(["a\nb", "cd"]);
  });

  it("does not treat a regular expression as a string", () => {
    expect(parseScript("var r=/function f(){}/;").strings).toEqual([]);
  });

  it("reduces an object literal with written-out keys to its shape", () => {
    expect(parseScript('var m={version:3,"mappings":"A",sources:[]};').objects).toEqual([
      { version: 3, mappings: "A", sources: "array" },
    ]);
    expect(parseScript("var m={[k]:3};").objects).toEqual([]);
  });

  it("tells a script that declares names from one that only uses them", () => {
    const declares = (text: string): boolean => parseScript(text).declaresBinding;
    expect(declares("function f(){}")).toBe(true);
    expect(declares("var a=1")).toBe(true);
    expect(declares("(a)=>a")).toBe(true);
    expect(declares("class A{}")).toBe(true);
    expect(declares("try{a()}catch(e){}")).toBe(true);
    expect(declares("a.b(c,d)")).toBe(false);
    expect(declares("Infinity,undefined,NaN")).toBe(false);
    expect(declares("label: text")).toBe(false);
  });

  it("counts top-level statements, and none in a text of comments alone", () => {
    expect(parseScript("/*! a */\n\n// b\n").statements).toBe(0);
    expect(parseScript("a();b();").statements).toBe(2);
  });
});

describe("classifyComments", () => {
  const classify = (text: string) => {
    const { ordinary, rejected } = classifyComments(text, parseScript(text).comments);
    return { ordinary: ordinary.length, rejected: rejected.length };
  };

  it("keeps a short legal pointer and drops an ordinary comment", () => {
    expect(classify("/*! LICENSE: a.LICENSE.txt */\n/* note */a();")).toEqual({
      ordinary: 1,
      rejected: 0,
    });
  });

  it("rejects a legal comment that carries code", () => {
    expect(classify("/*! function f() { return 1; } */a();")).toEqual({ ordinary: 0, rejected: 1 });
  });

  it("rejects a legal comment of calls and comparisons", () => {
    expect(classify("/*! read(a)===b(c)&&check(a)===true */a();")).toEqual({
      ordinary: 0,
      rejected: 1,
    });
  });

  it("rejects a legal comment over the size cap", () => {
    expect(classify(`/*! ${"license text ".repeat(40)}*/a();`)).toEqual({
      ordinary: 0,
      rejected: 1,
    });
  });
});

describe("lineOf", () => {
  it("counts every line terminator a script knows, and CRLF once", () => {
    expect(lineOf("a\nb\rc\u2028d\u2029e\r\nf", 11)).toBe(6);
    expect(lineOf("abc", 2)).toBe(1);
  });
});
