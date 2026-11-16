# Glossary

The words the code and the product use, one line each. Each change adds the terms it introduces.

## Product and people

- **One-Click HAR.** A Zen and Firefox extension that saves a complete HAR of any tab in one click. No DevTools needed, and it includes what already happened.
- **Gecko browser.** Zen, Firefox Nightly, Firefox Developer Edition, or an unbranded build or fork that does not force add-on signing, so it can load an experiment API.
- **User.** The person running One-Click HAR in their browser under their own Windows account.
- **Trent** (`tretuttle`). The maintainer. Decides stack questions and approves agent-context budget increases.

## Processes and principals

- **Parent process.** The Gecko process that runs browser chrome and privileged code. One-Click HAR records and stores captures here.
- **Content process.** A Gecko process that runs web pages. It holds no One-Click HAR data.
- **Principal.** The Gecko security identity attached to running code, which decides what that code may reach.
- **System principal.** The principal of browser chrome code. It passes every security check. The experiment API parent script runs with it.
- **`moz-extension` principal.** The principal of an extension's own pages and background script, scoped to its `moz-extension://` origin.
- **Content principal.** The principal of a web page, scoped to that page's origin.
- **Experiment API.** A WebExtension API that an unsigned or privileged extension declares itself. Its parent script runs with the system principal in the parent process, and only the declaring extension can call it.

## Capture and export

- **DevTools capture.** The request list inside an open DevTools Network panel, exported directly without the built-in panel save dialog.
- **Background recording.** The always-on, low-cost parent-process capture of requests and response bodies, used when DevTools was not open.
- **HAR export.** An HTTP Archive 1.2 file built on demand from DevTools capture, background recording, or both, with any missing bodies reported.
