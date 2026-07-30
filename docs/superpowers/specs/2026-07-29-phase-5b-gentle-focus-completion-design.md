# Phase 5B: Gentle Focus Completion

**Status:** Approved design  
**Date:** 2026-07-29  
**Depends on:** Phase 5A responsive experience foundation

## Purpose

Phase 5B makes the end of a focus interval less disruptive. It warns the
user shortly before the countdown ends, lets them restart the same interval
without leaving their current session, and turns an unanswered expiry into
quiet overtime after a short, soothing alarm sequence.

The feature preserves the product's core promise: the timer remains
wall-clock based, independent of the visible workspace, and recoverable
after an application restart. It does not add Touch Grass breaks,
soundscapes, tray-only execution, planning, or per-cycle analytics.

## Product Decisions

- Add a configurable focus-warning preset with:
  - Off
  - 30 seconds, the default
  - 1 minute
  - 2 minutes
  - 5 minutes
- Show the warning once during each countdown cycle.
- Keep the warning nonblocking. The countdown continues and the prompt
  never captures keyboard focus.
- Center the prompt in the timer column on desktop and mobile.
- Use no scrim. The timer, task, notes, Parking Lot, navigation, and
  Settings remain usable.
- Give the warning two actions:
  - **Take break now**
  - **Continue focusing**
- **Continue focusing** restarts the countdown from the full original
  interval duration.
- A restarted countdown remains part of the same session and can be
  repeated without limit.
- **Take break now** counts as successful focus and records the actual
  accrued focus time.
- If the countdown reaches zero unanswered:
  1. End focus at the exact deadline.
  2. Enter existing Flow mode automatically.
  3. Play the selected alarm tone three times.
  4. Continue silently as upward-counting quiet overtime.
  5. Offer **Take a break** and **End session**.
- Overtime is Flow time in history and review.
- Taking a break from overtime preserves the accrued Flow time.
- Any session action taken while the three-tone sequence is playing
  cancels the remaining repetitions.
- A recovered expired session enters quiet overtime without replaying a
  stale alarm.
- When the window is not foregrounded, send a native notification in
  addition to maintaining the in-app prompt.
- Native notification delivery is best-effort and never controls timer
  state.

## User Experience

### Focus-warning setting

Add a **Timer** section to the Phase 5A Settings drawer above Audio. It
contains a compact preset selector labeled **Focus warning**.

The persisted setting key is:

```text
focusWarningLeadMs
```

The validated values are:

```text
off
30000
60000
120000
300000
```

Use the string `off` rather than a numeric sentinel. Missing, malformed,
or unsupported values fall back to `30000`. Loading a fallback does not
write it back automatically.

The setting applies immediately:

- Changing to Off hides a warning for the current cycle and prevents its
  native notification.
- Changing to a lead time whose threshold has already been crossed shows
  the current cycle's prompt immediately.
- Changing the preset does not reset or pause the countdown.
- Delete All Data preserves this preference along with the existing
  appearance and alarm settings.

### Warning threshold

For a focusing, unpaused session, the warning window begins when:

```text
remaining focus time <= configured warning lead
```

If the warning lead is greater than or equal to the interval duration, the
warning appears immediately after the interval begins. Off never creates a
warning.

The in-app prompt remains visible throughout the warning window whenever
the session is actively focusing. Its
announcement and native notification occur at most once for a given
deadline. Pausing hides the prompt because the countdown is not advancing.
Resuming within the warning window shows the prompt again, but must not
send a duplicate announcement or native notification.

The current `focusDeadlineAt` is the cycle identity. Restarting focus creates
a new deadline, which makes the next warning a distinct cycle warning.

### Centered prompt

The warning is a compact framed popover centered below the timer controls:

- Maximum radius: 8 px.
- No full-screen scrim.
- No automatic focus movement.
- `aria-live="polite"` for the one-time announcement.
- Timer digits and current task remain visible.
- Desktop actions are side by side.
- Mobile actions stack above the bottom navigation.
- Long task or localized action text must wrap without overlap.
- Reduced-motion mode removes any entrance or exit transition.

Warning copy:

```text
30 seconds left
Ready for a break?
The timer keeps moving. Ignore this and the alarm will sound at zero.
```

The lead-time label reflects the selected preset.

Actions:

- **Take break now**
- **Continue focusing**

There is no dismiss button. Ignoring the prompt is the dismissal path.

### Continue focusing

Continue focusing:

- Keeps the same `sessionId`.
- Keeps the task, note, parked thoughts, original `startedAt`, selected
  interval length, and accumulated focus time.
- Sets the current cycle deadline to `now + plannedDurationMs`.
- Clears the current warning identity.
- Cancels any pending alarm sequence, defensively.
- Leaves the user in active focus, not a new history row.

