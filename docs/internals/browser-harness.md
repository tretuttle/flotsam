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

Every decision about a signal is a pure function over data in `src/signal-policy.ts`: `decideSignal` (an ordered table of refusal rules: an ID `<= 1`, the harness, its parent or its process group, a group the target does not lead, an ownership record not minted by `spawnOwned` or a verified lease, or a start time or profile path that no longer matches), tree membership, the stop state machine (`SIGTERM` to the tree, `SIGKILL` at `1500 ms`, give up at `5000 ms`, never a core-dump signal), and `decideLease`. `decideSignal` is the only issuer of a `SignalOrder`, and the host performer in `owned-process.ts` redeems an order (single use, refused unless issued) before its one `process.kill`; Windows uses `taskkill /T` instead (not observed on Linux). Liveness comes from the process table (`/proc`; one `ps` or `Win32_Process` listing on macOS and Windows, not observed on Linux), so nothing sends signal 0. Once a root has exited, its process group is no longer trusted, because its ID could belong to a reused PID: only processes naming the profile directory are stopped.

Stopping, reaping and profile removal take a `ProcessIo`. Tests pass `src/simulated-process-io.ts`, a fixed process table whose `perform` redeems orders exactly like the host and records them, so the whole chain (refusals, membership, escalation timing, cross-process reaping) is proven with no process and no signal on every machine and in CI.

By default (`suppressCoreDumps` enabled), Linux launches wrap the browser with `prlimit --core=1:1 --` when `prlimit` is on `PATH` so crashing or aborted browsers skip `systemd-coredump` (`RLIMIT_CORE = 0` still triggers core-pipe handlers here); macOS (`ReportCrash`) and Windows (`WER`) launch unwrapped and are not observed on Linux. Child exit watchers report on `exit` with a `100 ms` bounded stderr drain so descendants holding stderr cannot delay failure reporting, and unexpected post-connect socket closes attach the browser's exit status and stderr tail.

Before each launch, `reapOrphanedLaunches` scans a `0700` per-user lease directory (`one-click-har-leases-<uid>`) of `0600` version-2 leases recording PID, process start time (Linux `/proc/<pid>/stat` field 22), and exact profile path. A lease only authorizes a stop when its harness is gone and its browser still has the recorded start time and profile path; otherwise the stale lease and profile are cleared without a signal. A failed reap keeps the lease, records `reapFailures` and `lastReapFailure`, and retries on the next launch, so a transient failure never leaks a browser for good. Any profile inside a live Zen, Firefox, LibreWolf, Floorp, or Waterfox profile root is refused before creation.

## Tests that can send a signal

`scripts/signal-reach.ts` parses the repository and follows static imports from every function to `process.kill`, a `.kill()` call, or a spawned kill command; a dynamic import it cannot follow counts as reaching any module of its own package. `pnpm run check` fails, printing the path, when a test outside a `*.namespace.test.ts` file can reach one, or when a namespaced file does not call `requireIsolatedPidNamespace()` first.

The root Vite config runs `*.namespace.test.ts` files only inside the namespace that `src/namespace-isolation.test.ts` starts with `unshare --user --map-current-user --pid --fork --mount-proc`. Its launcher refuses unless it is PID 1, and each file refuses unless PID 1 is that launcher, a host process the outer run named is invisible, and every visible process descends from the launcher. Where the namespace is refused, the suites skip with a warning on a developer machine and fail under `CI`. GitHub's Ubuntu runner refuses one through AppArmor (`write failed /proc/self/uid_map`), so both workflows set `kernel.apparmor_restrict_unprivileged_userns=0` first. Also tried on the runner: `sudo unshare` works but runs the suites as root, and a container job has its own PID namespace but refuses `unshare` inside it.
