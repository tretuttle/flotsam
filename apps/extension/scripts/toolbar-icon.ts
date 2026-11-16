// The toolbar SVG is generated from the device sizes measured in Zen and Firefox.
// One grid per bitmap width, because 14 and 16 share no divisor with the fractional sizes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { extensionRoot } from "./manifest.ts";

export const LIGHT_BAR = "#004ECB";
export const LIGHT_TRAY = "#01662D";
export const DARK_BAR = "#ADCBFF";
export const DARK_TRAY = "#07F977";

/** Master drawing. icon.svg keeps these coordinates and the original fills. */
export const MASTER = {
  bars: [
    [8, 4, 24, 8],
    [16, 16, 24, 8],
    [24, 28, 24, 8],
    [32, 40, 16, 8],
  ],
  tray: "M8 32 V52 Q8 56 12 56 H52 Q56 56 56 52 V32",
  sw: 8,
  rx: 2,
} as const;

interface Grid {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly sw: number;
  readonly postTop: number;
  readonly bars: readonly (readonly [number, number, number, number])[];
}

/** Integer drawings. A unit is one device pixel of that bitmap. */
export const GRIDS: readonly Grid[] = [
  {
    id: "g14",
    w: 14,
    h: 14,
    sw: 2,
    postTop: 7,
    bars: [
      [1, 0, 5, 2],
      [3, 3, 5, 2],
      [5, 6, 5, 2],
      [7, 9, 4, 2],
    ],
  },
  {
    id: "g17",
    w: 17,
    h: 18,
    sw: 2,
    postTop: 8,
    bars: [
      [2, 1, 6, 2],
      [4, 4, 7, 3],
      [6, 8, 7, 2],
      [8, 11, 5, 3],
    ],
  },
  {
    id: "g20",
    w: 20,
    h: 20,
    sw: 2,
    postTop: 9,
    bars: [
      [2, 1, 8, 3],
      [5, 5, 7, 3],
      [8, 9, 7, 2],
      [10, 12, 5, 3],
    ],
  },
  {
    id: "g21",
    w: 21,
    h: 21,
    sw: 2,
    postTop: 9,
    bars: [
      [3, 1, 7, 3],
      [5, 5, 8, 3],
      [8, 9, 8, 3],
      [10, 13, 6, 3],
    ],
  },
  {
    id: "g24",
    w: 24,
    h: 24,
    sw: 2,
    postTop: 10,
    bars: [
      [3, 2, 9, 2],
      [6, 6, 9, 3],
      [9, 10, 9, 4],
      [12, 15, 6, 3],
    ],
  },
  {
    id: "g35",
    w: 35,
    h: 35,
    sw: 4,
    postTop: 15,
    bars: [
      [4, 2, 14, 5],
      [9, 9, 13, 4],
      [13, 15, 13, 5],
      [18, 22, 8, 4],
    ],
  },
  {
    id: "g40",
    w: 40,
    h: 40,
    sw: 4,
    postTop: 18,
    bars: [
      [5, 2, 15, 6],
      [10, 10, 15, 5],
      [15, 18, 15, 4],
      [20, 25, 10, 5],
    ],
  },
];

export interface Cell {
  /** CSS pixels of the toolbar image. */
  readonly css: number;
  /** Value written to layout.css.devPixelsPerPx. 1.75 is the string; Gecko uses 30/17. */
  readonly scale: string;
  /** Media-query width that matched, in px. The viewport is in [query, query + 0.1). */
  readonly query: number;
  readonly bitmap: readonly [number, number];
  readonly drawing: string;
}

/**
 * Device sizes of this button. 14 CSS px is the Zen pill.
 * 16 CSS px is the Firefox navbar and both customize palettes.
 * 32 CSS px is Zen dual and collapsed at a 1400 CSS px window.
 * Scales are 1, 1.25, 1.5, 1.75, 2, 2.5 and 3.
 */
