# Architecture

A map of the codebase for anyone contributing or digging into how a
feature works.

- `src/lib/session.ts` — pure session/timer state machine (no DOM, no
  `Date.now()` calls internally; every function takes `now` explicitly).
  The current focus cycle's deadline (`focusDeadlineAt`) is the sole
  authority for remaining time and expiry, unaffected by restarts or how
  late a render tick happens to notice the deadline was reached.
- `src/lib/focusWarning.ts` — pure visibility calculation plus an
  exactly-once coordinator for the pre-deadline warning: at most one
  announcement and one background notification per focus-cycle deadline,
  regardless of how many times the app re-evaluates it.
- `src/lib/alarmSequence.ts` — the injected, cancellable three-repetition
  completion alarm. One cancellation generation is the sole staleness
  mechanism; starting a new sequence or cancelling always invalidates
  whatever was previously scheduled.
- `src/lib/nativeNotifications.ts` — a browser-safe, best-effort adapter
  over the Tauri notification plugin: no-ops outside Tauri, requests
  permission at most once per app run, and never lets a denied or failed
  notification affect the timer. Deliberately does not attempt
  click-to-focus — verified against the installed plugin's own Rust
  source, not just its TypeScript types, its desktop backend has no
  supported way to observe a notification being clicked (that only exists
  on its mobile backend).
- `src/lib/FocusCompletionPrompt.svelte` — the shared, nonmodal centered
  prompt for both the pre-deadline warning and quiet-overtime states,
  reused by the full timer and the compact timer bar alike.
- `src/lib/parkingLot.ts` — pure parked-thought list operations.
- `src/lib/IdleParkedThoughts.svelte` — the compact front-page list of
  unresolved thoughts, with an accessible Start action for each one.
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
- `src/lib/ToneSelector.svelte` — the Settings-drawer UI for selecting and
  previewing an alarm tone from the catalog.
- `src/lib/soundscapeCatalog.ts` — the seven-track local catalog, including
  authored loop points and source/license metadata.
- `src/lib/soundscapeTrackLoader.ts` — lazily fetches and decodes a selected
  bundled WAV; no soundscape is requested before an explicit Play.
- `src/lib/soundscapeEngine.ts` — the bounded Web Audio loop engine, including
  offset-preserving suspension, crossfade buses, and decoded-buffer cleanup.
- `src/lib/soundscapeController.svelte.ts` — keeps music independent from timer
  sessions, coordinates lifecycle suppression for alarms and timed
  intermissions, and tears down the controller and audio resources when the app
  lifecycle ends.
- `src/lib/notes.ts` — the note type contract shared across the app:
  `SessionNoteRow` (including nullable `file_path`/`content_hash`),
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
  SQL row shapes, plus the launch-recovery decision logic, including the
  Back to start acknowledgement gate (a completed session whose review has
  been dismissed recovers to idle, not Review). No database access here;
  fully unit-tested without Tauri.
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
  every workspace while a session is active, including the same
  warning/quiet-overtime completion prompt the full timer shows.
- `src/lib/WorkspaceNav.svelte` — the Focus/History/Revisions navigation
  bar; one DOM tree that adapts between a desktop side rail and a mobile
  bottom bar via CSS, not two separate components.
- `src/lib/AppShell.svelte` — owns the persistent workspace rail, the
  Settings drawer's open/close state, and the `data-theme`/
  `data-appearance`/`data-timer-accent` attributes the token CSS reads.
- `src/lib/appearance.ts` — the typed appearance domain (theme families,
  appearance modes, timer accents) plus parsers that independently fall
  back to a safe default for any malformed persisted value.
- `src/lib/settingsController.svelte.ts` — applies a setting immediately
  and persists it through the same shared `taskQueue`; on a failed write
  it keeps the current value selected and surfaces a per-key retryable
  error rather than reverting the UI.
- `src/lib/SettingsDrawer.svelte` — the Settings dialog itself (Appearance
  and Audio sections), with a full focus trap and focus restoration on
  close.
- `src/lib/FocusSupportPanels.svelte` — stacks Greenhouse and Notes at
  every width, switching between them via tabs only on narrow/mobile
  viewports; both stay mounted the whole time, so neither one's draft is
  ever lost on a tab switch.
- `src/app.css` — the semantic design-token layer (`--surface`, `--text`,
  `--timer-accent`, etc.) resolved per theme/appearance/accent
  combination; components style themselves against these tokens rather
  than hardcoding colors.
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
