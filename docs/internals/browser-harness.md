# Browser harness

`tools/browser-harness` is the proof tool. A weakness here weakens every later proof, so these decisions are deliberate.

## A sample ends when the last resource finished

A sample runs from navigation start to the last of the 200 page resources finishing: stylesheet applied, script executed, image loaded, JSON body read. The page records each finish with `performance.now()` and reports the latest. Navigation `loadEventEnd` was used before. It excludes the 50 fetches that can end after the load event, and it reads 0 while the load event is still running.

A run that fails is kept in `failures` with its reason and counted in `errors`. The command exits 1 when any run failed. A run also fails when the server did not see exactly the scenario's requests, including an extra request or a resource the page never finished. `baseline` writes a file only when `errors` is 0.

## Baselines compare only like with like

A baseline file is named after platform, architecture, CPU count and model, browser name, version, build ID and headless or window. The same fields are inside the file, and a test fails if the name and contents disagree, if any run failed, or if a summary is missing. Compare two baselines only when their names match except for the capture, and when `sampleDefinition` matches.

## One launch, one remote protocol

A launch uses WebDriver BiDi unless `--protocol marionette` is passed. The process starts only that listener, so the choice does not depend on which port opens first. Marionette returns script results as `{value: ...}`. Closing a tab switches the session back to the window it started on, so the next tab still has a browsing context.

## Expected bytes are pinned, not computed

`src/pinned-responses.ts` holds the SHA-256 and length of every response, measured with curl and coreutils `sha256sum` against the running server. `har-check` and the tests compare against these constants. A digest table computed at run time from the generator agrees with the generator even when the generator is wrong. Changing a fixture means changing its pin in the same commit.

## The harness owns a whole process tree

On Linux and macOS the browser is spawned as a process group leader, and cleanup signals the group. Zen 1.25t and 1.24.2b on Linux put every child process (forkserver, content, socket, utility) in that group, observed with `ps -g`. On Windows `taskkill /T` walks parent links instead, so a child whose parent already died is not reached there. Every acquired resource, the fixture server, the profile directory, the browser group and the remote socket, sits on one disposable stack, so a failed launch or an interrupt releases all of it.

Browsers run headless unless `--show-window` is passed. The binary is always an input (`--binary` or `BROWSER_HARNESS_BINARY`). A profile directory inside a live Zen or Firefox family profile root, listed per platform in `BROWSER_PLATFORMS`, is refused. The temporary directory is checked, including the path it resolves to, before a profile directory is created. macOS and Windows compare those paths without case.
