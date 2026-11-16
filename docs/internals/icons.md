# Icons

The SVG files are in `apps/extension/src/icons`.

`icon.svg` is the master drawing. It uses the design 64-unit grid. Bars are 8 units high with `rx` 2, and every edge sits on the 4-unit grid. Fills stay `#3474E8` and `#1E9E4E`. `scripts/write-icons.ts` renders the manifest PNGs from this file. about:addons and the install prompt use those PNGs at 32, 48, and 96.

`toolbar.svg` is the only toolbar file. `scripts/toolbar-icon.ts` generates it from the size table and the colour table below. Both `theme_icons` slots and `default_icon` point at it. The file is one line. Each drawing is a nested `svg` with `preserveAspectRatio` set to `none`. The default drawing is the master geometry with the toolbar fills. A width query hides that drawing and shows one other.

## Which drawing a width gets

Gecko applies the SVG media queries to the toolbar image. The `width` query sees device pixels. A `min-resolution` query does not match inside that image. The string `1.75` written to `layout.css.devPixelsPerPx` is 30/17, which is 1.7647.

Integer multiples share a drawing. Multiples of 16 use the master. Multiples of 14 that are not multiples of 16 use `g14`. Any other measured width has its own grid, because 14 and 16 share no divisor with it. 40 is twice 20 and still has its own grid. 28 is `g14` at two device pixels per unit.

Snap grids use `rx` 0. Stroke width is the even integer nearest to `n * 8 / 64`, and a tie keeps the smaller value, so the 24-grid stroke is 2. The `g17` viewBox is 17 by 18. The painted Zen pill at that query is 17 by 17.

One `@media` rule shows one drawing. Bands are the measured query width plus or minus 0.35 px, merged when they share a drawing.

| Drawing | Query bands, px                                                |
| ------- | -------------------------------------------------------------- |
| g14     | 13.65 to 14.35, 27.65 to 28.55, 41.65 to 42.35, 56.05 to 56.75 |
| g17     | 17.15 to 17.85                                                 |
| g20     | 19.65 to 20.35                                                 |
| g21     | 20.65 to 21.35                                                 |
| g24     | 23.65 to 25.05                                                 |
| g35     | 34.65 to 35.35                                                 |
| g40     | 39.65 to 40.35                                                 |

Anything outside those bands is the master. 16, 32, 48, 64, 80, and 96 are the master.

The cells below were photographed in Zen 1.24.2b, Zen Twilight 1.25t, and Firefox Developer Edition 161. Twilight matched Zen stable. Bitmap is the screenshot box. Query is the width the media query saw.

| CSS px | Scale | Query px | Bitmap   | Drawing |
| ------ | ----- | -------- | -------- | ------- |
| 14     | 1     | 14       | 14 by 14 | g14     |
| 14     | 1.25  | 17.5     | 17 by 17 | g17     |
| 14     | 1.5   | 21       | 21 by 21 | g21     |
| 14     | 1.75  | 24.7     | 24 by 25 | g24     |
| 14     | 2     | 28       | 28 by 28 | g14     |
| 14     | 2.5   | 35       | 35 by 35 | g35     |
| 14     | 3     | 42       | 42 by 42 | g14     |
| 16     | 1     | 16       | 16 by 16 | master  |
| 16     | 1.25  | 20       | 20 by 20 | g20     |
| 16     | 1.5   | 24       | 24 by 24 | g24     |
| 16     | 1.75  | 28.2     | 28 by 28 | g14     |
| 16     | 2     | 32       | 32 by 32 | master  |
| 16     | 2.5   | 40       | 40 by 40 | g40     |
| 16     | 3     | 48       | 48 by 48 | master  |
| 32     | 1     | 32       | 32 by 32 | master  |
| 32     | 1.25  | 40       | 40 by 40 | g40     |
| 32     | 1.5   | 48       | 48 by 48 | master  |
| 32     | 1.75  | 56.4     | 56 by 56 | g14     |
| 32     | 2     | 64       | 64 by 64 | master  |
| 32     | 2.5   | 80       | 80 by 80 | master  |
| 32     | 3     | 96       | 96 by 96 | master  |

The 14 CSS px row at scale 1.75 is the one cell that cannot land on whole pixels. The query 24.7 selects `g24`. The screenshot box is 24 by 25 because the button's vertical edge is not on a device pixel. That bitmap has 21 colours. It still has 5 shapes, and the typical pixel equals the fill at 5.04 for the bars and 5.06 for the tray.

