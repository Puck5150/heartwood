# Phase 5C: Resumable Intermissions Design

**Status:** Approved design
**Date:** 2026-07-30
**Depends on:** Phase 5B gentle focus completion

## Objective

Add always-available Break and Touch Grass controls without turning an
ordinary interruption into a completed focus phase.

An intermission temporarily freezes the current focus or Flow timer, runs
its own recoverable countdown, and returns to the same session when the
user comes back. This is distinct from Phase 5B's post-focus Break, which
follows a successful focus completion and ends in Review.

## Product Decisions

- Break and Touch Grass are available throughout focus, paused focus,
  Flow, paused Flow, and quiet overtime.
- They are resumable intermissions, not focus-completion actions.
- Returning restores the same task, note, parked thoughts, session ID,
  and remaining focus or elapsed Flow state.
- Starting from an already-paused state returns to that paused state.
- Starting from an active state resumes automatically on return.
- Starting from quiet overtime returns to quiet overtime.
- The existing post-focus Break remains unchanged and still leads to
  Review.
- Intermission time is recorded separately as Break time and Touch Grass
  time and appears in Review, History, and exports only when nonzero.

## Control Design

The active timer remains the visual priority. A restrained "Step away"
strip sits below the timer's existing Pause and Finish controls.

Each intermission action is split into:

1. A primary action button that starts the intermission.
2. A neighboring duration button that cycles through allowed values.

There is no dropdown.

Break cycles:

```text
5 minutes -> 10 minutes -> 5 minutes
```

Touch Grass cycles:

```text
15 minutes -> 30 minutes -> 45 minutes -> 60 minutes -> 15 minutes
```

Defaults are 5 minutes for Break and 15 minutes for Touch Grass. The
current selections remain in memory while the app is open. They are not
new user preferences in this phase.

Both controls use at least 44 by 44 CSS pixel targets. On narrow screens,
the two actions stack while preserving the same action/duration
relationship. Long task text and all supported themes must not cause
horizontal overflow.

## Intermission Presentation

Break uses quiet, practical copy suitable for a bio break, water,
stretching, or stepping away.

Touch Grass uses:

```text
Go for a frickin' walk.
```

The intermission screen is intentionally sparse and calm:

- intermission name;
- remaining time;
- one short away-from-screen prompt;
- **I'm back**;
- the existing navigation and Settings access where applicable.

It must not become a marketing-style hero or a decorative card stack.
Touch Grass should feel warmer and more natural than the ordinary timer
without obscuring the countdown or controls.

## State Model

Add one explicit intermission state rather than overloading the existing
post-focus Break:

```text
IntermissionState
  status: "intermission"
  kind: "break" | "touchGrass"
  intermissionStartedAt
  intermissionDeadlineAt
  intermissionReturnStatus:
    "focusing" | "paused" | "flow" | "flowPaused"
  returnState: PausedState | FlowPausedState
  breakIntermissionMs
  touchGrassMs
```

`returnState` is always a frozen representation. Entering from an active
state first creates the corresponding paused snapshot at the same
timestamp. `intermissionReturnStatus` records whether return should resume
that snapshot or leave it paused.

The concrete implementation may flatten the return-state fields for
SQLite, but it must preserve this invariant:

> An intermission owns no independent focus calculation. It stores a
> frozen valid session state and returns through the existing resume
> transition.

This keeps deadline shifting, accumulated pause accounting, and Flow
pause accounting in their existing tested transitions.

## Transitions

Add pure, timestamp-injected transitions:

```text
startIntermission(state, kind, durationMs, now)
returnFromIntermission(intermission, now)
```

`startIntermission`:

- accepts focusing, paused, flow, and flowPaused;
- rejects idle, complete, awaitingDecision, existing intermission, and
  post-focus Break;
- validates the kind and one of the approved durations;
- freezes active focus or Flow at `now`;
- stores the intended return status;
- creates the intermission deadline;
- carries prior intermission totals unchanged.

`returnFromIntermission`:

- records actual elapsed intermission time, including overtime;
- increments only the matching Break or Touch Grass total;
- resumes when the recorded return status was active;
- remains paused when the recorded return status was paused;
- rejects every non-intermission state.

Returning early is valid. It records actual elapsed time rather than the
selected duration.

## Deadline And Overtime

Intermission remaining time is derived from its persisted deadline and
the current wall clock. At zero:

