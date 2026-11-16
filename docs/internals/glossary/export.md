# Glossary: Export

- **HAR export.** An HTTP Archive 1.2 file built on demand from DevTools capture, background recording, or both, with any missing bodies reported.
- **Standard redaction.** The default redaction level (`standard`) that removes structurally defined credential carriers (`Cookie`, `Set-Cookie`, `Authorization`, `Proxy-Authorization`, listed secret header and parameter names, cookie values, and URL userinfo) and reports every other place as `kept-not-examined`.
- **Shareable redaction.** The allowlist redaction level (`shareable`) that keeps only methods, status codes, timings, sizes, MIME types, host names, URL paths, header names, and allowlisted non-secret header values, and removes all bodies, query values, fragments, cookies, unlisted header values, redirects, page titles, comments, cache metadata, initiators, WebSocket messages, and custom fields.
- **Missing-body state.** The per-entry reason recorded in `_harExport` and counted by `@har-anytime/har/summarize` when a response body is absent or incomplete (`bodyIncomplete`).
