// The minifiers the build runs and the options it runs them with. extension.config.js hands them to rspack for the
// pages, build-experiment.ts runs them on the parent script, and check-xpi runs them again on the packed files, so
// the build and the check cannot disagree about what minified output is.
import {
  Compilation,
  SwcJsMinimizerRspackPlugin,
  sources,
  experiments,
  type Compiler,
  type RspackPluginInstance,
} from "@rspack/core";
import { Features, transform, transformStyleAttribute } from "lightningcss";

// extension.js turns reduce_vars and collapse_vars off; this keeps its choice. `passes: 0` runs compress until a pass
// changes nothing, the same bytes as 6, 8 or 10 passes on the first eight libraries in minify.test.ts. A second run
// then saves at most 8 bytes on any library there (vue, parent build); rspack's default of 2 passes left 509 on zod.
const SCRIPT_OPTIONS = {
  compress: { passes: 0, reduce_vars: false, collapse_vars: false },
  mangle: true,
  ecma: 2022,
  module: false,
} as const;

/** The shipped script for `code`. Legal comments go: the page build moves them into a `.LICENSE.txt` first. */
export const minifyScript = (code: string): string =>
  experiments.swc.minifySync(code, { ...SCRIPT_OPTIONS, format: { comments: false } }).code;

/**
 * What the build's minifier makes of a shipped script. Legal comments stay, because the page build leaves one, the
 * pointer to the `.LICENSE.txt` it extracted, and the check judges that comment on its own.
 */
export const reminifyScript = (code: string): string =>
  experiments.swc.minifySync(code, { ...SCRIPT_OPTIONS, format: { comments: "some" } }).code;

// No targets: every browser this ships to is a current Gecko, so lightningcss only minifies and never lowers syntax.
// extension.js also keeps :dir() and :lang() lists as written.
const STYLE_OPTIONS = {
  minify: true,
  exclude: Features.DirSelector | Features.LangSelectorList,
} as const;

export const minifyStyle = (code: string): string =>
  transform({ ...STYLE_OPTIONS, filename: "style.css", code: Buffer.from(code) }).code.toString();

/** The declarations of a `style` attribute, which are not a stylesheet and parse differently. */
export const minifyStyleAttribute = (code: string): string =>
  transformStyleAttribute({
    ...STYLE_OPTIONS,
    filename: "style",
    code: Buffer.from(code),
  }).code.toString();

/** Runs `minifyStyle` on every stylesheet rspack emits, where extension.js would run its own lightningcss options. */
class StyleMinimizer implements RspackPluginInstance {
  apply(compiler: Compiler): void {
    compiler.hooks.thisCompilation.tap(StyleMinimizer.name, (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: StyleMinimizer.name, stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE },
        (assets) => {
          for (const [name, asset] of Object.entries(assets)) {
            if (name.endsWith(".css"))
              compilation.updateAsset(
                name,
                new sources.RawSource(minifyStyle(asset.source().toString())),
              );
          }
        },
      );
    });
  }
}

/** The page build's minimizers: legal comments move to `<chunk>.LICENSE.txt`, as extension.js does by default. */
export const pageMinimizers = (): RspackPluginInstance[] => [
  new SwcJsMinimizerRspackPlugin({ extractComments: true, minimizerOptions: SCRIPT_OPTIONS }),
  new StyleMinimizer(),
];
