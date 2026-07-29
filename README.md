# Pomodoro Parking Lot

A polished, local-first focus workspace: start a focused work session, park
distracting thoughts without context-switching, continue in flow when the
timer ends, and turn worthwhile parked thoughts into intentional future
focus sessions.

## Phase 4C scope (current): seamless note revision history

Builds directly on Phase 4B's portable Markdown files: the current note is
still exactly one file per session, still authoritative, still exactly the
bytes the user typed. Phase 4C adds a lightweight, automatic revision
history on top of it — checkpoints, session-boundary snapshots, and
safety-net snapshots before anything destructive — without turning notes
into a versioned document library, without Git, and without per-revision
export or deletion.

- **A persistent workspace shell, independent of the timer.** `App.svelte`
  now has a `workspaceView` (`focus` | `history` | `revisions`) that is
  completely decoupled from `session` (the timer state machine): navigating
  to History or Revisions never pauses, resets, or otherwise touches the
  timer, and the wall-clock/focus-due effects run unconditionally regardless
  of which workspace is showing. A compact `ActiveTimerBar.svelte` strip
  keeps the active session, its controls, and the awaiting-decision actions
  (Break/Flow/Finish) visible and usable from every workspace, including
  through a focus expiring while History or Revisions is open — the alarm
  still plays exactly once and the visible workspace never changes out from
  under the user.
- **Three kinds of revision, one unified timeline**, defined in
  `src/lib/revisions.ts` and enforced identically by a SQL `CHECK`
  constraint (`src-tauri/src/migrations.rs`, migration version 4), Rust
  enums (`src-tauri/src/revision_commands.rs`), and a TypeScript union:
  - **Automatic** — `session_started` (a carried-forward note's first
    write), `session_completed` (captured from the *exact* content already
    committed at the moment a session transitions to complete, never a
    later edit made during review), and `review_finalized` (the note as it
    stood right before leaving review to start the next session).
  - **Checkpoint** — a manual "Save checkpoint" action, one click, no
    naming prompt.
  - **Safety** — `before_clear`, `before_restore`, `before_external_overwrite`,
    `before_external_reload`: a snapshot of whatever non-blank content is
    about to be discarded, always committed *before* the discarding action,
    never after.
  - Every kind dedupes by exact SHA-256 content hash, scoped to the session:
    an event whose content already has a revision row for that session
    reuses it rather than creating a second timeline entry. Blank/
    whitespace-only content never creates a revision at all.
- **Current note stays the sole source of truth; SQLite still stores no
  content.** A revision's actual bytes live at
  `<app-data>/note-revisions/<session-id>/<sha256>.md` — an immutable,
  content-addressed object whose filename must match the hash of its own
  bytes (verified on every read, not just on write) — while `note_revisions`
  rows carry only identifiers, the kind/reason pairing, an optional label,
  and a timestamp. `src-tauri/src/revision_files.rs` owns creating,
  verifying, and repairing these objects and rejects the same class of
  symlink/traversal escape `note_files.rs` already guards against for the
  current-note root.
- **A revision browser** (`RevisionHistory.svelte`) reachable from the
  active session's note toolbar or from any past session in History:
  a timeline of every revision for that session, a unified line diff or
  sanitized Markdown preview against the current note (each side's line
  endings detected and reported independently — a pure line-ending change
  stays visible rather than disappearing), rename (label only, never
  touches the snapshot body), and restore.
- **Restore always asks for final confirmation**, snapshots whatever
  non-blank current content it's about to replace as a `before_restore`
  safety revision first, and is journaled: a crash-safe
  `note-operations/<operation-id>/manifest.json`, written only after that
  safety revision's row already committed and only just before the current
  file is replaced, lets a crash or an in-process retry resume exactly
  where it left off — by comparing the current file's *actual* state
  against what the manifest recorded, never by trusting a stored "phase" for
  correctness. A stale comparison surfaces a non-destructive **Reload
  comparison** step rather than silently overwriting a newer change, and
  restoring content that already matches the current note is a no-op
  success that never manufactures a redundant safety revision.
- **Clearing, external conflicts, and deletion all get the same safety
  net.** Clearing a non-empty note to blank stages the file, verifies its
  exact bytes, snapshots them as `before_clear`, and only then deletes —
  an accidental clear is always recoverable from Revisions. External-edit
  conflict resolution (**Keep my version** / **Reload file**) is one atomic
  native operation per choice: it re-verifies the disk hash against the
  reported conflict, snapshots whichever side is about to be discarded, and
  only then performs the destructive step — a second external change during
  either flow surfaces a fresh conflict instead of silently overwriting
  anything.
