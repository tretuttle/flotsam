# Glossary: Extension

Terms introduced by the extension contract, engine, and host wiring go here.

- **API contract.** The typed table in `apps/extension/experiment/contract.ts` that lists each experiment API function with its parameters, each parameter's parser, and its result type. The build generates `schema.json` from it, and the extension pages and the parent script typecheck against it.
- **Host.** What runs the API's handlers after their arguments are parsed. The experiment host runs in the parent process; the standard host will run in a background script.
- **Export job.** One export the host runs, listed by `listExports` with its state: writing, done, cancelled or write-failed.
- **Export journal.** `exports.jsonl` in the archive. It names each `.har.part` before its first byte and again when it is renamed or deleted, so the next start deletes a part a crash left.
- **Toolbox.** A DevTools instance attached to one tab. When a toolbox is open, its Network panel holds that tab's requests.
