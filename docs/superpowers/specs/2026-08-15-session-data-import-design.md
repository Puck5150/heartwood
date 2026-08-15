# Session Data Import (.md / .csv) Design

**Status:** Approved by user, pending spec self-review and write-up review.

## Goal

Let a user restore session history from a file Heartwood itself exported
(History → Export → Markdown/CSV) — e.g. after reinstalling, moving to a
new machine, or recovering an old backup — by importing that file back in,
merged into whatever local data already exists.

## Non-Goals

- **Importing data from other tools.** Only Heartwood's own export format is
  supported. A `.md`/`.csv` file from another app is not a target — no
  format-guessing or column-mapping UI.
- **Whole-database/folder sync.** This is not a substitute for backing up
  notes, settings, or note-revision history — only the data already covered
  by History → Export (sessions, parked thoughts, project tags). No file
  copying, no wholesale replace.
- **Merging conflicting edits.** Import never overwrites anything that
  already exists locally (see Merge Behavior) — there is no field-level
  conflict resolution to design.
- **Importing pre-v4 exports.** Files exported before this feature shipped
  can't be read back losslessly (see Format Changes) and are rejected with
  a clear message, not best-effort parsed.

## Format Changes (Export Format Version 3 → 4)

Both export formats change so they can be read back with full fidelity.
`export.ts`'s `EXPORT_FORMAT_VERSION` bumps from `3` to `4`.

- **CSV:** gains a version marker as its first line — `Heartwood Export,4`
  — before the blank line and `Sessions` section. `formatExportAsCsv`
  currently has no version stamp anywhere in its visible output (only the
  in-memory `ExportData.version` field, which the CSV renderer never
  prints), so without this line `parseImportedCsv` would have no way to
  distinguish an old file from a new one. `completedAt` and parked-thought
  `createdAt` switch from `formatDateTime`'s locale-formatted text (`Aug
  15, 2026, 2:30 PM` — locale-dependent, minute precision only, not
  reliably parseable) to `new Date(ms).toISOString()`. Still
  human-readable, now exactly round-trippable. Every other CSV column is
  already a raw number or string and needs no change.
- **Markdown:** gains one hidden block at the very top of the file, before
  the `# Heartwood Export` heading:

  ```
  <!-- heartwood-export-data
  {"version":4,"exportedAt":...,"sessions":[...],"parkedThoughts":[...]}
  -->
  ```

  The JSON inside is exactly the `ExportData` object `buildExportData`
  already produces — no separate serialization to design or maintain. HTML
  comments are invisible in every markdown renderer (GitHub, editors,
  `MarkdownPreview.svelte`), so the human-readable prose below is
  unchanged. This is simpler and less fragile than embedding structured
  data per-session inline in the prose (no header-text matching, no
  per-field prose parsing).

- Old files (version < 4, or missing the hidden block / still using
  locale-formatted CSV dates) are rejected outright with a message
  explaining they predate import support — never best-effort parsed. A
  best-effort parse of a locale-formatted date string is exactly the
  silent-data-loss risk the user chose to avoid when picking full fidelity
  over both formats.

## Import Mechanics

### Parsing

- `import.ts` (new module, pure — no DOM/Tauri, mirrors `export.ts`'s own
  separation): two functions, `parseImportedMarkdown(content: string)` and
  `parseImportedCsv(content: string)`, both returning
  `{ data: ExportData } | { error: string }`. Markdown extracts and
  `JSON.parse`s the hidden comment's contents; CSV checks the first line
  for the `Heartwood Export,4` marker, then re-parses its own two sections
  (reversing `formatExportAsCsv`) into the same `ExportData` shape. Any
  missing block, malformed JSON, `version !== 4`, missing/mismatched CSV
  version line, or structurally invalid CSV returns a specific `error`
  string — never throws, never partially returns data.
- All parsing and validation completes before any database write. A
  rejected file writes nothing.

### Writing (all-or-nothing at parse time; per-row skip during write)

Runs against whatever's already loaded (`summaries`, `parkedThoughts`,
`projects` in `History.svelte`) plus new repository calls. New repository
functions needed in all three files (`tauriRepository.ts`,
`memoryRepository.ts`, `repository.ts` dispatcher — matching the existing
three-file pattern):

- **Sessions**, matched by `id` against existing rows:
  - Already present locally → skipped entirely (no session/note write, no
    project resolution for it).
  - Not present → a new repository function (e.g. `insertImportedSession`)
    inserts a `sessions` row directly — bypassing `serializeSessionState`
    and the live timer state machine entirely, since an imported session
    was never "in progress." Only the columns `History`'s own
    `toSessionSummary` actually reads get real values: `id`, `task`,
    `status='complete'`, `completed_at`, `planned_focus_ms`,
    `actual_focus_ms`, `flow_ms`, `took_break`, `break_ms`,
    `break_intermission_ms`, `touch_grass_ms`, `total_elapsed_ms`,
    `updated_at` (import time). `review_acknowledged_at` is set to the
    import timestamp immediately on insert — this is what guarantees the
    row can never be picked up by `recoverSessionState` as a live review
    screen if it ever becomes the most-recently-updated row (that check
    happens before `deserializeSessionRow` is ever called, so the
    machine-only columns like `started_at`/`focus_completed_at` are safe to
    leave `NULL` — nothing reads them for a row in this state; confirmed
    by the schema itself, which already has a migration test inserting a
    session with only `id, task, status, updated_at` populated). This
    keeps `project_id` out of the insert too, matching the standing
    boundary that `project_id` is only ever set via the dedicated
    `updateSessionProject` UPDATE, never through session-row writes.