export const CELLS: readonly Cell[] = [
  { css: 14, scale: "1", query: 14, bitmap: [14, 14], drawing: "g14" },
  { css: 14, scale: "1.25", query: 17.5, bitmap: [17, 17], drawing: "g17" },
  { css: 14, scale: "1.5", query: 21, bitmap: [21, 21], drawing: "g21" },
  { css: 14, scale: "1.75", query: 24.7, bitmap: [24, 25], drawing: "g24" },
  { css: 14, scale: "2", query: 28, bitmap: [28, 28], drawing: "g14" },
  { css: 14, scale: "2.5", query: 35, bitmap: [35, 35], drawing: "g35" },
  { css: 14, scale: "3", query: 42, bitmap: [42, 42], drawing: "g14" },
  { css: 16, scale: "1", query: 16, bitmap: [16, 16], drawing: "master" },
  { css: 16, scale: "1.25", query: 20, bitmap: [20, 20], drawing: "g20" },
  { css: 16, scale: "1.5", query: 24, bitmap: [24, 24], drawing: "g24" },
  { css: 16, scale: "1.75", query: 28.2, bitmap: [28, 28], drawing: "g14" },
  { css: 16, scale: "2", query: 32, bitmap: [32, 32], drawing: "master" },
  { css: 16, scale: "2.5", query: 40, bitmap: [40, 40], drawing: "g40" },
  { css: 16, scale: "3", query: 48, bitmap: [48, 48], drawing: "master" },
  { css: 32, scale: "1", query: 32, bitmap: [32, 32], drawing: "master" },
  { css: 32, scale: "1.25", query: 40, bitmap: [40, 40], drawing: "g40" },
  { css: 32, scale: "1.5", query: 48, bitmap: [48, 48], drawing: "master" },
  { css: 32, scale: "1.75", query: 56.4, bitmap: [56, 56], drawing: "g14" },
  { css: 32, scale: "2", query: 64, bitmap: [64, 64], drawing: "master" },
  { css: 32, scale: "2.5", query: 80, bitmap: [80, 80], drawing: "master" },
  { css: 32, scale: "3", query: 96, bitmap: [96, 96], drawing: "master" },
];

export interface Surface {
  readonly id: string;
  readonly scheme: "light" | "dark";
  readonly hex: string;
}

/** Toolbar pixels behind the icon, grouped by the scheme the icon is given. */
export const SURFACES: readonly Surface[] = [
  { id: "zen-preset-0-beige", scheme: "light", hex: "#EBE8E6" },
  { id: "zen-preset-1-pink", scheme: "light", hex: "#EBCED9" },
  { id: "zen-preset-2-mauve", scheme: "light", hex: "#D2C1CF" },
  { id: "zen-preset-3-coral", scheme: "light", hex: "#EBBABF" },
  { id: "zen-preset-4-orange", scheme: "light", hex: "#EFC7B9" },
  { id: "zen-preset-5-yellow", scheme: "light", hex: "#EDE2B9" },
  { id: "zen-preset-6-mint", scheme: "light", hex: "#ACE7CC" },
  { id: "zen-preset-7-sky", scheme: "light", hex: "#BFD9E2" },
  { id: "zen-preset-8-slate", scheme: "light", hex: "#BDBDC8" },
  { id: "zen-preset-9", scheme: "light", hex: "#EFEEED" },
  { id: "zen-preset-10", scheme: "light", hex: "#EFE8EB" },
  { id: "zen-preset-11", scheme: "light", hex: "#EAE0E9" },
  { id: "zen-preset-12", scheme: "light", hex: "#EFDEE0" },
  { id: "zen-preset-13", scheme: "light", hex: "#EFE4E1" },
  { id: "zen-preset-14", scheme: "light", hex: "#EFEDE6" },
  { id: "zen-preset-15", scheme: "light", hex: "#E4EEE8" },
  { id: "zen-preset-16", scheme: "light", hex: "#E3EBEE" },
  { id: "zen-preset-17", scheme: "light", hex: "#DCDDE6" },
  { id: "zen-preset-18", scheme: "light", hex: "#B6AEBA" },
  { id: "zen-preset-19", scheme: "light", hex: "#BEACB9" },
  { id: "zen-preset-20", scheme: "light", hex: "#CAB1B2" },
  { id: "zen-preset-21", scheme: "light", hex: "#D4BFB1" },
  { id: "zen-preset-22", scheme: "light", hex: "#E2D5BA" },
  { id: "zen-preset-23", scheme: "light", hex: "#DFDFD1" },
  { id: "zen-preset-24", scheme: "light", hex: "#C4D3C6" },
  { id: "zen-preset-25", scheme: "light", hex: "#A7BBB4" },
  { id: "zen-preset-26", scheme: "light", hex: "#A8B3BF" },
  { id: "zen-preset-27", scheme: "light", hex: "#EFEFEF" },
  { id: "zen-pill", scheme: "light", hex: "#D9D9DA" },
  { id: "zen-dual", scheme: "light", hex: "#E9E9E9" },
  { id: "firefox-system", scheme: "light", hex: "#F2F2F2" },
  { id: "firefox-compact-light", scheme: "light", hex: "#FEF4F1" },
  { id: "firefox-alpenglow", scheme: "light", hex: "#EFD4F2" },
  { id: "zen-preset-0-beige", scheme: "dark", hex: "#747170" },
  { id: "zen-preset-1-pink", scheme: "dark", hex: "#745862" },
  { id: "zen-preset-2-mauve", scheme: "dark", hex: "#5C4C59" },
  { id: "zen-preset-3-coral", scheme: "dark", hex: "#74464A" },
  { id: "zen-preset-4-orange", scheme: "dark", hex: "#775243" },
  { id: "zen-preset-5-yellow", scheme: "dark", hex: "#766A43" },
  { id: "zen-preset-6-mint", scheme: "dark", hex: "#397156" },
  { id: "zen-preset-7-sky", scheme: "dark", hex: "#4A626B" },
  { id: "zen-preset-8-slate", scheme: "dark", hex: "#484953" },
  { id: "zen-preset-9", scheme: "dark", hex: "#777676" },
  { id: "zen-preset-10", scheme: "dark", hex: "#777174" },
  { id: "zen-preset-11", scheme: "dark", hex: "#746972" },
  { id: "zen-preset-12", scheme: "dark", hex: "#776869" },
  { id: "zen-preset-13", scheme: "dark", hex: "#776E69" },
  { id: "zen-preset-14", scheme: "dark", hex: "#777670" },
  { id: "zen-preset-15", scheme: "dark", hex: "#6D7772" },
  { id: "zen-preset-16", scheme: "dark", hex: "#6C7476" },
  { id: "zen-preset-17", scheme: "dark", hex: "#666670" },
  { id: "zen-preset-18", scheme: "dark", hex: "#403A44" },
  { id: "zen-preset-19", scheme: "dark", hex: "#493943" },
  { id: "zen-preset-20", scheme: "dark", hex: "#543C3D" },
  { id: "zen-preset-21", scheme: "dark", hex: "#604B3C" },
  { id: "zen-preset-22", scheme: "dark", hex: "#6B6045" },
  { id: "zen-preset-23", scheme: "dark", hex: "#68685B" },
  { id: "zen-preset-24", scheme: "dark", hex: "#4E5D51" },
  { id: "zen-preset-25", scheme: "dark", hex: "#32463F" },
  { id: "zen-preset-26", scheme: "dark", hex: "#343E4A" },
  { id: "zen-preset-27", scheme: "dark", hex: "#777777" },
  { id: "zen-pill", scheme: "dark", hex: "#2E2E2F" },
  { id: "zen-dual", scheme: "dark", hex: "#131313" },
  { id: "firefox-compact-dark", scheme: "dark", hex: "#381D1E" },
  { id: "firefox-system", scheme: "dark", hex: "#44434B" },
  { id: "firefox-alpenglow", scheme: "dark", hex: "#281D50" },
];

