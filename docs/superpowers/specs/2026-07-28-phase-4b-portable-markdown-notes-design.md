# Phase 4B: Portable Markdown Session Notes

**Status:** Approved design
**Date:** 2026-07-28
**Depends on:** Phase 4A SQLite-backed session notes (PR #8)

## Purpose

Phase 4B moves session note content from SQLite into app-managed Markdown
files without changing the product's one-note-per-session model. The files
are portable and directly inspectable, while Pomodoro Parking Lot remains
the only supported writer during this phase.

This phase also makes Markdown useful inside the app through a compact,
sanitized preview. It does not expand the app into a note library or a
general-purpose Markdown editor.

## Product Decisions

- Each focus session owns at most one independent Markdown file.
- Carrying a note forward copies its content into a new file for the new
  session. The original file is never shared or mutated.
- Files live under the platform-specific Tauri app-data directory in
  `notes/`.
- File contents are exactly the text entered by the user. The app adds no
  heading, front matter, session metadata, or hidden marker.
- Files use UTF-8 without a byte-order mark. Saving does not normalize line
  endings, trim whitespace, or add a trailing newline.
- Markdown files are the sole long-term source of note content.
- SQLite stores note identity, session association, relative file path,
  content hash, and timestamps.
- The app manages writes. Live synchronization with external editors is
  out of scope, but the app must never silently overwrite an external
  change.
- Clearing a note to whitespace removes its file and metadata.
- The notes directory is fixed for Phase 4B. Choosing or relocating it is
  deferred.

## Non-Goals

Phase 4B does not include:

- Named checkpoints or automatic revision snapshots
- Revision comparison or restore
- Multiple notes per session
- Reusable notes shared by multiple sessions
- Note search, tags, folders, or a note library
- A custom notes directory
- Live filesystem watching or external-editor synchronization
- A formatting toolbar, split-pane editor, or rich-text editing
- Markdown import
- Git integration

These boundaries keep the phase focused on establishing a reliable,
portable storage foundation. Checkpoints and revision history are the
intended Phase 4C.

## Storage Architecture

### Ownership boundaries

The existing TypeScript repository remains the frontend persistence
boundary. A small Rust-backed note file store owns:

- Resolving the app-data and notes directories
- Creating directories
- Generating and validating relative note paths
- Reading note files
- Computing content hashes
- Atomic compare-and-write operations
- Staging, restoring, and finalizing file deletion
- Recovering interrupted staged deletions
- Opening the notes directory with the operating system

The frontend never supplies or operates on an arbitrary absolute path.
Rust resolves every stored relative path beneath the canonical notes
directory and rejects traversal outside it.

SQLite operations continue to use the established repository and native
transaction patterns. The existing shared FIFO write queue serializes note
file operations, note metadata changes, session writes, and deletion.

### Directory layout

```text
<app-data>/
├── notes/
│   └── 2026-07-28--project-outline--<full-session-id>.md
└── note-trash/
    └── <operation-id>/
        └── notes/
            └── <original-relative-path>
```

The filename is assigned once, on the first non-empty save, and is never
renamed when the task or session later changes. It contains:

1. The local calendar date of the session start
2. A filesystem-safe task slug, capped at 48 characters
3. The full session UUID for collision resistance

Slug generation must be deterministic and cross-platform safe. It uses
ASCII letters, digits, and single hyphens; unsupported text is removed,
leading and trailing hyphens are trimmed, and the fallback slug is
`session`.

SQLite stores only the path relative to `<app-data>/notes/`.

`content_hash` is the lowercase hexadecimal SHA-256 digest of the exact
UTF-8 bytes stored in the file. Reads hash the same bytes they return,
rather than performing a second filesystem read that could observe
different content.

### SQLite transition

The next schema migration extends `session_notes` with nullable
`file_path` and `content_hash` fields. The existing non-null `content`
column remains temporarily so Phase 4A rows can migrate safely.

The storage states are:

| State | Meaning |
| --- | --- |
| `file_path IS NULL` | Legacy Phase 4A content is still authoritative for this row. |
| `file_path IS NOT NULL` | The Markdown file is authoritative; `content` must be an empty string. |
| No row | The session has no note. |

New or migrated rows with a file path never store a duplicate content copy
in SQLite. A later cleanup migration may rebuild the table without the
legacy `content` column after the file migration has been deployed and
proven, but that cleanup is not part of Phase 4B.

## Data Flows

### Startup and legacy migration

Startup performs staged-deletion recovery before loading notes, then
migrates legacy rows.

For each row whose `file_path` is null and whose legacy content is not
blank:

1. Derive its deterministic relative filename.
2. Encode the legacy string as UTF-8 and atomically write those exact bytes
   to that file without adding or removing content.
3. Read back or hash the committed file.
4. In one SQLite update, store `file_path` and `content_hash` and replace
   `content` with an empty string.

Rows whose legacy content is blank are deleted.

The migration is idempotent:

- A crash before the file rename leaves SQLite untouched.
- A crash after the file rename but before the SQLite update may leave an
  unreferenced file. The next run derives the same path, verifies or
  replaces it with the same legacy content, and completes the metadata
  update.
- A file-write or metadata failure leaves the legacy SQLite content
  authoritative and available for retry.

Migration failures are surfaced without discarding the SQLite fallback.
They do not silently convert a note to empty content.

### Loading

For a file-backed row, the repository reads the Markdown file and returns
its content plus its current hash. The file is the source of truth, so an
external edit made while the app was closed is accepted on load and the
metadata hash is refreshed.

If the referenced file is missing, unreadable, or outside the notes
directory, the app reports a note-file error. It does not display an empty
editor or create a replacement file automatically.

### Saving

Each loaded note keeps an in-memory expected content hash. A save supplies
the expected hash and desired content to the Rust file store.

The file store:

1. Resolves and validates the relative path.
2. Hashes the current on-disk file when one exists.
3. Rejects the write as a conflict when the on-disk hash matches neither
   the expected hash nor the desired content hash.
4. Writes the desired content to a temporary file in the notes directory.
5. Flushes and atomically renames the temporary file over the destination.
6. Returns the new content hash.
7. Updates SQLite metadata only after the file operation succeeds.

If the file was successfully written but the metadata update failed, a
retry is idempotent: when the current file already matches the desired
content, the file operation succeeds and allows the metadata update to be
retried.

Transient I/O and metadata failures continue through Phase 4A's bounded
automatic retries, manual retry action, transition flushes, and
window-close blocking. The previous committed file remains untouched
until atomic replacement succeeds.

### External-change conflict

There is no live filesystem watcher. An external edit made while the app
is open is detected on the next save through the expected-hash check.

A conflict is non-transient and must not consume the normal automatic
retry budget. The user's in-memory edit remains intact and the UI offers:

- **Reload file:** replace the editor content with the current file after
  explicit confirmation that the in-memory edit will be discarded.
- **Keep my version:** explicitly force an atomic write of the in-memory
  content over the external version.

Neither choice occurs automatically.

### Carry-forward

Starting the next session still flushes and finalizes the reviewed
session's note first. When carry-forward is selected:

1. Use the finalized old note content.
2. Create a new note identity and deterministic path for the new session.
3. Atomically write a separate Markdown file.
4. Store metadata associated only with the new session.

Failure uses the same pending-save and retry behavior as an ordinary new
note. The old session's file and metadata are never modified.

### Clearing a note

Whitespace-only content means no note. Clearing a note:

1. Stages its existing file under `note-trash/`.
2. Deletes its `session_notes` row.
3. Finalizes removal of the staged file.

The operation uses the same recovery rules as session deletion. The UI
does not retain or render an empty note entry.

### History and export

History continues to flush pending note work and drain the shared write
queue before reading. It loads file-backed content through the repository,
then passes the same `SessionSummary` shape to history and export.

Markdown and JSON export behavior remains unchanged except that its note
content now originates from files. A missing or unreadable note file makes
the history/export load fail visibly rather than silently omitting content.

## Deletion And Recovery

SQLite and the filesystem cannot participate in one atomic transaction.
Deletion therefore uses same-volume staging plus idempotent startup
recovery.

### Single session or cleared note

1. Invalidate pending saves for the affected session.
2. Atomically rename the note file into
   `note-trash/<operation-id>/notes/<original-relative-path>`.
3. Commit the existing SQLite deletion transaction.
4. Remove the staged operation directory.

If the SQLite transaction fails, restore the file before reporting
failure.

On startup, each staged relative file is compared with SQLite metadata:

- If a row still references the original path and the original file is
  absent, restore the staged file.
- If no row references the path, finish deleting the staged file.
- If both original and staged files exist, preserve the referenced
  original and remove the stale staged copy only after verifying it is not
  authoritative.

### Delete all data

The shared write queue and note invalidation first stop pending writes.
The app atomically moves the complete notes directory into one staged
operation directory, commits the existing delete-all SQLite transaction,
then removes the staged directory and recreates an empty notes directory.

If SQLite deletion fails, the staged notes directory is restored. Startup
uses the same metadata-based rule to finish or roll back an interrupted
operation.

File cleanup failures remain visible and retry on startup; the app must
not claim complete deletion while note files remain in staging.

## Editing And Preview

The existing session note surface gains an **Edit / Preview** segmented
control.

- Edit is the default.
- Edit reuses the current autosaving textarea and its focus/blur behavior.
- Preview occupies the same constrained dimensions as the editor to avoid
  shifting the timer, parking lot, or review controls.
- The control appears during active focus, paused focus, flow, and session
  review.
- Break mode continues to hide the note surface.
- History renders the same sanitized Markdown presentation without editing
  controls.

Supported preview syntax includes paragraphs, headings, emphasis, lists,
blockquotes, fenced and inline code, and links. The renderer:

- Disables or removes raw HTML
- Rejects unsafe URL schemes such as `javascript:`
- Allows only explicit safe schemes such as `https:`, `http:`, and
  `mailto:`
- Opens allowed links through the system browser after a deliberate click
- Never executes scripts or loads embedded remote media

The preview styling follows the existing calm, compact visual language.
It uses readable spacing and code treatment without introducing a nested
card, oversized headings, or a separate document-editor layout.

An **Open Notes Folder** command appears with History's export and
data-management actions. It opens only the canonical app-managed notes
directory and accepts no arbitrary path from the frontend.

## Error Handling

Errors are classified so the UI can offer the correct recovery:

| Error | Behavior |
| --- | --- |
| Transient file or SQLite failure | Keep the edit pending; bounded automatic retry, then manual retry. |
| External-change conflict | Stop automatic retries; offer Reload file and Keep my version. |
| Missing or unreadable file | Preserve metadata; disable destructive autosave and offer retry/open-folder actions. |
| Legacy migration failure | Keep SQLite content authoritative and retry later. |
| Staged deletion cleanup failure | Keep the operation recoverable, report incomplete deletion, and retry at startup. |
| Markdown rendering failure | Show escaped plain text rather than unsafe or blank output; editing remains available. |

No error path should convert unavailable content into an empty successful
save.

## Security And Privacy

- All note storage remains local and works offline.
- Rust canonicalizes and bounds every note path beneath app data.
- Temporary and staged files remain beneath app data on the same volume.
- No shell command is used to write, delete, or open a note.
- The notes-folder opener receives no user-controlled path.
- Markdown raw HTML and embedded remote media are disabled.
- Preview links use an allowlist and explicit user action.
- Note content and absolute paths are excluded from production logs.
- Tauri capabilities remain limited to the exact native commands and
  opener behavior required by this phase.

## Testing Strategy

### Rust tests with temporary directories

- Deterministic, collision-safe filename generation
- Rejection of traversal and absolute paths
- Atomic create and replacement
- Previous-file preservation on pre-rename failure
- Idempotent success when desired content already matches disk
- External-change conflict detection
- Missing and unreadable file behavior
- Staging, restore, final deletion, and startup recovery
- Delete-all directory staging and recovery
- Folder creation and empty-note cleanup

### Repository and migration tests

- Phase 4A content migrates byte-for-byte
- Empty legacy rows are removed
- A file failure leaves legacy SQLite content authoritative
- A metadata failure after file creation completes on retry
- File-backed reads ignore the legacy content column
- Carry-forward creates a distinct file and row
- Clearing, single-session deletion, and delete-all affect only their
  intended files and rows
- History and export receive file-backed note content
- Memory and Tauri repositories preserve matching behavior

### Frontend tests

- Edit/Preview mode state and stable content handoff
- Markdown syntax rendering
- Raw HTML removal and unsafe-link rejection
- Safe-link handling
- Conflict errors bypass automatic retry and preserve the editor draft
- Reload and force-overwrite resolution paths
- Missing-file errors never become empty saves

### Validation

Before the phase is considered complete:

- `npm test`
- `npm run check`
- `npm run build`
- `cargo check`
- `cargo test`
- `git diff --check`
- Manual Tauri migration from a real Phase 4A database
- Manual restart, carry-forward, clear, delete, delete-all, conflict, and
  Open Notes Folder checks
- Manual visual pass at compact and normal window sizes

## Acceptance Criteria

1. Existing Phase 4A notes migrate automatically without content loss.
2. New and migrated notes survive restart and render correctly in Edit,
   Preview, review, history, and export.
3. Every non-empty session note has one authoritative Markdown file and no
   duplicate content in SQLite.
4. Carry-forward creates an independent file for the new session.
5. Clearing, per-session deletion, and delete-all remove the intended
   files without affecting unrelated notes.
6. Interrupted migration, save, and deletion operations recover safely.
7. External file changes are never silently overwritten.
8. Missing or unreadable files are reported and never treated as empty
   notes.
9. Open Notes Folder opens the canonical app-managed directory.
10. Preview renders supported Markdown while blocking raw HTML, unsafe
    links, script execution, and remote embedded media.
11. The app remains offline-capable and existing timer, parking-lot,
    history, export, deletion, and tone behavior remains unchanged.
