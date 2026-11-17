import { describe, expect, it } from "vite-plus/test";
import {
  checkKey,
  combineWitness,
  missingSibling,
  planTargets,
  traversalUrls,
  type PlanInput,
  type WitnessCheck,
} from "./targets.ts";

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
  inventory: [{ path: "/d/one-click-har/k0", directory: true }],
  guessedKeyFolders: ["/d/one-click-har/g1"],
  redirectToLog: "http://attacker.example/redir?to=x",
  wrRedirect: "http://attacker.example/wr-redirect",
  rec: {
    id: "rec@test",
    base: "moz-extension://u/",
    popupPath: "action/index.html",
    popupScriptPath: "action/index.js",
    parentScript: "experiment/parent.js",
    schema: "experiment/schema.json",
    files: ["manifest.json"],
  },
  probe: { base: "moz-extension://p/", warMark: "W", secretMark: "S" },
  randomUuid: "r",
  randomId: "none@test",
  plantedResource: { hit: "resource://och-planted/log", miss: "resource://och-planted/missing" },
  resourceNames: ["gre"],
  chromePackages: ["global"],
  mozSrc: null,
  binDir: "/opt/zen",
};
const LOG_FILE: WitnessCheck = { kind: "file", path: INPUT.file.log, mark: "M" };

