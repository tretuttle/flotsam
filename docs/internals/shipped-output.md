# Shipped output

The rule: everything in the packed XPI is production build output. No source, no source maps, no development builds, nothing unminified. `pack` and CI run `apps/extension/scripts/check-xpi.ts` on the archive, and it fails naming the file and the rule.

The check answers one question: is every shipped file what the build's own minifier writes, with no source file or source map beside it? Its oracle is the minifier itself. It runs the shared minifier again on every script and stylesheet, including those a page carries inline, and fails a file that comes back smaller by more than a measured margin. Everything else it does finds source maps and source files by their structure, or fails closed on what it cannot read.

## One minifier per kind of file, shared by the build and the check

`scripts/minify.ts` owns the minifiers and their options. `extension.config.js` installs them in the rspack page build, `build-experiment.ts` runs the same SWC function on the parent script after rolldown bundles it, and the check runs them again. `PRODUCERS` in `xpi-rules.ts` maps each kind of shipped file to the build step that writes it and the minifier it must survive.

A file is minified when that minifier, run again, saves at most a small absolute margin. The margins are measured, not chosen:

- **Scripts, 16 bytes.** SWC with `compress.passes: 0` runs until a pass changes nothing. A second run then saves 0 bytes on every packed script and 1 on `shared/framework.js`. On the 24 libraries `minify.test.ts` builds through both script build paths, the most it saves is vue's: 7 bytes through the page build and 8 through the parent build. With rspack's default of 2 passes it left 509 bytes on zod and 468 on vue, which is why both build paths now use `passes: 0`. The parent script moved from the Oxc minifier to SWC for the same reason: re-minifying one minifier's output with another fails honest code.
- **Stylesheets, 0 bytes.** lightningcss reaches a fixed point in one run: 0 bytes on both packed sheets and on real 13 KB and 90 KB sheets. The style minimizer passes no browser targets, because every browser this ships to is a current Gecko.

A margin is the most readable code that can hide in a file. With 16 bytes, no readable function or arrow function fits on any packed script, two spaced statements (52 bytes) do, and nothing fits on a stylesheet. A version bump that moves a residual past its margin fails `minify.test.ts` first: re-measure and change the margin with the numbers.

## Fail closed is one rule

`cannot-judge` covers everything that stops the check from judging a file: bytes that are not UTF-8, nesting past the check's limit, a parser or minifier error, JSON that does not parse, a script or stylesheet the minifier reduces to nothing (an empty file included), a rule that throws, and a judge process that crashes or runs out of time. An archive that cannot be opened at all fails under its own name.

**Nesting has a limit of the check's own: 256 brackets.** The parsers and minifiers recurse natively, so where they crash depends on the machine's stack. SWC crashed on an array nested 5000 deep on one machine and minified it on the CI runner, and at a 1 MB stack it crashed from 600. A verdict that depends on the runner is not fail closed, so before any parser, minifier or `JSON.parse` sees a script, stylesheet, JSON file or JSON candidate, a plain loop counts its deepest bracket nesting. Past 256 the file fails with the depth it measured. Honest output is shallow: 20 levels at most across every packed file and the libraries through both script builds, brackets inside strings and regular expressions included. The check gives the same verdicts with `ulimit -s 1024` and `node --stack-size=200`.

The crash path stays as the backstop for what the limit does not cover. `xpi-judge.ts` reads the files in a child process and prints a line before each one, so a native crash names the file it was on, and `check-xpi.ts` starts a new child for the rest. The child gets the check's own Node flags. The tests prove this with a child that kills itself with SIGKILL and one that exits without a verdict, because an abort or a segfault writes a core dump on every machine that runs the suite; `check-xpi.test.ts` fails if any check or judge process in it ends on a signal that dumps core.

## Real parsers, not scanners

- **Pages and vectors** are read with parse5, which implements the HTML standard's tokenizer, so tags, character references and end tags are what a browser sees. Every script-bearing place it exposes is judged as a file of its own kind: `<script>` and `<style>` bodies, `on*` handlers, `style` attributes, `javascript:` and `data:` URLs in URL attributes (after the URL parser strips tabs and line breaks), and `srcdoc` pages, recursively. A comment in a page or a vector fails. A vector fails when whitespace with a line break sits between its elements, because the build ships its icons on one line.
- **Scripts** are read with oxc-parser, the parser the build runs. Its comments, strings and object literals are read only to find a source map or a `sourceMappingURL`.
- **Source maps** are recognised by their keys in any order after `JSON.parse`: as a JSON file or any value in it, a JSON string inside a value, a script string or object literal, or a page or vector text or attribute value. A PNG is read chunk by chunk: anything after `IEND`, a text chunk or a bad checksum fails it.

## What the check does not judge

**String contents and the comments the minifier keeps.** The minifier treats a string as data and writes its contents back unchanged. So "did the build minify this?" has no answer for a string, and minifying cannot make it smaller, which is the performance reason for the rule. Four rounds of rules that guessed which strings hold source each failed a published library: ejs, handlebars and djv ship their own runtime source as strings to compile at run time. The same holds for comments the minifier keeps. The page build's `SwcJsMinimizerRspackPlugin` with `extractComments: true` (`pageMinimizers` in `minify.ts`) moves legal comments into `<chunk>.LICENSE.txt` and leaves a `/*! LICENSE: ... */` pointer. The parent's `minifyScript` drops every comment. The check's `reminifyScript` keeps legal comments (`format.comments: "some"`), so a kept legal comment saves nothing, and a `.LICENSE.txt` is not read for code. Any other comment in a script is something the minifier removes, so it counts toward the margin like whitespace.

So readable source inside a string, a legal comment or a license notice passes. No build mistake writes it there: a skipped minify leaves whitespace, names and ordinary comments in the code, and those fail. Putting it there is concealment, not a build mistake. The same holds for a source map split across two files, base64-encoded in a string, or inside a CSS string.

A stylesheet whose rules are joined by U+2028, with nothing else to remove, passes, correctly. CSS reads U+2028 as part of a name, so lightningcss writes those bytes back unchanged, and that is what the build writes for any source holding the character. A sheet that skipped the minifier keeps spaces, line breaks or comments, which fail, and layout written with U+2028 does not parse.

## The parent's result shape is checked at run time

`experiment/parent-api.ts` builds the API object from injected reads, so `contract.test.ts` runs the real handler in Node. It compares `Object.keys` of the result, the browser object and both toolbox shapes with `environmentKeys` in `contract.ts`. TypeScript checks excess properties only on a fresh literal; a returned variable with an extra key passes typecheck and fails this comparison.

## Trap: extension.js bundles scripts from `scripts/`

extension.js reserves a project folder named `scripts/` and bundles into the build any file in it that imports no Node built-in. A new tooling module in `apps/extension/scripts/` shipped inside the XPI. `extension.config.js` sets `folders: { scripts: false }`, and `dev-only-file` fails any `scripts/` path in the archive.
