# Shipped output

The rule: everything in the packed XPI is production build output. No source, no source maps, no development builds, nothing unminified. `pack` and CI run `apps/extension/scripts/check-xpi.ts` on the archive, and it fails naming the file and the rule.

## One minifier per kind of file, shared by the build and the check

`scripts/minify.ts` owns the minifiers and their options. `extension.config.js` installs them in the rspack page build, `build-experiment.ts` runs the same SWC function on the parent script after rolldown bundles it, and the check runs them again. `PRODUCERS` in `xpi-rules.ts` maps each kind of shipped file to the build step that writes it and the minifier it must survive.

A file is minified when that minifier, run again, saves at most a small absolute margin. The margins are measured, not chosen:

- **Scripts, 16 bytes.** SWC with `compress.passes: 0` runs until a pass changes nothing. A second run then saves 0 bytes on every packed script, 1 on `shared/framework.js`, and at most 7 (vue) on the eight libraries `minify.test.ts` builds through both script build paths. With rspack's default of 2 passes it left 509 bytes on zod and 468 on vue, which is why both build paths now use `passes: 0`. The parent script moved from the Oxc minifier to SWC for the same reason: re-minifying one minifier's output with another fails honest code.
- **Stylesheets, 0 bytes.** lightningcss reaches a fixed point in one run: 0 bytes on both packed sheets and on real 13 KB and 90 KB sheets. The style minimizer passes no browser targets, because every browser this ships to is a current Gecko.

A margin is the most readable code that can hide in a file. With 16 bytes, no readable function or arrow function fits on any packed script, two spaced statements (52 bytes) do, and nothing fits on a stylesheet. A version bump that moves a residual past its margin fails `minify.test.ts` first: re-measure and change the margin with the numbers.

## Fail closed is one rule

`cannot-judge` covers everything that stops the check from judging a file: bytes that are not UTF-8, a parser or minifier error, JSON that does not parse, a script or stylesheet the minifier reduces to nothing (an empty file included), a rule that throws, and a judge process that crashes or runs out of time. `xpi-judge.ts` reads the files in a child process and prints a line before each one, so a native crash (SWC segfaults on arrays nested about 5000 deep) names the file it was on, and `check-xpi.ts` starts a new child for the rest. An archive that cannot be opened at all fails under its own name.

## Real parsers, not scanners

- **Pages and vectors** are read with parse5, which implements the HTML standard's tokenizer, so tags, character references and end tags are what a browser sees. Every script-bearing place it exposes is judged as a file of its own kind: `<script>` and `<style>` bodies, `on*` handlers, `style` attributes, `javascript:` and `data:` URLs in URL attributes (after the URL parser strips tabs and line breaks), and `srcdoc` pages, recursively. A comment in a page or a vector fails. A vector fails when whitespace with a line break sits between its elements, because the build ships its icons on one line.
- **Scripts** are read with oxc-parser, the parser the build runs, for comments, strings and object literals.
- **Source maps** are recognised by their keys in any order after `JSON.parse`: as a JSON file or any value in it, a JSON string inside a value, a script string or object literal, or a page or vector text or attribute value. A PNG is read chunk by chunk: anything after `IEND`, a text chunk or a bad checksum fails it.
- **Strings in scripts** are data the minifier never touches. One that parses as a script that declares a name (a function, class, variable or parameter) is measured with names shortened and spaces dropped, against the script margin. Prose never declares a name, so error messages and URLs that happen to parse are not measured. Text that parses only as TypeScript fails. Text that parses as neither is judged by its lines: more than 512 bytes of lines that look like code fails. zod ships generated-code fragments of up to 85 bytes of such lines, so a lower bound would fail it.

## What the check does not see

Each needs a deliberately hostile author, and none can come from the build. A source map split across two files, base64-encoded in a string, or inside a CSS string. Readable source split over several strings that each parse as nothing. Up to 512 bytes of code-looking lines in a string that parses as nothing. A stylesheet whose rules are joined by U+2028 passes, correctly: CSS reads U+2028 as part of a name, so lightningcss writes those bytes back unchanged.

## The parent's result shape is checked at run time

`experiment/parent-api.ts` builds the API object from injected reads, so `contract.test.ts` runs the real handler in Node. It compares `Object.keys` of the result, the browser object and both toolbox shapes with `environmentKeys` in `contract.ts`. TypeScript checks excess properties only on a fresh literal; a returned variable with an extra key passes typecheck and fails this comparison.

## Trap: extension.js bundles scripts from `scripts/`

extension.js reserves a project folder named `scripts/` and bundles into the build any file in it that imports no Node built-in. A new tooling module in `apps/extension/scripts/` shipped inside the XPI. `extension.config.js` sets `folders: { scripts: false }`, and `dev-only-file` fails any `scripts/` path in the archive.
