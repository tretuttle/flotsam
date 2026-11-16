# Glossary: Export

- **HAR export.** An HTTP Archive 1.2 file built on demand from DevTools capture, background recording, or both, with any missing bodies reported.
- **Standard redaction.** The default redaction level (`standard`). It removes the values its rules name as credentials, redaction records from an earlier run, and values whose JSON type does not match the model, and leaves every other value, and the order of keys, as it was. The report it writes lists exactly what it removed and what it kept without examining; see [Redaction](../redaction.md).
- **Shareable redaction.** The allowlist redaction level (`shareable`). It keeps only the places its table marks `kept-by-allowlist` and removes every other place. The report it writes lists both.
- **Missing-body state.** The per-entry state recorded in `_harExport` and counted by `@one-click-har/har/summarize`: a body that is missing, with its reason, or incomplete (`bodyIncomplete`), with the reason its first part was all that was stored. An incomplete body never counts as present.
- **Body window.** The 3 MiB of a body the export reads before writing any of it. A body that ends inside it is written in one piece and its encoding is decided on all its bytes; a longer response body streams as base64, and a longer request body is cut short at the window.
- **Cut-short body.** A body whose first bytes are in the file and whose rest is not. Its comment says how many bytes are present and why, from `CUT_SHORT_REASONS`.
- **Unpaired item.** A source item whose `ExchangeId` key is `null` (such as a DevTools entry without a `resourceId`); it cannot join across sources and is written once and counted in the report.
- **Non-network row.** A source listing entry whose URL scheme is outside `http:` and `https:` (`data:`, `blob:`, `about:`); counted by scheme in the report and excluded from `entries`.
