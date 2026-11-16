# Glossary: Harness

Terms introduced by the real-browser harness, fixtures, and measurements go here.

- **Browser harness.** `tools/browser-harness`: the fixture server, the isolated headless launcher for any Gecko browser, and the `measure`, `baseline` and `har-check` commands later pull requests rerun as proof.
- **Scenario.** A named set of responses one fixture page makes the browser fetch, each with its method, path, status and pinned SHA-256 and length. `har-check` judges a HAR against one scenario.
- **Sample.** One measured page load: from navigation start to the moment the last of the 200 resources finished, as the page reports it.
- **Baseline.** A committed set of samples with no extension installed, named after the machine, browser build and display it ran on. A baseline with a failed run is not written.
- **Remote protocol.** WebDriver BiDi or Marionette. A launch asks for one, and only that listener is started.
