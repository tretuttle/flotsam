# Flotsam

Flotsam is an always-on, low-overhead recorder for Gecko browsers: Zen, Firefox Nightly, Firefox Developer Edition, and unbranded builds or forks that do not force add-on signing. It keeps each response body at or above a size threshold, keeps metadata for every other response, and exports HAR files later. Stored data is readable only by the user's own Windows account and by system-principal code.

Trent (`tretuttle`) maintains it and decides stack questions. The repository setup is modeled on T3 Code (`pingdotgg/t3code`) and `parkpal-monorepo`. When you are unsure how to structure something, read how they do it and copy the pattern.

## Security boundaries

Use these words exactly. The [Glossary](docs/internals/glossary.md) defines each one.

- **Parent process and content processes.** Gecko runs browser chrome and privileged code in the parent process and web pages in content processes. Recording and storage happen in the parent process.
- **System principal.** The experiment API parent script runs with the system principal in the parent process. Only the extension that declares the experiment API can call it. It is the only code that reads or writes stored captures.
- **`moz-extension` principal.** Extension pages and the background script run with the `moz-extension` principal. They reach stored data only through the experiment API.
- **Content principal.** Web pages run with a content principal in a content process. Nothing Flotsam stores or exposes is reachable from a content principal.

A change that moves data or code across one of these boundaries says so in its pull request.

## Stack

Decided, and changed only by the maintainer:

- One pnpm monorepo. Node and pnpm are pinned in `package.json` (`engines`, `packageManager`) and `mise.toml`.
- `apps/extension` is the browser extension, built with extension.js. It declares the experiment API and ships its parent script.
- `packages/*` holds pure domain logic shared by the extension and the experiment API parent script, such as the size threshold decision and HAR serialization. No browser globals and no barrel files; export subpaths.
- `oxlint-plugin-flotsam` holds the custom lint rules and their tests. `scripts` holds repository checks.

## Repository rules

- `main` only accepts pull requests whose `Check` job passed. Never push to `main` or weaken a check to get green.
- Work on a branch or worktree off `main`. Open no drafts and leave nothing unpushed.
- Do not commit plans, research notes, scratch files, or captured browser data.
- `.audit/` holds decision trails. Add rows; do not rewrite or delete existing ones.
- No emoji or em dashes in product copy. `flotsam/no-emoji` and `flotsam/no-em-dash-copy` enforce it in app and package source.
- Every tool runs through a package script or `pnpm exec`. Do not assume a global `vp`.
- Never change global configuration (mise, npm, git) or switch package managers to get past an error. Language runtimes stay in `mise.toml`.

## Where things are written down

A tool's own memory is not a store here. What must outlive the session goes in one of these:

- What is being built next: GitHub issues. The pull request that lands the work closes its issue.
- A decision and its reason: `docs/internals/`, in the pull request that acts on it.
- A term or product noun: `docs/internals/glossary.md`.
- A lesson about working here: a check first (a lint rule, a test, a CI step), and a line in this file only when no check can hold it.

`notes.md` at the repository root is gitignored scratch on one machine. Move anything durable out of it before calling work done.

## Verifying

- `pnpm install` is the only setup step. It installs the pre-commit hook, which runs format, lint and knip on staged files.
- `pnpm run check` runs everything CI runs: format, lint, knip, typecheck, tests, and the agent-context budget.
- One piece at a time: `pnpm run lint`, `pnpm run typecheck`, `pnpm run knip:check`, or `pnpm exec vp test run <files>`.
- `typecheck` runs `effect-tsgo tsrs --noEmit` per package, the native TypeScript 7 checker. There is no `typescript` package to run.
- Test rules are in [Testing](docs/internals/testing.md).
- Lint suppressions and `@ts-expect-error` need a reason: end the directive with `-- reason` or put a comment on the line above. `flotsam/require-suppression-reason` enforces it, and unused suppressions are errors.
- `flotsam/no-low-value-comments` caps a comment at four lines and rejects ones that restate the code.
- `flotsam/no-unreasoned-state-sync` reports every React effect; one that stays states its reason with `// oxlint-disable-next-line flotsam/no-unreasoned-state-sync -- <why>`.
- `flotsam/namespace-node-imports` requires `import * as NodeFS from "node:fs"` style imports for Node built-ins.

## Documentation

Most code changes do not need a documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it.
- Do not document every feature, enumerate fields or methods, narrate control flow, or append PR summaries.
- When a documented decision changes, rewrite or remove the affected text. Do not append another account of the new behavior.

## Agent setup

- This file is the only instruction file in this repository; `CLAUDE.md` points to it. `Check` fails a pull request that makes either file larger than on `main`, so rewrite before adding. Only a maintainer's request justifies the `agent-context-increase` label. Do not add per-harness copies (`GEMINI.md`, `.cursor/rules`, `.codex/`, `.grok/`).
- `.claude/settings.json` only turns Claude's own memory off here, so Claude sessions use the stores above like every other tool.
