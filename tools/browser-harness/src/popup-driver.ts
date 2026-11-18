// Opens the real toolbar popup and reaches its DOM, for checks that drive the popup as a user does. Observed in
// headless Zen 1.24.2b; docs/internals/browser-harness.md says why each step is needed.

export const PRIVATE_UTILS = `const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
  const windowOf = (priv) => [...Services.wm.getEnumerator("navigator:browser")].find((w) => PrivateBrowsingUtils.isWindowPrivate(w) === priv);`;

export const CLOSE_POPUPS = `const done = arguments[arguments.length - 1];
  for (const w of Services.wm.getEnumerator("navigator:browser"))
    for (const b of w.document.querySelectorAll(".webextension-popup-browser")) b.closest("panel")?.hidePopup();
  done(true);`;

/**
 * Selects the target tab, waits until the selection has held for 200 ms (Marionette's switch to the helper page can
 * land after it), then opens the popup the way the toolbar button does. The popup reads its tab as it loads.
 */
export const OPEN_POPUP = `const done = arguments[arguments.length - 1];
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

/** An expression for a page of the add-on: runs `body` with the open popup's window as `w`, or answers null. */
export const inPopup = (body: string) => `(() => {
  const w = browser.extension.getViews({ type: "popup" })[0];
  if (w === undefined) return null;
  ${body}
})()`;
