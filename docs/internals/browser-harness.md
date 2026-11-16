# Browser harness

`tools/browser-harness` is the single launcher, fixture server, and proof runner for every Gecko browser. Extension scripts (`verify:browser`, `screenshot:toolbar`) launch through it rather than keeping separate spawn, profile, or shutdown code.

## Check discovery and version oracle

`browser-harness check` discovers every `*.ts` file under `tools/browser-harness/checks/` in sorted filename order and fails if zero checks are discovered or an unknown `--check` filter is requested. `environment` compares `oneClickHar.getEnvironment()` against the browser's own WebDriver session capabilities (`name`, `version`, `buildId`) instead of `application.ini` on disk, waits for `WebExtensionPolicy.getByID(id).active` rather than racing startup, and verifies schema refusals and DevTools open/close state. `restart` installs the XPI, shuts the browser down cleanly, relaunches on the same profile without reinstalling, and verifies the extension stays active. `cost-baseline` runs the rotated three-arm cost check.

## Three-arm cost measurement and baselines

`browser-harness cost` measures `off` (no extension), `extension` (packed XPI installed), and `panel` (Network panel open on the tab before navigation) across the cost pages (`cost-images`, `cost-heavy`, `cost-mixed`). Arms assert their own preconditions before counting (`extension`: active policy and working extension API; `panel`: Netmonitor open and recorded request count >= served count; `off`: neither), trigger GC/CC, and settle at least `2500 ms` until two consecutive `250 ms` parent main-thread windows are at or below `5.0 ms` (capped at `8000 ms`) so fresh-profile startup bursts stay outside the window.

Arms rotate inside each round, round `0` is dropped as warmup, and rounds whose machine load exceeds `25%` CPU or `1`-minute loadavg `max(4, round(cpuCount * 0.25))` are discarded and repeated. Primary CPU is parent main-thread milliseconds from `ChromeUtils.requestProcInfo()` (thread with `tid === pid`) between navigation start and page completion. The budget for `extension` is `off + 0.5 * (panel - off)`. CI runs `--short` (`3` rounds on `cost-images`). Baselines under `tools/browser-harness/baselines/` and `baselines/cost/` are written only when `errors` is `0`.

## Fixture server ground truth

Every non-control response from the fixture server carries a monotonic `X-Seq` header, and the server records a per-sequence SHA-256 (`wireSha256` and `decodedSha256`) alongside a request log. This covers both static pinned fixtures (`src/pinned-responses.ts`) and dynamic or streaming identity fixtures (`/poll`, cancelled 4 MiB download, 304 revalidation, cache hit, 302-to-307 redirect chain, service worker synthesize and passthrough, endless NDJSON stream, refused loopback port, and `Content-Disposition: attachment` download link). Control queries under `/__harness/` do not increment `X-Seq` or enter the fixture request log.

## Launch modes, cache control, and remote protocols

A remote launch uses WebDriver BiDi unless `--protocol marionette` is passed. Closing a tab in Marionette switches back to the initial window handle so subsequent tabs remain valid. Default launch prefs disable the HTTP cache (`browser.cache.disk.enable`, `browser.cache.memory.enable`, `network.http.use-cache`); pass `cache: true` to enable it for 304 and cache-hit checks.

`launchBrowser` accepts a named `launchMode`:

- `recommended` (default): keeps Gecko Remote Agent's recommended preferences (`remote.prefs.recommended = true`). Observed on Zen Twilight 1.25t, this modifies `125` effective preferences (on top of the `22` `LAUNCH_PREFS`), including setting `security.fileuri.strict_origin_policy` to `false`.
- `real-defaults`: sets `remote.prefs.recommended = false` in `user.js` while still applying `LAUNCH_PREFS` and remote-protocol prefs. `security.fileuri.strict_origin_policy` stays `true`.
- `none`: launches with no `-marionette`, no `--remote-debugging-port`, no remote prefs, no `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`, and `stdio: "ignore"` (never opening an unread pipe), optionally passing `urls` directly.

## Process-tree ownership, exit reporting, and orphan cleanup

On Linux and macOS the browser spawns as a process group leader and stop sends `SIGTERM`, waits up to `1500 ms`, and escalates only to `SIGKILL` (never a core-dump signal); on Windows `taskkill /T` then `/T /F` ends the tree. Every resource sits on an `AsyncDisposableStack`. Child exit watchers report on `exit` with a `100 ms` bounded stderr drain so descendants holding stderr cannot delay failure reporting, and unexpected post-connect socket closes attach the browser's exit status and stderr tail.

Before each launch, `reapOrphanedLaunches` scans a `0700` per-user lease directory (`one-click-har-leases-<uid>`) of `0600` version-2 leases recording PID, process start time (Linux `/proc/<pid>/stat` field 22; macOS `ps -o lstart=` and Windows `Win32_Process.CreationDate` are not observed on Linux), and exact profile path. Unparseable leases are ignored; any live process whose start time or command line does not match the lease is left untouched and its stale lease removed; reap failures warn rather than blocking later launches. Any profile inside a live Zen, Firefox, LibreWolf, Floorp, or Waterfox profile root is refused before creation.
