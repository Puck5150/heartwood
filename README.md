# Pomodoro Parking Lot

A polished, local-first focus workspace: start a focused work session, park
distracting thoughts without context-switching, continue in flow when the
timer ends, and turn worthwhile parked thoughts into intentional future
focus sessions.

## Phase 2 scope (current): desktop shell + local persistence

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

### Explicitly out of scope for Phase 2

No notes, no audio, no tray behavior, no global shortcuts, no
notifications, no history/dashboard UI, no data export or deletion UI, no
native packaging/signing, no settings UI (the `settings` table exists in
the schema but is unused — reserved for a later phase).

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
- `src/lib/persistence.ts` — pure translation between in-memory state and
  SQL row shapes, plus the launch-recovery decision logic. No database
  access here; fully unit-tested without Tauri.
- `src/lib/repository.ts` — the only module that talks to the SQL plugin.
  Intentionally thin: load a connection, run a query.
- `src/lib/*.test.ts` — unit tests for all of the above.
- `src/App.svelte` and `src/lib/*.svelte` — the UI, wired to the pure logic
  above.
- `src-tauri/` — the Tauri shell: window config (`tauri.conf.json`),
  capabilities/permissions (`capabilities/default.json`), and the SQLite
  migrations (`src/migrations.rs`).
