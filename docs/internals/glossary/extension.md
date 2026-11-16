# Glossary: Extension

Terms introduced by the extension contract, engine, and host wiring go here.

- **API contract.** The typed table in `apps/extension/experiment/contract.ts` that lists each experiment API function with its parameters and result type. The build generates `schema.json` from it, and the extension pages and the parent script typecheck against it.
- **Toolbox.** A DevTools instance attached to one tab. When a toolbox is open, its Network panel holds that tab's requests.