1. Keep the session in intermission.
2. Play the selected return tone three times.
3. Send one silent native notification when the main window is not
   foregrounded.
4. Display upward-counting quiet overtime.
5. Wait for **I'm back**.

Focus never resumes automatically. The return alarm is one-shot per
intermission deadline and uses the same cancellation and generation
discipline as Phase 5B's completion alarm.

Recovery after the deadline enters intermission overtime silently. It
does not replay an alarm or synthesize an old notification during
startup.

## Audio

Return tones are separate from focus-completion tones.

Settings gains a return-tone selector that:

- uses the existing settings controller and shared write queue;
- includes a calm default;
- lists **Sad Trombone** plainly as an optional choice;
- previews one tone without changing timer state;
- never starts playback at application launch.

Any pending focus warning or completion-alarm sequence is cancelled when
an intermission starts.

A playing local soundscape fades out when an intermission starts. It
resumes after **I'm back** only when the user had explicitly started it
during the same session. Phase 5D owns the soundscape controller and
implements that integration against this state boundary.

Audio and notification failures are nonblocking and must never prevent
entering or returning from an intermission.

## Persistence

Add a SQLite migration for:

- active intermission kind;
- start and deadline timestamps;
- intended return status;
- cumulative Break intermission milliseconds;
- cumulative Touch Grass milliseconds.

Reuse existing focus/Flow pause columns for the frozen return state where
their meaning remains exact. Do not serialize nested state as an opaque
JSON blob.

Serialization must clear active intermission columns after return while
retaining cumulative totals. Deserialization rejects contradictory or
partial active-intermission rows rather than guessing.

Startup recovery must preserve:

- selected intermission kind;
- exact remaining time or overtime;
- frozen focus/Flow position;
- active-versus-paused return behavior;
- cumulative intermission totals.

Every repository write continues through the application's one shared
FIFO task queue.

## Review, History, And Export

Completed sessions gain:

```text
breakIntermissionMs
touchGrassMs
```

These are distinct from the existing post-focus `breakMs`.

Review and History:

- omit each value when it is zero;
- label ordinary resumable time **Breaks**;
- label Touch Grass time **Touch Grass**;
- keep the existing post-focus metric labeled **Break**.

Markdown and JSON exports include the two totals using the same omission
rules and versioning discipline as existing fields.

`totalElapsedMs` remains wall-clock session time and therefore already
includes intermissions.

## Error Handling

- Invalid duration or state leaves the current session untouched.
- A failed session persistence write uses the existing visible
  persistence-error path.
- A failed return tone or soundscape fade never blocks the transition.
- Notification permission denial is not an application error.
- A missing parked thought, note error, or revision error remains
  independent of intermission state.
- Repeated Start clicks cannot create nested intermissions.
- Repeated **I'm back** clicks produce at most one return transition.

## Accessibility

- Controls remain in normal document order and require no modal
  semantics.
- Cycling buttons expose the current duration in their accessible name.
- Intermission changes are announced once through a polite live region.
- No automatic focus movement occurs when the intermission begins or
  reaches zero.
- Touch targets are at least 44 by 44 CSS pixels.
- Reduced-motion mode removes decorative motion without changing timing.
- Color is not the sole distinction between Break and Touch Grass.

## Testing

Pure state tests cover:

- every valid source status;
- active and already-paused return behavior;
- focus deadline preservation across early and overtime return;
- Flow elapsed-time preservation;
- approved and rejected durations;
- separate cumulative totals;
- repeated and invalid transitions.

Persistence tests cover:

- migration shape;
- active intermission round trips;
- returned-session round trips;
- exact recovery before and after the deadline;
- malformed and legacy rows;
- cumulative totals through completion.

Application and component tests cover:

- always-available controls in full and compact timer views;
- duration cycling and accessible names;
- one-shot return alarm and notification;
- no automatic resume at zero;
- **I'm back** behavior from focus and Flow;
- Review, History, and export totals;
- soundscape suppression hooks without requiring the Phase 5D engine.

Manual verification covers desktop and 360 by 640 mobile layouts, every
theme family, reduced motion, background notifications, audible alarm
spacing, quit/relaunch recovery, and no horizontal overflow with long
text.

## Deferred

- hydration prompts;
- standing reminders;
- walking analytics or step tracking;
- geolocation;
- custom intermission durations;
- automatically scheduled intermissions;
- planner or calendar integration;
- YouTube or other network music providers.

