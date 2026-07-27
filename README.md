# Pomodoro Parking Lot

A polished, local-first focus workspace: start a focused work session, park
distracting thoughts without context-switching, continue in flow when the
timer ends, and turn worthwhile parked thoughts into intentional future
focus sessions.

## Phase 1 scope (this prototype)

This is the interaction prototype described in
`docs/claude-phase-1-handoff.md` and `docs/product-direction.md` — a plain
Svelte + TypeScript + Vite web app, **in-memory state only**, built to
validate the core interaction loop before any desktop plumbing is added.

It supports:

- Entering a focus task and starting a timer.
- Pausing and resuming.
- Ending a focus session early ("Finish early") instead of only ever
  waiting for the timer to complete.
- Parking thoughts during a session.
- The timer-completion decision screen (break / flow / finish).
- Flow mode, counting up instead of down.
- An end-of-session review with focus/flow/break stats.
- Selecting a parked thought as the next focus task.

**Parking lot ownership model:** thoughts are tagged with the session that
captured them. The live parking-lot list during a session, and the
"Parked thoughts" section of the review screen, show only thoughts from
the *current* session. Thoughts left over from earlier sessions (not
deleted or promoted) are never silently mixed in — they carry forward and
appear in a separate, explicitly labeled "Still parked from earlier"
section on the review screen, per `parkingLot.ts`.

### Explicitly out of scope for Phase 1

No Tauri, no SQLite, no persistence (a refresh loses all state), no notes,
no audio, no tray behavior, no global shortcuts, no native platform code.
See `docs/claude-phase-1-handoff.md` for the full rationale.

## Commands

```bash
npm install       # install dependencies
npm run dev       # start the dev server
npm run check     # type-check (svelte-check + tsc)
npm test          # run the unit test suite (vitest)
npm run build     # production build
```

## Where the logic lives

- `src/lib/session.ts` — pure session/timer state machine (no DOM, no
  `Date.now()` calls internally; every function takes `now` explicitly).
- `src/lib/parkingLot.ts` — pure parked-thought list operations.
- `src/lib/*.test.ts` — unit tests for both of the above.
- `src/App.svelte` and `src/lib/*.svelte` — the UI, wired to the pure logic
  above.