describe("planned targets", () => {
  const plan = planTargets(INPUT);

  it("gives every planned target a witness check, and nothing else one", () => {
    const planned = new Set(
      Object.values(plan.targets)
        .flat()
        .flatMap((u) => (typeof u === "string" ? [u] : [...u])),
    );
    expect([...planned].toSorted()).toEqual(Object.keys(plan.checks).toSorted());
    expect(Object.values(plan.checks).every((c) => c.length > 0)).toBe(true);
  });

  it("witnesses a wrapped or redirected file through the file itself", () => {
    const log = "file:///d/one-click-har/k0/sites/bank.example/log/r-0.jsonl";
    expect(plan.targets["viewsource-fetch"]).toEqual([`view-source:${log}`]);
    expect(plan.checks[`view-source:${log}`]).toEqual([LOG_FILE]);
    expect(plan.checks[`jar:${log}!/`]).toEqual([LOG_FILE]);
    expect(plan.checks["http://attacker.example/redir?to=x"]).toEqual([
      { kind: "redirect", url: "http://attacker.example/redir?to=x", to: log },
      LOG_FILE,
    ]);
    expect(plan.checks["http://attacker.example/wr-redirect?from=tab"]).toEqual([LOG_FILE]);
    expect(plan.checks["file:///d/one-click-har/"]).toEqual([
      { kind: "file", path: "/d/one-click-har" },
    ]);
    expect(plan.targets["fetch-file-body"]).toEqual([
      "file:///d/one-click-har/k0/sites/bank.example/bodies/r1.7.body",
    ]);
    expect(plan.checks["file:///d/one-click-har/k0/sites/bank.example/bodies/r1.7.body"]).toEqual([
      { kind: "file", path: INPUT.file.body, mark: "M" },
    ]);
    expect(plan.checks["file:///dl/e.har"]).toEqual([
      { kind: "file", path: "/dl/e.har", mark: "M" },
    ]);
    expect(plan.checks["file:///d/one-click-har/k0/"]).toEqual([
      { kind: "file", path: "/d/one-click-har/k0" },
    ]);
  });

  it("plans the parent script and schema the manifest names, and the planted log by its mark", () => {
    const named = planTargets({
      ...INPUT,
      rec: { ...INPUT.rec, parentScript: "p/x.js", schema: "p/s.json" },
    });
    expect(named.targets["mozext-parent"]).toEqual(["moz-extension://u/p/x.js"]);
    expect(named.targets["mozext-schema"]).toEqual(["moz-extension://u/p/s.json"]);
    expect(named.checks["resource://och-planted/log"]).toEqual([
      { kind: "load", url: "resource://och-planted/log", mark: "M" },
    ]);
  });

  it("keys a check by its fields, whatever their order, and drops an absent mark", () => {
    expect(checkKey({ kind: "file", path: "/a", mark: "M" })).toBe(
      checkKey({ path: "/a", mark: "M", kind: "file" } as WitnessCheck),
    );
    expect(checkKey({ kind: "load", url: "u", mark: undefined })).toBe(
      checkKey({ kind: "load", url: "u" }),
    );
    expect(checkKey({ kind: "load", url: "u" })).toBe('[["kind","load"],["url","u"]]');
  });

  it("plans guesses under each derived key, paired with a sibling no product writes", () => {
    expect(plan.targets["script-file-oracle"]).toEqual([
      [
        "file:///d/one-click-har/g1/sites/bank.example/log/r-0.jsonl",
        "file:///d/one-click-har/g1/sites/bank.example/log/r-0.jsonl-och-missing",
      ],
    ]);
    expect(plan.targets["script-site-oracle"]).toEqual([
      [
        "file:///d/one-click-har/g1/sites/bank.example/",
        "file:///d/one-click-har/g1/sites/bank.example-och-missing/",
      ],
    ]);
    expect(missingSibling("file:///a/b/")).toBe("file:///a/b-och-missing/");
    expect(missingSibling("file:///a/b")).toBe("file:///a/b-och-missing");
  });

  it("asks the system principal about schemes, add-ons, tabs and services, and the check about facts", () => {
    expect(plan.checks["resource://gre/"]).toEqual([{ kind: "resource", name: "gre" }]);
    expect(plan.checks["chrome://global/content/"]).toEqual([{ kind: "chrome", pkg: "global" }]);
    expect(plan.targets["moz-src-root"]).toEqual([]);
    expect(plan.targets["sendmessage-oracle"]).toEqual([["addon:rec@test", "addon:none@test"]]);
    expect(plan.checks["addon:none@test"]).toEqual([{ kind: "addon", id: "none@test" }]);
    expect(plan.checks["tab:moz-extension://u/action/index.html"]).toEqual([
      { kind: "tab", url: "moz-extension://u/action/index.html" },
    ]);
    expect(plan.checks["moz-extension://p/secret.txt"]).toEqual([
      { kind: "load", url: "moz-extension://p/secret.txt", mark: "S" },
    ]);
    expect(plan.checks["api:oneClickHar"]).toEqual([{ kind: "fact", name: "recorder-api" }]);
    expect(plan.checks["downloads:all"]).toEqual([{ kind: "service", name: "downloads" }]);
    expect(plan.checks["traffic:http://bank.example/"]).toEqual([
      { kind: "fact", name: "bank-traffic" },
    ]);
    expect(plan.checks["store:recorder-idb"]).toEqual([{ kind: "fact", name: "recorder-idb" }]);
    expect(plan.checks["store:recorder-storage-local"]).toEqual([
      { kind: "fact", name: "recorder-storage" },
    ]);
    expect(plan.checks["clipboard:"]).toEqual([{ kind: "service", name: "clipboard" }]);
    expect(plan.checks["notifications:"]).toEqual([{ kind: "service", name: "notifications" }]);
    expect(plan.targets["mozext-timing"]).toEqual([
      ["moz-extension://u/manifest.json", "moz-extension://r/manifest.json"],
    ]);
  });

  it("walks from a scheme's base folder to the log in four encodings, and needs both to exist", () => {
    expect(traversalUrls("resource://gre/", "/opt/zen", "/d/x/log")).toEqual([
      "resource://gre/..%2F..%2Fd%2Fx%2Flog",
      "resource://gre/%2e%2e/%2e%2e/d/x/log",
      "resource://gre/%2e%2e%2f%2e%2e%2fd%2fx%2flog",
      "resource://gre/..%5C..%5Cd%5Cx%5Clog",
    ]);
    const first = planTargets({ ...INPUT, mozSrc: "moz-src:///a.sys.mjs" }).checks;
    const [walk] = traversalUrls("moz-src:///", "/opt/zen", INPUT.file.log);
    expect(first[walk!]).toEqual([{ kind: "load", url: "moz-src:///a.sys.mjs" }, LOG_FILE]);
    expect(first["moz-src:///a.sys.mjs"]).toEqual([{ kind: "load", url: "moz-src:///a.sys.mjs" }]);
  });
});

describe("witness", () => {
  it("finds a target present only when it has checks and every one held", () => {
    const plan = {
      targets: {},
      checks: {
        both: [LOG_FILE, { kind: "addon", id: "a" }] as WitnessCheck[],
        one: [{ kind: "addon", id: "a" }] as WitnessCheck[],
        none: [] as WitnessCheck[],
        unrun: [{ kind: "addon", id: "b" }] as WitnessCheck[],
      },
    };
    const results = new Map([
      [checkKey(LOG_FILE), { ok: false, detail: "NotFoundError" }],
      [checkKey({ kind: "addon", id: "a" }), { ok: true, detail: "active" }],
    ]);
    const addonA = checkKey({ kind: "addon", id: "a" });
    expect(combineWitness(plan, results)).toEqual({
      both: {
        present: false,
        detail: "NotFoundError; active",
        checks: [checkKey(LOG_FILE), addonA],
      },
      one: { present: true, detail: "active", checks: [addonA] },
      none: { present: false, detail: "", checks: [] },
      unrun: {
        present: false,
        detail: "no result for addon",
        checks: [checkKey({ kind: "addon", id: "b" })],
      },
    });
  });
});
