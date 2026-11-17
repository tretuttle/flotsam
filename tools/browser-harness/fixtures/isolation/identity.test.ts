import { describe, expect, it } from "vite-plus/test";
import { identities } from "./identity.ts";
import { PROBE_TABLE } from "./probe-table.ts";
import { checkKey, planTargets, type PlanInput, type WitnessCheck } from "./targets.ts";

const INPUT: PlanInput = {
  marker: "M",
  file: {
    appFolder: "/d/one-click-har",
    keyFolder: "/d/one-click-har/k0",
    log: "/d/one-click-har/k0/sites/bank.example/log/r-0.jsonl",
    body: "/d/one-click-har/k0/sites/bank.example/bodies/r1.7.body",
    export: "/dl/e.har",
    siteDir: "/d/one-click-har/k0/sites/bank.example",
  },
  inventory: [
    { path: "/p/one-click-har.archive-key", directory: false },
    { path: "/d/one-click-har/k0", directory: true },
  ],
  guessedKeyFolders: ["/d/one-click-har/g1", "/d/one-click-har/g2"],
  redirectToLog: "http://attacker.example/redir?to=x",
  wrRedirect: "http://attacker.example/wr-redirect",
  rec: {
    id: "rec@test",
    base: "moz-extension://u/",
    popupPath: "action/index.html",
    popupScriptPath: "action/index.js",
    parentScript: "experiment/parent.js",
    schema: "experiment/schema.json",
    files: ["manifest.json", "action/index.html"],
  },
  probe: { base: "moz-extension://p/", warMark: "W", secretMark: "S" },
  randomUuid: "r",
  randomId: "none@test",
  plantedResource: { hit: "resource://och-planted/log", miss: "resource://och-planted/missing" },
  resourceNames: ["gre", "app"],
  chromePackages: ["global"],
  mozSrc: "moz-src:///a.sys.mjs",
  binDir: "/opt/zen",
};
const key = (check: WitnessCheck): string => checkKey(check);