- **Parked thoughts**, matched by `id`: a new function (e.g.
  `insertParkedThoughtIfAbsent`, `INSERT ... ON CONFLICT(id) DO NOTHING` in
  the Tauri backend) rather than reusing `insertParkedThought` — that
  existing function is a plain `INSERT` used by the live app where an id
  collision is a real bug worth throwing on; import needs collision to be
  the expected, silent-skip case instead.
- **Notes:** only written for sessions that were newly inserted this
  import (via the existing `saveNote`) — never for a session that already
  existed locally, so import can never clobber a local note edit.
- **Projects:** for each newly-inserted session with a non-null
  `projectName` in the export, resolve against the locally-loaded
  `projects` list by exact `name` + `categoryLabel` match. No match →
  create one (existing `insertProject`, or the equivalent in whichever
  repository is active) with that name/category, then add it to the
  in-memory list so later sessions in the same import can match against it
  too. Once resolved (found or created), tag the session via the existing
  `updateSessionProject` — never by writing `project_id` directly in the
  session insert.
- Sessions/thoughts/projects/notes are written in that dependency order
  (projects resolved and sessions inserted before notes/project-tag
  writes, since both need the session row to exist first).

### Result Reporting

Import returns a summary object (counts, not full row data) that the UI
turns into one message: `"Imported 42 sessions, 3 parked thoughts. 5
already existed and were skipped. 2 new projects created."` A file that
parses but contains nothing new still reports success with all-zero counts
(distinct from a parse/version error, which reports failure and writes
nothing).

## UI

`History.svelte`'s existing export row (`.export-row`, currently
"Export: Markdown / CSV / Notes folder") gains an "Import" link in the
same row, opening a native file picker via `@tauri-apps/plugin-dialog`'s
`open` (filtered to `.md`/`.csv`, mirroring the existing `save` dialog
`exportMarkdown`/`exportCsv` already use) and reading the chosen file with
`@tauri-apps/plugin-fs`'s `readTextFile`. In browser-dev mode (non-Tauri,
same `isTauri()` branch the export flow already uses), falls back to a
hidden `<input type="file">` + `FileReader`, matching the existing
Tauri/browser split rather than introducing a new pattern.

- Success: result summary shown in the same `role="status"` area
  `exportError` already occupies (renamed/generalized to a general
  `importExportStatus`, or a parallel `importResult` state — implementer's
  call, following whichever keeps the template simplest), and the
  session/parked-thought/project lists visible in `History.svelte` refresh
  from the repository so newly-imported data appears immediately without
  requiring a manual reload.
- Failure (wrong version, corrupt file, dialog cancelled): dialog-cancelled
  is a silent no-op (matches Export's own cancel handling); every other
  failure shows the specific `error` string from the parser in the same
  status area Export's own errors use.

## Testing

- `import.ts`: pure unit tests for both parsers — valid round-trip (build
  export data, format it, parse it back, assert deep equality minus the
  fields format changes on purpose), version rejection (missing/mismatched
  `Heartwood Export,4` line for CSV, `version !== 4` in the JSON for
  Markdown), malformed JSON in the Markdown comment, missing the hidden
  comment entirely, structurally broken CSV (missing section, missing
  header row).
- Repository layer: tests for `insertImportedSession` (fresh insert,
  id-collision skip, `review_acknowledged_at` always set) and
  `insertParkedThoughtIfAbsent` (fresh insert, id-collision skip) in both
  `tauriRepository`-equivalent Rust/SQL tests (if applicable — matching
  however `saveSession`'s existing SQL is tested) and `memoryRepository.ts`.
- `History.svelte`: component tests for the Import button flow — success
  summary message, project auto-creation, existing-session skip, note
  written only for new sessions, error message for a rejected file,
  cancelled-dialog no-op — following the same patterns already established
  for the Export tests in this file.
- Manual: a real Tauri run — export from one profile's data, import into a
  fresh/different local DB, confirm sessions/thoughts/projects/notes all
  land correctly and re-importing the same file a second time is a no-op —
  per this project's standing rule that interactive/native-integration
  changes get a live Tauri check, not just unit tests.

## Out of Scope / Deferred

- Importing non-Heartwood `.md`/`.csv` files.
- Importing pre-v4 Heartwood exports.
- Whole-database/folder sync (a prior, unimplemented design for this —
  `2026-08-06-data-export-import-sync-design.md` — covered a different,
  wholesale-replace mechanism; that spec was retired as stale in favor of
  this narrower, merge-based feature).
- Per-conflict manual resolution UI (skip-existing is the only merge
  policy).
