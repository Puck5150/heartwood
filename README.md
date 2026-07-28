# Pomodoro Parking Lot

A polished, local-first focus workspace: start a focused work session, park
distracting thoughts without context-switching, continue in flow when the
timer ends, and turn worthwhile parked thoughts into intentional future
focus sessions.

## Phase 4A scope (current): SQLite-backed session notes

A single free-text note per focus session, editable during the session and
visible afterward. Deliberately a stepping stone, not the final notes
system: SQLite storage validates the workflow (autosave, persistence,
review/history display, export, deletion) before committing to a
Markdown-file-based design later.

- **New `session_notes` table** (migration version 2 in
  `src-tauri/src/migrations.rs`): `id`, `session_id` (`UNIQUE`), `content`,
  `created_at`, `updated_at`. One note per session, enforced by the unique
  constraint and an upsert (`ON CONFLICT(session_id) DO UPDATE`) rather
  than a separate insert/update path. No FK to `sessions.id` — consistent
  with `parked_thoughts`, this schema has no FK constraints anywhere, so
  deletion is explicit in the repository layer instead of via cascade.
- **`SessionNotes.svelte`**: a compact textarea shown near the timer/parking
  lot during an active focus or flow session (including while paused), not
  during a break — and reused on the review screen too, since the note
  stays editable after the session ends, not just during it. Autosaves on a
  600ms debounce (`src/App.svelte`) rather than on every keystroke, with an
  explicit flush on any session-state transition (finish, pause, promote a
  thought, etc.), on the textarea losing focus, and on a Tauri window-close
  request — so a debounce window can never silently drop the last few
  keystrokes typed before the user moves on or quits.
- **Autosave failure is a first-class outcome, not just a console log**:
  `src/lib/noteSaveController.ts` is a small, pure, unit-tested module that
  tracks the currently-pending save and distinguishes success from failure
  explicitly (`App.svelte` never just assumes a flush worked). A real
  failure retries automatically up to 3 times on a short delay; once
  exhausted, the error message changes and a manual "Retry" action appears
  instead of continuing to claim it'll retry itself. A window-close request
  is only allowed through once the pending note has actually saved — if it
  fails, the window stays open, the edit stays pending, and the error (with
  the retry action once retries are exhausted) stays visible.
- **A failed save can never resurrect a deleted note**: the same
  `noteSaveController` tracks which sessions (or, after delete-all,
  everything) have been invalidated, checked again at the moment a save
  actually fails — not just when it was scheduled — so it doesn't matter
  whether a delete lands before, during, or after a save that was already
  in flight when it ran. Deleting a session invalidates twice: once before
  the delete is enqueued (catches a save still waiting out its debounce,
  not yet enqueued at all) and once after the delete commits (catches a
  save that was already in flight and only repopulates itself for retry
  *after* failing, possibly while the delete was still waiting in the write
  queue). `noteSaveController.test.ts` covers this race directly and
  deterministically, with no real timers involved.
- **Notes persist across restarts**, including mid-review: recovering the
  most recent session (existing Phase 2 recovery path) now restores a
  completed session to its actual review screen rather than coercing it to
  idle, and reloads that session's note content either way — verified
  end-to-end by typing a note, quitting immediately, relaunching, and
  confirming both the review screen and the note are exactly as left.
- **Editable on the review screen, with an optional carry-forward**: unlike
  the rest of history, a just-completed session's note stays editable on
  `SessionReview.svelte` rather than going read-only. A "Carry this note
  into the next session" checkbox — shown only once the note has real
  content, off by default for every review — copies the finalized text into
  an independent note row for whichever session is started next (typed
  task or promoted parked thought), flushed immediately through the same
  `noteSaveController` as any other note edit rather than a bespoke
  one-off write — so a failure carrying it forward gets the same bounded
  retry, manual-retry action, and close-blocking behavior as normal
  autosave, instead of the carried text only ever existing in memory. The
  original session's note is never mutated by carrying it forward.
  `History.svelte` still shows notes read-only per row, using
  `hasNoteContent()`/the pre-filtered `noteContent` on `SessionSummary` so
  an empty or whitespace-only note renders as nothing there.