On a flat toolbar, a snap bitmap has 3 colours. A master bitmap has more, from the round corners. Firefox at 16 CSS px and scale 1 has 11. Typical contrast on those cells still equals the fill.

## Colours

The icon knows the colour scheme and not the toolbar colour. Each scheme uses one blue and one green, chosen against the worst background of that scheme, on the design hue, with chroma at least 0.08.

| Slot       | Fill      | Worst surface           | Fill contrast | Margin over 3 |
| ---------- | --------- | ----------------------- | ------------- | ------------- |
| Light bars | `#004ECB` | zen preset 18 `#B6AEBA` | 3.304         | 0.304         |
| Light tray | `#01662D` | zen preset 18 `#B6AEBA` | 3.317         | 0.317         |
| Dark bars  | `#ADCBFF` | zen preset 27 `#777777` | 2.722         | none          |
| Dark tray  | `#07F977` | zen preset 27 `#777777` | 3.161         | 0.161         |

Distance from the master fills, and from the round 2 toolbar fills, in sRGB.

| Slot       | Fill      | From `#3474E8` or `#1E9E4E` | From round 2        |
| ---------- | --------- | --------------------------- | ------------------- |
| Light bars | `#004ECB` | 70.6                        | 34.0 from `#1F5BD0` |
| Light tray | `#01662D` | 71.2                        | 33.7 from `#12803A` |
| Dark bars  | `#ADCBFF` | 150.8                       | 38.3 from `#8DB6FF` |
| Dark tray  | `#07F977` | 102.4                       | 89.8 from `#5ADE8C` |

Light toolbar colours are a darker blue and a darker green than the master. Dark bars are a pale blue. The dark tray is a bright green, louder than the browser's own light icons, and it is the green that stays at 3 to 1 on `#777777`.

`#ADCBFF` does not reach 3 to 1 on seven dark backgrounds. A chroma of 0.05, `#CADEFF`, would clear about 3.28 and no longer reads as the design blue. Hue 231 at chroma 0.08, `#9DDDFF`, reaches 3.041 and reads as cyan. Both were rejected. The shortfall is the fill contrast of `#ADCBFF`.

| Surface            | Background | Bar contrast | Short of 3 |
| ------------------ | ---------- | ------------ | ---------- |
| zen preset 27      | `#777777`  | 2.722        | 0.278      |
| zen preset 9       | `#777676`  | 2.752        | 0.248      |
| zen preset 14      | `#777670`  | 2.769        | 0.231      |
| zen preset 15      | `#6D7772`  | 2.816        | 0.184      |
| zen preset 10      | `#777174`  | 2.902        | 0.098      |
| zen preset 16      | `#6C7476`  | 2.902        | 0.098      |
| zen preset 0 beige | `#747170`  | 2.942        | 0.058      |

Every other listed dark surface, and every listed light surface, clears 3 to 1 for both fills. `scripts/toolbar-icon.test.ts` recomputes those contrasts. A later edit that drops a clearing surface under 3 fails the test. The seven shortfalls are pinned to two decimals.

`prefers-color-scheme` follows the colour scheme of the toolbar image. Zen's pill can report a false matchMedia dark query and still paint the dark fills. Firefox may compute `light dark` and still paint the dark fills when the toolbar is dark. Both `theme_icons` slots stay this one file. Firefox's navbar switches slots when the toolbar has brighttext. Zen's pill draws the dark slot in both appearances.

## Where a fresh install puts the button

`action.default_area` is `navbar`. A fresh profile puts the button in `nav-bar`.

At a 1400 CSS px window the photographed sizes are these.

| Browser                   | Surface           | CSS px |
| ------------------------- | ----------------- | ------ |
| Zen single toolbar        | pill in `nav-bar` | 14     |
| Zen dual and collapsed    | `nav-bar`         | 32     |
| Firefox navbar            | `nav-bar`         | 16     |
| Zen and Firefox customize | palette           | 16     |

The extensions panel and the overflow menu were not in the headless window bitmap. A chrome probe of the panel image was 0 by 0, and the overflow list was empty. Customize at 16 CSS px was photographed. On Zen that is the 20 device px cell on `#E9E9E9` at scale 1.25.

## What the screenshots measured

Every geometry cell in the table above, on the default light and dark toolbars, had 5 shapes. Typical contrast equalled the fill. The dark-bar shortfalls are the exception, and they are a colour limit on those seven backgrounds.

