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

Enter a new task and a duration (1–180 whole minutes), then start — or use
the same duration to start directly from any unresolved thought shown on
the front page. A parked thought is removed from the parking lot only after
its focus session starts successfully. The timer counts down; pause and
resume at any time.

### Park distracting thoughts

While focusing, anything that pulls at your attention goes into the
**parking lot** instead of derailing the session — jot it down and keep
working. Parked thoughts stay tied to the session that captured them, and
carry forward (clearly labeled as "still parked from earlier") into your
next session so nothing gets lost.

### Play flow-state music

During an active focus session, open the music-note menu to choose from seven
bundled instrumental soundscapes, then control Play/Pause and volume without
affecting the timer. Music starts only after you press Play, remains available
offline, fades for alarms and intermissions, and resumes at the same point when
you return to the same session. Starting a new session requires a fresh Play.

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

Shortly before the planned duration or a later quiet-overtime check-in
(configurable — see Settings below), a small nonblocking prompt appears under
the timer, without interrupting anything you're doing:

- **Continue focusing** — restarts the full planned duration, as many
  times as you like, without losing your place.
- **Take break now** — ends focus early but successfully, and starts a
  break timer. The eventual review shows how much focus time you
  actually accrued.

Ignore the first prompt and it goes away on its own once the timer actually
reaches zero: a short three-tone alarm plays, and the session moves into
**quiet overtime** — the same Flow you'd reach by choosing to keep going, just
reached automatically. The quiet-overtime prompt offers:

- **Stay with it** — dismisses the current check-in, stops any remaining alarm
  repetitions, and keeps the same session in quiet overtime.
- **Take a break** — starts a break timer, preserving the overtime
  already accrued.
- **End session** — ends the session and takes you to the review
  screen, where you can edit your note, wrap up, and either start the
  next session (optionally carrying forward any thoughts still parked)
  or use **Back to start** to return to the idle front page instead.

Quiet overtime keeps counting upward without restarting the session. Each full
planned focus duration creates another check-in until you take a break or end
the session. The selected warning preference can announce the upcoming
check-in; an unacknowledged check-in plays the short alarm sequence and then
returns to quiet overtime.

**Back to start** acknowledges that review as seen — the session, its
note, and any revisions stay exactly as they are and remain fully
reachable from History; only a marker on that one session is recorded, so
relaunching the app afterward opens the idle front page instead of
reopening the same review. If you use Back to start on one session and
never look at another completed session's review, relaunching still
opens idle — only a review you've actually dismissed is skipped.

If the app is in the background or minimized when the timer reaches
zero, it sends a single, silent system notification instead of relying
on you seeing the in-app prompt — notifications are best-effort and
depend on your OS granting permission the first time a session with
warnings enabled starts. **The app does not implement or guarantee
bringing itself to the front when you click a notification.** The
installed notification plugin's desktop backend has no supported way
for the app to observe a notification being clicked — only its mobile
(iOS/Android) backend does, and this app doesn't target mobile — so no
click-to-focus behavior is wired up (verified directly against the
plugin's own Rust source, not just its TypeScript declarations). Because
the app never receives any signal from a click, whatever your OS does
natively when you click the notification (if anything) is entirely
outside the app's control and may vary by platform; this has not been
independently exercised by clicking a real system notification on
macOS, Windows, or Linux. If a future version of the plugin adds real
desktop support for this, it's worth revisiting.

### History

**View history** is reachable from the workspace rail at any time, and also
as a direct link on the timer itself while a session is running — it never
interrupts or resets the running timer. It shows every completed session —
task, timings, and parked thoughts — and lets you:

- **Export** your data as Markdown or JSON.
- **Open Notes Folder** to browse the raw note files directly.
- **Delete** an individual session, or **Delete all data**, which removes
  every session, parked thought, note, and note revision — your
  preferences (like the selected alarm tone) are kept.

### Settings

Open **Settings** from the workspace rail (available from Focus, History,
and Revisions alike — it never interrupts a running timer) to adjust:

- **Theme** — Sunlit, Cozy, Quiet Natural, Coastal Air, Night Walk, Moon
  Garden, or Graphite.
- **Appearance** — Light, Dark, or System (follows your OS setting live).
- **Timer accent** — Blue, Green, Orange, Red, or Yellow.
- **Focus warning** — how much advance notice the "time's almost up" or next
  check-in prompt gives you: Off, 15 seconds, or 30 seconds (default). Off
  skips only the advance warning and its silent notification; the timer still
  reaches its marker and quiet-overtime check-ins continue.
- **Alarm tone** — pick from the built-in catalog and preview it before
  committing.
- **Music credits** — view the title and creator for each locally bundled
  soundscape. Playback, selection, and volume stay in the music-note menu.

Each choice applies immediately and is remembered between launches
(`themeFamily`, `appearanceMode`, `timerAccent`, `focusWarningLeadMs`, and
`selectedToneId` are the persisted setting keys). If a choice fails to
save, the field shows the last value you picked with an inline **Retry**
rather than silently reverting. "Delete all data" (above) never clears
these preferences.

### Works at any window size

The native app is desktop-only. Its browser UI is phone-responsive down to a
360×640 viewport, but iOS and Android packaging are a future follow-up. The
desktop window resizes down to 720×560. Parking Lot and Notes are stacked, not
side by side, at every width; on a narrow browser viewport they switch between
tabs instead, to save vertical space — nothing you've typed into either one is
lost when you switch tabs or resize.

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
- `src/lib/soundscapeController.svelte.ts` — keeps music independent from the
  timer while coordinating intermission/alarm suppression and terminal cleanup.
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
- `src/lib/FocusSupportPanels.svelte` — stacks Parking Lot and Notes at
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