/**
 * Dark-scheme bars cannot reach 3:1 on these backgrounds while staying on the
 * master's blue hue with chroma at least 0.08. The recorded ratio is #ADCBFF.
 */
export const DARK_BAR_SHORTFALLS: readonly { readonly id: string; readonly ratio: number }[] = [
  { id: "zen-preset-27", ratio: 2.722 },
  { id: "zen-preset-9", ratio: 2.752 },
  { id: "zen-preset-14", ratio: 2.769 },
  { id: "zen-preset-15", ratio: 2.816 },
  { id: "zen-preset-10", ratio: 2.902 },
  { id: "zen-preset-16", ratio: 2.902 },
  { id: "zen-preset-0-beige", ratio: 2.942 },
];

const lin = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = lin((n >> 16) & 255);
  const g = lin((n >> 8) & 255);
  const b = lin(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast of two opaque sRGB fills. */
export const contrast = (a: string, b: string): number => {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
};

const TOL = 35;

const bandsFor = (id: string): Array<[number, number]> => {
  const raw = CELLS.filter((cell) => cell.drawing === id).map((cell) => {
    const c = Math.round(cell.query * 100);
    return [c - TOL, c + TOL] as [number, number];
  });
  raw.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of raw) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
};

/** Drawing whose band contains this media-query width. Anything else is the master. */
export const drawingAt = (width: number): string => {
  const c = Math.round(width * 100);
  for (const grid of GRIDS) {
    for (const [a, b] of bandsFor(grid.id)) {
      if (c >= a && c <= b) return grid.id;
    }
  }
  return "master";
};

const px = (hundredths: number): string => {
  const n = hundredths / 100;
  return Number.isInteger(n) ? String(n) : String(n);
};

