# Pomodoro Parking Lot

A polished, local-first focus workspace: start a focused work session, park
distracting thoughts without context-switching, continue in flow when the
timer ends, and turn worthwhile parked thoughts into intentional future
focus sessions.

## Phase 3B scope (current): data deletion

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
- `src/lib/taskQueue.ts` — a small pure FIFO async queue. Every repository
  write in `App.svelte` (session saves, parked-thought inserts/deletes,
  session deletes, delete-all) is enqueued through one instance of this,
  guaranteeing writes execute in the order they were requested regardless
  of how long any individual one takes.
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
  capabilities/permissions (`capabilities/default.json`), and the SQLite
  migrations (`src/migrations.rs`).
