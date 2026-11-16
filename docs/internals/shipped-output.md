# Shipped output

The rule: everything in the packed XPI is production build output. No source, no source maps, no development builds, nothing unminified. `pack` and CI run `apps/extension/scripts/check-xpi.ts` on the archive and fail naming the file and the rule.

## The rules are one table

`scripts/xpi-rules.ts` lists every rule with what it inspects, how it decides, and the planted archive that proves it. `check-xpi.test.ts` runs every planted archive and requires the exact set of rules that file fails. A rule cannot be added without a plant, and a plant whose rule is removed fails. To add a rule, add a row.

## Decisions

- **A file's extension says what it claims to be; the rules read its bytes.** A `.json` file must parse as strict JSON, must not be a source map, and must not hold readable source in a string. A `.png` must start with the PNG signature. A `.LICENSE.txt` must be prose. Scripts and styles inside an HTML page or SVG are judged like files. Judging by extension let a source map named `parent.map.json` and a development React build named `.json` through.
- **Minified means few line breaks in any window, not a good file average.** A window of 512 characters may hold at most 3 line breaks. A file average lets one 218 KB line carry 2.7 KB of readable source. Minified output measured 0 or 1 break in the whole file; React's development build holds 30 breaks in one window.
- **Comments are found by tokenizing.** `/*` inside a string, a template literal or a regular expression is data. `xpi-source.ts` matched every comment in 8818 `.js`, `.cjs` and `.mjs` files under `node_modules` (166455 comments) exactly as acorn does.
- **A minified script keeps no comment except a short legal one.** A legal comment starts `/*!` or carries `@license` or `@preserve`, is at most 400 characters, and holds no code punctuation or keyword. Anything else that claims to be legal fails as `legal-comment`.

## Trap: extension.js bundles scripts from `scripts/`

extension.js reserves a project folder named `scripts/` and bundles into the build any file in it that imports no Node built-in. A new tooling module in `apps/extension/scripts/` shipped inside the XPI. `extension.config.js` sets `folders: { scripts: false }`, and `dev-only-file` fails any `scripts/` path in the archive.
