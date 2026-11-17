# Extension API and the export host

Extension pages call one API, `browser.oneClickHar`, defined by one table in `apps/extension/experiment/contract.ts`. The experiment host runs it in the parent process with the system principal. Pages hold the `moz-extension` principal and get counts, rows and job states back: no file path, body byte or HAR text crosses in either direction. Content principals reach nothing.

## One table, a parser on every parameter

- Every parameter carries its own parser, and `createOneClickHarApi` runs `parseArguments` before any handler, in every host. Gecko's schema checks the experiment host's integers too, but the standard host's port has none, so the parser is the check that always runs. Object parameters are `any` in the generated `schema.json` and checked only by their parser: `getPopup({ tabId: -1 })` is refused by the parser, `getEnvironment(-1)` by the schema first.
- `contract.test.ts` walks every row's parameter and result types and fails typecheck when a key that holds a path, folder, text, content or HAR, or a byte array, appears at any depth. A key under an index signature is walked too: `string` keys swallowed a planted `folder.path` until the walk skipped them.
- Pages may import only `experiment/contract.ts`; a lint override on `apps/extension/src/**` refuses the rest.

## Tab ids are states

`tabManager.get` throws for tab 0, a closed tab, an unknown id and a private tab this add-on may not see. The host looks a tab up once and turns any throw into `no-such-tab`, so `getEnvironment` and `getPopup` answer every parsed id with a state. `{ tabId: null }` is the popup's own "no tab" (Zen's empty tab reports -1).

## Counts and exports read the same lines

- The activity index is filled at startup from every valid segment summary, after recovery summarized earlier runs, and then from each batch of lines the store appends. Both the popup and an export flush the store twice first: a file body's line joins a batch only after its rename, which runs on the write chain after the first flush was queued. The popup's count for a preset therefore equals the entries the export writes, live captures included.
- An export reads the segments `segmentsFor` names, keeps the lines `inSelection` accepts, and adds the recorder's live captures as in progress. Bodies are read from packs and body files in 3 MiB chunks; a stored wire encoding is undone by Gecko's own converters (`gzip`, `deflate`, `br`, `zstd`), so `content.size` is the decoded size.

## The file

- One export runs at a time, and it keeps running after the popup closes. `listExports` keeps this run's ten newest jobs.
- The file goes to the chosen folder or the browser's Downloads folder, as `<name>.har.part` renamed to `<name>.har`. A line in the archive's `exports.jsonl` names the part before it is created and again when it is renamed or deleted; the next start deletes every part with no end line (crash row 13). Only `.har.part` paths are ever taken from the journal.
- Every file call goes through `exportFiles` in `export-file.ts`; `geckoExportPlatform` in `host.ts` holds the only raw calls. A replaced path cannot redirect a write, because the export never opens a path twice:
  - The folder is judged by its real path. A folder that is a link, or whose real path is inside or contains the profile, the archive or a known substitution, is `folder-refused`, before anything is created in it. A missing folder is created, then judged again.
  - The part is created exclusively (`PR_EXCL`: anything at the name, a dangling link included, is `name-taken` and the next number is tried), and every byte goes through that one handle. A part replaced mid-export, by a link, a regular file or a hard link to `prefs.js`, receives nothing; one round appended 143 MB into `prefs.js` through a link while writing by path.
  - Before the rename, the folder must still be that real folder and the part a regular file, not a link, of exactly the bytes written and starting with them; otherwise `file-replaced`. A same-size file with the same first 64 bytes would pass; nothing reads the whole file back.
  - The rename never overwrites: a taken name moves on to `<name> (2).har`. A collision is decided by the rename and the exclusive create themselves, not by a check before them.
- A refused call is the only failure, as a `WriteFailure` kind from `FS_ERROR_KINDS`, keyed by the identifier the platform gives (an IOUtils `DOMException` name or an XPCOM nsresult name). Each name in the table is produced by a cause `export-failures` makes happen for real; a name no cause produces has no row and comes back `other`. A full disk is `disk-full` with both numbers whenever the volume had fewer free bytes than the call needed. Gecko's own Downloads helper falls back to the system Downloads folder when the configured one fails, so the matrix names each row's folder in `settings.json`.
- A failure is a fixed kind and numbers, with no text field. A platform error's message names the export folder and the profile (`jar:file://<profile>/extensions/...`), and the failure crosses to the `moz-extension` principal; one round sent both in `{ kind: "other", detail }`. `contract.test.ts` fails typecheck if any failure field reachable from `listExports` is not a number or its kind is not a fixed word.
- Cancel aborts the run's signal, which `runExport` reads before every body chunk, so at most one chunk (4 MiB of base64) and one sink batch are written after it.
