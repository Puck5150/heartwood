# Claude Phase 1 Handoff

## Read first

Please read these repository documents before coding:

- `docs/product-brief.md`
- `docs/architecture-review.md`
- `docs/product-direction.md`

Treat the brief as product intent, the architecture review as sequencing guidance, and the product direction as the latest decision update from the user.

## Current request

Start the first implementation milestone as a plain Svelte/Vite web prototype, without Tauri, SQLite, notes, audio, tray behavior, global shortcuts, or native platform code.

The goal is to validate the interaction loop before committing to desktop plumbing.

## Phase 1 deliverable

Build a small but visually polished Svelte + TypeScript prototype that supports:

1. Entering a focus task.
2. Starting a focus timer.
3. Pausing and resuming.
4. Parking thoughts during the session.
5. Reaching timer completion.
6. Choosing break, flow, or finish.
7. Showing flow mode counting upward.
8. Showing an end-of-session review.
9. Selecting a parked thought as the next focus task.

Use in-memory state only.

## Architecture guidance

- Put timer and session-state behavior in pure TypeScript functions where practical.
- Use a strict state-machine style so invalid session transitions are hard to represent.
- Compute timer display from timestamps and accumulated pause duration, not from a decrementing counter.
- Keep the file structure small; avoid creating large future-facing folders before they have real code.
- Use Svelte stores only if they make the prototype clearer.

## Visual guidance

The first screen should be the working app experience, not a landing page.

Aim for a calm, polished, compact focus workspace:

- The current focus task and timer are the visual center.
- The parking-lot input is always easy to reach during a session.
- Review mode should make parked thoughts easy to process.
- Flow mode should feel subtly distinct from countdown focus mode.

Avoid dashboard sprawl, gamification, streaks, productivity scores, heavy task management, and decorative pages.

## Tests

Please include unit tests for the pure session/timer logic:

- normal completion
- pause and resume
- repeated pauses
- flow transition
- invalid transition rejection
- starting next session from a parked thought

Manual UI testing is fine for the first Svelte screen, but the timer math should be tested outside the browser.

## Stop line

Do not add Tauri or persistence in this pass unless the user explicitly asks for it.
