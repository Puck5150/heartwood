# Repeating Quiet-Overtime Markers

**Status:** Approved design  
**Date:** 2026-07-31  
**Amends:** `2026-07-29-phase-5b-gentle-focus-completion-design.md`

## Purpose

Quiet overtime should support a user who chooses to remain in flow without
letting a completed focus interval disappear from awareness. The completion
prompt gains a **Stay with it** action, and the warning/alarm cadence repeats at
each multiple of the selected focus duration until the user takes a break or
ends the session.

This amendment replaces Phase 5B's one-time quiet-overtime prompt behavior and
its focus-warning preset list. All other Phase 5B decisions remain in force.

## Product Decisions

- Quiet overtime remains continuous Flow time. Repeated markers do not restart
  the timer, create new sessions, or reset elapsed time.
- The overtime prompt offers three actions:
  - **Stay with it**
  - **Take a break**
  - **End session**
- **Stay with it** dismisses the current prompt, cancels any remaining alarm
  repetitions, and leaves the session in quiet overtime.
- After **Stay with it**, the next marker occurs one full selected focus
  duration after the current marker.
- Markers repeat without a limit until the session leaves quiet overtime.
- Before every marker, the app uses the persisted Focus warning preference to
  decide whether and when to show the advance warning.
- Focus warning choices are:
  - Off
  - 15 seconds before
  - 30 seconds before, the default
- Off disables only the advance warning and its silent native notification.
  It does not disable the marker, completion prompt, or completion alarm.
- If the prompt has not been acknowledged by the marker, the selected alarm
  tone plays three times and then stops. Overtime remains quiet afterward.
- A prompt acknowledged before its marker prevents that marker's alarm. An
  action taken while the alarm is playing cancels the remaining repetitions.
- A recovered quiet-overtime session does not replay a stale warning or alarm.
  It schedules the next future marker from the session timestamps.

## Timing Model

Let:

```text
D = selected focus duration
E = original focus deadline
L = configured warning lead, or Off
```

The original expiry is marker 1 at `E`. Subsequent markers are:

```text
marker(n) = E + (n - 1) * D, for n >= 1
```

When warnings are enabled, each warning begins at:

```text
warning(n) = marker(n) - L
```

For a 25-minute focus interval with the default 30-second warning:

```text
24:30  initial warning
25:00  marker 1 and alarm if unacknowledged
49:30  marker 2 warning
50:00  marker 2 and alarm if unacknowledged
74:30  marker 3 warning
75:00  marker 3 and alarm if unacknowledged
```

The overtime display counts upward from `E` throughout this sequence. It does
not reset at markers.

The scheduler uses wall-clock timestamps rather than chained timeout durations.
This prevents accumulated drift when the app is backgrounded or rendering is
delayed. If evaluation occurs after a marker, the app handles only the current
marker and never replays alarms for every skipped marker.

## Prompt Behavior

The existing centered, nonmodal prompt remains shared by the full timer and the
compact active-timer bar. Navigation, notes, Parking Lot, Settings, pause, Break,
and Touch Grass controls remain available while it is visible.

During quiet overtime, the actions are presented in this order:

1. **Stay with it**, the primary action.
2. **Take a break**, the secondary action.
3. **End session**, the restrained destructive action.

Selecting **Stay with it**:

- acknowledges the current marker identity;
- hides the prompt immediately;
- cancels the current or pending alarm sequence;
- leaves session state, session identity, task, notes, and elapsed Flow time
  unchanged; and
- makes the next marker the current marker timestamp plus `D`.

The action does not persist an additional history event. Marker acknowledgement
is runtime coordination state, not session content.

## Warning Setting

The existing `focusWarningLeadMs` setting remains the single source of truth.
Its validated values become:

```text
off
15000
30000
```

Missing, malformed, and retired values fall back to `30000`. The Settings
drawer labels make the meaning explicit: the selected time is how long before
each interval expiry the warning appears.

Changes apply immediately without resetting the timer:

- Choosing Off hides an active advance warning and prevents future advance
  warnings.
- Choosing 15 or 30 seconds shows the current marker's warning immediately if
  its threshold has already passed.
- Changing the lead time does not acknowledge the marker or suppress its alarm.
- Delete All Data continues to preserve the preference.

## Runtime Coordination

Keep repeated-marker behavior out of the persisted session state machine. A
small coordinator derives marker identity and timing from:

- `sessionId`;
- original focus deadline;
- selected focus duration;
- current wall-clock time;
- configured warning lead; and
- the current marker's acknowledgement state.

The coordinator exposes the current prompt view and whether the marker has just
expired unacknowledged. The application remains responsible for starting and
cancelling the existing alarm sequence and for invoking existing Break and End
session transitions.

Marker identity includes the session and marker timestamp. This prevents a
dismissal in one session from hiding a prompt in another and prevents duplicate
warnings, notifications, or alarm sequences during repeated reactive
evaluation.

On application recovery, the coordinator selects the next marker strictly
after the recovery time. Recovery remains silent, matching the existing rule
that stale completion alarms are never replayed. If recovery occurs inside the
warning window for that future marker, the warning appears immediately and the
alarm may play when the future marker arrives. A marker that passed while the
application was closed is never replayed.

## Audio and Notifications

- Advance native notifications remain silent and best-effort.
- Foreground and background evaluations share one marker identity, so each
  warning notification is attempted at most once.
- The selected completion tone and existing three-play alarm sequence are
  reused at every unacknowledged marker.
- Starting an alarm continues to suppress the active soundscape through the
  existing audio lifecycle.
- Acknowledging the prompt cancels the alarm sequence. The existing audio
  lifecycle then restores the same-session soundscape normally.
- Alarm or notification failures do not alter session timing or prevent prompt
  actions.

## Testing

Focused unit and component tests must prove:

- the warning preset parser accepts only Off, 15 seconds, and 30 seconds and
  defaults retired or malformed values to 30 seconds;
- Settings displays the three explicit choices and persists changes through the
  existing settings controller;
- marker and warning timestamps are derived correctly for multiple durations;
- marker evaluation is drift-free, idempotent, and does not replay skipped
  alarms;
- **Stay with it** hides the prompt without changing session state or elapsed
  overtime;
- acknowledging during the warning window prevents the marker alarm;
- acknowledging during playback cancels remaining repetitions;
- an ignored marker plays exactly one three-tone sequence;
- the next warning and marker return one full selected duration later;
- Off suppresses advance warnings but not marker prompts or alarms;
- Break, End session, pause, navigation, and soundscape lifecycle behavior remain
  intact; and
- recovery is silent and schedules the next future marker.

Run the full frontend checks, tests, production build, Rust checks, and Rust
tests. Complete manual browser and Tauri verification with a short focus duration
or controlled clock so at least two consecutive overtime markers can be
observed without waiting through production-length intervals.

## Out of Scope

- Persisting marker acknowledgements or a marker history in SQLite.
- Creating separate history rows for overtime markers.
- Changing the selected focus duration during an active session.
- Configuring the number of alarm repetitions per marker.
- Adding a maximum overtime duration or marker count.
