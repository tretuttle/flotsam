# Glossary: UI

Terms introduced by the popup, history, and options pages go here.

- **Popup view.** One screen of the toolbar popup, a variant of the `PopupView` union in `apps/extension/src/popup/view.ts`: `ready`, `custom`, `exporting`, `done`, `error-write`, `error-store`, `empty-tab`, `empty-private`, `no-tab` or `api-missing`. The reducer moves between them and returns API calls as commands; the store runs the commands.
- **Ready-made export.** One of the popup's four rows (this tab, this tab recent, this site, everything recorded), built from `PRESETS` with the count and "up to" size the API's `getPopup` reports. One click on a row starts its export.
- **Footer choices.** The two toggles under the rows, response bodies and removing secrets, which apply to every row and to Custom. They start from the export defaults in settings.
- **Custom export.** The popup view that builds a selection from a scope, a time range, a request filter and a file name, checks it with `parseSelection`, and counts it with `preview` before the export starts.
- **Missing-body group.** One line of the result: a count of bodies not in the file for one reason from `MISSING_REASONS` or `CUT_SHORT_REASONS`, with a link to the setting that changes it where the table names one. Bodies left out by the footer choice are listed but not counted as missing.
- **No-tab view.** The popup on a tab it cannot use, such as Zen's empty tab (id -1). Only the rows that need no tab are offered.
- **Blocking recording problem.** A `RecordingProblem` that means nothing is being recorded (`archive-refused`, `archive-unwritable`); it shows the `error-store` view instead of the rows. Other problems show as a warning line above the rows.
- **Session.** A stretch of one site's activity with no gap longer than 30 minutes (`SESSION_GAP_MINUTES`), as `listSessions` returns it. The history page lists sessions by site; ticked sessions of any sites export as one file through the `sessions` selection.
- **History page.** `src/pages/history/`: sites on the left, the chosen site's sessions on the right, and a selection bar whose "Export as one file" is disabled while nothing is ticked. Excluding a site from it asks once, in place.
- **Settings section.** An element of the options page whose id is a `SettingsSection`. Every popup settings link opens one; the options page keys its section table by that type, so a link with no section fails typecheck. `export-holding` and `unreadable-files` explain a retention problem and say what the user can do.
