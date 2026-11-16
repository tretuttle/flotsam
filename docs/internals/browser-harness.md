# Browser harness

`tools/browser-harness` is the single launcher, fixture server, and proof runner for every Gecko browser. Extension scripts (`verify:browser`, `screenshot:toolbar`) launch through it rather than keeping separate spawn, profile, or shutdown code.

## Check discovery and version oracle

`browser-harness check` discovers every `*.ts` file under `tools/browser-harness/checks/` in sorted filename order. `environment` compares `oneClickHar.getEnvironment()` against the browser's own WebDriver session capabilities (`name`, `version`, `buildId`) instead of `application.ini` on disk, waits for `WebExtensionPolicy.getByID(id).active` rather than racing startup, and verifies schema refusals and DevTools open/close state. `restart` installs the XPI, shuts the browser down cleanly, relaunches on the same profile without reinstalling, and verifies the extension stays active. `cost-baseline` runs the rotated three-arm cost check.

## Three-arm cost measurement and baselines

`browser-harness cost` measures `off` (no extension), `extension` (packed XPI installed), and `panel` (Network panel open on the tab before navigation) across the cost pages (`cost-images`, `cost-heavy`, `cost-mixed`). Arms rotate inside each round so machine load drift affects every arm evenly, round 0 is dropped as warmup, and scored rounds report median, spread, and machine load. The budget for `extension` is `off + 0.5 * (panel - off)`. CI runs a short profile (`--short`, 3 rounds on `cost-images`); full runs use 6 rounds across all three cost pages.

A sample ends when the page reports its last resource finished (`performance.now()`), and any failed or unexpected request fails the run (`errors > 0`). Baseline commands refuse to write files when `errors > 0`. Baselines under `tools/browser-harness/baselines/` and `baselines/cost/` encode machine, browser name, version, build ID, and display mode in both filename and JSON, and are compared only when those fields match.

## Fixture server ground truth

Every non-control response from the fixture server carries a monotonic `X-Seq` header, and the server records a per-sequence SHA-256 (`wireSha256` and `decodedSha256`) alongside a request log. This covers both static pinned fixtures (`src/pinned-responses.ts`, measured with `curl` and `sha256sum`) and dynamic or streaming identity fixtures (`/poll`, cancelled 4 MiB download, 304 revalidation, cache hit, 302-to-307 redirect chain, service worker synthesize and passthrough, endless NDJSON stream, refused loopback port, and `Content-Disposition: attachment` download link). Control queries under `/__harness/` do not increment `X-Seq` or enter the fixture request log.

## One launch, one remote protocol, and launch modes

A remote launch uses WebDriver BiDi unless `--protocol marionette` is passed (required for chrome-privileged DevTools and policy checks). Closing a tab in Marionette switches back to the initial window handle so subsequent tabs remain valid.

`launchBrowser` accepts a named `launchMode`:

- `recommended` (default): starts BiDi or Marionette with Gecko Remote Agent's recommended preferences (`remote.prefs.recommended` stays `true`). Observed on Zen Twilight 1.25t, this modifies 130 preferences on the default/user branch, including setting `security.fileuri.strict_origin_policy` to `false` (giving `file://` documents universal file-origin access), disabling `privacy.trackingprotection.pbmode.enabled`, `signon.autofillForms`, `security.certerrors.mitm.priming.enabled`, `security.remote_settings.intermediates.enabled`, `extensions.update.enabled`, `extensions.systemAddon.update.enabled`, `network.captive-portal-service.enabled`, `network.connectivity-service.enabled`, setting `security.notification_enable_delay` to `0`, `security.webauthn.related_origin_requests_mode` to `1`, and enabling `focusmanager.testmode`.
- `real-defaults`: starts BiDi or Marionette with `remote.prefs.recommended` set to `false` in `user.js`, preserving Gecko's real default preferences. Observed on Zen Twilight 1.25t, `security.fileuri.strict_origin_policy` remains `true` (and the other recommended overrides above are not applied). Checks that probe `file://` or default browser security policies must ask for `real-defaults`.
- `none`: launches the browser with no `-marionette`, no `--remote-debugging-port`, no `devtools.debugger.remote-enabled`, no `remote.active-protocols`, and no `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`, optionally passing CLI `urls` directly so a check can test an untouched browser process.

## Process-tree ownership and orphan cleanup

On Linux and macOS the browser spawns as a process group leader and cleanup kills the group (`SIGKILL`); on Windows `taskkill /T /F` ends the tree. Every resource (server, profile directory, browser group, remote socket, and active-launch lease) sits on an `AsyncDisposableStack`. Before each launch, `reapOrphanedLaunches` scans `<tmpdir>/one-click-har-leases/` for leases whose `harnessPid` is no longer alive (such as after an untrappable `SIGKILL` of the harness process), verifies the profile directory is outside live browser profile roots, terminates any remaining browser group matching that PID/profile, and removes the orphaned profile directory.

Browsers run headless unless `--show-window` is passed. The binary must come from `--binary`, `BROWSER_HARNESS_BINARY`, or `GECKO_BINARY` with no platform-specific default. Any profile path resolving inside a live Zen, Firefox, LibreWolf, Floorp, or Waterfox profile root is refused before creation (case-folded on macOS and Windows).
