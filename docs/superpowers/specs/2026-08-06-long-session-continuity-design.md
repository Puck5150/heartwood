# Long Session Continuity & Automatic Touch Grass Reminders

**Status:** Approved by user, pending spec self-review and write-up review.

## Goal

Let a single Heartwood session span hours across many focus-block/break
cycles, instead of forcing a brand-new session every time the user takes a
break at the end of a focus block. Also make the existing "Touch Grass"
stand-up-and-walk-away break proactively suggested once the user has gone
too long without one, rather than relying purely on them remembering to
click it.

## Problem

Heartwood already has two different "break" concepts:

- **Intermission** (`session.ts`'s `startIntermission`/`returnFromIntermission`,
  kind `'break'` or `'touchGrass'`): a resumable pause *during* active focus
  or Flow. Ending it resumes the same session exactly where it left off.
  This already works correctly and is not being changed.
- **Post-focus Break** (`BreakState`, entered via `takeBreakFromFocus` or
  `takeBreakFromFlow` — the "Take a break now" / "Take a break" choice
  offered when a focus cycle is about to expire or has entered quiet
  overtime): once here, the only exit is `endBreak()`, which unconditionally
  transitions to `'complete'` — ending the session. There is no way back
  into focusing on the same session, forcing the user to start an entirely
  new session (new task entry, new duration, new sessionId, disconnected
  history) even mid-way through what was really one long work block.

Separately, Touch Grass (the existing 15/30/45/60-minute stand-up break) is
only ever started manually. Long sessions need a nudge, not just an
available button.

## Non-Goals

- Changing how Intermission (mid-focus resumable pause) already works.
- A hard cap on how long a session can run.
- Interrupting active focus/flow mid-cycle to force a stand-up prompt — the
  suggestion only ever appears at an existing decision point (see below).
- Any change to how session review/history displays a session's task,
  notes, or parked thoughts — only the break-time totals shown change (see
  Data Model below).

## Architecture

### Break resume

A new `resumeFromBreak(state, now)` transition in `session.ts`, valid only
from `BreakState`. It returns to `'focusing'` with a fresh
`focusDeadlineAt = now + plannedDurationMs` — the same deadline math
`restartFocusCycle` already uses — keeping the same `sessionId`, `task`,
`accumulatedPauseMs`, notes, and parked thoughts. The break just taken gets
folded into a new cumulative `breakMs` total (see Data Model).

`BreakState`'s screen currently shows one "Finish" action wired to
`endBreak`. It becomes two explicit actions:

- **Resume session** → `resumeFromBreak` → back to focusing, same task,
  same planned duration, no extra prompt.
- **End session** → `endBreak` (unchanged) → `'complete'`, session review.

### Automatic Touch Grass suggestion

Every session state that carries the existing cumulative totals
(`breakIntermissionMs`, `touchGrassMs`, ...) gains a `lastTouchGrassAt:
number` field, initialized to the session's `startedAt` and updated to
`now` whenever a `touchGrass`-kind intermission ends via
`returnFromIntermission`.

The UI computes elapsed time since `lastTouchGrassAt` and compares it to a
new configurable Settings value, `touchGrassReminderThresholdMs` (default
60 minutes), stored the same way the existing focus-warning-lead-time
setting is stored. This check only happens at existing decision points —
never as an unprompted interruption:

- The "about to expire" warning prompt (`FocusCompletionPrompt`, `kind:
  'warning'`).
- The quiet-overtime prompt (`FocusCompletionPrompt`, `kind: 'overtime'`).

When the threshold is exceeded, that same prompt visually highlights a
"Time to stand up — Touch Grass?" option alongside its existing choices
(Continue focusing / Take a break now, or Stay with it / Take a break / End
session) — no new standalone prompt component, no interruption of active
focus.

## Data Model

- **`sessions.break_ms`** (SQLite, already exists): changes meaning from
  "the one break's length" to a running total across every post-focus break
  taken during the session — the same accumulation pattern
  `breakIntermissionMs`/`touchGrassMs` already use. `resumeFromBreak` adds
  the just-finished break's elapsed time into this total before returning
  to focusing; `endBreak` still reports the final total the same way it
  reports `breakIntermissionMs`/`touchGrassMs` today.
- **`sessions.last_touch_grass_at`** (SQLite, new nullable column, migration
  version 9): persists `lastTouchGrassAt` so a recovered in-progress session
  (app restart mid-session, per the existing session-recovery machinery)
  keeps its correct threshold state. A NULL value (any session recovered
  from before this column existed) is treated as "use this session's
  `started_at`" — the same safe default as a session that's never done a
  Touch Grass.
- **`touchGrassReminderThresholdMs`** (new row in the existing generic
  `settings` key/value table): no migration needed, follows the same
  read/write path as every other setting in `settingsController.svelte.ts`.

## SessionReview

`SessionReview.svelte`'s `breakMs` prop now receives the summed total
instead of a single break's length — this is a data-shape change only, not
a display change; the label already reads as a duration, not "last break."

## UI Changes

- `FocusCompletionPrompt.svelte`: both prompt kinds (`warning`, `overtime`)
  gain an optional highlighted Touch Grass suggestion, shown when the
  threshold is exceeded. Exact visual treatment (e.g. an accent-colored
  extra button) follows this project's existing prompt/button conventions
  — no new component needed, extend the existing props.
- Break-state screen: swap the single "Finish" button for "Resume session" /
  "End session".
- Settings: new numeric/duration input for `touchGrassReminderThresholdMs`,
  following the same settings-section pattern used for the existing
  focus-warning-lead-time control.

## Error Handling

- `resumeFromBreak` rejects (same `TransitionResult` pattern as every other
  transition) when called from any status other than `'break'` — mirrors
  `endBreak`'s existing guard.
- A session recovered from a pre-migration-9 row (`last_touch_grass_at`
  NULL) never sees a false "you're overdue" flag on first render — it's
  treated as freshly reset to `started_at`, not zero/epoch.

## Testing

- `session.test.ts`: new tests for `resumeFromBreak` — valid only from
  `BreakState`, produces a fresh `focusDeadlineAt`, preserves
  `sessionId`/`task`/notes/parked-thought scoping, correctly accumulates
  `breakMs` across multiple break/resume cycles in one session. Existing
  `endBreak` tests updated for the new cumulative `breakMs` shape.
- `session.test.ts`: `lastTouchGrassAt` correctly initializes to
  `startedAt` and updates only on a `touchGrass`-kind
  `returnFromIntermission`, never on a plain `'break'`-kind one.
- Migration tests (`migrations.rs`): version 9 adds the nullable column
  without disturbing existing rows, matching the style of prior additive
  migrations.
- Svelte component tests: `FocusCompletionPrompt.test.ts` for the
  threshold-exceeded highlighted state on both prompt kinds; App-level
  tests for the break screen's new Resume/End buttons and for threshold
  persistence through the settings controller.
- Manual: a real Tauri run taking a post-focus break, resuming, confirming
  the timer keeps the same task/notes/parked thoughts, and that
  SessionReview's final break total reflects two summed breaks.

## Out of Scope / Deferred

- Any cap on session length.
- Interrupting active focus/flow to force the stand-up prompt.
- Changing Intermission's existing behavior.