const queryFor = (id: string): string =>
  bandsFor(id)
    .map(([a, b]) => `(min-width:${px(a)}px) and (max-width:${px(b)}px)`)
    .join(",");

const widthRules = (): string =>
  GRIDS.map(
    (grid) => `@media ${queryFor(grid.id)}{.m{display:none}.${grid.id}{display:inline}}`,
  ).join("");

const gridSvg = (grid: Grid): string => {
  const half = grid.sw / 2;
  const top = grid.postTop + half;
  const bot = grid.h - half;
  const right = grid.w - half;
  const bars = grid.bars
    .map(
      ([x, y, w, h]) =>
        `<rect class="bar" x="${x}" y="${y}" width="${w}" height="${h}" fill="${LIGHT_BAR}"/>`,
    )
    .join("");
  const tray = `<path class="tray" d="M${half} ${top} V${bot} H${right} V${top}" fill="none" stroke="${LIGHT_TRAY}" stroke-width="${grid.sw}" stroke-linecap="butt" stroke-linejoin="miter"/>`;
  return `<svg class="${grid.id} off" x="0" y="0" width="64" height="64" viewBox="0 0 ${grid.w} ${grid.h}" preserveAspectRatio="none">${bars}${tray}</svg>`;
};

/** The toolbar file, one line, both theme slots. */
export const generateToolbarSvg = (): string => {
  const bars = MASTER.bars
    .map(
      ([x, y, w, h]) =>
        `<rect class="bar" x="${x}" y="${y}" width="${w}" height="${h}" rx="${MASTER.rx}" fill="${LIGHT_BAR}"/>`,
    )
    .join("");
  const tray = `<path class="tray" d="${MASTER.tray}" fill="none" stroke="${LIGHT_TRAY}" stroke-width="${MASTER.sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const style =
    `<style>.off{display:none}.bar{fill:${LIGHT_BAR}}.tray{stroke:${LIGHT_TRAY}}` +
    `${widthRules()}` +
    `@media (prefers-color-scheme:dark){.bar{fill:${DARK_BAR}}.tray{stroke:${DARK_TRAY}}}</style>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="One-Click HAR">` +
    `${style}<g class="m">${bars}${tray}</g>${GRIDS.map(gridSvg).join("")}</svg>`
  );
};

const fill = (
  grid: Int8Array,
  w: number,
  x: number,
  y: number,
  bw: number,
  bh: number,
  v: number,
): void => {
  const h = grid.length / w;
  for (let yy = Math.max(0, y); yy < Math.min(h, y + bh); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(w, x + bw); xx++) grid[yy * w + xx] = v;
  }
};

/** 4-connected ink shapes. `merge` lays bar 2 on bar 1 in this drawing. */
export const shapeCount = (id: string, merge = false): number => {
  const grid = GRIDS.find((item) => item.id === id);
  const w = grid ? grid.w : 16;
  const h = grid ? grid.h : 16;
  const bars = grid
    ? grid.bars.map((bar) => [...bar])
    : MASTER.bars.map(([x, y, bw, bh]) => [x / 4, y / 4, bw / 4, bh / 4]);
  const sw = grid ? grid.sw : 2;
  const postTop = grid ? grid.postTop : 7;
  const anchorX = bars[0]?.[0];
  const anchorY = bars[0]?.[1];
  const second = bars[1];
  if (merge && second && anchorX !== undefined && anchorY !== undefined) {
    second[0] = anchorX;
    second[1] = anchorY;
  }
  const px = new Int8Array(w * h);
  bars.forEach((bar, i) => {
    const [x, y, bw, bh] = bar;
    if (x === undefined || y === undefined || bw === undefined || bh === undefined) return;
    fill(px, w, x, y, bw, bh, i + 1);
  });
  fill(px, w, 0, postTop, sw, h - postTop, 5);
  fill(px, w, w - sw, postTop, sw, h - postTop, 5);
  fill(px, w, 0, h - sw, w, sw, 5);
  const seen = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < px.length; i++) {
    if (!px[i] || seen[i]) continue;
    n += 1;
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const cur = st.pop();
      if (cur === undefined) break;
      const x = cur % w;
      const y = (cur - x) / w;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (px[j] && !seen[j]) {
          seen[j] = 1;
          st.push(j);
        }
      }
    }
  }
  return n;
};

export const toolbarSvgPath = NodePath.join(extensionRoot, "src", "icons", "toolbar.svg");

if (import.meta.main) {
  NodeFS.writeFileSync(toolbarSvgPath, generateToolbarSvg());
}
