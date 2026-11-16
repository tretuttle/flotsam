# Glossary: Processes and principals

- **Parent process.** The Gecko process that runs browser chrome and privileged code. One-Click HAR records and stores captures here.
- **Content process.** A Gecko process that runs web pages. It holds no One-Click HAR data.
- **Principal.** The Gecko security identity attached to running code, which decides what that code may reach.
- **System principal.** The principal of browser chrome code. It passes every security check. The experiment API parent script runs with it.
- **`moz-extension` principal.** The principal of an extension's own pages and background script, scoped to its `moz-extension://` origin.
- **Content principal.** The principal of a web page, scoped to that page's origin.
- **Experiment API.** A WebExtension API that an unsigned or privileged extension declares itself. Its parent script runs with the system principal in the parent process, and only the declaring extension can call it.