- **Deletion is layered and independently recoverable.** Deleting a
  session removes its current note *and* its entire revision history
  together; **Delete revision history** (from the revision browser) removes
  only the revisions for that session, leaving its current note and session
  metrics untouched; "Delete all data" removes every current note and every
  revision. All three stage their file-system moves under one typed,
  multi-root manifest (`note-trash/<operation-id>/manifest.json`, alongside
  the staged `notes/` and `note-revisions/` subtrees) before the SQL
  transaction runs — every intended move recorded up front, a failure
  partway through rolled back entirely, and a rollback that can't fully
  recover leaving the manifest for startup recovery rather than guessing
  further.
- **One process, one queue.** `tauri-plugin-single-instance` is registered
  first, before every other plugin, in `src-tauri/src/lib.rs` — launching a
  second instance just raises and focuses the existing window rather than
  opening a second one or touching storage. Every revision create/restore/
  rename/delete goes through the same `writeQueue` every other repository
  write already used, so it can never land out of order relative to a
  session save or delete.
- **Read-only navigation never waits.** Opening History or Revisions is
  immediate even while a note save is stuck retrying — a background flush
  is attempted best-effort, but the workspace itself is never blocked on
  it. Only actions whose correctness *depends* on that flush (Save
  checkpoint, Restore) are disabled while it's unresolved.
- Explicitly deferred, same boundary as the approved design: Git
  integration, revision export, deleting an individual revision,
  configurable retention/pruning, and any Phase 5 native-editor behavior.
  Export (Markdown/JSON from History) and Open Notes Folder are unchanged
  from Phase 4B — both remain **current-note-only**; neither reads or
  writes anything under `note-revisions/`.

## Phase 4B scope: portable Markdown session notes

Session note *content* now lives in app-managed Markdown files instead of
SQLite. Still one independent note per session — this phase moves where the
bytes live and adds a safe way to view them as Markdown; it does not turn
notes into a library, add revisions, or open up a custom notes folder.

- **One UTF-8 Markdown file per non-empty session note**, under
  `<app-data>/notes/`, named deterministically from the session's local
  start date, a filesystem-safe slug of the task (ASCII letters/digits,
  single hyphens, capped at 48 characters, falling back to `session` for
  unsupported text), and the full session UUID for collision resistance —
  e.g. `2026-07-28--project-outline--<uuid>.md`. The filename is assigned
  once, on first save, and never renamed later even if the task changes.
  File contents are exactly the string the user typed: no heading, no
  front matter, no added trailing newline, no line-ending normalization.
  `src-tauri/src/note_files.rs` owns this — reading, hashing, atomic
  writes, and staged deletion — and is the *only* place a relative note
  path is resolved to a real filesystem path; it rejects traversal,
  absolute paths, and symlinks that resolve outside the notes directory,
  even a dangling one (checked before ever writing through it).
- **SQLite now stores identity and metadata, not content**: migration
  version 3 (`src-tauri/src/migrations.rs`) adds nullable `file_path` and
  `content_hash` (lowercase hex SHA-256 of the exact file bytes) columns to
  `session_notes`. A row with `file_path` set is file-backed and its
  `content` column is always `''`; a row with `file_path IS NULL` is a
  still-unmigrated Phase 4A row, and its `content` remains authoritative
  until migration succeeds.
- **Automatic, idempotent legacy migration**: on every startup,
  `initialize_note_storage_core` (`src-tauri/src/note_commands.rs`) writes
  each still-legacy row's content to its deterministic file path and then
  updates SQLite metadata in that order, so a crash between the two steps
  is always safely retryable — re-deriving the same path and either
  verifying or replacing it with the same legacy content via the same
  compare-and-write path a normal save uses. A whitespace-only legacy row
  is deleted outright rather than migrated. A migration failure (e.g. the
  derived path is blocked by something else on disk) leaves the legacy
  SQLite content authoritative rather than silently discarding it.
