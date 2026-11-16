# Icons

The SVG masters are in `apps/extension/src/icons`. `icon.svg` is the one drawing. The PNG sizes under `icons` in the manifest are rendered from it by `scripts/write-icons.ts` on every build, so they cannot drift.

## Why the toolbar slot that Zen shows is `icon.svg`

`theme_icons` has a `light` slot for dark toolbars and a `dark` slot for light toolbars. Firefox picks the `light` slot only when the button sits in a toolbar with `brighttext`. Zen lists every extension button in `#zen-overflow-extensions-list`, and Firefox gives that list the panel image, which takes the `light` slot only when the window root has `lwt-popup="dark"`. Zen does not set it, so in Zen the `dark` slot shows in both appearances (stock Zen 1.25t, `ui.systemUsesDarkTheme` 0 and 1).

The `dark` slot is therefore `icon.svg`, whose colors reach 3:1 on white, Firefox light, Firefox dark and Zen dark. The design review measured the dark-blue light-toolbar variant at 2.34:1 on dark toolbars, below 3:1. `toolbar-dark.svg` is the `light` slot, for Firefox's dark toolbars.

`pnpm run screenshot:toolbar --out <folder>` loads the packed XPI in an isolated Zen and saves the button in both appearances.
