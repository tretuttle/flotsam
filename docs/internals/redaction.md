# Redaction

`packages/har/src/redact.ts` removes what a redaction level promises and writes a report of what it kept. Review rounds kept failing on one gap: a sentence in the report or the pull request said more than the code did. So no sentence about what a level does is written by hand.

## One table, every key

`model.ts` derives `HarModelField`, every key of every model interface at any depth, by walking the types from `HarLog` and `HarEntry`; a type already on the path (the initiator stack's `parent`) is not walked again. `HAR_MODEL_FIELD_TABLE` has exactly one row per key, whatever its type: the value kinds, the places, the value a required field takes when its value is removed, and for containers where their own fields are listed. Type checks in `redact.ts` fail when a key has no row, or when a row's kinds, item kind or removal value disagree with the model type. Five rounds found a field a narrower table missed (strings only, then `_harExport` strings, then numbers, booleans and nested Chrome types); one table over every key leaves nothing between tables.

A value whose JSON type is not the one its row gives is removed at both levels, recorded under `wrong-type`, and replaced by the row's removal value when the field is required. The removal value is itself checked against the model type. A request URL that is no longer a valid URL once its parts are removed is replaced by `https://redacted.invalid/` and recorded the same way; no redaction path puts an input value back. Counting is by place: every present value counts once, including `null` and the empty string, so a custom `_port: 443` or a cookie's `expires: null` is counted when kept and recorded when removed.

## Userinfo is found by scanning, not by parsing the outer URL

Rounds 5 and 6 each found URLs whose credentials survived because the redaction parsed the outer URL and did not recognise its shape: first URLs with no authority, then URLs inside wrappers such as `blob:`, `view-source:` and `jar:`. `redactEveryUserinfo` therefore never looks at the outer scheme. It finds every `scheme://` in the text, raw or percent-encoded to any depth, reads the authority up to the next `/`, `?`, `#`, backslash or space, and removes everything before the authority's last `@`. A wrapper nobody has named yet, a URL nested three deep, or a URL carried in another URL's path, query or fragment is handled the same way, at both levels. Request URLs and page titles both pass through it. `isHarUrl` also checks the URL inside a wrapper, so `blob:https://user@/x` is not a valid URL.

The report is built from `HAR_PLACE_TABLE`, which gives each place its status at each level and a label, from the field table, and from the rules in force: each place's label, fields, status and `canStillHold`, the `guarantee` with one clause per status, and `remainingRisk`. A place selected by rules (`selectedBy`) names the header, query or parameter names the rules select, and falls to "kept without examining" under `standard` when no rule selects it. `redact-report.test.ts` parses the guarantee back into places and fails when a clause names a place the tables do not give that status, or when a place listed as removed still holds its planted marker. Copy the level description for a pull request or the glossary from a report, never from memory.

## What the report may carry

Records and `_harExport.redactedFields` name a removal by model field path, place, rule id and count. They never carry a value, a header name, a query name or a custom key, because a level can remove those, and copying them into the report would publish what was removed.

## Decisions

- A header is on the default list when its value is a credential or a proof signed for one request: `DPoP` (RFC 9449) and `Signature` (RFC 9421) are listed. `Digest`, `Content-Digest` and `Repr-Digest` hold a hash of the body and are not.
- `_harExport` is this product's own annotation. Body source and body-state notes are the `export-annotation` place: kept under `standard`, removed under `shareable`. An earlier run's `redaction` report and `redactedFields` list are `redaction-record`, replaced at both levels. Unknown keys under `_harExport` are custom fields, like unknown `_` fields from other tools: kept under `standard`, removed under `shareable`.
- `standard` rebuilds every object in its own key order and changes only removed values, so a document with nothing to remove comes back byte for byte. It writes nothing into `comment` fields.
- The summarizer never reads a redaction report from the document, because any file can carry one. The caller passes the report `redactHar` returned.
