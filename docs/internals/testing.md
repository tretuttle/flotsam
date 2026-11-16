# Testing

Rules for writing tests, and for asking for them in review.

## What to test

- Test behavior that can break: principal and permission boundaries, persistence and file ACL guards, size-threshold decisions, HAR serialization, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, and mock-call mirrors.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test or at each call site.
- In review, ask for a missing test only when it would catch a real regression. Flag a new test that breaks the rules above, and name the fix: fold it into the existing case or table, delete it, or keep one layer.
- Behavior changes in `packages/*` ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, and state bugs get a failing test first, then the fix. Purely visual bugs get before/after captures as their proof and no test.

## Waiting for work

Never wait on sleeps or polling. A test that needs a timeout to pass is wrong.

- No real-clock waits. Await the promise or event that marks the milestone, or use fake timers and advance them.
- No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
- No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
- `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.

## Each workspace keeps its own Vitest cache

`vite.config.ts` sets `test.fsModuleCachePath` to `"node_modules/.vitest-cache"`. The value matches Vitest's documented default, but the line is not redundant. Left unset, Vitest puts the cache in the monorepo root's `node_modules`. Set explicitly, the path resolves against Vitest's `root`, which is each workspace's folder under `vp run -r test`. Those runs are parallel, so a shared folder fails with `ENOTEMPTY` after a lockfile change: one run deletes the cache while another writes to it.