Zen stable presets, bar typical then tray typical, 5 shapes. The same numbers at scale 1 and 1.25.

| Preset        | Background | Bars | Tray | Against 3        |
| ------------- | ---------- | ---- | ---- | ---------------- |
| 18            | `#B6AEBA`  | 3.30 | 3.32 | clears           |
| 19            | `#BEACB9`  | 3.32 | 3.33 | clears           |
| 26            | `#A8B3BF`  | 3.34 | 3.36 | clears           |
| 8 slate       | `#BDBDC8`  | 3.82 | 3.84 | clears, was 2.70 |
| 2 mauve       | `#D2C1CF`  | 4.16 | 4.17 | clears, was 2.94 |
| 3 coral       | `#EBBABF`  | 4.17 | 4.19 | clears, was 2.95 |
| 27 dark       | `#777777`  | 2.72 | 3.16 | bars short 0.278 |
| 9 dark        | `#777676`  | 2.75 | 3.20 | bars short 0.248 |
| 14 dark       | `#777670`  | 2.77 | 3.22 | bars short 0.231 |
| 0 beige dark  | `#747170`  | 2.94 | 3.42 | bars short 0.058 |
| 5 yellow dark | `#766A43`  | 3.26 | 3.79 | clears, was 2.62 |
| 6 mint dark   | `#397156`  | 3.48 | 4.04 | clears, was 2.80 |

Presets 15, 10, and 16 were not photographed. The contrast test pins their bar fills at 2.816, 2.902, and 2.902.

Alpenglow on the Firefox navbar, not the customize palette, is `#EFD4F2` at 5.21 and 5.23, and `#281D50` at 9.24 and 10.73. Five shapes at scale 1 and 1.25.

The six cells that failed at round 2, plus the 32 CSS px dual toolbar this window actually draws. Columns are bar typical, tray typical, and shape count.

| Surface                   | CSS | Scale | Device   | Main          | Round 2       | After         |
| ------------------------- | --- | ----- | -------- | ------------- | ------------- | ------------- |
| Zen pill `#D9D9DA`        | 14  | 1.25  | 17 by 17 | 2.33, 2.46, 4 | 2.96, 3.57, 4 | 5.04, 5.06, 5 |
| Zen pill `#D9D9DA`        | 14  | 1.5   | 21 by 21 | 2.33, 2.46, 5 | 2.96, 3.57, 5 | 5.04, 5.06, 5 |
| Zen customize `#E9E9E9`   | 16  | 1.25  | 20 by 20 | not shot      | not shot      | 5.86, 5.88, 5 |
| Zen dual `#E9E9E9`        | 32  | 1.25  | 40 by 40 | 3.60, 2.86, 5 | 4.99, 4.14, 5 | 5.86, 5.88, 5 |
| Firefox `#F2F2F2`         | 16  | 1.25  | 20 by 20 | 3.90, 2.32, 5 | 5.41, 3.01, 5 | 6.35, 6.38, 5 |
| Firefox compact `#FEF4F1` | 16  | 1.25  | 20 by 20 | 4.04, 2.38, 5 | 5.61, 3.07, 5 | 6.58, 6.61, 5 |
| Firefox `#F2F2F2`         | 16  | 1.5   | 24 by 24 | 3.90, 3.10, 5 | 5.41, 4.49, 5 | 6.35, 6.38, 5 |

Round 2 at 24 device px still selected the 14-unit drawing. The cell above has 5 shapes there and is soft. After selects `g24`. The Firefox `#F2F2F2` bitmap at scale 1.5 has 3 colours.

Two planted files were measured on the Zen pill. Recolouring the light fills to `#D9D9DA` gives contrast 1.00 and 0 shapes on the light pill, at scale 1 and 1.25. The dark pill of that same file stays 8.24 and 9.58 with 5 shapes. Recolouring the dark fills to the dark pill background gives 1.00 and 0 shapes on the dark pill. The light pill of that file stays 5.04 and 5.06 with 5 shapes. Merging two bars in every drawing gives 4 shapes on the 14 px pill, the 17 px pill, the dark pill, and the 32 px master. The light plant on the dual toolbar is not contrast 1. That background is `#E9E9E9`, so the measured contrast is 1.16 and 1.07 with 6 shapes.

The mark is still four bars stepping into a tray. At scale 1.75 the edges are soft and the five shapes stay separate.
