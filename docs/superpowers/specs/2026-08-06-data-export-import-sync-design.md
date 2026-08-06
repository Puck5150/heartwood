# Data Export/Import (Cross-Device Sync) Design

**Status:** Approved by user, pending spec self-review and write-up review.

## Goal

Let a user carry their Heartwood data (sessions, Greenhouse thoughts, settings,
notes, note revision history, trash) between devices used one at a time, by
exporting a full snapshot into a folder they already have synced via
Dropbox/Google Drive/OneDrive/etc., and importing that snapshot on another
device. Heartwood never talks to any cloud provider's API directly — it only
ever reads/writes plain files in a folder the user picks; whatever already
syncs that folder (their existing sync client) does the rest.

## Non-Goals

- **Live/continuous sync.** No background upload, no watching the folder for
  changes, no "always in sync" behavior. Export and Import are explicit,
  user-triggered actions.
- **Concurrent multi-device use.** The design assumes Heartwood runs on one
  device at a time. No locking, no conflict resolution between two live
  writers — Import always wholesale-replaces local data (after a safety
  backup), it never merges.
- **Direct cloud provider API integration.** No OAuth, no Google
  Drive/Dropbox/Microsoft Graph API calls. The user's own sync client (if
  any) is entirely out of scope for Heartwood to know about.
- **Redirecting the live database to the synced folder.** The app's normal
  local app-data directory remains the only location the running app ever
  reads/writes during a session. The synced folder only ever holds a static
  snapshot copy, written by Export and consumed by Import.

## Architecture

A new **Sync** section in Settings (below the existing Updates section,
same `settings-section` pattern as `SettingsDrawer.svelte`'s Updates section
added for the manual update-check button) with two actions:

- **Export to...** — opens a native folder picker (`tauri-plugin-dialog`,
  already a dependency), defaulting to the last-used path if one is
  remembered. Copies the entire local app-data folder (the SQLite DB file,
  the `notes/`, `note-trash/`, and note-revisions directories — everything
  under the app-data root) into a `Heartwood-sync/` subfolder of the chosen
  directory, overwriting whatever was there before.
- **Import from...** — opens the same kind of folder picker, defaulting to
  the last-used path. Looks for a `Heartwood-sync/` subfolder inside the
  chosen directory and validates it looks like real Heartwood data (contains
  the expected DB filename) before touching anything. If valid: backs up the
  current local app-data folder to a timestamped sibling folder, copies the
  snapshot over the local app-data folder, then prompts the user to restart
  the app (reusing the existing restart mechanism from
  `tauri-plugin-process`, already wired up for the auto-updater's
  `updateController.svelte.ts`).

The last-used folder path (the *parent* directory the user picked, not the
`Heartwood-sync/` subfolder itself) is remembered as a plain setting in the
existing `settings` table/`settingsController.svelte.ts`, so a second
Export or Import is a single click without re-browsing.

## Data Covered

Everything under the app-data root: the SQLite database file (`pomodoro.db`,
checkpointed to a single consistent file before copying — see Technical
Note below, so no separate WAL/SHM handling is needed), the `notes/`
directory, `note-trash/`, and the note-revisions directory that
`NoteFileStore` already manages (`src-tauri/src/note_files.rs`). This is a
straight recursive directory copy — the same shape of operation
`legacy_data_migration.rs`'s `copy_dir_recursive` already performs for the
identifier-rename recovery, reused/adapted here rather than reinvented.

**Technical note — WAL mode:** `tauri-plugin-sql`'s underlying `sqlx` SQLite
pool defaults to WAL journal mode, which splits the database across
`pomodoro.db`, `pomodoro.db-wal`, and `pomodoro.db-shm`. A directory copy
taken mid-session (Export while the app is running) could copy the main
file and WAL file out of sync with each other. Export must checkpoint the
WAL (`PRAGMA wal_checkpoint(TRUNCATE)`) immediately before copying, so the
snapshot is always a single consistent `pomodoro.db` file with no pending
WAL data left behind.

## Export Flow

1. User clicks "Export to...", picks a folder (or accepts the remembered
   one via a one-click "Export to `<remembered path>`" affordance).
2. App runs `PRAGMA wal_checkpoint(TRUNCATE)` on the live DB connection.
3. App recursively copies the app-data root into
   `<chosen>/Heartwood-sync/`, overwriting any existing contents there.
4. On success: brief confirmation message in the Sync section (mirrors the
   "You're up to date." pattern from the manual update-check button).
5. On failure (folder not writable, disk full, picker cancelled): error
   message in the same spot; local data is never touched by Export, so
   there is nothing to roll back.

## Import Flow

1. User clicks "Import from...", picks a folder (or accepts the remembered
   one).
2. App looks for `<chosen>/Heartwood-sync/` and validates it contains the
   expected DB filename. If missing or invalid: error message, nothing
   touched.
3. App backs up the current local app-data folder by renaming it to a
   timestamped sibling (e.g. `app-data-backup-2026-08-06T143000/`) — never
   deleted, matching this project's standing rule against destructive
   operations without a safety net.
4. App copies `<chosen>/Heartwood-sync/` into the now-vacated local
   app-data path.
5. App prompts the user to restart, reusing the existing relaunch mechanism
   already built for the auto-updater.
6. On any failure before step 5 completes: abort without having renamed
   away the original local folder (or restore it if the rename already
   happened), so a failed Import never leaves the user with no usable data
   directory.

## UI

Settings → new "Sync" section, following the existing settings-section
convention:

```
SYNC

Export your data to a folder (e.g. inside Dropbox, Google Drive, or
OneDrive) to carry it to another device, or import a previously exported
folder here.

[Export to...]  [Import from...]

<status message area, same role="status" pattern as the Updates section>
```

Import additionally needs a confirmation step before executing (since it
overwrites local data, even with a backup) — a simple native confirm
dialog or an inline expandable confirm following the same
`.row-confirm`/`.row-confirm-text` pattern already established in
`History.svelte` and reused in `Greenhouse.svelte`'s delete flow.

## Error Handling

- Folder picker cancelled: no-op, no message.
- Export target not writable / disk full: error message, local data
  untouched.
- Import target missing/invalid `Heartwood-sync/` folder: error message,
  nothing touched.
- Import failure mid-copy: original local data is restored from the backup
  rename rather than left half-overwritten.

## Testing

- Rust: unit tests for the new directory-copy-with-WAL-checkpoint command
  and the backup-then-adopt command, covering the missing-source,
  invalid-source (no DB file), and successful-copy cases — same style as
  `legacy_data_migration.rs`'s existing tests.
- Svelte: component tests for the new Sync settings section (button
  states, confirm-before-import flow, status messages) following the same
  patterns established in `SettingsDrawer.test.ts` for the manual
  update-check button.
- Manual: a real Tauri run exporting to a temp folder and importing it back
  (or into a second local profile) to confirm the round trip actually
  restores identical data, per this project's standing rule that
  interactive/native-integration changes get a live Tauri check, not just
  unit tests.

## Out of Scope / Deferred

- Real-time or background sync.
- Any provider-specific API integration.
- Merge-on-import (Import is always wholesale replace-with-backup).
- Automatic export-on-quit (considered and explicitly declined in favor of
  manual buttons only, for predictability).
