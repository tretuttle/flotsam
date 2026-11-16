import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  CELLS,
  DARK_BAR,
  DARK_BAR_SHORTFALLS,
  DARK_TRAY,
  GRIDS,
  LIGHT_BAR,
  LIGHT_TRAY,
  SURFACES,
  contrast,
  drawingAt,
  generateToolbarSvg,
  shapeCount,
  toolbarSvgPath,
} from "./toolbar-icon.ts";

const shownClass = (svg: string, width: number): string => {
  let shown = "master";
  let hits = 0;
  for (const rule of svg.matchAll(
    /@media ([^{]+)\{(?:\.m\{display:none\}\.(g\d+)\{display:inline\})\}/g,
  )) {
    const query = rule[1] ?? "";
    const id = rule[2] ?? "";
    const hit = query.split(",").some((part) => {
      const min = part.match(/width>=([\d.]+)px/);
      const max = part.match(/width<=([\d.]+)px/);
      if (!min?.[1] || !max?.[1]) return false;
      return width + 1e-9 >= Number(min[1]) && width - 1e-9 <= Number(max[1]);
    });
    if (!hit) continue;
    hits += 1;
    shown = id;
  }
  expect(hits, `width ${width} matched ${hits} drawings`).toBeLessThanOrEqual(1);
  return shown;
};

describe("toolbar icon", () => {
  it("writes the file the media query table describes", () => {
    const svg = generateToolbarSvg();
    expect(svg.includes("\n")).toBe(false);
    expect(NodeFS.readFileSync(toolbarSvgPath, "utf8")).toBe(svg);
    for (const cell of CELLS) {
      expect(drawingAt(cell.query), `${cell.css}@${cell.scale}`).toBe(cell.drawing);
      expect(shownClass(svg, cell.query), `${cell.css}@${cell.scale}`).toBe(cell.drawing);
    }
    for (const width of [16, 32, 48, 64, 80, 96]) {
      expect(drawingAt(width)).toBe("master");
      expect(shownClass(svg, width)).toBe("master");
    }
  });

  it("keeps five separate shapes on every grid, and a merged bar does not", () => {
    for (const grid of GRIDS) expect(shapeCount(grid.id)).toBe(5);
    expect(shapeCount("master")).toBe(5);
    for (const grid of GRIDS) expect(shapeCount(grid.id, true)).toBe(4);
    expect(shapeCount("master", true)).toBe(4);
  });

  it("clears 3:1 on every light surface and on every dark surface a recognisable colour can reach", () => {
    const short = new Map(DARK_BAR_SHORTFALLS.map((row) => [row.id, row.ratio]));
    for (const surface of SURFACES) {
      if (surface.scheme === "light") {
        expect(contrast(LIGHT_BAR, surface.hex), surface.id).toBeGreaterThanOrEqual(3);
        expect(contrast(LIGHT_TRAY, surface.hex), surface.id).toBeGreaterThanOrEqual(3);
        continue;
      }
      expect(contrast(DARK_TRAY, surface.hex), surface.id).toBeGreaterThanOrEqual(3);
      const bars = contrast(DARK_BAR, surface.hex);
      const claimed = short.get(surface.id);
      if (claimed === undefined) {
        expect(bars, surface.id).toBeGreaterThanOrEqual(3);
      } else {
        expect(bars, surface.id).toBeCloseTo(claimed, 2);
        expect(bars, surface.id).toBeLessThan(3);
      }
    }
    const missed = SURFACES.filter(
      (surface) => surface.scheme === "dark" && contrast(DARK_BAR, surface.hex) < 3,
    ).map((surface) => surface.id);
    expect(missed.toSorted()).toEqual(DARK_BAR_SHORTFALLS.map((row) => row.id).toSorted());
  });

  it("planted: a fill equal to the background has contrast 1", () => {
    expect(contrast("#D9D9DA", "#D9D9DA")).toBe(1);
    expect(contrast("#381C1C", "#381C1C")).toBe(1);
  });
});