describe("target identities", () => {
  const found = identities(INPUT);

  it("names a file by its path and the marker it holds, and a folder by its path", () => {
    expect(found["fetch-file-log"]).toEqual({
      role: "archive-log",
      kind: "one",
      check: key({ kind: "file", path: INPUT.file.log, mark: "M" }),
    });
    expect(found["fetch-file-body"]).toEqual({
      role: "archive-body",
      kind: "one",
      check: key({ kind: "file", path: INPUT.file.body, mark: "M" }),
    });
    expect(found["iframe-file-export"]?.role).toBe("export");
    expect(found["fetch-file-export"]).toMatchObject({
      check: key({ kind: "file", path: "/dl/e.har", mark: "M" }),
    });
    expect(found["script-root-oracle"]).toEqual({
      role: "app-folder",
      kind: "one",
      check: key({ kind: "file", path: "/d/one-click-har" }),
    });
    expect(found["resource-traversal"]).toEqual({
      role: "archive-log",
      kind: "every",
      check: key({ kind: "file", path: INPUT.file.log, mark: "M" }),
    });
  });

  it("lists every inventory entry, guessed key and scheme name, one check each", () => {
    expect(found["inventory-read"]).toEqual({
      role: "inventory",
      kind: "list",
      checks: [
        key({ kind: "file", path: "/p/one-click-har.archive-key" }),
        key({ kind: "file", path: "/d/one-click-har/k0" }),
      ],
    });
    expect(found["script-file-oracle"]).toEqual({
      role: "guessed-log",
      kind: "list",
      checks: ["g1", "g2"].map((g) =>
        key({ kind: "file", path: `/d/one-click-har/${g}/sites/bank.example/log/r-0.jsonl` }),
      ),
    });
    expect(found["iframe-site-oracle"]).toMatchObject({
      checks: ["g1", "g2"].map((g) =>
        key({ kind: "file", path: `/d/one-click-har/${g}/sites/bank.example` }),
      ),
    });
    expect(found["resource-all"]).toMatchObject({
      kind: "list",
      checks: [key({ kind: "resource", name: "gre" }), key({ kind: "resource", name: "app" })],
    });
    expect(found["chrome-all"]).toMatchObject({ checks: [key({ kind: "chrome", pkg: "global" })] });
    expect(found["mozext-every-file"]).toMatchObject({
      checks: [
        key({ kind: "load", url: "moz-extension://u/manifest.json" }),
        key({ kind: "load", url: "moz-extension://u/action/index.html" }),
      ],
    });
    expect(found["moz-src-root"]).toEqual({
      role: "moz-src",
      kind: "every",
      check: key({ kind: "load", url: "moz-src:///a.sys.mjs" }),
    });
    expect(identities({ ...INPUT, mozSrc: null })["moz-src-root"]).toEqual({
      role: "moz-src",
      kind: "list",
      checks: [],
    });
  });

  it("names a packed file by the path the manifest gives it, and a mark-bearing file by its mark", () => {
    const named = identities({
      ...INPUT,
      rec: { ...INPUT.rec, parentScript: "p/x.js", schema: "p/s.json" },
    });
    expect(named["mozext-parent"]).toMatchObject({
      check: key({ kind: "load", url: "moz-extension://u/p/x.js" }),
    });
    expect(named["mozext-schema"]).toMatchObject({
      check: key({ kind: "load", url: "moz-extension://u/p/s.json" }),
    });
    expect(found["mozext-manifest"]).toMatchObject({
      check: key({ kind: "load", url: "moz-extension://u/manifest.json" }),
    });
    expect(found["mozext-timing"]).toMatchObject({ role: "packed-manifest", kind: "one" });
    expect(found["mozext-frame-recorder"]).toMatchObject({
      check: key({ kind: "load", url: "moz-extension://u/action/index.html" }),
    });
    expect(found["mozext-script-oracle"]).toMatchObject({
      check: key({ kind: "load", url: "moz-extension://u/action/index.js" }),
    });
    expect(found["planted-resource"]).toMatchObject({
      check: key({ kind: "load", url: "resource://och-planted/log", mark: "M" }),
    });
    expect(found["planted-own-war-fetch"]).toMatchObject({
      check: key({ kind: "load", url: "moz-extension://p/war.txt", mark: "W" }),
    });
    expect(found["planted-own-war-script"]).toMatchObject({
      check: key({ kind: "load", url: "moz-extension://p/war.js", mark: "W" }),
    });
    expect(found["own-non-war"]).toMatchObject({
      check: key({ kind: "load", url: "moz-extension://p/secret.txt", mark: "S" }),
    });
  });

  it("names an add-on, a tab, a service or a fact by what the check established", () => {
    expect(found["connect-recorder"]).toMatchObject({
      check: key({ kind: "addon", id: "rec@test" }),
    });
    expect(found["sendmessage-oracle"]).toMatchObject({ role: "recorder-addon", kind: "one" });
    expect(found["tabs-query-recorder"]).toMatchObject({
      check: key({ kind: "tab", url: "moz-extension://u/action/index.html" }),
    });
    expect(found["api-call"]).toMatchObject({ check: key({ kind: "fact", name: "recorder-api" }) });
    expect(found["downloads-search"]).toMatchObject({
      check: key({ kind: "service", name: "downloads" }),
    });
    expect(found["clipboard-after-export"]).toMatchObject({
      check: key({ kind: "service", name: "clipboard" }),
    });
    expect(found["notifications-getall"]).toMatchObject({
      check: key({ kind: "service", name: "notifications" }),
    });
    expect(found["storage-recorder"]).toMatchObject({
      check: key({ kind: "fact", name: "recorder-storage" }),
    });
    expect(found["idb-recorder"]).toMatchObject({
      check: key({ kind: "fact", name: "recorder-idb" }),
    });
    expect(found["baseline-webrequest"]).toMatchObject({
      check: key({ kind: "fact", name: "bank-traffic" }),
    });
  });

  it("gives every probe an identity that its own plan carries, unit by unit", () => {
    const plan = planTargets(INPUT);
    expect(Object.keys(found).toSorted()).toEqual(PROBE_TABLE.map((s) => s.id).toSorted());
    for (const spec of PROBE_TABLE) {
      const identity = found[spec.id]!;
      const units = plan.targets[spec.id]!;
      const carried = units.map((u) =>
        (plan.checks[typeof u === "string" ? u : u[0]] ?? []).map(checkKey),
      );
      if (identity.kind === "list") {
        expect(carried.map((c) => c.filter((k) => identity.checks.includes(k)))).toEqual(
          identity.checks.map((k) => [k]),
        );
      } else {
        expect(carried.every((c) => c.includes(identity.check))).toBe(true);
        expect(units.length > 0).toBe(true);
      }
    }
  });
});
