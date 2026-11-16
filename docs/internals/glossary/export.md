# Glossary: Export

- **HAR export.** An HTTP Archive 1.2 file built on demand from DevTools capture, background recording, or both, with any missing bodies reported.
- **Standard redaction.** The default redaction level (`standard`). It removes the values its rules name as credentials, redaction records from an earlier run, and values whose JSON type does not match the model, and leaves every other value, and the order of keys, as it was. The report it writes lists exactly what it removed and what it kept without examining; see [Redaction](../redaction.md).
- **Shareable redaction.** The allowlist redaction level (`shareable`). It keeps only the places its table marks `kept-by-allowlist` and removes every other place. The report it writes lists both.
- **Missing-body state.** The per-entry state recorded in `_harExport` and counted by `@one-click-har/har/summarize`: a body that is missing, with its reason, or incomplete (`bodyIncomplete`), with the reason its first part was all that was stored. An incomplete body never counts as present.
- **Written value.** A `WrittenUrl` or `WrittenBody` value produced only by the export's redaction port so page titles and small bodies reach the sink only after redaction has run.
- **Unpaired item.** A source item whose `ExchangeId` key is `null` (such as a DevTools entry without a `resourceId`); it cannot join across sources and is written once and counted in the report.
- **Non-network row.** A source listing entry whose URL scheme is outside `http:` and `https:` (`data:`, `blob:`, `about:`); counted by scheme in the report and excluded from `entries`.
