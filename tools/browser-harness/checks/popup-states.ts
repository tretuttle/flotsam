import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  readExtensionId,
  readExtensionPopupPath,
  type BrowserSession,
  type Pref,
} from "../src/browser.ts";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { judgeExport, validateHar } from "../src/export-judge.ts";
import { openExtensionPage, value, type ExtensionPage } from "../src/export-session.ts";
import {
  popupAuditExpression,
  sizeProblems,
  type DomAudit,
  type PopupBox,
} from "../src/popup-audit.ts";
import { callHook, recordingWorkspace, type RecordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "popup-states";
const THEMES = [
  { name: "light", dark: 0 },
  { name: "dark", dark: 1 },
] as const;
type Theme = (typeof THEMES)[number]["name"];

/** Marionette turns this off as a recommended pref; a user's browser has it on, so the popup is shown as users see it. */
const USER_DEFAULTS: readonly Pref[] = [
  { name: "security.fileuri.strict_origin_policy", value: true },
];

/** Button names as the popup shows them. Written here, not read from the product, so a renamed button fails. */
const NAMES = {
  custom: "Choose range, scope and file name",
  back: "Back",
} as const;

/** Where the popup opens: a tab by URL in a normal or private window, or Zen's empty tab (url null). */
type Target = { readonly url: string | null; readonly private: boolean };

const PRIVATE_UTILS = `const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
  const windowOf = (priv) => [...Services.wm.getEnumerator("navigator:browser")].find((w) => PrivateBrowsingUtils.isWindowPrivate(w) === priv);`;

const CLOSE_POPUPS = `const done = arguments[arguments.length - 1];
  for (const w of Services.wm.getEnumerator("navigator:browser"))
    for (const b of w.document.querySelectorAll(".webextension-popup-browser")) b.closest("panel")?.hidePopup();
  done(true);`;

/**
 * Selects the target tab, waits until the selection has held for 200 ms (Marionette's switch to the helper page can
 * land after it), then opens the popup the way the toolbar button does. The popup reads its tab as it loads.
 */
const OPEN_POPUP = `const done = arguments[arguments.length - 1];
  const [addonId, target] = arguments;
  ${PRIVATE_UTILS}
  (async () => {
    const win = windowOf(target.private);
    if (win === undefined) throw new Error("no window");
    const wanted = () =>
      target.url === null
        ? win.gBrowser.selectedTab.hasAttribute("zen-empty-tab")
        : !win.gBrowser.selectedTab.hasAttribute("zen-empty-tab") &&
          win.gBrowser.selectedBrowser.currentURI.spec === target.url;
    const select = () => {
      if (target.url === null) return win.gZenWorkspaces.selectEmptyTab();
      const tab = [...win.gBrowser.tabs].find(
        (t) => !t.hasAttribute("zen-empty-tab") && t.linkedBrowser.currentURI.spec === target.url,
      );
      if (tab === undefined) throw new Error("no tab at " + target.url);
      win.gBrowser.selectedTab = tab;
    };
    let held = 0;
    for (let i = 0; i < 100 && held < 4; i += 1) {
      if (Services.focus.activeWindow !== win) win.focus();
      if (wanted() && Services.focus.activeWindow === win) held += 1;
      else {
        held = 0;
        select();
      }
      await new Promise((resolve) => win.setTimeout(resolve, 50));
    }
    if (!wanted() || Services.focus.activeWindow !== win)
      throw new Error("the target tab did not stay selected in the focused window");
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
    const extension = WebExtensionPolicy.getByID(addonId).extension;
    const widgetId = ExtensionCommon.makeWidgetId(addonId) + "-browser-action";
    if (win.document.getElementById(widgetId) === null) win.CustomizableUI.addWidgetToArea(widgetId, win.CustomizableUI.AREA_NAVBAR);
    await ExtensionParent.apiManager.global.browserActionFor(extension).openPopup(win, false);
    const browser = () => win.document.querySelector(".webextension-popup-browser");
    let last = "";
    let stable = 0;
    for (let i = 0; i < 200 && stable < 4; i += 1) {
      await new Promise((resolve) => win.setTimeout(resolve, 50));
      const size = String(browser()?.clientWidth) + "x" + String(browser()?.clientHeight);
      stable = size === last && (browser()?.clientHeight ?? 0) > 100 ? stable + 1 : 0;
      last = size;
    }
    done({ ok: true, selected: wanted() && stable >= 4, detail: { selected: wanted(), size: last, spec: win.gBrowser.selectedBrowser.currentURI.spec, privateAllowed: WebExtensionPolicy.getByID(addonId).privateBrowsingAllowed, browsers: [...Services.wm.getEnumerator("navigator:browser")].map((w) => w.document.querySelectorAll(".webextension-popup-browser").length), widget: win.document.getElementById(widgetId) !== null } });
  })().catch((error) => done({ ok: false, error: String(error) }));`;

/** The popup's own `<browser>`, drawn from its compositor output once its size holds for two reads. */
const SNAPSHOT = `const done = arguments[arguments.length - 1];
  const [priv, draw] = arguments;
  ${PRIVATE_UTILS}
  (async () => {
    const win = windowOf(priv);
    const b = win.document.querySelector(".webextension-popup-browser");
    if (b === null) throw new Error("no popup browser");
    let last = "";
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => win.setTimeout(resolve, 50));
      const size = b.clientWidth + "x" + b.clientHeight;
      if (size === last) break;
      last = size;
    }
    let png = null;
    if (draw) {
      const bitmap = await b.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      png = canvas.toDataURL("image/png");
    }
    done({ ok: true, png, width: b.clientWidth, height: b.clientHeight });
  })().catch((error) => done({ ok: false, error: String(error) }));`;

const SET_THEME = `const done = arguments[arguments.length - 1];
  Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[0]);
  done(true);`;

/**
 * Lets the add-on run in private windows, restarts it so the grant applies, and opens a private window on `url` with
 * a page of the add-on beside it. A page reaches only popups of its own principal, so the private popup is read from
 * there; its Marionette handle comes back.
 */
const PRIVATE_WINDOW = `const done = arguments[arguments.length - 1];
  const [addonId, url, pagePath] = arguments;
  (async () => {
    const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await ExtensionPermissions.add(addonId, { permissions: ["internal:privateBrowsingAllowed"], origins: [] });
    await (await AddonManager.getAddonByID(addonId)).reload();
    const win = OpenBrowserWindow({ private: true });
    await new Promise((resolve) => {
      const seen = (subject) => {
        if (subject !== win) return;
        Services.obs.removeObserver(seen, "browser-delayed-startup-finished");
        resolve();
      };
      Services.obs.addObserver(seen, "browser-delayed-startup-finished");
    });
    const system = Services.scriptSecurityManager.getSystemPrincipal();
    const loaded = (tab, spec) =>
      new Promise((resolve) => {
        const poll = () => (tab.linkedBrowser.currentURI.spec === spec && !tab.hasAttribute("busy") ? resolve() : win.setTimeout(poll, 50));
        poll();
      });
    const policy = WebExtensionPolicy.getByID(addonId);
    while (!policy.active) await new Promise((resolve) => win.setTimeout(resolve, 50));
    const pageUrl = WebExtensionPolicy.getByID(addonId).getURL(pagePath);
    const page = win.gBrowser.addTab(pageUrl, { triggeringPrincipal: system });
    const tab = win.gBrowser.addTab(url, { triggeringPrincipal: system });
    win.gBrowser.selectedTab = tab;
    await Promise.all([loaded(page, pageUrl), loaded(tab, url)]);
    const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
    done({ ok: true, page: NavigableManager.getIdForBrowser(page.linkedBrowser) });
  })().catch((error) => done({ ok: false, error: String(error) }));`;

const inPopup = (body: string) => `(() => {
  const w = browser.extension.getViews({ type: "popup" })[0];
  if (w === undefined) return null;
  ${body}
})()`;

const VIEW_KIND = inPopup(`return w.document.querySelector(".popup")?.dataset.view ?? null;`);

type Shot = {
  readonly state: string;
  readonly theme: Theme;
  readonly view: string;
  readonly file: string | null;
  readonly box: PopupBox;
  readonly checked: DomAudit["checked"];
  readonly problems: readonly string[];
};

const chrome = async <T>(
  session: BrowserSession,
  script: string,
  args: readonly unknown[] = [],
): Promise<T> => {
  const answer = (await session.evaluateChrome(script, args)) as T & {
    readonly ok?: boolean;
    readonly error?: string;
  };
  if (answer.ok === false) throw new Error(answer.error);
  return answer;
};

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(v)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** One browser with the add-on, a page of the add-on to reach the popup from, and the screenshots it writes. */
class PopupDriver {
  readonly shots: Shot[] = [];
  readonly session: BrowserSession;
  /** Replaced after the add-on restarts, which closes its pages. */
  page: ExtensionPage;
  readonly addonId: string;
  readonly shotDir: string;
  readonly log: (line: string) => void;

  constructor(
    session: BrowserSession,
    page: ExtensionPage,
    addonId: string,
    shotDir: string,
    log: (line: string) => void,
  ) {
    this.log = log;
    this.session = session;
    this.page = page;
    this.addonId = addonId;
    this.shotDir = shotDir;
  }

  /** Opens the real popup on `target` and waits until it draws `view`. */
  async open(target: Target, view: string): Promise<void> {
    this.log(`${NAME}: open the popup on ${String(target.url)} for ${view}`);
    await chrome(this.session, CLOSE_POPUPS);
    await until(
      () => value<number>(this.page, `browser.extension.getViews({ type: "popup" }).length`),
      (n) => n === 0,
      "the previous popup to close",
    );
    const opened = await chrome<{ selected: boolean; detail: unknown }>(this.session, OPEN_POPUP, [
      this.addonId,
      target,
    ]);
    if (!opened.selected)
      throw new Error(
        `the popup did not settle on ${String(target.url)}: ${JSON.stringify(opened.detail)}`,
      );
    await this.view(view);
  }

  async view(kind: string): Promise<void> {
    try {
      await until(
        () => value<string | null>(this.page, VIEW_KIND),
        (v) => v === kind,
        `the popup to show ${kind}`,
      );
    } catch (error) {
      const shown = await value<string | null>(
        this.page,
        inPopup(`return w.document.body.innerText;`),
      );
      throw new Error(`${String(error)}; the popup reads: ${JSON.stringify(shown)}`, {
        cause: error,
      });
    }
  }

  /** Clicks the button whose accessible name is `name`, as a user's click would. */
  click(name: string): Promise<unknown> {
    return value(
      this.page,
      inPopup(`const button = [...w.document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent).trim() === ${JSON.stringify(name)});
        if (button === undefined) throw new Error("no button named " + ${JSON.stringify(name)});
        button.click();
        return true;`),
    );
  }

  clickRow(index: number): Promise<unknown> {
    return value(
      this.page,
      inPopup(
        `w.document.querySelectorAll(".presets .preset")[${String(index)}].click(); return true;`,
      ),
    );
  }

  text(selector: string): Promise<string | null> {
    return value(
      this.page,
      inPopup(`return w.document.querySelector(${JSON.stringify(selector)})?.textContent ?? null;`),
    );
  }

  async audit(
    priv: boolean,
    draw: string | null,
  ): Promise<{ box: PopupBox; audit: DomAudit; problems: string[] }> {
    const snap = await chrome<{ png: string | null; width: number; height: number }>(
      this.session,
      SNAPSHOT,
      [priv, draw !== null],
    );
    const audit = await value<DomAudit>(this.page, popupAuditExpression());
    const box: PopupBox = {
      width: snap.width,
      height: snap.height,
      scrollWidth: audit.scrollWidth,
      scrollHeight: audit.scrollHeight,
    };
    if (draw !== null && snap.png !== null)
      NodeFS.writeFileSync(draw, Buffer.from(snap.png.slice(snap.png.indexOf(",") + 1), "base64"));
    return { box, audit, problems: [...audit.problems, ...sizeProblems(box)] };
  }

  /** Screenshots and audits the open popup in both themes, then leaves it light. */
  async capture(state: string, priv = false): Promise<void> {
    this.log(`${NAME}: capture ${state}`);
    const view = (await value<string | null>(this.page, VIEW_KIND)) ?? "none";
    for (const theme of priv ? THEMES.filter((t) => t.dark === 1) : THEMES) {
      await chrome(this.session, SET_THEME, [theme.dark]);
      await until(
        () =>
          value<boolean | null>(
            this.page,
            inPopup(`return w.matchMedia("(prefers-color-scheme: dark)").matches;`),
          ),
        (dark) => dark === (theme.dark === 1),
        `the ${theme.name} theme`,
      );
      const file = NodePath.join(this.shotDir, `${state}-${theme.name}.png`);
      const { box, audit, problems } = await this.audit(priv, file);
      this.shots.push({
        state,
        theme: theme.name,
        view,
        file,
        box,
        checked: audit.checked,
        problems,
      });
    }
    await chrome(this.session, SET_THEME, [0]);
  }
}

/** Each audit's planted failure, put into the real popup DOM; the audit must name it. */
const PLANTS = [
  {
    name: "text #8A93A3 on white (3.1:1)",
    expect: "text contrast",
    html: `<p data-plant="" style="color:#8A93A3;background:#FFFFFF">planted low contrast</p>`,
  },
  {
    name: "an icon button with no name",
    expect: "no accessible name",
    html: `<button data-plant="" type="button" class="iconbtn"><svg class="ic" width="16" height="16"></svg></button>`,
  },
  {
    name: "an em dash in copy",
    expect: "dash U+2014",
    html: `<p data-plant="">Saved ${String.fromCodePoint(0x2014)} done</p>`,
  },
  {
    name: "an emoji in copy",
    expect: "emoji",
    html: `<p data-plant="">Saved ${String.fromCodePoint(0x1f4be)}</p>`,
  },
  { name: "a transition", expect: "motion", css: `.preset { transition: background-color 150ms }` },
  { name: "a 420 px wide popup", expect: "px wide", css: `.popup { width: 420px !important }` },
  { name: "a 700 px tall popup", expect: "px tall", css: `.pad { min-height: 700px }` },
] as const;

async function plantAndAudit(
  driver: PopupDriver,
): Promise<{ caught: string[]; missed: string[]; clean: string[] }> {
  const caught: string[] = [];
  const missed: string[] = [];
  for (const plant of PLANTS) {
    await value(
      driver.page,
      inPopup(`const html = ${JSON.stringify("html" in plant ? plant.html : "")};
        const css = ${JSON.stringify("css" in plant ? plant.css : "")};
        if (html) w.document.querySelector(".pad").insertAdjacentHTML("beforeend", html);
        if (css) { const s = w.document.createElement("style"); s.dataset.plant = ""; s.textContent = css; w.document.head.append(s); }
        return true;`),
    );
    const { problems } = await driver.audit(false, null);
    (problems.some((p) => p.includes(plant.expect)) ? caught : missed).push(plant.name);
    await value(
      driver.page,
      inPopup(
        `for (const el of w.document.querySelectorAll("[data-plant]")) el.remove(); return true;`,
      ),
    );
  }
  const { problems: clean } = await driver.audit(false, null);
  return { caught, missed, clean };
}

const number = (text: string | null): number => Number((text ?? "").replace(/[^0-9]/gu, ""));

async function launchDriver(
  workspace: RecordingWorkspace,
  context: CheckContext,
  extensionPath: string,
  shotDir: string,
  extra: { readonly prefs?: readonly Pref[]; readonly dataHome?: string } = {},
): Promise<BrowserSession & { driver: PopupDriver }> {
  const session = await workspace.launch({
    binaryPath: context.binaryPath,
    extensionPath,
    display: context.display,
    protocol: "marionette",
    signal: context.signal,
    extraPrefs: [...USER_DEFAULTS, ...(extra.prefs ?? [])],
    ...(extra.dataHome === undefined ? {} : { dataHome: extra.dataHome }),
  });
  const page = await openExtensionPage(session, extensionPath);
  return Object.assign(session, {
    driver: new PopupDriver(
      session,
      page,
      await readExtensionId(extensionPath),
      shotDir,
      context.log,
    ),
  });
}

/**
 * Every popup state in the real popup panel of Zen with the packed add-on, reached through the real API: screenshots
 * in light and dark, and audits of the popup's DOM (contrast, names, 400 by 600, motion, copy), each audit shown to
 * catch a planted failure. One click on a row writes a file the fixture server's SHA-256 confirms, and the result
 * names it.
 */
const check: HarnessCheck = {
  name: NAME,
  description:
    "every popup state renders in light and dark, passes its audits, and one click on a row saves the file",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const result = (problems: readonly string[], detail: string, data?: unknown): CheckResult => ({
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? detail : problems.join("; "),
      data,
    });
    if (context.extensionPath === null) return result(["needs --extension"], "");
    const extensionPath = context.extensionPath;
    await using a = await startFixtureServer();
    await using b = await startFixtureServer();
    await using workspace = recordingWorkspace(NAME);
    const shotDir =
      context.outDir === null
        ? NodePath.join(workspace.downloads, "..", "shots")
        : NodePath.join(context.outDir, NAME);
    NodeFS.mkdirSync(shotDir, { recursive: true });
    const problems: string[] = [];
    const shots: Shot[] = [];

    const full = `http://127.0.0.1:${String(a.port)}/fixtures/`;
    const plain = `http://localhost:${String(b.port)}/`;
    let oneClick: unknown = null;
    /** Zen draws a private window and its popups dark whatever the system theme; observed, so no light shot exists. */
    let privateDarkUnderLight: boolean | null = null;
    let plants: Awaited<ReturnType<typeof plantAndAudit>> | null = null;
    {
      await using session = await launchDriver(workspace, context, extensionPath, shotDir);
      const driver = session.driver;
      const fullTab = await session.openTab(full);
      await session.evaluate(fullTab, `window.__harnessReady`);
      await session.evaluate(
        fullTab,
        `fetch("/fixtures/video").then((r) => r.arrayBuffer()).then(() => "done")`,
      );
      const plainTab = await session.openTab(plain);

      await driver.open({ url: full, private: false }, "ready");
      await driver.capture("ready");
      plants = await plantAndAudit(driver);

      await driver.click(NAMES.custom);
      await driver.view("custom");
      await driver.capture("custom");
      await driver.click(NAMES.back);
      await driver.view("ready");

      await callHook(session, { kind: "export-pause", point: "before-link", action: "arm" });
      await driver.clickRow(0);
      await driver.view("exporting");
      await until(
        () => callHook(session, { kind: "export-pause", point: "before-link", action: "reached" }),
        (reached) => reached === true,
        "the export to reach its pause",
      );
      await driver.capture("exporting");
      await callHook(session, { kind: "export-pause", point: "before-link", action: "release" });
      await driver.view("done");
      await driver.capture("done-missing");
      const gapsShown = await driver.text(".gaps");
      if (gapsShown === null || !gapsShown.includes("audio and video"))
        problems.push(`done-missing lists no audio and video group: ${String(gapsShown)}`);

      await driver.open({ url: plain, private: false }, "ready");
      const shownCount = number(await driver.text(".presets .preset .p-n b"));
      await driver.clickRow(0);
      await driver.view("done");
      await driver.capture("done");
      const named = (await driver.text(".file"))?.trim() ?? "";
      const written = NodePath.join(workspace.downloads, named);
      if (named === "" || !NodeFS.existsSync(written)) {
        problems.push(
          `the result names "${named}", which is not in the export folder: ${NodeFS.readdirSync(workspace.downloads).join(", ")}`,
        );
      } else {
        const text = NodeFS.readFileSync(written, "utf8");
        const verdict = judgeExport(text, {
          servers: [{ host: `localhost:${String(b.port)}`, server: b }],
          hosts: [`localhost:${String(b.port)}`],
          previewCount: shownCount,
          secret: "ONE-CLICK-HAR-NO-SECRET-PLANTED",
        });
        problems.push(...verdict.problems.map((p) => `one click: ${p}`));
        const invalid = await validateHar(text);
        if (invalid !== null) problems.push(`one click: har-validator: ${invalid}`);
        oneClick = {
          file: named,
          rowCount: shownCount,
          entries: verdict.entries,
          exact: verdict.exact,
          bytes: text.length,
        };
      }

      await callHook(session, { kind: "export-fault", op: "link", errno: "ENOSPC" });
      await driver.open({ url: plain, private: false }, "ready");
      await driver.clickRow(0);
      await driver.view("error-write");
      await driver.capture("error-write");

      const blank = "about:blank";
      await session.openTab(blank);
      await driver.open({ url: blank, private: false }, "empty-tab");
      await driver.capture("empty-tab");

      await driver.open({ url: null, private: false }, "no-tab");
      await driver.capture("no-tab");

      const privateUrl = `http://127.0.0.1:${String(a.port)}/fixtures/no-store`;
      // The restart closes the add-on's pages, so Marionette moves to a web tab first.
      await session.evaluate(plainTab, `"moved"`);
      const privatePage = await chrome<{ page: string }>(session, PRIVATE_WINDOW, [
        driver.addonId,
        privateUrl,
        await readExtensionPopupPath(extensionPath),
      ]);
      driver.page = { session, tab: privatePage.page };
      await until(
        () => session.evaluate(privatePage.page, `typeof browser`),
        (type) => type === "object",
        "the private window's add-on page to answer",
      );
      await driver.open({ url: privateUrl, private: true }, "empty-private");
      await driver.capture("empty-private", true);
      await chrome(session, SET_THEME, [0]);
      privateDarkUnderLight = await until(
        () =>
          value<boolean | null>(
            driver.page,
            inPopup(`return w.matchMedia("(prefers-color-scheme: dark)").matches;`),
          ),
        (dark) => dark !== null,
        "the private popup's colour scheme",
      );
      shots.push(...driver.shots);
    }
    {
      await using refused = recordingWorkspace(`${NAME}-refused`);
      await using session = await launchDriver(refused, context, extensionPath, shotDir, {
        dataHome: NodePath.join(refused.profileDir, "archive-inside-profile"),
      });
      await session.openTab(plain);
      await session.driver.open({ url: plain, private: false }, "error-store");
      await session.driver.capture("error-store");
      shots.push(...session.driver.shots);
    }
    {
      await using off = recordingWorkspace(`${NAME}-api-off`);
      await using session = await launchDriver(off, context, extensionPath, shotDir, {
        prefs: [{ name: "extensions.experiments.enabled", value: false }],
      });
      await session.openTab(plain);
      await session.driver.open({ url: plain, private: false }, "api-missing");
      await session.driver.capture("api-missing");
      shots.push(...session.driver.shots);
    }

    for (const shot of shots)
      problems.push(...shot.problems.map((p) => `${shot.state} ${shot.theme}: ${p}`));
    if (plants !== null) {
      problems.push(...plants.missed.map((m) => `planted ${m} was not caught`));
      problems.push(...plants.clean.map((p) => `after the plants were removed: ${p}`));
    }
    const states = [...new Set(shots.map((s) => s.state))];
    if (privateDarkUnderLight === false)
      problems.push(
        "a private window now follows a light system theme: capture empty-private in light too",
      );
    return result(
      problems,
      `${String(shots.length)} screenshots of ${states.join(", ")} in ${shotDir} (empty-private in dark only: Zen draws private windows dark under a light system theme); planted and caught: ${plants?.caught.join(", ") ?? "none"}; one click: ${JSON.stringify(oneClick)}`,
      {
        shots: shots.map(({ file, ...rest }) => ({
          ...rest,
          file: file === null ? null : NodePath.basename(file),
        })),
        plants,
        oneClick,
        privateDarkUnderLight,
      },
    );
  },
};

/** @discovered-check */
export default check;
