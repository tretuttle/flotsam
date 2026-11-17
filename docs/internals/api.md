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
- The file goes to the chosen folder or the browser's Downloads folder, through `guardFolder`, as `<name>.har.part`. A line in the archive's `exports.jsonl` names the part before its first byte and again when it is renamed or deleted; the next start deletes every part with no end line (crash row 13). Only `.har.part` paths are ever taken from the journal.
- A refused write is the only failure. It is `write-failed`, and when the volume's free bytes are below what the refused write needed it is `disk-full` with both numbers, whatever the error text said. The part is deleted.
- Cancel aborts the run's signal, which `runExport` reads before every body chunk, so at most one chunk (4 MiB of base64) and one sink batch are written after it.
