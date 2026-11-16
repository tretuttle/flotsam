# Glossary: Harness

Terms introduced by the real-browser harness, fixtures, and measurements go here.

- **Browser harness.** `tools/browser-harness`: the single isolated launcher for any Gecko browser, the fixture server, and the `check`, `cost`, `measure`, `baseline`, and `har-check` commands.
- **Check.** One `*.ts` file under `tools/browser-harness/checks/` found by file discovery and run by `browser-harness check` and CI.
- **Cost arm.** One of `off`, `extension`, or `panel` (Network panel open), rotated inside each round with round 0 dropped as warmup.
- **Sequence ground truth.** The per-sequence byte length, status, and SHA-256 recorded by the fixture server for every `X-Seq` response, paired with the server's request log.
- **Scenario.** A named set of responses one fixture page makes the browser fetch, each with its method, path, status, and pinned or per-sequence SHA-256 and length.
- **Sample.** One measured page load: from navigation start to the moment the last resource finished, as the page reports it.
- **Baseline.** A committed set of samples (`off` or `panel`, or no-extension `measure`) named after the machine, browser build, and display mode it ran on. Written only when `errors` is 0.
- **Remote protocol.** WebDriver BiDi or Marionette. A launch asks for one, and only that listener is started.