The action is valid only from active focus while the warning prompt is
available. It is not offered during pause or quiet overtime.

### Take break now

Take break now:

- Ends focus at the action timestamp.
- Computes actual focus from the original session start minus accumulated
  focus pauses.
- Starts the existing break state immediately.
- Does not play the focus-completion alarm.
- Records zero Flow time because overtime did not begin.
- Cancels any pending alarm sequence, defensively.

This is successful early completion, not the existing **Finish** escape
hatch. The eventual review shows the actual focus duration and, when it is
less than the original interval, the original planned interval.

### Expiry and quiet overtime

At the exact deadline, the pure state machine transitions directly from
focus into Flow:

- `focusCompletedAt` is the deadline, not a later render tick.
- `flowStartedAt` is the same deadline.
- Flow elapsed time therefore remains correct if the UI tick arrives late.
- The UI presents the mode as **Quiet overtime** while retaining Flow as
  the persisted state and history category.

The overtime prompt remains centered and nonblocking:

```text
Planned focus complete
Stay with it, or step away
Overtime stays quiet while you decide.
```

Actions:

- **Take a break**
- **End session**

Existing pause and resume remain available during overtime. Pause or either
prompt action cancels any remaining alarm repetitions.

Taking a break from overtime snapshots elapsed Flow time into the Break
state. Ending that break produces a completed session containing both the
Flow and break durations. End session uses the existing Flow-completion
path.

## State-Machine Design

### Deadline ownership

Add `focusDeadlineAt` to active countdown states:

```ts
interface FocusingState {
  status: 'focusing';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  focusDeadlineAt: number;
}

interface PausedState extends Omit<FocusingState, 'status'> {
  status: 'paused';
  pausedAt: number;
}
```

`startedAt` remains the start of the user-visible session.
`plannedDurationMs` remains the selected interval length.
`focusDeadlineAt` belongs only to the current countdown cycle.

Remaining time becomes:

```text
focusing: max(0, focusDeadlineAt - now)
paused:   max(0, focusDeadlineAt - pausedAt)
```

Pause does not alter the deadline. Resume adds the pause duration to both:

- `focusDeadlineAt`
- `accumulatedPauseMs`

This keeps current-cycle countdown math and total actual-focus accounting
consistent across unlimited restarts.

### New and revised transitions

Add pure, timestamp-injected transitions:

```text
restartFocusCycle(focusing, now)
takeBreakFromFocus(focusing, now)
completeFocusIntoFlow(focusing, deadline)
takeBreakFromFlow(flow | flowPaused, now)
```

Rules:

- `restartFocusCycle` requires active focus and sets a full new deadline.
- `takeBreakFromFocus` records `focusCompletedAt = now` and begins Break.
- `completeFocusIntoFlow` requires the deadline to be due and sets both
  focus completion and Flow start to the exact deadline.
- `takeBreakFromFlow` computes Flow elapsed time, carries it into Break,
  and starts the break at `now`.

Retain `awaitingDecision` deserialization compatibility for rows created by
older versions. Recovery normalizes a legacy awaiting-decision row into
Flow beginning at its stored `focusCompletedAt`; it does not play an alarm.
New Phase 5B transitions do not create `awaitingDecision`.

### Actual focus and history

At focus completion:

```text
actualFocusMs = max(0, focusCompletedAt - startedAt - accumulatedPauseMs)
```

This naturally includes time across every restarted cycle while excluding
focus pauses.

Completed-session fields mean:

- `plannedFocusMs`: the originally selected interval length.
- `actualFocusMs`: all active focus accrued before Flow or break.
- `flowMs`: quiet overtime accrued before ending or taking a break.
- `breakMs`: elapsed break time.
- `totalElapsedMs`: wall-clock span from original session start through
  final completion.

No cycle count, cycle list, or per-cycle statistics are added.

### Break state

Extend Break state with the focus and Flow totals needed for completion:

```text
actualFocusMs
flowMsBeforeBreak
```

A break taken before zero stores `flowMsBeforeBreak = 0`. A break taken
from quiet overtime stores the elapsed Flow duration. Use the existing
SQLite `actual_focus_ms` and `flow_ms` columns when serializing Break;
no additional columns are needed for these totals.

## Persistence And Migration

Add SQLite migration version 5:

```sql
ALTER TABLE sessions ADD COLUMN focus_deadline_at INTEGER;
```

Serialization requirements:

- Focusing and paused rows persist `focus_deadline_at`.
- Flow, FlowPaused, Break, and Complete serialize
  `focus_deadline_at = NULL`; the deadline has no ownership after focus
  completion.
- Break rows persist `actual_focus_ms` and any `flow_ms` accrued before the
  break.
