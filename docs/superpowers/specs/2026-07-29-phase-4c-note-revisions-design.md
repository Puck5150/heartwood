# Phase 4C: Seamless Note Revisions

**Status:** Approved design
**Date:** 2026-07-29
**Depends on:** Phase 4B portable Markdown notes (PR #9)

## Purpose

Phase 4C adds trustworthy revision history to the existing one-note-per-
session model. It gives users quiet automatic snapshots, one-click manual
checkpoints, readable comparisons, and a reversible restore flow without
turning Pomodoro Parking Lot into a general document manager.

The timer remains independent of navigation. A user may inspect history,
compare revisions, and restore a note while a focus timer continues to run.
Timer completion remains audible and actionable without forcing the user
out of the view they are using.

## Product Decisions

- The current Markdown file remains the sole authoritative current note.
- Revisions are immutable Markdown snapshots managed by the app.
- Revision metadata lives in SQLite; revision content lives in app-managed
  files.
- Snapshot files are content-addressed within each session.
- Identical content creates at most one revision per session.
- Automatic snapshots happen only at meaningful session boundaries.
- A manual checkpoint is one click and receives a timestamp-based default
  label. Naming is optional and can happen later.
- A selected revision can be viewed as a unified line comparison or as a
  rendered Markdown preview.
- Restore always has an inline final confirmation.
- Before destructive content replacement, the displaced content is saved
  as a safety revision when it is non-empty and not already represented.
- Clearing a non-empty current note first saves its verified content as a
  safety revision.
- Restore never changes timer state, parked thoughts, session metrics, or
  the current workspace view.
- The desktop app enforces one running process. A second launch focuses the
  existing window instead of creating a second persistence queue.
- Clearing the current editor removes the current note file but retains
  its revisions. Deleting the session or all data removes those revisions.
- Revisions have no automatic retention limit in Phase 4C. They are small
  text files and remain until their history or owning session is deleted.

## Non-Goals

Phase 4C does not include:

- Git repositories, commits, branches, or Git interoperability
- Periodic snapshots while the user types
- A snapshot for every autosave, pause, or resume
- User-configurable snapshot schedules or retention policies
- Cross-session shared revision objects
- Multiple current notes per session
- Revision merging or conflict resolution
- Side-by-side editing
- Rich-text diffing
- Search across revision content
- Importing revision history from external files or applications
- Editing a historical revision in place
- Deleting individual revisions
- Exporting revision history; existing Markdown and JSON exports continue
  to contain the current note only
- Exposing the internal revision-object directory through Open Notes
  Folder; that command continues to open only portable current notes
- Native tray, global-shortcut, or background-timer work planned for
  Phase 5

## Experience Model

### Persistent timer

The full timer remains the visual center of the main focus workspace. When
the user opens History or Revisions during an active focus, pause, flow, or
break state, it becomes a compact persistent strip above that workspace.

The compact strip shows:

- Current task
- Countdown or elapsed time
- Current mode
- Pause or resume when the state supports it
- The existing finish action

Changing `workspaceView` must not mount, unmount, reset, or otherwise own
the timer state machine. The top-level session state, wall-clock update,
deadline detection, and alarm playback continue independently of the
visible workspace.

If focus expires while History or Revisions is open:

1. Play the selected alarm exactly once using the existing completion
   behavior.
2. Keep the current workspace visible.
3. Replace the compact timer state with a persistent completion notice.
4. Offer Break, Flow, and Finish actions directly from that notice.

Choosing an action updates the session state without forcing navigation.
The user can return to the main workspace explicitly.

When there is no active timer, History and Revisions use the normal app
header without an empty timer strip.

### Navigation

Navigation is workspace-level, not timer-level:

- **Focus** returns to the current session, review, break, decision, or
  setup screen.
- **History** opens completed session history.
- **Revisions** opens revision history for a selected session note.

The Session Notes toolbar exposes a History icon button that opens
Revisions for the current session. Each completed session with note
content or revisions exposes the same action in History.

Opening an old session's revisions while another session is timing is
allowed. The revision view identifies the note by task and session date so
the user cannot confuse it with the active task shown in the timer strip.

### Revision browser

The revision browser uses two regions:

1. A chronological revision timeline, newest first
2. A comparison area for the selected revision

Each timeline entry displays:

- Custom label when one exists
- Otherwise a friendly reason such as `Session complete`,
  `Review finalized`, `Checkpoint`, or `Before restore`
- Timestamp
- A secondary type label: `automatic`, `checkpoint`, or `safety`

The newest revision is selected by default. Selection does not write data.

Opening Revisions starts a background flush when the loaded editor belongs
to the target session, then loads that session's last committed note,
expected content hash, and revision metadata through the shared queue.
Opening an old session does not replace the active session's editor state.

The comparison area provides a segmented **Changes / Preview** control:

- **Changes** is the default and shows a unified line diff from the
  selected revision to the current note. Removed lines belong to the
  revision; added lines belong to the current note.
- **Preview** renders the selected revision through the existing sanitized
  Markdown preview pipeline.

Diffing uses the maintained `diff`/jsdiff library rather than a custom
line-diff algorithm. The UI must remain usable with long lines, Unicode,
empty content, and files without a trailing newline.

Line-ending-only changes remain visible rather than being normalized away.
The comparison header identifies each side's detected `LF`, `CRLF`, or
mixed line endings, and a missing final newline is rendered with the
conventional `No newline at end of file` marker. Hashes and restores always
use original bytes; comparison presentation never changes stored content.

To avoid blocking the webview on pathological externally edited files,
the app does not run an inline diff when either side exceeds 512 KiB of
UTF-8 content or 10,000 lines. It also skips Markdown rendering for that
revision. Changes and Preview instead show an escaped plain-text excerpt
capped at 32 KiB with a truncation status. Metadata, restore, and refresh
actions remain available, and no unbounded parser work runs on the timer's
webview thread.

### Manual checkpoint

The current note surface has a checkpoint icon button with a tooltip. It is
available during focus, pause, flow, and review.

Activation:

1. Flush the current note through the existing save controller.
2. Create a revision from the committed file.
3. Keep the user in the current workspace.
4. Show brief non-blocking feedback.

The default presentation is `Checkpoint` plus its timestamp. No naming
dialog interrupts capture. From the revision browser, **Rename** changes
the selected revision's optional label inline. Enter or blur saves; Escape
cancels. Labels are trimmed, limited to 80 Unicode characters, and
normalize to null when empty.

If the note is empty, checkpoint is disabled. If the same content already
exists as a revision for that session, creation is a successful no-op and
the UI reports `No changes since the last revision`.

### Restore

Restore is a deliberate two-step action:

1. The user selects and inspects a revision.
2. **Restore this revision** reveals an inline confirmation.

The confirmation offers **Cancel** and **Confirm restore**. It is not a
native dialog or `window.confirm()`. Its detail reflects the loaded current
state:

- Non-empty current content not yet represented: `Your current note will
  be saved as a safety revision first.`
- Non-empty content already represented: `Your current note is already
  preserved in revision history.`
- No current note: `This revision will become the current note.`

On success:

- The selected content becomes the current Markdown note.
- The current editor and any loaded History summary for that session are
  refreshed.
- The revision list remains open with a success status.
- The selected historical revision remains immutable.
- The prior current content is represented by a `Before restore` safety
  revision when needed.
- Timer and session state remain untouched.

Restore is disabled when selected content already matches the current
note.

## Snapshot Policy

Phase 4C creates revisions for these events:

| Event | Type | Condition | Default label |
| --- | --- | --- | --- |
| Carried note committed for a new session | Automatic | New session starts with non-empty carried content | `Session started` |
| Session enters review | Automatic | Current note is non-empty | `Session complete` |
| User leaves review to start the next session | Automatic | Note changed since the session-complete snapshot | `Review finalized` |
| User activates checkpoint | Checkpoint | Current note is non-empty and not already represented | `Checkpoint` |
| Before current note is cleared | Safety | Verified current content is non-empty | `Before clear` |
| Before revision restore | Safety | Displaced current content is non-empty and differs from the target | `Before restore` |
| Before app version overwrites an external change | Safety | External file content is non-empty and not already represented | `Before external overwrite` |
| Before reload discards an in-memory app draft | Safety | Draft is non-empty and not already represented | `Before external reload` |

No revision is created for blank or whitespace-only content.

Deduplication is session-scoped by exact SHA-256 content hash. When an
event encounters content whose hash already has a revision row for that
session, the operation reuses that revision and does not create a second
timeline entry. It does not rename or retimestamp the existing entry.

Automatic snapshot failure does not roll back a valid timer transition or
prevent the next session from starting. A small revision-write controller,
modeled on the existing note-save controller, retains the request with its
original session ID, reason, timestamp, exact UTF-8 boundary content, and
expected content hash. Native code recomputes and verifies that hash on
every attempt. The controller uses bounded retry, surfaces a manual retry
after exhaustion, participates in window-close blocking, and supports
per-session/all-session invalidation before and after deletion so a
delayed retry cannot recreate deleted data. A request whose retained bytes
do not match its retained hash is invalid, receives no automatic retry, and
surfaces a blocking integrity error.

Pending automatic intent is process-local in Phase 4C. A normal window
close waits for it, but an operating-system kill or process crash may lose
an event that had not yet created its immutable object. The authoritative
current note remains safe. Filesystem/SQLite operations that did begin are
restart-recoverable; persisting unstarted event intent is deferred.

## Storage Architecture

### Directory layout

```text
<app-data>/
├── notes/
│   └── <current-note>.md
├── note-revisions/
│   └── <session-id>/
│       └── <sha256>.md
├── note-operations/
│   └── <operation-id>/
│       └── manifest.json
└── note-trash/
    └── <operation-id>/
        ├── manifest.json
        ├── notes/
        │   └── <current-note>.md
        └── note-revisions/
            └── <session-id>/
                └── <sha256>.md
```

Revision snapshots contain exactly the note's UTF-8 bytes. They receive no
front matter, generated heading, or embedded metadata. Their lowercase
hexadecimal SHA-256 filename must match the hash of their bytes.

Objects are content-addressed per session rather than globally. This keeps
session deletion and recovery local and avoids a reference-count or
garbage-collection subsystem. Carry-forward still creates independent
notes and independent revision histories.

### Filesystem boundary

The Rust note file boundary adds ownership of `note-revisions/`:

- Create and validate the revision root
- Validate session IDs and 64-character lowercase SHA-256 hashes
- Resolve snapshot paths beneath the canonical revision root
- Reject symlink and traversal escapes
- Atomically create immutable snapshot objects
- Return idempotent success when an existing object matches its hash
- Reject an existing object whose bytes do not match its filename
- Read and re-hash snapshots before returning them
- Stage, restore, finalize, and recover revision deletion
- Atomically create and validate typed operation manifests
- Recover interrupted restores by deterministic roll-forward

The frontend never sends an absolute path. It supplies session and revision
identifiers; Rust derives all filesystem locations.

### SQLite migration

The next migration creates:

```sql
CREATE TABLE note_revisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
        kind IN ('automatic', 'checkpoint', 'safety')
    ),
    reason TEXT NOT NULL CHECK (
        reason IN (
            'session_started',
            'session_completed',
            'review_finalized',
            'manual',
            'before_clear',
            'before_restore',
            'before_external_overwrite',
            'before_external_reload'
        )
    ),
    label TEXT CHECK (label IS NULL OR length(label) <= 80),
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, content_hash),
    CHECK (
        (kind = 'automatic' AND reason IN (
            'session_started', 'session_completed', 'review_finalized'
        ))
        OR (kind = 'checkpoint' AND reason = 'manual')
        OR (kind = 'safety' AND reason IN (
            'before_clear',
            'before_restore',
            'before_external_overwrite',
            'before_external_reload'
        ))
    )
);

CREATE INDEX idx_note_revisions_session_created
    ON note_revisions(session_id, created_at DESC);
```

The SQL checks, Rust enums, and TypeScript unions all enforce the exact wire
values and kind/reason pairings shown above. Native creation also verifies
inside its SQLite transaction that the owning session still exists.
Listing uses `ORDER BY created_at DESC, rowid DESC` so events sharing one
millisecond have a stable insertion-order tie-breaker.

There is no foreign key, matching the repository's existing explicit
deletion model. Session deletion commands must delete revision rows
explicitly in the same SQLite transaction as the session and note rows.

Revision rows store no note content and no absolute or relative path. The
path is derived from validated `session_id` and `content_hash`.

## Data Flows

### Startup

`initializeNoteStorage()` extends its existing recovery sequence:

1. Validate/create `notes/`, `note-revisions/`, and `note-trash/`.
2. Validate/create `note-operations/`.
3. Recover or flag interrupted restore manifests.
4. Recover staged note and revision deletions.
5. Run the existing Phase 4A-to-4B note migration.
6. Verify revision metadata only when its content is requested; startup
   does not read every historical snapshot.

A missing or corrupt snapshot is reported when the affected revision list
or content is opened. It is never converted to an empty revision.

### Create revision

Revision creation runs through the existing shared FIFO write queue.

1. The caller flushes pending current-note work when the requested session
   is the loaded editor session and captures the exact committed content
   plus returned hash at the event boundary.
2. Native code accepts those boundary bytes, recomputes their hash, and
   requires it to equal the request hash. Dedicated clear/restore/conflict
   commands instead obtain their own safety bytes from verified disk or
   staged content.
3. Return no content for blank or whitespace-only input.
4. Hash the exact UTF-8 bytes.
5. When `(session_id, content_hash)` already exists, read and verify its
   snapshot object before returning it. Recreate a missing object from the
   verified request bytes; treat hash-mismatched existing bytes as
   corruption and block the operation.
6. Atomically create and verify the immutable snapshot object.
7. In one SQLite transaction, recheck that the owning session exists and
   insert the revision metadata row.
8. Return the normalized revision record.

An object written before a failed metadata insert is safe but unreferenced.
A later retry uses the same hash path, verifies the existing bytes, and
completes the insert. Startup may leave such an object in place; because
it is immutable and session-scoped, it cannot replace or corrupt current
content. Session deletion and delete-all remove it.

### List and load

Listing revisions reads metadata only. Loading one revision invokes Rust
with its revision ID:

1. Fetch the row.
2. Derive and validate the snapshot path.
3. Read its bytes.
4. Verify the computed hash matches both the row and filename.
5. Return content and metadata.

The repository must not accept a caller-supplied content hash as authority
for an arbitrary read.

History loads revision counts as metadata and adds `revisionCount` to each
session summary. It does not read every snapshot body. A completed session
shows its revision action when `noteContent` is non-empty or
`revisionCount` is greater than zero.

### Automatic trigger orchestration

The session state transition remains immediate and never waits on note or
revision I/O. `applyResult()` detects every transition whose prior status
is not `complete` and whose next status is `complete`, covering Finish
from the decision screen, finish early, finish flow, and end break.

For that transition:

1. Apply the new in-memory timer state immediately.
2. Enqueue the normal session-row persistence.
3. Start/continue the final current-note flush without blocking the timer
   or workspace.
4. After the flush succeeds, enqueue `session_completed` using the
   completion event timestamp, exact committed content, and resulting note
   hash.
5. If the flush or snapshot fails, keep the completed session state,
   preserve pending work in its controller, and surface retry.

When leaving review for a new session, the existing successful old-note
flush remains a prerequisite. The app then enqueues `review_finalized`
with the old session ID, exact committed content, and hash before it
enqueues new-session note work.
Deduplication makes it a no-op when review made no changes. The new timer
may start without waiting for snapshot completion.

When carried content is successfully committed for the new session,
`session_started` is enqueued with that exact carried content and new note
hash. Fresh blank sessions create no start snapshot.

Recovering an already-complete session after startup does not synthesize a
lifecycle snapshot. Existing pre-4C sessions receive their first revision
only at a future defined trigger or manual checkpoint.

### Restore

Restore is one serialized native repository operation after UI
confirmation:

1. Load the selected revision row and verified snapshot bytes.
2. Load the current note metadata.
3. Distinguish `no_note_row` from `note_row_with_file`. Only
   `no_note_row` is a cleared/never-created note eligible for current-file
   creation. A row whose referenced file is missing, unreadable, or still
   legacy blocks restore and uses the existing storage-recovery flow. When
   no row exists, Rust derives the deterministic path and requires it to
   be absent; an unreferenced file at that path is an integrity error, not
   an empty note.
4. Read current content only through that validated state.
5. If current content already matches the target, repair/upsert note
   metadata as needed and return idempotent success before checking the
   old expected hash.
6. Otherwise compare the current hash with the frontend's expected current
   hash and report an external-change conflict instead of overwriting when
   it is stale.
7. If current content is non-empty and differs from the target, atomically
   ensure its snapshot object exists and commit a deduplicated
   `before_restore` revision row.
8. Atomically write the restore-operation manifest.
9. Compare-and-write or create the current note against the same expected
   prior state. A new mismatch returns a fresh external conflict without
   overwriting.
10. Upsert the `session_notes` row and current `content_hash`.
11. Remove the completed manifest.
12. Return the restored note and safety revision metadata.

The safety revision row is committed before the current file is replaced.
Therefore:

- Failure before replacement leaves the current note unchanged.
- Failure during atomic replacement leaves the current note unchanged.
- Failure updating existing note metadata after replacement leaves the
  restored file authoritative and retry remains idempotent.

If the current note is absent, restore derives its deterministic path from
the owning session, creates a new `session_notes` row, and writes the
selected content. Restoring whitespace-only content is impossible because
blank revisions are never created.

Every restore writes an atomic manifest to
`note-operations/<operation-id>/manifest.json` before replacing current
content. The manifest records operation kind, session ID, validated
relative current-note path, prior state (`absent` or prior hash), target
revision ID/hash, safety revision ID when present, and phase. It contains
no note content.

Startup recovery verifies the manifest, session row, target object, current
file, and metadata:

- Current file at the target hash: roll forward the metadata upsert and
  remove the manifest.
- Current file still at the recorded prior hash, or still absent when
  prior state was absent: complete the target write, upsert metadata, and
  remove the manifest.
- Current file at any other hash: preserve every file and revision, leave
  current content untouched, mark/cancel the prepared operation, and
  surface an external-change recovery error.
- Missing/corrupt target object or missing owning session: preserve
  available data and surface a blocking storage error.

This journal closes the cleared-note crash window: a target file can never
remain invisible merely because its first `session_notes` insert failed.
An in-process retry first finds and resumes a matching unfinished manifest
for that session/revision instead of creating a second operation.
If the final compare-and-write detects a late external change, native code
marks the manifest cancelled and removes it. Failure to remove a cancelled
manifest is harmless: startup sees its cancelled phase, performs no note
write, and retries manifest cleanup.

When the expected hash is stale in Revisions, the UI does not reuse the
active editor's Keep/Reload prompt. It reports that the current file
changed and offers **Reload comparison**. Reloading is non-destructive: it
refreshes current content and expected hash while leaving the immutable
target revision selected. A subsequent restore requires a fresh final
confirmation and preserves the newly observed current content as its
safety revision.

### External-change decisions

Phase 4B's conflict choices gain safety snapshots:

- **Keep my version:** invoke one native
  `resolve_external_conflict_keep` operation with the app draft and exact
  disk hash returned by the conflict. Native code re-reads the disk file.
  If that hash changed again, it returns a fresh conflict. Otherwise it
  snapshots those verified bytes as `Before external overwrite`,
  compare-and-writes the app draft against that exact hash without
  `force`, and updates note metadata. If the draft already landed during a
  lost response, it repairs metadata and returns idempotent success before
  creating another safety snapshot.
- **Reload file:** after the existing discard confirmation, snapshot the
  non-empty in-memory draft as `Before external reload` and return the
  verified disk content from one native
  `resolve_external_conflict_reload` operation. The command requires the
  disk hash to still match the reported conflict; a second external edit
  returns a fresh conflict instead of discarding the draft against stale
  information.

If the safety snapshot cannot be committed, the destructive replacement
does not proceed. The user draft and conflict state remain intact.

### Rename

Rename changes only the nullable `label` field in SQLite. It never renames
or rewrites a snapshot file. Rust trims and validates the 80-character
limit as the final authority. Whitespace-only labels normalize to null,
which restores the friendly default reason label.

## Queueing And Concurrency

All current-note saves, revision creation, restore, rename, note loads
that refresh hashes, session deletion, and delete-all operations use the
existing shared FIFO queue. Tauri's single-instance plugin ensures only one
desktop process owns that queue and the app-data mutation boundary. A
second launch raises/focuses the existing main window and performs no
storage initialization or write.

Each editor or revision view tracks the expected current note hash.
Revision restore and external-overwrite commands enforce that expected
hash natively immediately before replacement. A stale UI can therefore
never silently overwrite a newer external change.

Read-only navigation to History or Revisions happens immediately and never
waits for persistence. The app attempts the current-editor flush in the
background and keeps any save error globally visible. Until that flush
succeeds, History and Revisions show committed content, identify that
pending editor changes are not included, and disable checkpoint/restore
actions whose correctness depends on the failed flush. A successful
background flush refreshes the committed comparison.

The timer's wall-clock effect and alarm path never await the persistence
queue. Revision creation from a current file includes the expected hash
captured at its triggering boundary, so a delayed retry cannot silently
snapshot different externally edited content under the old event label.

Write actions that require a failed note flush remain disabled and surface
the existing retry affordance. Read-only navigation and timer controls
remain usable.

## Deletion And Recovery

### Clear current note

Clearing the editor to whitespace continues to remove the current
Markdown file and `session_notes` row. The native clear operation first
atomically stages the current file, then reads and hashes those exact staged
bytes. If their hash does not equal the expected current hash, it restores
staging and returns a fresh conflict. If the live path was recreated before
restore, it preserves both copies and reports the conflict.

After verification, clear creates/commits a deduplicated `before_clear`
safety object from the staged bytes, then inserts/reuses its revision row
and deletes the current-note row in one SQLite transaction before
finalizing staging. Existing deduplicated objects must pass hash
verification before they count as safety. If safety creation or the SQL
transaction fails, the current file is restored and the editor draft
remains pending. Existing revisions remain, so an accidental clear is
recoverable.

The revision action remains available for that session from History when
revisions exist even if the current note is empty.

### Delete revision history

The revision browser offers **Delete revision history** as a secondary
destructive action. It uses an inline final confirmation that explicitly
states the current note and session will remain.

The native operation stages the complete
`note-revisions/<session-id>/` directory under a typed manifest, deletes
that session's revision rows in one transaction, and then finalizes or
restores the staged directory with the same partial-failure rules used by
session deletion. It also invalidates pending revision requests before and
after the queued delete. Future automatic or manual events may create new
revisions normally.

### Delete session

Per-session deletion:

1. Invalidates pending current-note and revision work for that session.
2. Creates one typed staging manifest listing both roots.
3. Stages its current note file when present.
4. Stages its complete `note-revisions/<session-id>/` directory when
   present.
5. Deletes the session, note, and revision rows in one SQLite transaction.
6. Finalizes the staged files.

On database failure, both current note and revision snapshots are restored.
The staging primitive records all intended moves before its first rename.
If any move fails, it immediately rolls back every completed move; a
failed rollback leaves the manifest for startup recovery. Startup restores
all staged entries when owning rows remain and finalizes them when the
transaction's rows are gone. If staged and live paths both exist with
different verified bytes, it preserves both and reports the conflict.

### Delete all data

Delete-all stages both the complete `notes/` and `note-revisions/`
directories under the same typed manifest, with the same all-or-rollback
staging guarantee. It commits deletion of sessions, parked thoughts,
session notes, and note revisions, then finalizes staging and recreates
both empty directories.

Per-session confirmation explicitly includes its current note and revision
history. Delete-all confirmation explicitly includes all current notes and
revision history. Settings, including the selected tone, remain untouched.

## Ownership And Implementation Slices

Phase 4C remains one product phase and may ship as one pull request, but
implementation should land in three internally validated slices:

1. **Persistent workspace shell:** extract compact timer/status controls
   and workspace navigation from `App.svelte`; prove navigation and alarm
   independence before revision UI is added.
2. **Checkpoint/list/compare:** add migration, immutable snapshot store,
   repository contracts, revision controller, timeline, diff, preview,
   rename, counts, and automatic triggers.
3. **Destructive safety:** add before-clear, restore journal, external
   conflict native operations, revision-history deletion, and combined
   deletion recovery.

Expected ownership boundaries:

- `App.svelte`: session orchestration, active workspace, loaded current
  editor, and global status only
- `ActiveTimerBar.svelte` and `WorkspaceNav.svelte`: persistent shell
- `RevisionHistory.svelte`: timeline, compare/preview, rename, restore
  confirmation, and history-delete confirmation
- `revisions.ts`/`revisionDiff.ts`: revision types, labels, and pure diff
  presentation
- `revisionOperationController.ts`: retry, pending status, close blocking,
  and deletion invalidation
- Repository adapters: matching browser-memory and Tauri revision APIs
- `revision_files.rs`: immutable objects, manifests, staging, validation,
  and recovery
- `revision_commands.rs`: typed command DTOs and revision transactions
- `db_commands.rs`: combined session/delete-all row and file operations
- `lib.rs`/Tauri setup: single-instance enforcement and narrowly scoped
  command registration

Detailed revision UI or retry state must not be added directly to the
already-large `App.svelte`.

## Error Handling

| Error | Behavior |
| --- | --- |
| Transient snapshot file or SQLite failure | Keep operation pending; bounded retry, then manual retry and close blocking. |
| Duplicate content | Successful no-op with quiet feedback. |
| Duplicate row with missing snapshot | Recreate from verified source bytes before reporting success. |
| Duplicate row with corrupt snapshot | Block the operation and preserve all source/current content. |
| Stale hash while opening a checkpoint | Preserve all content; use the active editor's existing conflict choices. |
| Stale hash during revision restore | Preserve all content; offer Reload comparison and require a new confirmation. |
| Process exits before an automatic request starts | Current note remains authoritative; no revision event is promised. |
| Interrupted restore/overwrite manifest | Deterministically roll forward when hashes match; otherwise preserve all data and block for recovery. |
| Missing snapshot object | Keep metadata; disable restore and report that revision content is unavailable. |
| Snapshot hash mismatch | Treat as corruption; never preview or restore the bytes. |
| Failed safety snapshot | Do not perform restore, overwrite, or reload. |
| Failed current-file replacement | Keep current note unchanged and safety revision available. |
| Metadata failure after successful restore | File remains authoritative; retry/load refreshes metadata. |
| Rename failure | Keep the prior label and allow retry. |
| Staged cleanup failure | Report cleanup pending and retry at startup. |
| Diff rendering failure | Fall back to escaped selected/current text; Preview remains available. |

No error path treats unavailable revision content as an empty successful
snapshot or restore.

## Visual And Accessibility Requirements

- Follow the approved compact revision-browser mock.
- Keep cards at 8px radius or less; do not nest cards.
- Use existing design tokens and Lucide icons for tool actions.
- Icon-only controls have accessible names and tooltips.
- The unified diff uses more than color: `+` and `-` markers remain visible.
- Added, removed, muted, and focus colors meet readable contrast in light
  and dark themes.
- Timeline, diff, confirmation, and timer strip remain usable at the
  compact Tauri window width and at 320 CSS pixels.
- Long task names, labels, and unbroken note lines wrap or truncate without
  moving timer controls or overlapping adjacent content.
- Keyboard users can reach revision entries, tabs, rename, restore, and
  confirmation in a predictable order.
- Focus returns to the initiating control when restore is cancelled.
- Success and error feedback uses appropriate `role="status"` or
  `role="alert"` behavior without repeatedly announcing timer ticks.
- Reduced-motion preferences are respected.

## Security And Privacy

- All current and historical content remains local and offline-capable.
- Rust confines revision paths beneath canonical app data and rejects
  traversal, absolute paths, symlink escapes, invalid session IDs, and
  invalid hash names.
- Snapshot content is never executed.
- Revision Preview reuses Phase 4B's sanitized Markdown renderer.
- Production logs exclude note content, revision content, hashes tied to
  content, and absolute paths.
- No shell command reads, writes, restores, or deletes revisions.
- Delete-session and delete-all remove historical content as well as
  current content.
- Clearing current content intentionally remains recoverable; the UI must
  not describe it as deleting history.

## Testing Strategy

### Rust filesystem tests

- Revision root creation and symlink rejection
- Session ID and SHA-256 path validation
- Atomic immutable object creation
- Idempotent create when existing bytes match the hash
- Missing deduplicated object is repaired from verified source bytes
- Corrupt deduplicated object blocks safety-sensitive operations
- Corruption rejection when filename, metadata, and bytes disagree
- Missing snapshot behavior
- Per-session revision-directory staging, restore, and finalize
- Combined current-note and revision recovery
- Partial multi-root staging failure rolls back completed moves
- Typed manifest validation and rejection of tampered manifests
- Interrupted restore roll-forward for every manifest phase
- Delete-all staging and recovery for both roots

### Migration and native command tests

- Migration creates the expected table, unique constraint, and index
- A real version-3 database upgrades to version 4 without changing current
  note rows or files
- Revision kinds and reasons round-trip through command DTOs
- Duplicate `(session_id, content_hash)` returns the existing revision
- Blank content produces no revision
- Snapshot-file failure prevents metadata insertion
- Metadata failure after object creation retries idempotently
- List ordering is newest first
- Rename changes metadata only; trimming, 80-character validation, and
  blank-to-null normalization are enforced
- Restore verifies the selected object
- Restore repairs metadata and succeeds idempotently when target bytes
  already landed
- Restore rejects a genuinely stale expected current hash
- Safety revision commits before replacement
- Failed replacement preserves the current note
- Metadata failure after replacement recovers from authoritative file
- Restore recreates a cleared current note
- Restore refuses to treat a referenced missing/unreadable current file as
  a cleared note
- Restore of a cleared note recovers after failure/crash between file
  creation and metadata insertion
- Before-clear safety commits before current deletion
- Failed before-clear snapshot prevents current deletion
- Before-clear stages first and snapshots the exact staged bytes
- Before-clear external race restores or preserves both copies
- Keep/Reload reject a second external edit after the original conflict
- Session deletion removes only its rows and files
- Revision-history deletion leaves the current note and session intact
- Delete-all removes all revision rows and files

### TypeScript and repository tests

- Memory and Tauri repositories expose matching revision contracts
- Snapshot reason/kind parsing rejects unknown values
- Shared queue orders save, checkpoint, restore, delete, and delete-all
- Automatic snapshot triggers fire at the defined boundaries
- Unchanged content does not create a duplicate trigger row
- Review edits create `Review finalized` only when content changed
- External reload/overwrite safety flow preserves displaced content
- Loaded current-note hashes refresh after restore
- History summaries refresh after restoring an old session
- Revision counts load without reading snapshot bodies
- Pending automatic revision retries are invalidated around deletion
- Normal close waits for revision-controller pending work; simulated
  process termination does not imply durable unstarted event intent

### Frontend component tests

- Persistent timer strip appears in History/Revisions only while a session
  is active
- Navigating views does not alter timer state
- Completion alarm fires once while Revisions is open
- A failed note/revision flush and read-only navigation cannot delay focus
  expiration or duplicate its alarm under fake timers
- Completion notice does not force navigation
- Break, Flow, and Finish actions work from the completion notice
- Timeline selection and newest-first default
- Changes/Preview segmented control
- Unified diff additions, removals, unchanged lines, empty current content,
  long lines, Unicode, CRLF/LF differences, mixed endings, and final-newline
  markers
- Empty and duplicate checkpoint states
- Inline rename save and cancel
- Restore confirmation, cancel, success, stale-content error, and disabled
  same-content state
- Oversized diff fallback at the byte and line thresholds
- Oversized Markdown preview bypasses the parser and caps escaped output
- Revision access for a cleared note
- Delete-revision-history confirmation and current-note preservation
- Layout at compact and normal widths

### Validation

Before Phase 4C is considered complete:

- `npm test`
- `npm run check`
- `npm run build`
- `cargo check`
- `cargo test`
- `git diff --check`
- Verify every new Tauri command is registered and has the minimum required
  capability permission
- Manual second-launch check confirms one persistence owner and focuses the
  existing window
- Manual Tauri checkpoint, rename, compare, preview, restore, clear, delete,
  delete-all, restart, and interrupted-operation checks
- Manual external-edit Keep/Reload safety checks
- Manual timer expiration and alarm while History and Revisions are open
- Manual visual pass in light/dark mode at compact and normal window sizes

## Acceptance Criteria

1. Users can create a manual checkpoint with one action and no naming
   interruption.
2. Defined session boundaries create automatic snapshots without duplicate
   revisions for unchanged content.
3. Current note content remains authoritative in its portable Markdown
   file; SQLite stores revision metadata only.
4. Every revision snapshot is immutable, hash-verified, and confined to its
   owning session beneath app data.
5. Users can compare a revision with the current note as a unified line
   diff or inspect its sanitized Markdown preview.
6. Restore always requires final confirmation and preserves displaced
   current content as a safety revision before replacement.
7. Clearing a non-empty current note preserves its verified prior content
   as a safety revision before deletion.
8. External reload and overwrite choices preserve the content they discard
   as safety revisions.
9. Clearing a current note retains recoverable revisions; session deletion
   and delete-all remove current and historical note content. Users can
   also delete a session's revision history without deleting its current
   note or session metrics.
10. Revision create, restore, rename, deletion, and recovery are serialized
    with existing persistence work, owned by one app process, and survive
    retry or restart safely.
11. Read-only History and Revisions navigation remains accessible while the
    timer runs even when current-note persistence needs attention.
12. Navigating, comparing, checkpointing, renaming, and restoring never
    pause, reset, or otherwise alter timer state.
13. Timer expiration while another workspace is open plays the selected
    alarm once, preserves that workspace, and exposes Break, Flow, and
    Finish actions persistently.
14. Missing or corrupt snapshot content is reported and never previewed or
    restored as though it were valid.
15. Existing timer, parking-lot, note portability, Markdown preview,
    history, export, deletion, and tone behavior remains intact.
