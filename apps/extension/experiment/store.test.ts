import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parseSite, runIdAt, type ByteCount, type EpochMs } from "@one-click-har/recording/ids";
import {
  LAYOUT,
  logSegmentId,
  logSegmentPath,
  packId,
  packPath,
  type SafeFolder,
} from "@one-click-har/recording/layout";
import { DEFAULT_USER_SETTINGS, type StoredSettings } from "@one-click-har/recording/settings";
import type { Timers } from "./gecko-io.ts";
import { openStore } from "./store.ts";

const ROOT = "/mock-store" as SafeFolder;
const RUN = runIdAt(1_700_000_000_000 as EpochMs);

const makeSettings = (maxBodyBytes: number): StoredSettings => ({
  user: {
    ...DEFAULT_USER_SETTINGS,
    retention: {
      maxBodyBytes: maxBodyBytes as ByteCount,
      maxDetailBytes: 100_000 as ByteCount,
      maxAgeDays: 14,
    },
  },
  exportFolder: { kind: "downloads" },
});

describe("openStore startup gate and ledger persistence", () => {
  const saved: Record<string, unknown> = {};
  const written = new Map<string, string>();

  beforeEach(() => {
    written.clear();
    const g = globalThis as Record<string, unknown>;
    for (const key of ["IOUtils", "PathUtils", "Ci", "Cc"]) {
      saved[key] = g[key];
    }
    g["PathUtils"] = {
      join: (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/"),
    };
    g["IOUtils"] = {
      exists: async (path: string) => written.has(path),
      getChildren: async () => [],
      stat: async (path: string) => {
        const text = written.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return { type: "regular", size: text.length, lastModified: 1 };
      },
      readUTF8: async (path: string) => written.get(path) ?? "",
      writeUTF8: async (path: string, text: string) => {
        written.set(path, text);
        return text.length;
      },
      setPermissions: async () => undefined,
      move: async (from: string, to: string) => {
        const data = written.get(from) ?? "";
        written.delete(from);
        written.set(to, data);
      },
      remove: async (path: string) => {
        written.delete(path);
      },
      makeDirectory: async () => undefined,
    };
    g["Ci"] = {};
    g["Cc"] = {};
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  });

  it("starts with waitUntilLoaded active and persists ledger.json on close", async () => {
    const timers: Timers = {
      repeat: () => ({ cancel: () => undefined }),
      once: () => ({ cancel: () => undefined }),
      cancelAll: () => undefined,
    } as unknown as Timers;

    const settings = makeSettings(10_000_000);
    const storeWithoutLedger = openStore({
      run: RUN,
      root: ROOT,
      modes: { dir: null, file: null },
      settings,
      timers,
      onSettings: () => undefined,
    });
    expect(storeWithoutLedger.isReady()).toBe(false);
    expect(storeWithoutLedger.needsStartupBuffer()).toBe(true);
    expect(storeWithoutLedger.usage().bodyBytes).toBe(10_000_000);

    await storeWithoutLedger.initRetention();
    expect(storeWithoutLedger.isReady()).toBe(true);
    expect(storeWithoutLedger.needsStartupBuffer()).toBe(false);
    expect(storeWithoutLedger.usage().bodyBytes).toBe(0);

    await storeWithoutLedger.close();
    const raw = written.get(`${ROOT}/${LAYOUT.ledger}`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      version: 1,
      run: RUN,
      clean: true,
      bodyBytes: 0,
      detailBytes: 0,
      bodyCount: 0,
      detailCount: 0,
      siteCount: 0,
    });

    // Non-empty archive shutdown must persist exact byte totals (kills half-ledger mutations).
    const g = globalThis as Record<string, unknown>;
    const prevIo = g["IOUtils"] as Record<string, unknown>;
    const site = parseSite("example.test")!;
    const pRel = packPath(packId(site, RUN, 1));
    const lRel = logSegmentPath(logSegmentId(site, RUN, 1));
    const pAbs = `${ROOT}/${pRel.join("/")}`;
    const lAbs = `${ROOT}/${lRel.join("/")}`;
    const siteDir = `${ROOT}/${LAYOUT.sitesDir}/${pRel[1]!}`;
    const packsDir = `${siteDir}/${LAYOUT.packDir}`;
    const logsDir = `${siteDir}/${LAYOUT.logDir}`;
    const scanDirs = new Set([`${ROOT}/${LAYOUT.sitesDir}`, siteDir, packsDir, logsDir]);
    g["IOUtils"] = {
      ...prevIo,
      exists: async (path: string) =>
        scanDirs.has(path) || path === pAbs || path === lAbs || written.has(path),
      getChildren: async (path: string) => {
        if (path === `${ROOT}/${LAYOUT.sitesDir}`) return [siteDir];
        if (path === siteDir) return [packsDir, logsDir];
        if (path === packsDir) return [pAbs];
        if (path === logsDir) return [lAbs];
        return [];
      },
      stat: async (path: string) => {
        const now = Date.now();
        if (scanDirs.has(path)) return { type: "directory", size: 0, lastModified: now };
        if (path === pAbs) return { type: "regular", size: 4_000_000, lastModified: now };
        if (path === lAbs) return { type: "regular", size: 1_000, lastModified: now };
        const text = written.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return { type: "regular", size: text.length, lastModified: now };
      },
    };
    const storePopulated = openStore({
      run: RUN,
      root: ROOT,
      modes: { dir: null, file: null },
      settings,
      timers,
      onSettings: () => undefined,
    });
    await storePopulated.initRetention();
    await storePopulated.close();
    const populatedRaw = written.get(`${ROOT}/${LAYOUT.ledger}`);
    expect(JSON.parse(populatedRaw!)).toEqual({
      version: 1,
      run: RUN,
      clean: true,
      bodyBytes: 4_000_000,
      detailBytes: 1_000,
      bodyCount: 1,
      detailCount: 1,
      siteCount: 1,
    });
    g["IOUtils"] = prevIo;

    const storeWithHeadroom = openStore({
      run: RUN,
      root: ROOT,
      modes: { dir: null, file: null },
      settings,
      timers,
      persistedUsage: { bodyBytes: 2_000_000, detailBytes: 50_000 },
      onSettings: () => undefined,
    });
    expect(storeWithHeadroom.isReady()).toBe(false);
    expect(storeWithHeadroom.needsStartupBuffer()).toBe(true);
    expect(storeWithHeadroom.needsStartupBuffer(1_000_000)).toBe(false);
    expect(storeWithHeadroom.usage()).toEqual({ bodyBytes: 2_000_000, detailBytes: 50_000 });
    await storeWithHeadroom.close();
  });
});