- Save all transitions through the existing application `writeQueue`.

Backward compatibility:

- A legacy focusing or paused row with no deadline derives:

  ```text
  started_at + planned_duration_ms + accumulated_pause_ms
  ```

- The derived deadline is persisted on the next ordinary session save.
- A legacy focusing row already past its derived deadline recovers into
  quiet Flow at the derived deadline without alarm playback.
- A legacy awaiting-decision row recovers into quiet Flow at
  `focus_completed_at`.
- Existing completed history rows remain unchanged.

Recovery always uses wall-clock timestamps. It never persists a remaining
duration counter.

## Warning Coordination

Warning coordination belongs outside the pure session state machine.

A focused warning controller consumes:

- Current session state.
- Current wall-clock time.
- Validated warning preset.
- Window foreground state.
- Notification adapter.

It owns:

- The deadline for which a warning was last announced.
- Whether the centered prompt is currently visible.
- Exactly-once native notification dispatch per deadline.
- Clearing its cycle marker when the deadline changes.

It does not own:

- Countdown math.
- Session transitions.
- Alarm playback.
- Settings persistence.
- Workspace navigation.

Navigation and opening Settings never reset the warning marker. Both the
full timer and compact timer presentations consume the same warning state,
so changing workspaces cannot duplicate or lose the prompt.

## Alarm Sequence

Refactor tone playback so its duration and cancellation are explicit.

The existing tone catalog and tone IDs remain unchanged. Add a small alarm
sequence controller that:

- Plays the currently selected tone exactly three times.
- Starts the next repetition only after the previous tone schedule ends.
- Uses one cancellation generation or token.
- Ignores stale timeout or playback completions.
- Allows only one completion sequence at a time.
- Exposes `start(toneId)` and `cancel()`.
- Safely no-ops when Web Audio is unavailable.

Cancel the sequence on:

- Continue focusing.
- Take break now.
- Take a break from overtime.
- End session.
- Pause during quiet overtime.
- Session deletion or Delete All Data.
- Component teardown.

The session transitions into Flow independently of audio success.

Tone preview in Settings remains a single playback and must not start a
three-repetition alarm sequence. Starting a preview first cancels any
completion sequence, then plays the selected preview once. Overlapping
audio is not allowed.

## Native Notifications

Use the official Tauri notification plugin behind a local adapter. The
adapter keeps browser-safe development mode free from Tauri imports and
side effects.

The adapter provides:

```text
ensurePermission(): Promise<boolean>
notifyWarning(task, leadLabel): Promise<void>
notifyCompletion(task): Promise<void>
focusMainWindow(): Promise<void>
dispose(): Promise<void>
```

Permission behavior:

- Do not request permission at application launch.
- On the first focus start with warnings enabled, check permission and
  request it if the platform reports a promptable state.
- Permission checking and prompting never delay or cancel the focus-start
  transition.
- Do not repeatedly prompt after denial.
- A denial or plugin error leaves the timer and in-app prompt fully
  functional.
- Off does not request permission.

Dispatch behavior:

- If the main window is foregrounded, do not send a native warning.
- If it is backgrounded or minimized, send one silent native warning per
  deadline.
- At zero, send one silent completion notification when backgrounded.
- Native notifications contain the task text and no note or parked-thought
  content.
- Activating a notification focuses the existing main window and reveals
  the centered prompt.
- Native notifications must not play their own sound; the app's selected
  three-tone sequence is the only audible completion cue.

Native action buttons, scheduled notifications after the process exits,
and tray-only background execution are deferred.

## Error Handling

- Invalid warning settings independently use the 30-second default.
- A failed setting write keeps the selected value in memory and uses the
  existing per-key Retry behavior.
- Notification permission denial is not an application error.
- Notification send or activation failures are logged and otherwise
  ignored.
- Web Audio failure never blocks the Flow transition or prompt.
- A failed session save uses the existing nonblocking persistence error
  path; state-machine behavior is not rolled back.
- Overlapping warning, notification, and alarm callbacks use generation
  guards so stale work cannot apply after a restart, pause, deletion, or
  new session.

## Accessibility

- The centered prompt does not move focus automatically.
- A polite live-region announcement occurs once per cycle.
- Buttons remain reachable in normal document order.
- The prompt is not marked modal.
- Keyboard users can activate either action without leaving the timer
  workspace.
- Focus indicators use semantic theme tokens and meet the existing
  contrast checks.
- Mobile actions retain at least 44 by 44 CSS-pixel targets.
- Reduced-motion preference removes prompt transitions.
- Native notification permission denial never removes the accessible
  in-app path.

## Testing

### Pure state-machine tests

Cover:

