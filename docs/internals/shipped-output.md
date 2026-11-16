# Shipped output

The rule: everything in the packed XPI is production build output. No source, no source maps, no development builds, nothing unminified. `pack` and CI run `apps/extension/scripts/check-xpi.ts` on the archive and fail naming the file and the rule.

## The rules are one table

`scripts/xpi-rules.ts` lists every rule with what it inspects, how it decides, and the planted archive that proves it. `check-xpi.test.ts` runs the evasions from both verification reports and requires the exact set of rules that file fails. A rule cannot be added without a plant, and a plant whose rule is removed fails. To add a rule, add a row.

## Decisions

- **Minified means the build's minifier cannot improve it, and no line break sits between tokens.** For each script and stylesheet the check runs the same minifier the build runs, with comments kept, and fails when the output is smaller by more than `max(32 bytes, 3% of the file)`. On the real build the savings were 0, 3, 5, 7 and 302 bytes (302 of 218517), so the margin is about twice the largest observed. A minifier also leaves no line break between tokens, so one outside a string, template, regular expression or comment fails; the line holding a kept legal comment is the only exception. This replaces the old 512-character window, which let pretty source through once each line was 170 characters and ignored CR, U+2028 and U+2029.
- **A string that decodes to readable source is still readable source.** A script string or template quasi with at least two line breaks, at least 120 characters, code keywords, and a value the minifier shrinks by over 40% fails `string-holds-source`. A minifier cannot rewrite string data, so size alone does not catch a function hidden in a template literal.
- **A file's extension says what it claims to be; the rules read its bytes.** A `.json` file must parse as strict JSON and must not be a source map. A `.png` must start with the PNG signature. A `.svg` must hold an `<svg` element and a `.html` a doctype or `<html`. A first-byte signature for ZIP, gzip, WebAssembly, ELF, Mach-O, PDF, RAR or 7-Zip fails `foreign-content`, so an archive or wasm module cannot ship under an allowed suffix regardless of its name. The build's icon SVG is one line plus a trailing newline; any other line break fails.
- **Comments are found by the build's own parser.** `oxc-parser` reads scripts, so `/*` inside a string or a regular expression is data, and a comment after `a++/2` is still a comment. `sourceMappingURL` is looked for in those comments only, which keeps the same text inside a string legal. A legal comment is at most 400 characters and holds no code punctuation or keyword; `==` counts, because a comment of calls and comparisons is a program.
- **A source map is an object, not a file name.** The check looks for a version 3 map object at any offset in every file's bytes, and inside decoded JSON strings and script strings. A map behind a NUL byte, inside an SVG, after a PNG, or as a JSON string value fails.
- **Every script and style the markup would run is judged.** `inlineBodies` reads closed and unclosed `<script>` bodies, `data:` URLs in `src`, `on*` handlers and `style` attributes.
- **A development build is a marker, not a file name.** `NODE_ENV`, `jsxDEV`, `__DEV__` and the React DevTools banner fail in any spelling, including the bracket form, because a production build folds them away.

## The parent's result shape is checked at run time

`experiment/parent-api.ts` builds the API object from injected reads, so `contract.test.ts` runs the real handler in Node. It compares `Object.keys` of the result, the browser object and both toolbox shapes with `environmentKeys` in `contract.ts`. TypeScript checks excess properties only on a fresh literal; a returned variable with an extra key passes typecheck and fails this comparison.

## Trap: extension.js bundles scripts from `scripts/`

extension.js reserves a project folder named `scripts/` and bundles into the build any file in it that imports no Node built-in. A new tooling module in `apps/extension/scripts/` shipped inside the XPI. `extension.config.js` sets `folders: { scripts: false }`, and `dev-only-file` fails any `scripts/` path in the archive.
