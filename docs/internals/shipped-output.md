# Shipped output

The rule: everything in the packed XPI is production build output. No source, no source maps, no development builds, nothing unminified. `pack` and CI run `apps/extension/scripts/check-xpi.ts` on the archive, and it fails naming the file and the rule.

## One minifier per kind of file, shared by the build and the check

`scripts/minify.ts` owns the minifiers and their options. `extension.config.js` installs them in the rspack page build, `build-experiment.ts` runs the same SWC function on the parent script after rolldown bundles it, and the check runs them again. `PRODUCERS` in `xpi-rules.ts` maps each kind of shipped file to the build step that writes it and the minifier it must survive.

A file is minified when that minifier, run again, saves at most a small absolute margin. The margins are measured, not chosen:

- **Scripts, 16 bytes.** SWC with `compress.passes: 0` runs until a pass changes nothing. A second run then saves 0 bytes on every packed script and 1 on `shared/framework.js`. On the ten libraries `minify.test.ts` builds, the most it saves is vue's: 7 bytes through the page build and 8 through the parent build. Six more libraries measured the same way (dayjs, zustand, marked, pako, lru-cache, lit-html) save at most 1. With rspack's default of 2 passes it left 509 bytes on zod and 468 on vue, which is why both build paths now use `passes: 0`. The parent script moved from the Oxc minifier to SWC for the same reason: re-minifying one minifier's output with another fails honest code.
- **Stylesheets, 0 bytes.** lightningcss reaches a fixed point in one run: 0 bytes on both packed sheets and on real 13 KB and 90 KB sheets. The style minimizer passes no browser targets, because every browser this ships to is a current Gecko.

A margin is the most readable code that can hide in a file. With 16 bytes, no readable function or arrow function fits on any packed script, two spaced statements (52 bytes) do, and nothing fits on a stylesheet. A version bump that moves a residual past its margin fails `minify.test.ts` first: re-measure and change the margin with the numbers.

## Fail closed is one rule

`cannot-judge` covers everything that stops the check from judging a file: bytes that are not UTF-8, nesting past the check's limit, a parser or minifier error, JSON that does not parse, a script or stylesheet the minifier reduces to nothing (an empty file included), a rule that throws, and a judge process that crashes or runs out of time. An archive that cannot be opened at all fails under its own name.

**Nesting has a limit of the check's own: 256 brackets.** The parsers and minifiers recurse natively, so where they crash depends on the machine's stack. SWC crashed on an array nested 5000 deep on one machine and minified it on the CI runner, and at a 1 MB stack it crashed from 600. A verdict that depends on the runner is not fail closed, so before any parser, minifier or `JSON.parse` sees a script, stylesheet, JSON file, script string or JSON candidate, a plain loop counts its deepest bracket nesting. Past 256 the file fails with the depth it measured. Honest output is shallow: 20 levels at most across every packed file and eight libraries through both script builds, brackets inside strings and regular expressions included. The check gives the same verdicts with `ulimit -s 1024` and `node --stack-size=200`.

The crash path stays as the backstop for what the limit does not cover. `xpi-judge.ts` reads the files in a child process and prints a line before each one, so a native crash names the file it was on, and `check-xpi.ts` starts a new child for the rest. The child gets the check's own Node flags. The tests prove this with a child that kills itself with SIGKILL and one that exits without a verdict, because an abort or a segfault writes a core dump on every machine that runs the suite; `check-xpi.test.ts` fails if any check or judge process in it ends on a signal that dumps core.

## Real parsers, not scanners

- **Pages and vectors** are read with parse5, which implements the HTML standard's tokenizer, so tags, character references and end tags are what a browser sees. Every script-bearing place it exposes is judged as a file of its own kind: `<script>` and `<style>` bodies, `on*` handlers, `style` attributes, `javascript:` and `data:` URLs in URL attributes (after the URL parser strips tabs and line breaks), and `srcdoc` pages, recursively. A comment in a page or a vector fails. A vector fails when whitespace with a line break sits between its elements, because the build ships its icons on one line.
- **Scripts** are read with oxc-parser, the parser the build runs, for comments, strings and object literals. A `.LICENSE.txt` is read with it too: the page build writes one as the legal comments it extracted, so a notice fails when it holds a statement, prose outside a comment, or a comment the legal-comment rule rejects.
- **Source maps** are recognised by their keys in any order after `JSON.parse`: as a JSON file or any value in it, a JSON string inside a value, a script string or object literal, or a page or vector text or attribute value. A PNG is read chunk by chunk: anything after `IEND`, a text chunk or a bad checksum fails it.
- **Strings in scripts** are data the minifier never touches. A string is judged only when the script parser reads it as a complete script that declares a name (a function, class, variable or parameter). It is then re-minified by `reminifyStringScript` in `minify.ts`, the script options without compress, against the script margin. Compress would delete a string's text as dead code, and vue ships 208 bytes of global names in one string. A string that declares nothing is data: mangling renames labels, and a Thai error message in zod parses as a label and a name, saving 22 bytes. Across the sixteen libraries through both builds, 31,985 strings parse as scripts, 10 declare a name, and re-minifying those saves at most 8 bytes.

## What the check does not see

Each needs a deliberately hostile author, and none can come from the build. Readable source in a string that is not itself a parsable script is not detected: a function after a syntax error, TypeScript, or source split over several strings that each parse as nothing. Neither is a script in a string that declares no name, such as a run of indented calls. No build step writes source into a string by accident: a bundler writes code as code, and its strings hold data. A source map split across two files, base64-encoded in a string, or inside a CSS string is not detected either. A stylesheet whose rules are joined by U+2028 with nothing else to remove passes, correctly: CSS reads U+2028 as part of a name, so lightningcss writes those bytes back unchanged, and that is what the build writes for any source holding the character. No build mistake produces it: a sheet that skipped the minifier keeps spaces, line breaks or comments, which fail, and layout written with U+2028 does not parse.

## The parent's result shape is checked at run time

`experiment/parent-api.ts` builds the API object from injected reads, so `contract.test.ts` runs the real handler in Node. It compares `Object.keys` of the result, the browser object and both toolbox shapes with `environmentKeys` in `contract.ts`. TypeScript checks excess properties only on a fresh literal; a returned variable with an extra key passes typecheck and fails this comparison.

## Trap: extension.js bundles scripts from `scripts/`

extension.js reserves a project folder named `scripts/` and bundles into the build any file in it that imports no Node built-in. A new tooling module in `apps/extension/scripts/` shipped inside the XPI. `extension.config.js` sets `folders: { scripts: false }`, and `dev-only-file` fails any `scripts/` path in the archive.