- Initial deadline creation.
- Remaining-time math from the deadline.
- Pause and resume shifting the deadline.
- Continue focusing resetting a full same-duration cycle.
- Unlimited repeated restarts under the same session ID.
- Actual focus accumulation across restarts and pauses.
- Take break now before zero.
- Exact-deadline transition into Flow.
- Flow elapsed time after a late render tick.
- Take break from Flow and preserve Flow duration.
- End session from Flow.
- Invalid transition rejection.

### Persistence and migration tests

Cover:

- Version 5 adds `focus_deadline_at`.
- Every active state round-trips exactly.
- Break round-trips actual focus and prior Flow time.
- Legacy active rows derive a deadline.
- Legacy overdue rows recover into Flow at the historical deadline.
- Legacy awaiting-decision rows recover into Flow.
- Completed history rows remain unchanged.

### Warning-controller tests

Use fake time and deferred adapters to prove:

- Every preset threshold.
- Off never warns.
- A lead longer than the interval warns immediately.
- One announcement and one native notification per deadline.
- Pause hides without duplicating on resume.
- Continue creates a new warning identity.
- Navigation and Settings changes do not duplicate a warning.
- Foreground suppresses native warning.
- Background sends it.
- Denial and adapter failure preserve the in-app prompt.
- Stale callbacks cannot apply after a deadline reset or teardown.

### Alarm-controller tests

Use fake timers and an injected single-tone player to prove:

- Exactly three sequential repetitions.
- No overlap.
- Every required action cancels remaining repetitions.
- Starting a newer sequence invalidates an older one.
- Tone preview remains single-play.
- Missing Web Audio is a safe no-op.

### Component and application tests

Cover:

- Centered warning copy and actions.
- Centered quiet-overtime copy and actions.
- No modal semantics or focus theft.
- Desktop side-by-side and mobile stacked actions.
- Timer, notes, Parking Lot, navigation, and Settings remain accessible.
- Continue keeps the same session, note, task, and parked thoughts.
- Take break now records actual focus.
- Zero transitions once, starts one alarm sequence, and shows Flow.
- Recovery into overtime never replays an alarm.
- Compact timer workspaces consume the same warning state.
- Settings hydrate and persist every warning preset.

### Real Tauri verification

Verify on the primary development platform:

1. Permission is not requested at launch.
2. First focus start with a warning enabled requests permission once.
3. Foreground warning uses only the centered in-app prompt.
4. Background warning sends one silent native notification.
5. Activating it focuses the existing main window.
6. At zero, the selected tone plays three times and Flow starts.
7. Taking an action cancels remaining repetitions.
8. Quit and relaunch before a deadline resumes correctly.
9. Quit and relaunch after a deadline restores quiet overtime with no
   stale alarm.
10. Settings and timer remain usable at the configured minimum desktop
    size and at 360 by 640 CSS pixels.

Document platform-specific notification behavior that cannot be exercised
on the primary machine for later Windows and Linux packaging validation.

## Documentation

Update:

- README Settings and focus-completion behavior.
- CHANGELOG Phase 5B entry.
- Tauri capabilities and dependency notes.
- Any manual validation notes required for platform-specific notification
  behavior.

Do not add implementation-phase narration back into README.

## Explicit Deferrals

Phase 5B does not include:

- Touch Grass break prompts or break-duration presets.
- Stand-up or walking prompts.
- Flowstate soundscapes, looping audio, volume, or crossfades.
- New bundled alarm or music assets.
- Sad Trombone or other return tones.
- Native notification action buttons.
- System tray or operation after the process exits.
- Global shortcuts.
- Start at login.
- Single-instance changes beyond what already exists.
- Per-cycle history, cycle counts, or cycle analytics.
- Daily planning or calendar integration.
- Soundscape system-media integration.

## Acceptance Criteria

Phase 5B is complete when:

1. Warning presets persist and default to 30 seconds.
2. The centered prompt appears once per deadline without pausing or
   stealing focus.
3. Continue focusing starts a full same-duration countdown in the same
   session and can repeat indefinitely.
4. Take break now records actual focus and begins a break without alarm.
5. Unanswered zero enters Flow at the exact deadline.
6. The selected tone plays three sequential times and is cancellable.
7. Quiet overtime counts upward and offers Take a break and End session.
8. A break after overtime preserves Flow time.
9. Session restart recovery is correct before and after the deadline and
   never replays stale audio.
10. Background native notifications are silent, permission-safe, and
    nonessential to timer correctness.
11. Existing navigation, notes, Parking Lot, revisions, history, themes,
    alarm selection, deletion coordination, and timer independence remain
    intact.
12. Automated frontend and Rust validation pass.
13. Real Tauri notification, audio, recovery, desktop, and mobile-sized
    checks are recorded.
