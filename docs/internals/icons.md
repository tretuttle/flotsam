# Icons

The SVG files are in `apps/extension/src/icons`.

`icon.svg` is the master drawing. It uses the design's 64-unit grid: bars are 8 units high and every edge sits on the 4-unit grid. `scripts/write-icons.ts` renders the PNG sizes in the manifest from this file on every build. about:addons and the install prompt use those PNGs (32, 48, and 96).

`toolbar.svg` is the toolbar button, and it is the only toolbar file. The drawing for 16 CSS px and larger is the same geometry as `icon.svg`. Zen's single toolbar draws the button at 14 CSS px, and the 64-unit grid does not land on pixels there, so a second drawing in the same file uses a 14-unit grid. One unit of that drawing is one device pixel at 14 px and two device pixels at 28 px.

## What picks the drawing and the colours

Gecko applies the SVG's own media queries to the toolbar image. Two facts were measured in Zen 1.24.2b, Zen Twilight 1.25t, and Firefox Developer Edition 161, from the pixels of the real button.

The `width` query sees device pixels, not CSS pixels. A 14 CSS px button is a 14 px viewport at 1x and a 28 px viewport at 2x. `@media (max-width: 15px)` matches only the 14 px viewport. `@media (min-width: 24px) and (max-width: 30px)` matches only the 28 px viewport. Both show the 14-unit drawing. 16, 32, and 64 device pixels fall through to the master geometry, which is pixel-aligned at those sizes. `(min-resolution: 2dppx)` does not match inside the toolbar image at 2x, in any of the three browsers, even when `window.matchMedia("(min-resolution: 2dppx)")` is true. The width query is what separates 1x from 2x.

`@media (prefers-color-scheme: dark)` switches the fills. Light toolbars use the design's light pair, bars `#1F5BD0` and tray `#12803A`. Dark toolbars use bars `#8DB6FF` and tray `#5ADE8C`. The query follows the browser appearance in the navigation bar, in Zen's single-toolbar pill, and in the extensions panel. The lowest typical-pixel contrast measured on those surfaces is 3.57:1, the tray on Zen's light pill (`#D9D9DA`). Two runs of that pill agreed exactly.

`theme_icons` does not choose a different file. Both the `light` slot and the `dark` slot point at `toolbar.svg`. Firefox's navigation bar does switch slots when the toolbar has `brighttext`. Zen's pill and the extensions panel do not: they draw the `dark` slot in both appearances. One file that switches its own colours covers both.

## Where a fresh install puts the button

`action.default_area` is `navbar`. A fresh profile puts the button in `nav-bar` in Zen stable, Zen Twilight, and Firefox Developer Edition. In Zen's single toolbar that bar draws the button at 14 CSS px. Without `default_area`, the same install puts the button in the extensions panel.

`pnpm run screenshot:toolbar --out <folder>` loads the packed XPI in an isolated Zen and saves the button in both appearances.
