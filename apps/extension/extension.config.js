// `pnpm dev` runs Zen on a managed profile. Set ZEN_BINARY to run another Gecko browser.
const geckoBinary = process.env.ZEN_BINARY ?? String.raw`C:\Program Files\Zen Twilight\zen.exe`;

export default {
  // scripts/ holds this repo's tooling. By default extension.js bundles any script in it that imports no Node builtin.
  folders: { scripts: false },
  browser: {
    zen: {
      geckoBinary,
      preferences: { "extensions.experiments.enabled": true },
    },
  },
};
