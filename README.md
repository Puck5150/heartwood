# Pomodoro Parking Lot

A polished, local-first focus workspace: start a focused work session, park
distracting thoughts without context-switching, continue in flow when the
timer ends, and turn worthwhile parked thoughts into intentional future
focus sessions.

Everything is stored locally — a SQLite database plus a folder of plain
Markdown notes on your own machine. Nothing is uploaded anywhere.

For the full build history and what each development phase added, see
[CHANGELOG.md](CHANGELOG.md).

## Installing

You need [Node.js](https://nodejs.org/) (20.19.x, 22.12.x, or 24+) and a
Rust toolchain (`rustc`/`cargo`) on your `PATH` to build and run the
desktop app — see [tauri.app](https://v2.tauri.app/start/prerequisites/)
for platform-specific setup if you don't have Rust installed yet.

```bash
git clone https://github.com/Puck5150/pomodoro_parking_lot.git
cd pomodoro_parking_lot
npm install
```

## Running the app

```bash
npm run tauri:dev
```

This starts the real desktop app with SQLite persistence. On first launch
it creates its own local database and a `notes/` folder under the OS's
standard app-data directory — nothing is created anywhere else on disk.

For a production build (a native installer/binary):

```bash
npm run tauri:build
```

The built app is placed under `src-tauri/target/release/`.

If you just want to poke at the UI without building the Rust shell,
`npm run dev` starts a plain Vite dev server in the browser — it falls back
to an in-memory store, so nothing you do there is saved across a reload.

## Using the app

### Start a focus session

Enter a task and a duration (1–180 minutes), then start. The timer counts
down; pause and resume at any time.

### Park distracting thoughts

While focusing, anything that pulls at your attention goes into the
**parking lot** instead of derailing the session — jot it down and keep
working. Parked thoughts stay tied to the session that captured them, and
carry forward (clearly labeled as "still parked from earlier") into your
next session so nothing gets lost.

### Take notes

Each session has its own Markdown note, autosaved as you type. Switch to
**Preview** to see it rendered; switching back never loses your place.
Notes are stored as plain `.md` files on disk (see [CHANGELOG.md](CHANGELOG.md)
for exactly where and how), so they're readable and portable outside the
app too.

Use **Save checkpoint** any time you want to mark a point in the note you
might want to come back to. The app also automatically snapshots your note
at session boundaries and right before anything destructive (clearing it,
restoring an old version, resolving an external edit conflict) — open
**Revisions** from the note toolbar to browse, compare, rename, or restore
any of these snapshots.

### When the timer ends

A gentle alarm plays and you're asked what's next:

- **Take a break** — starts a break timer.
- **Continue in flow** — keeps working past the planned duration, now
  counting up instead of down.
- **Finish session** — ends the session and takes you to the review
  screen, where you can edit your note, wrap up, and start the next
  session (optionally carrying forward any thoughts still parked).

### History

**View history** shows every completed session — task, timings, and parked
thoughts — and lets you:

- **Export** your data as Markdown or JSON.
- **Open Notes Folder** to browse the raw note files directly.
- **Delete** an individual session, or **Delete all data**, which removes
  every session, parked thought, note, and note revision — your
  preferences (like the selected alarm tone) are kept.

### Settings

The idle screen lets you pick an alarm tone from a small built-in catalog
and preview it before committing to it. Your choice is remembered between
launches.

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

## Where the logic lives

A map of the codebase for anyone contributing or digging into how a
feature works:

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
