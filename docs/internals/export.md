# Export

`packages/export` turns the background recording and any open DevTools capture into one streamed HAR 1.2 document. Like `packages/recording`, its `tsconfig.json` gives `src/` no DOM or Node types (`AbortSignalLike` is structural), so a browser or Node global in source is a type error.

## Merging the two sources

- Pairing joins strictly on `ExchangeId` (`<run>.<channelId>`). Channel ids repeat across browser restarts, so keying without the run pairs a DevTools item with an older run's line; a 50 ms time-window fallback paired 22 of 59 requests wrongly in `proto-pairing`. Items without a key stay unpaired and appear once per source.
- `FIELD_RULES` in `merge.ts` is a mapped type over `HarEntryField` (derived from `@one-click-har/har/model`), so adding a model field without a rule fails typecheck. Related fields (`request-head`, `response-head`, `timings`) come whole from one source via `FIELD_GROUPS`, so an entry never mixes one source's status with another's headers or timings from two clocks.
- `bodyPlan` tries the recording's stored bytes first and DevTools second. When neither has a candidate, the recording's reason wins except `not-recorded`, which yields to DevTools' more specific state (such as `devtools-truncated` or `empty`).

## Streaming, redaction, and traps

- Entries stream one at a time in three parts (`entryHead`, body chunks, `entryTail`) with `"pages"` written after `"entries"`. Opening the first working body candidate happens before `entryHead` is written so an unreadable candidate falls through to the next or becomes a missing-body entry without leaving torn JSON.
- `response.content.size` counts decoded bytes as they pass through the encoder, not `encodedBodySize`, because a gzipped body's wire length is smaller than its decoded text.
- If a body fails after its first chunk or was capped at `first-part` (`over-body-cap`), the written bytes remain, `entryTail` sets `_harExport.bodyIncomplete: true` and `bodyState: "unavailable"`, and `@one-click-har/har/summarize` counts it as incomplete rather than present.
- `WrittenUrl` and `WrittenBody` are branded types produced only by `RedactPort`. `pageFor` accepts only `WrittenUrl`, preventing a navigation URL secret from leaking into `log.pages[].title` after entry redaction. Small JSON and form bodies up to `REDACT_BODY_MAX` (1 MiB) are buffered for `RedactPort.body`; larger or unparsed bodies stream unbuffered and are listed under `notScanned`.
- Non-network URLs (`data:`, `blob:`, `about:`) are excluded by `classifyUrl` and counted in `report.notNetwork`, because `har-to-k6` 0.13.0 rejects an entire archive containing one while still exiting 0.
- `parseExportRequest` accepts only `"har"` packaging until compressed packaging formats are measured. Export jobs never add files to the browser's Downloads list.
