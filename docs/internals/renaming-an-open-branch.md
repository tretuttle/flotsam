# Renaming an open branch

The code was renamed from the retired product name to One-Click HAR in one sweep, and `pnpm run rename:check` in `check` fails any pull request that brings the old name back. A branch cut before the sweep still uses the old name in its code, file names and package scope, so it fails that check and conflicts with `main`.

To bring such a branch along:

1. Run `pnpm run rename:fix` on the branch. It rewrites file contents and moves files with `git mv`, and a second run changes nothing.
2. Run `pnpm install` to regenerate `pnpm-lock.yaml`, which the script leaves alone.
3. Commit the result.
4. Rebase onto `main`. The renames are already in your commit, so only real conflicts remain.

`pnpm run rename:check` lists every remaining occurrence with its file and line. The replacement table lives in `scripts/rename-identifiers.ts`; add a row there if a new spelling turns up. `.audit/` is never touched, because its rows are history.
