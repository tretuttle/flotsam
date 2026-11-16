# Redaction

`packages/har/src/redact.ts` removes what a redaction level promises and writes a report of what it kept. Four review rounds failed on one gap: a sentence in the report or the pull request said more than the code did. So no sentence about what a level does is written by hand.

## The tables are the only source

`HAR_MODEL_FIELD_TABLE` gives every string-holding field of the HAR model one or more places, and `HAR_MODEL_NUMBER_FIELD_TABLE` lists every field HAR 1.2 types as a number or boolean. Both are keyed by types derived from `model.ts`, so a new field without a row is a type error. `HAR_PLACE_TABLE` gives each place its status at each level and a short label. The redaction code can only record a removal for a place the field's row lists, also checked at compile time.

The report is built from those tables and the rules in force: each place's label, fields, status and `canStillHold`, the `guarantee` with one clause per status, and `remainingRisk`. A place selected by rules (`selectedBy`) names the header, query or parameter names the rules select, and falls to "kept without examining" under `standard` when no rule selects it. `redact-report.test.ts` parses the guarantee back into places and fails when a clause names a place the tables do not give that status, or when a place listed as removed still holds its planted marker. Copy the level description for a pull request or the glossary from a report, never from memory.

## What the report may carry

Records and `_harExport.redactedFields` name a removal by model field path, place, rule id and count. They never carry a value, a header name, a query name or a custom key, because a level can remove those, and copying them into the report would publish what was removed.

## Decisions

- A header is on the default list when its value is a credential or a proof signed for one request: `DPoP` (RFC 9449) and `Signature` (RFC 9421) are listed. `Digest`, `Content-Digest` and `Repr-Digest` hold a hash of the body and are not.
- `_harExport` is this product's own annotation. Body source and body-state notes are the `export-annotation` place: kept under `standard`, removed under `shareable`. An earlier run's `redaction` report and `redactedFields` list are `redaction-record`, replaced at both levels. Unknown keys under `_harExport` are custom fields, like unknown `_` fields from other tools: kept under `standard`, removed under `shareable`.
- `standard` rebuilds every object in its own key order and changes only removed values, so a document with nothing to remove comes back byte for byte. It writes nothing into `comment` fields.
- The summarizer never reads a redaction report from the document, because any file can carry one. The caller passes the report `redactHar` returned.