- **Included in exports**: `SessionExportEntry.noteContent` flows straight
  through from `SessionSummary` — `history.ts` already joins note content in
  by session id, so `export.ts` needed no separate notes parameter or join.
  Markdown export renders note content as an indented blockquote under its
  session; JSON export includes it as a plain field, `null` when absent.
- **Deletion is atomic and complete, via native Rust transactions**:
  deleting a single session and its note, and wiping all data, are each a
  real `sqlx::Transaction` in `src-tauri/src/db_commands.rs` — not a
  `BEGIN; …; COMMIT;` string through `db.execute()`. The JS SQL plugin only
  guarantees one pooled connection for a single `execute()` call; it can't
  guarantee a ROLLBACK after a mid-batch failure reaches that *same*
  connection rather than a different one from the pool. A `sqlx::Transaction`
  holds one connection for its whole lifetime and rolls back automatically
  on drop if `commit()` is never reached — including on every early return —
  so there's no path that leaves a half-applied delete or a dangling open
  transaction. Covered by a real fault-injection test
  (`db_commands.rs`'s test module) that forces a transaction's second
  statement to fail after its first has already run, then asserts the
  first statement's effect was rolled back and the database is still
  writable afterward. UI state only updates once the transaction has
  actually committed.
- **Same patterns as every other write**: `saveNote` goes through the same
  `writeQueue` (established in Phase 3B) as session saves, parked-thought
  writes, and tone-setting writes, so a note autosave can never race with
  a delete and resurrect a note for a session that was just removed. The
  queue also exposes `drain()`, awaited before a Tauri window is allowed to
  actually close, so nothing already in flight is cut off mid-write.
- **Both repository backends implemented in parallel**, as always:
  `tauriRepository.ts` against real SQLite, `memoryRepository.ts` for
  browser/dev-mode fallback, with matching upsert semantics (preserving the
  original `id`/`created_at` across repeated updates) verified by unit
  tests in both `notes.test.ts` and `memoryRepository.test.ts`.
- Out of scope for this phase (deferred to the eventual Markdown-file notes
  system): multiple notes per session, a note library/search, revision
  history, restore checkpoints, external file import/export for individual
  notes, and any rich Markdown preview or editor — a plain textarea is
  intentional here.

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
- `src/lib/notes.ts` — pure helpers for the one-note-per-session model:
  `hasNoteContent()` (treats empty/whitespace-only as no note) and
  `getNoteContentForSession()`, the join used by `history.ts`.
- `src/lib/SessionNotes.svelte` — the compact textarea shown during an
  active focus/flow session and reused on the review screen; autosaves on
  a debounce, flushed explicitly on any session-state transition, on blur,
  and before a Tauri window close.
- `src/lib/noteSaveController.ts` — pure, unit-tested tracking for a
  pending note save: distinguishes success from a real failure, bounds
  automatic retries before requiring a manual one, and invalidates a
  save-in-progress so it can never repopulate itself and resurrect a note
  after its session (or everything, via delete-all) has been deleted. No
  timers or I/O of its own — `App.svelte` owns the actual `saveNote()` call
  and the debounce/retry scheduling.
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
- `src/lib/tauriRepository.ts` — the real SQLite-backed repository. The
  only module that talks to the SQL plugin. Intentionally thin: load a
  connection, run a query.
- `src/lib/memoryRepository.ts` — the in-memory fallback used by
  `npm run dev` outside of Tauri.
- `src/lib/*.test.ts` — unit tests for all of the above.
- `src/App.svelte` and `src/lib/*.svelte` — the UI, wired to the pure logic
  above.
- `src-tauri/` — the Tauri shell: window config (`tauri.conf.json`),
  capabilities/permissions (`capabilities/default.json` and
  `permissions/`), the SQLite migrations (`src/migrations.rs`), and
  `src/db_commands.rs` — the two native commands (delete-session-with-note,
  delete-all-data) that need a real `sqlx::Transaction` rather than a
  `db.execute()` batch, with their own Rust-side fault-injection tests
  (`cargo test`).
