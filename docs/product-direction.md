# Product Direction

## Product center

Pomodoro Parking Lot is a polished, local-first focus workspace where users can start a focused work session, park distracting thoughts without context switching, continue in flow when the timer ends, and turn worthwhile parked thoughts into intentional future focus sessions.

It should feel like a small, well-made desk instrument: calm, compact, tactile, and dependable.

## Core loop

1. Choose one focus task.
2. Start a timed focus session.
3. Park intrusive thoughts quickly.
4. When the planned interval ends, choose one of:
   - Take a break
   - Continue in flow
   - Finish the session
5. Review parked thoughts.
6. Optionally promote a parked thought into the next focus task.

## Parking lot lifecycle

A parked thought starts as lightweight capture, not a task-management commitment.

The active parking lot should help the user avoid derailment during a session. It should not pressure the user to organize every thought immediately.

During session review, a parked thought may be:

- Deleted
- Kept for later
- Added to a note later
- Promoted into a focus task

When a parked thought is promoted into a focus task, it should leave the active parking lot but remain linked in history as the source of that focus session.

## Focus tasks

A focus task is the thing the user is intentionally working on now.

For the initial product, a focus task may come from:

- Text typed directly by the user
- A parked thought selected during review or when starting a new session

The app should eventually remember recent or unfinished focus tasks, but the MVP should avoid becoming a general task manager.

## Explicit early boundaries

Do not include early:

- Due dates
- Priorities
- Projects
- Labels
- Reminders
- Subtasks
- Kanban views
- Team workflows
- Productivity scoring
- Streaks or gamification

These features may be reconsidered later only if they clearly serve the focus-session loop.

## Deferred daily planning direction

A future, separately designed Today workspace may extend the focus loop
without turning the app into a general task manager or calendar.

Current direction:

- Three highlighted daily outcomes plus a flexible later list
- Explicit item completion; completing a focus interval does not complete
  its planner item
- Accumulated focus time and session count per item
- Automatic carry-forward of incomplete items in a visible carried group
- Optional read-only calendar context
- Per-calendar title or busy-only privacy selection
- No two-way calendar management in the first planner iteration

This is deferred product direction, not committed implementation scope.
It requires its own design specification after the timer, native break,
and audio foundations are stable.

## Visual direction

The app should look nice because it is meant to sit beside the user's work for long stretches.

The visual language should be:

- Calm, not clinical
- Polished, not flashy
- Compact, not cramped
- Warm enough to feel inviting
- Restrained enough to stay out of the way

The timer and current focus task should be the visual center of gravity. The parking lot should be close at hand, easy to scan, and visually secondary.

Flow mode should feel subtly different from countdown mode, using color, spacing, or motion to signal that the user has moved from planned focus into continued productive momentum.

## MVP implication

The first implementation milestone should prove this loop:

1. Start a session from typed text.
2. Park thoughts during the session.
3. Reach timer completion.
4. Choose break, flow, or finish.
5. Review parked thoughts.
6. Start the next session from a parked thought.

Notes, persistence, Tauri, SQLite, global shortcuts, tray behavior, and audio should wait until the interaction prototype proves the product shape.
