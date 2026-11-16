// `pnpm dev` runs Zen on a managed profile. Set ZEN_BINARY to run another Gecko browser.
const geckoBinary = process.env.ZEN_BINARY ?? String.raw`C:\Program Files\Zen Twilight\zen.exe`;

export default {
  browser: {
    zen: {
      geckoBinary,
      preferences: { "extensions.experiments.enabled": true },
    },
  },
};