- **Atomic compare-and-write with expected-hash conflict detection**: every
  save supplies the content hash it last observed; a write is rejected as
  a `Conflict` (with the actual on-disk content and hash returned) when
  neither that expected hash nor the desired content's own hash matches
  what's currently on disk — catching an external edit made while the app
  was running. A write whose desired content already matches disk is a
  no-op success, which is what makes retrying a save after a metadata-only
  failure safe. The file itself is written via `atomic-write-file` (pinned
  to `0.2.3`; the `0.3` line needs Rust 1.85, newer than this crate's
  declared 1.77.2 minimum) — a temp file in the same directory, flushed,
  then atomically renamed over the destination, so the previous file is
  never observably missing or partially written.
- **Conflict-aware autosave in the frontend**: `noteSaveController.ts` now
  takes a `classifyFailure` function and distinguishes `transient` failures
  (bounded automatic retry, as before) from `conflict`/`missing`/
  `unreadable` ones, which are non-transient — kept pending for an
  explicit decision instead of silently retried. `src/lib/noteStorage.ts`
  normalizes whatever a backend actually throws (a native Tauri error or
  memoryRepository's plain mirror of that same shape) into one
  `NoteStorageError` type. The UI offers **Reload file** (discard the local
  draft, adopt what's on disk — behind an inline Cancel/Confirm step, since
  it's destructive) or **Keep my version** (force-overwrite the external
  change) for a conflict; a missing/unreadable file disables editing
  outright and offers **Retry** — none of these are ever automatic.
- **Staged deletion, not cascading SQL**: SQLite and the filesystem can't
  share one transaction, so deleting a session's note (or all notes) first
  atomically renames the file(s) into `note-trash/<operation-id>/`, then
  runs the existing SQL transaction, then finalizes (permanently discards)
  the staged copy on success or restores it if the transaction failed. If
  final cleanup itself fails after a successful delete, the database
  change still stands — the frontend surfaces a separate, non-blocking
  "cleanup pending" notice rather than treating it as the delete having
  failed, and startup recovery finishes the leftover cleanup automatically.
  Startup recovery (`recover_staged_deletions_core`) walks every staged
  file and, by comparing hashes against current `session_notes` metadata,
  decides whether an interrupted operation should finish (metadata gone —
  delete the staged copy) or roll back (metadata still references it and
  the original is genuinely absent — restore the staged copy); anything
  that doesn't cleanly resolve one way is left in place and surfaced for
  attention rather than guessed at.
- **Carry-forward creates an independent file**: unchanged in spirit from
  Phase 4A — the same `noteSaveController` flush, now routed through the
  file-backed save path — but the new session's note is a genuinely
  separate file on disk, not just a separate SQLite row; the original
  session's file is never touched.
- **Stable Edit/Preview tabs** (`SessionNotes.svelte`, `MarkdownPreview.svelte`):
  Edit is the default and reuses the existing autosaving textarea
  unchanged; Preview renders the same content through a deliberately
  restricted `markdown-it` (`src/lib/markdown.ts`) — raw HTML disabled,
  images disabled outright (no automatic remote loads), only `http:`,
  `https:`, and `mailto:` link schemes allowed (checked both by the
  renderer's `validateLink` and again by `MarkdownPreview.svelte` before
  ever honoring a click), and every link opened through the system browser
  via `@tauri-apps/plugin-opener` rather than navigating the app's own
  window. A rendering failure falls back to escaped plain text rather than
  blank or unsafe output. The tabs are a real ARIA tabs pattern (roving
  tabindex, Left/Right/Home/End) and share one `.note-body` sizing so
  switching modes never shifts the timer, parking lot, or review controls.
  History renders the same sanitized preview, read-only.
- **Open Notes Folder** (in History, next to Export): a native command
  that opens only its own resolved `notes_dir()` with the OS file manager
  via `tauri-plugin-opener`'s Rust API — it accepts no path from the
  frontend, so there's no way to make it open anything else.
- Explicitly deferred at the time, same boundary as the original design:
  named checkpoints/revision history, revision comparison or restore
  (Phase 4C added these — see above), multiple notes per session, a note
  library/search, a custom notes directory, live filesystem watching or
  external-editor synchronization, a rich-text editor, Markdown import, and
  Git integration (still deferred).

## Phase 4A history: SQLite-backed session notes (superseded by Phase 4B)

Phase 4A shipped one free-text note per session stored directly as a
`session_notes.content` column — an intentional stepping stone to validate
the *workflow* (autosave, persistence, review/history display, export,
deletion) before committing to the Markdown-file design Phase 4B replaced
it with. SQLite is no longer the content source (see Phase 4B above for the
current architecture), but several things engineered during this phase
carried forward essentially unchanged:

- **`noteSaveController.ts`** (still central to Phase 4B's autosave): a
  pure, unit-tested module that distinguishes success from failure
  explicitly rather than assuming a flush worked, tracks pending saves
  *per session id* (not one shared slot) so a completed session's final
  flush and a newly carried-forward session's first save can never steal
  or discard each other's content when both are outstanding at once, and
  closes a specific deletion race: a save already enqueued when its
  session is deleted must never repopulate itself and resurrect the note
  after failing — `generation`/`invalidatedSessionIds` bookkeeping is
  rechecked at the moment of failure, not just at schedule time, and a
  session is invalidated both before its delete is enqueued and again
  after it commits.
- **Atomic deletion via native Rust transactions**
  (`src-tauri/src/db_commands.rs`): a real `sqlx::Transaction`, not a
  `BEGIN; …; COMMIT;` string through `db.execute()` — the JS SQL plugin
  only guarantees one pooled connection for a single call, with no way to
  guarantee a follow-up `ROLLBACK` reaches that *same* connection after a
  mid-batch failure. A `sqlx::Transaction` rolls back automatically on
  drop if `commit()` is never reached, verified by a real fault-injection
  test that fails a transaction's second statement and asserts the first
  statement's effect was rolled back and the database is still writable
  afterward. Phase 4B's staged file deletion wraps around this same
  transaction pattern rather than replacing it.
- **Every repository write goes through one ordered queue**
  (`src/lib/taskQueue.ts`), covering session saves, parked-thought
  inserts/deletes, session deletes, delete-all, and note saves alike, so a
  slow write already in flight can never land after a later delete and
  resurrect data the delete just removed. Phase 4B extends this principle:
  a file-backed note *load* that refreshes SQLite's `content_hash` counts
  as a write for queue-ordering purposes too.
- **Editable review screen with carry-forward, and read-after-write
  consistency for history/export**: both introduced in Phase 4A and
  preserved by Phase 4B without behavior change — see the Phase 4B section
  above for how carry-forward and history now interact with file-backed
  content specifically.

## Phase 3D scope: alarm tone

A selectable, gentle chime plays when a focus session completes on its own.

- **A small built-in tone catalog** (`TONE_CATALOG` in `src/lib/sound.ts`)
  with three stable-id tones — Gentle Chime (default), Soft Bell, Rising
  Arpeggio — each synthesized with the Web Audio API. No bundled audio
  files, no new dependency, consistent with the product brief's own
  preference for generated sound over imported audio. All three are
  deliberately gentle (sine waves, soft envelopes), not jarring
  alarms/sirens, matching this app's calm visual direction.
- **Selectable from the idle screen** via `ToneSelector.svelte`: click a
  tone's name to select it, or "Preview" to hear any tone without
  changing the selection.
- **The selection persists** using the `settings` table that's existed
  since Phase 2 but was unused until now — a small, generic
  `getSetting(key)`/`setSetting(key, value)` repository pair (not
  tone-specific, reusable for any future setting), with tone-selection
  writes going through the same `writeQueue` as every other write, per
  the discipline established in Phase 3B. Verified end-to-end against the
  real database: selecting a non-default tone, confirming the row in
  `settings`, relaunching the app, and confirming both the UI and the
  actual sound played reflect the persisted choice, not the default.
- **`playTone(id)`** replaces the old single-tone `playFocusCompleteChime()`
  — a general "play this tone by id" path used for both the focus-complete
  alarm and previewing. Falls back to the default tone for an unknown id,
  and fails silently (never surfaces an app error) if Web Audio is
  unavailable or blocked.
- **Still only plays for a session completing live**, i.e. from the
  `$effect` that notices `isFocusDue` while the app is open — not when
  `recoverSessionState` jumps straight to `awaitingDecision` after the app
  is reopened well after the timer actually expired (that would startle
  rather than notify), and not from `finishFocusEarly` (the user just took
  that action themselves). This behavior carried over unchanged from the
  first pass at this phase; re-verified manually alongside everything
  else above.
- Tone *schedules* (which notes, in what order, for how long) are pure and
  unit-tested for every tone in the catalog; actually playing one through
  `AudioContext` is a browser-API side effect, verified by ear instead —
  including the selected tone actually playing at focus completion, not
  just via Preview.
- Still no volume control and no custom/imported tones — the catalog is
  fixed and small by design for this pass.

## Phase 3C scope: data export

Completes the data-ownership arc started by Phase 3A (history) and Phase
3B (deletion): lets you export your data out of the app.

- Two formats from the History view: **Markdown** (human-readable) and
  **JSON** (structured, versioned — meant as a future import format, not
  built yet).
- Each completed session exports with task, completed timestamp, planned
  focus, actual focus, flow, break, total elapsed, parked-thought count,
  and the text of any thoughts still parked and tagged with that session.
- **Currently parked thoughts are also exported as a separate flat list**,
  independent of the per-session grouping above — this covers a thought
  parked during a still-active session, or one whose original session was
  deleted (Phase 3B), so nothing gets lost just because it isn't tied to
  visible history.
- Export is read-only: `src/lib/export.ts` never calls any repository
  write function, and the UI layer only reads already-loaded data — it
  cannot change app state or persisted data by construction.
- **Native save dialog in Tauri, browser download outside it.** A plain
  Blob + anchor-click download (the "browser-safe" approach) works fine
  in `npm run dev`, but doesn't work inside Tauri's WebView — navigating
  to a `blob:` URL is silently blocked there, the same class of issue as
  `window.confirm()` from Phase 3B. Confirmed by testing both paths
  directly rather than assuming: in Tauri, "Export" opens a native save
  dialog (`@tauri-apps/plugin-dialog`) and writes to the chosen path
  (`@tauri-apps/plugin-fs`); outside Tauri it falls back to the Blob
  download. Capabilities added are minimal and specific:
  `dialog:allow-save` and `fs:allow-write-text-file` — no broad
  filesystem access. The dialog plugin automatically scopes the fs
  plugin to exactly the path the user picks, so `fs:allow-write-text-file`
  never needs a pre-configured path scope.

### Explicitly out of scope for Phase 3C

No import (JSON is shaped to make a future import feature straightforward,
but nothing reads it back in yet), no notes export (no notes feature
exists yet), no custom export templates, no analytics, no projects/labels/
tags. Alarm tones are Phase 3D; audio/media-player controls remain
unscoped.

## Phase 3B scope: data deletion

Lets you delete data from the history view added in Phase 3A.

- Each history row has a "Delete" action (with an inline Confirm/Cancel
  step) that removes just that session's row (`deleteSessionRow()`). It
  does **not** touch `parked_thoughts` rows tagged with that session's id —
  a historical record and a live, unresolved parked thought are separate
  concerns, and deleting the former shouldn't silently discard the latter.
- "Delete all data" wipes every session **and every parked thought**
  (`deleteAllData()`) — a full reset. The button and confirmation copy say
  so explicitly, since the action's blast radius is wider than "history"
  alone would suggest.
- Both actions only remove something from the UI *after* the delete is
  confirmed to have actually happened (`await` then update, not optimistic
  removal), so a failed delete leaves the item visible with an error
  shown, rather than pretending it's gone.
- After a successful "Delete all data", the app resets to a clean idle
  state — current session/review state, view, and task/duration drafts
  all clear — rather than leaving you looking at a review screen or
  history list that now references data which no longer exists.
- **Confirmation is in-app UI, not `window.confirm()`, for both delete
  actions:** native JS dialogs (`confirm`/`alert`/`prompt`) aren't
  reliably supported across Tauri's WebView backends — on this setup
  `confirm()` silently returned without ever showing anything, so nothing
  happened. Both delete paths instead reveal an inline confirmation step
  directly in `History.svelte`.
- **Every repository write goes through one ordered queue** —
  `src/lib/taskQueue.ts`, a small pure FIFO async queue, unit-tested
  independent of Svelte or the DB. This covers session saves, parked-
  thought inserts/deletes, session deletes, and delete-all alike. Without
  this, a write that was already in flight when a delete fires (parking a
  thought right before hitting "Delete all data", for example) could land
  *after* the delete completes and silently recreate the data just
  removed; routing every write through the same queue guarantees it
  always runs after anything already pending, never before it.
- "View history" is reachable from the session review screen as well as
  the idle screen, not just idle — the original Phase 3A scope limited it
  to idle only, but the review screen is the only place you land right
  after finishing a session, and there's no other in-app path back to
  idle without quitting and relaunching, which was real friction in
  practice.

## Phase 3A scope: session history foundation

A simple, read-only history view backed entirely by session rows Phase 2
was already persisting — no schema changes.

- "View history" on the idle screen shows every completed session: task,
  completed date/time, focus (actual, plus planned if it differs), flow,
  break, total elapsed, and a parked-thought count.
- `src/lib/history.ts` derives the ordered, completed-only summary list
  from raw `SessionRow`s — pure and unit-tested, independent of how the
  rows were loaded.
- **Documented limitation:** the parked-thought count reflects thoughts
  still sitting in the parking-lot pool tagged with that session's id —
  not a historical "how many were ever parked there" count. Once a thought
  is promoted or deleted its row is gone (see the parking-lot ownership
  model below), so this number can only reflect what's still there today.
- Read-only in this pass (deletion followed in Phase 3B; export and
  settings are still out of scope). No notes, Markdown, revision history,
  audio, projects, labels, analytics, or task-manager features either,
  consistent with every earlier phase.
- The focus-session loop and review screen are unchanged. History is only
  reachable from the idle screen (i.e. before starting a session, or after
  recovery following a completed session), not mid-session.

## Phase 2 scope: desktop shell + local persistence

Phase 1 was a plain Svelte/Vite web prototype with in-memory state only.
Phase 2 wraps that same frontend in a Tauri 2 desktop shell and adds SQLite
persistence, without changing the interaction loop itself:

- The Svelte frontend is unchanged in spirit — Tauri wraps it, it wasn't
  rewritten.
- Sessions and parked thoughts are persisted to a local SQLite database via
  the Tauri SQL plugin (`tauri-plugin-sql`), through a thin repository
  layer (`src/lib/repository.ts`).
- On launch, the app recovers the last active or incomplete session and
  the full parked-thought pool. Timer state is always recomputed from
  stored timestamps, never a saved countdown value — a focus session that
  expired while the app was closed comes back as the decision screen, a
  paused session comes back paused, and a flow session's elapsed time is
  still a live calculation.
- **Documented choice:** a *completed* session is not resumed into the
  review screen on relaunch — that would resurrect a stale "what just
  happened" screen long after the fact. Recovery starts fresh at idle
  instead; the completed session's row and its parked thoughts are
  untouched in the database, so review's carry-forward view of them is
  unaffected. See `recoverSessionState()` in `src/lib/persistence.ts`.
- Tauri capabilities are scoped to exactly what this phase needs: core
  window basics and the four SQL plugin permissions actually used (load,
  select, execute, close). No shell, HTTP, filesystem, tray, global
  shortcut, or updater permissions.
- `npm run dev` (the plain Vite dev server, no Tauri) still works for fast
  frontend iteration, same as Phase 1 — `src/lib/repository.ts` detects at
  runtime whether it's running inside Tauri and picks either the real
  SQLite-backed repository or an in-memory fallback (`memoryRepository.ts`)
  accordingly, so `@tauri-apps/plugin-sql` is never invoked outside Tauri.
  The fallback doesn't persist across reloads — only `npm run tauri:dev`
  gives you real persistence.
- Session saves are queued in transition order and the SQL upsert only
  applies a write if it's newer than what's already stored
  (`WHERE excluded.updated_at > sessions.updated_at`), so a slow write from
  an earlier transition can never clobber a newer one that lands first.

### Explicitly out of scope for Phase 2

No notes, no audio, no tray behavior, no global shortcuts, no
notifications, no data export, no native packaging/signing, no settings UI
(the `settings` table exists in the schema but is unused — reserved for a
later phase). Session history was added later, in Phase 3A; data deletion
in Phase 3B.

### Parking lot ownership model (unchanged from Phase 1)

Thoughts are tagged with the session that captured them. The live
parking-lot list during a session, and the review screen's primary list,
show only the current session's thoughts. Thoughts left over from earlier
sessions (kept, not deleted or promoted) carry forward and appear in a
separate, explicitly labeled "Still parked from earlier" section instead
of silently blending in. See `src/lib/parkingLot.ts`.

## Commands

```bash
npm install         # install dependencies
npm run dev         # start the Vite dev server (frontend only, no Tauri)
npm run check       # type-check (svelte-check + tsc)
npm test            # run the unit test suite (vitest)
npm run build       # production build of the frontend
npm run tauri:dev   # run the desktop app in dev mode (Vite + Tauri)
npm run tauri:build # build the desktop app
```

`npm run tauri:dev` requires a Rust toolchain (`rustc`/`cargo`) on PATH —
see [tauri.app](https://v2.tauri.app/start/prerequisites/) for platform
setup if you don't have one yet.

## Where the logic lives

- `src/lib/session.ts` — pure session/timer state machine (no DOM, no
  `Date.now()` calls internally; every function takes `now` explicitly).
- `src/lib/parkingLot.ts` — pure parked-thought list operations.
- `src/lib/duration.ts` — pure duration validation (1–180 whole minutes)
  and the "start with a user-supplied minutes value" decision, shared by
  every place a session can be started with an adjustable duration.
- `src/lib/history.ts` — pure derivation of the session-history list from
  raw session rows: filters to completed sessions, counts currently-parked
  thoughts per session, and orders most-recently-completed first.
- `src/lib/export.ts` — pure export builder: turns session summaries and
  the parked-thought pool into a versioned `ExportData` payload, plus
  Markdown and JSON renderers. No DOM, no Tauri — triggering the actual
  save/download is `History.svelte`'s job.
- `src/lib/sound.ts` — the built-in tone catalog and the focus-complete
  alarm. Tone schedules are pure, unit-tested functions; actually playing
  one via `AudioContext` is a browser-API side effect, verified by ear
  rather than by test.
- `src/lib/ToneSelector.svelte` — the idle-screen UI for selecting and
  previewing an alarm tone from the catalog.
- `src/lib/notes.ts` — the note type contract shared across the app:
  `SessionNoteRow` (now including nullable `file_path`/`content_hash`),
  `SaveNoteOptions`/`SaveNoteResult`/`DeleteOutcome`, plus
  `hasNoteContent()` (treats empty/whitespace-only as no note) and
  `getNoteContentForSession()`, the join used by `history.ts`.
- `src/lib/noteStorage.ts` — normalizes whatever a backend actually throws
  for a note-storage failure (a native Tauri `NoteCommandError` or
  memoryRepository's plain mirror of that wire shape) into one
  `NoteStorageError` with a `kind` (`transient`/`conflict`/`missing`/
  `unreadable`) the rest of the app branches on.
- `src/lib/markdown.ts` — a deliberately restricted `markdown-it` instance
  (raw HTML and images disabled, only `http:`/`https:`/`mailto:` link
  schemes allowed) plus the plain-text fallback used if rendering itself
  ever fails.
- `src/lib/MarkdownPreview.svelte` — renders that sanitized HTML and
  intercepts link clicks, opening only an already-revalidated safe URL
  through the system browser (`@tauri-apps/plugin-opener` in Tauri,
  `window.open` in browser dev mode) rather than navigating the app itself.
- `src/lib/SessionNotes.svelte` — the compact Edit/Preview surface shown
  during an active focus/flow session and reused on the review screen.
  Edit autosaves on a debounce, flushed explicitly on any session-state
  transition, on blur, and before a Tauri window close; Preview renders
  the same content through `MarkdownPreview.svelte`. A real ARIA tabs
  pattern (roving tabindex, arrow/Home/End keys) switches between them
  without shifting surrounding layout.
- `src/lib/noteSaveController.ts` — pure, unit-tested tracking for pending
  note saves, keyed *per session id* (not one shared slot): distinguishes
  success from a real failure, classifies a failure (via an injected
  `classifyFailure`) as `transient` (bounded automatic retry) or non-
  transient (`conflict`/`missing`/`unreadable` — kept pending for an
  explicit decision, never auto-retried), invalidates a save-in-progress so
  it can never repopulate itself and resurrect a note after its session (or
  everything, via delete-all) has been deleted, and serializes repeated
  flush() calls for the same session without letting two different
  sessions' saves interfere with each other. No timers or I/O of its own —
  `App.svelte` owns the actual `saveNote()` call and the debounce/retry
  scheduling.
- `src/lib/taskQueue.ts` — a small pure FIFO async queue. Every repository
  write in `App.svelte` (session saves, parked-thought inserts/deletes,
  session deletes, delete-all, note saves) is enqueued through one instance
  of this, guaranteeing writes execute in the order they were requested
  regardless of how long any individual one takes. Also exposes `drain()`,
  awaited before a Tauri window is allowed to actually close.
- `src/lib/persistence.ts` — pure translation between in-memory state and
  SQL row shapes, plus the launch-recovery decision logic. No database
  access here; fully unit-tested without Tauri.
- `src/lib/repository.ts` — runtime dispatcher between the two repository
  backends below, based on whether the app is running inside Tauri.
- `src/lib/tauriRepository.ts` — the real SQLite/file-backed repository.
  Session/parked-thought/setting reads and writes still talk to the SQL
  plugin directly; every note operation instead calls one of the native
  note commands and normalizes its camelCase DTO into the app's
  `SessionNoteRow` shape.
- `src/lib/memoryRepository.ts` — the in-memory fallback used by
  `npm run dev` outside of Tauri, mirroring the file-backed note contract's
  *semantics* (content-hash conflict detection, whitespace clears the
  note) without an actual filesystem.
- `src/lib/*.test.ts` — unit tests for all of the above.
- `src/App.svelte` and `src/lib/*.svelte` — the UI, wired to the pure logic
  above.
- `src-tauri/` — the Tauri shell: window config (`tauri.conf.json`),
  capabilities/permissions (`capabilities/default.json` and
  `permissions/`), the SQLite migrations (`src/migrations.rs`), and:
  - `src/db_commands.rs` — the native session/delete-all/delete-revision-
    history commands, all three staging their file-system moves through
    the typed multi-root manifest (`stage_session_data`/
    `stage_revision_history`/`stage_all_data`) before their SQL
    transaction runs, and deleting `note_revisions` rows in the same
    transaction as `sessions`/`session_notes` where relevant. Their own
    Rust-side fault-injection tests live alongside them (`cargo test`).
  - `src/note_files.rs` — the pure filesystem boundary for notes: path
    confinement, hashing, atomic compare-and-write, and staged deletion/
    restore/recovery. The only module that ever resolves a relative note
    path to a real filesystem path.
  - `src/note_commands.rs` — native note DTOs/errors and the SQLite/file
    orchestration for initialization (recovery + legacy migration), load,
    save (including whitespace-triggered clearing, now routed through the
    stage/verify/snapshot/delete safety flow it shares with restore),
    external-conflict resolution (`resolve_external_conflict_keep`/
    `_reload`), revision restore (`restore_note_revision_core`, plus the
    restore-manifest resume/recovery logic), and opening the notes folder.
    Startup recovery here runs restore-manifest recovery, then typed
    staged-data recovery, then the original single-file staged-deletion
    recovery, in that order.
  - `src/revision_files.rs` — extends `NoteFileStore` with everything
    revision-specific: content-addressed snapshot objects under
    `note-revisions/<session-id>/`, the crash-safe restore-operation
    manifest (`note-operations/<operation-id>/manifest.json`), and the
    typed multi-root staged-data manifest
    (`note-trash/<operation-id>/manifest.json`) used by session,
    revision-history, and delete-all deletion.
  - `src/revision_commands.rs` — native revision DTOs/errors, the
    `RevisionKind`/`RevisionReason` enums (mirrored exactly by the SQL
    `CHECK` constraint and the TypeScript union), and the
    create/list/load/rename/count commands. `insert_or_reuse_revision_row`
    and `revision_dto_by_id` are shared helpers `note_commands.rs` also
    calls from inside its own transactions.
- `src/lib/workspace.ts` — the `WorkspaceView` type (`focus` | `history` |
  `revisions`), deliberately independent of `session`/timer state.
- `src/lib/ActiveTimerBar.svelte` — the compact timer strip shown from
  every workspace while a session is active, including the
  awaiting-decision actions.
- `src/lib/WorkspaceNav.svelte` — the Focus/History/Revisions navigation
  bar.
- `src/lib/revisions.ts` — dependency-free revision domain types
  (`RevisionKind`, `RevisionReason`, `NoteRevision`, `RestoreRevisionResult`,
  `CurrentNoteSnapshot`), wire-value validation shared with the Rust enums,
  and presentation helpers (default reason labels, label normalization).
- `src/lib/revisionDiff.ts` — pure, bounded unified-diff building (`jsdiff`)
  between a revision and the current note, with independent per-side
  line-ending detection and a capped plain-text fallback for oversized
  content — no rendering, no Tauri.
- `src/lib/revisionOperationController.ts` — pending-automatic-revision-
  request bookkeeping, modeled directly on `noteSaveController.ts`'s own
  race-safety (the same deletion-race and concurrent-retry closures,
  reused rather than re-derived).
- `src/lib/RevisionHistory.svelte` — the revision browser: timeline,
  diff/preview comparison, rename, restore (with dynamic confirmation
  copy, same-content disablement, and a non-destructive Reload comparison
  step for a stale conflict), and Delete revision history.
