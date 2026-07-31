# Phase 5C Resumable Intermissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recoverable Break and Touch Grass intermissions that temporarily freeze an active or paused focus/Flow session, alert once at the intermission deadline, and return to the exact prior timer state while recording separate cumulative totals.

**Architecture:** Extend the pure timestamp-injected session state machine with one explicit `intermission` state containing a frozen paused focus/Flow snapshot. Keep cumulative intermission totals on every non-idle session state so they survive multiple intermissions, completion, persistence, recovery, history, and export. Integrate the new state through the existing shared save queue, alarm sequence, notification adapter, settings controller, full timer, and compact timer surfaces without creating a parallel timer owner.

**Tech Stack:** Svelte 5 runes, TypeScript, Vitest, Tauri 2, Rust, SQLite/sqlx, Web Audio API.

## Global Constraints

- Preserve the existing post-focus `break` state and its Review-ending behavior.
- Keep `session.ts` pure: no `Date.now()`, browser APIs, audio, persistence, or Svelte state.
- Use approved duration cycles only: Break `5/10`, Touch Grass `15/30/45/60`.
- Never auto-return from an intermission; deadline expiry enters quiet upward overtime.
- Recovery after expiry is silent and must not replay the return alarm or notification.
- Route every session and setting write through the existing shared FIFO queue.
- Keep return-tone selection separate from focus-completion-tone selection.
- Do not implement soundscapes, hydration, standing reminders, custom durations, planner, calendar, or network music providers in this phase.
- Maintain at least 44 by 44 CSS pixel action targets, keyboard access, reduced-motion behavior, and 360 by 640 layout support.
- Add behavior through focused helpers/components; avoid duplicate full/compact timer logic and speculative abstractions.

---

## Task 1: Extend The Pure Session State Machine

**Files:**
- Modify: `src/lib/session.ts`
- Modify: `src/lib/session.test.ts`

- [ ] Add failing tests for starting an intermission from `focusing`, `paused`, `flow`, and `flowPaused`.
- [ ] Add failing tests for rejecting `idle`, `awaitingDecision`, `intermission`, post-focus `break`, and `complete`.
- [ ] Add failing tests for each approved duration and for zero, negative, unknown-kind, and unapproved durations.
- [ ] Add failing tests proving active sources return active and paused sources return paused.
- [ ] Add failing tests proving early and overtime return shift the focus deadline through the existing `resume()` transition.
- [ ] Add failing tests proving Flow elapsed time is frozen during the intermission and continues after return.
- [ ] Add failing tests for separate cumulative Break and Touch Grass totals across multiple intermissions.
- [ ] Add failing tests proving all completion paths preserve the cumulative totals.

Introduce shared totals on every non-idle state:

```ts
export interface IntermissionTotals {
  breakIntermissionMs: number;
  touchGrassMs: number;
}

export type IntermissionKind = 'break' | 'touchGrass';
export type IntermissionReturnStatus = 'focusing' | 'paused' | 'flow' | 'flowPaused';
export type FrozenIntermissionReturnState = PausedState | FlowPausedState;

interface IntermissionState extends IntermissionTotals {
  status: 'intermission';
  kind: IntermissionKind;
  intermissionStartedAt: number;
  intermissionDeadlineAt: number;
  intermissionReturnStatus: IntermissionReturnStatus;
  returnState: FrozenIntermissionReturnState;
  // sessionId/task and the timer fields are read from returnState.
}
```

- [ ] Export immutable duration option maps and a validator from `session.ts`:

```ts
export const INTERMISSION_DURATION_OPTIONS_MS = {
  break: [5 * 60_000, 10 * 60_000],
  touchGrass: [15 * 60_000, 30 * 60_000, 45 * 60_000, 60 * 60_000],
} as const;
```

- [ ] Initialize both totals to zero in `startFocus()` and carry them explicitly through every constructor that does not use object spread.
- [ ] Implement `startIntermission(state, kind, durationMs, now)` by using `pause(state, now)` for active states and preserving paused states as-is.
- [ ] Implement `returnFromIntermission(state, now)` by adding actual elapsed time to the matching total and using `resume(frozen, now)` only when `intermissionReturnStatus` was active.
- [ ] Implement pure display helpers:

```ts
getIntermissionRemainingMs(state, now): number | null
getIntermissionOvertimeMs(state, now): number | null
isIntermissionDue(state, now): boolean
```

- [ ] Make duplicate `I'm back` calls harmless at the application boundary by rejecting non-intermission input without mutating state.
- [ ] Run `npm test -- --run src/lib/session.test.ts`.
- [ ] Commit: `feat: add resumable intermission state`

## Task 2: Persist And Recover Intermissions

**Files:**
- Modify: `src-tauri/src/migrations.rs`
- Modify: `src/lib/persistence.ts`
- Modify: `src/lib/persistence.test.ts`
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/memoryRepository.test.ts`

- [ ] Add a failing Rust migration test for the new session columns.
- [ ] Add migration version 7:

```sql
ALTER TABLE sessions ADD COLUMN intermission_kind TEXT;
ALTER TABLE sessions ADD COLUMN intermission_started_at INTEGER;
ALTER TABLE sessions ADD COLUMN intermission_deadline_at INTEGER;
ALTER TABLE sessions ADD COLUMN intermission_return_status TEXT;
ALTER TABLE sessions ADD COLUMN break_intermission_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN touch_grass_ms INTEGER NOT NULL DEFAULT 0;
```

- [ ] Extend `SessionRow` and `EMPTY_ROW_FIELDS` with those exact fields.
- [ ] Add failing round-trip tests for all four return statuses, both kinds, pre-deadline recovery, overtime recovery, returned sessions, and completed totals.
- [ ] Serialize `status: 'intermission'` with the frozen return state's existing focus/Flow fields plus the four active intermission columns.
- [ ] Serialize cumulative totals for every non-idle state; clear only the four active intermission columns after return.
- [ ] Deserialize legacy null totals as zero.
- [ ] Validate intermission rows as one coherent record. Throw a descriptive error when kind/start/deadline/return status is partial, the kind/status is unknown, required frozen focus/Flow fields are absent, or paused/active return metadata contradicts the frozen snapshot.
- [ ] Recover an expired intermission unchanged so App renders quiet overtime without invoking audio or notification code.
- [ ] Update the Tauri upsert column list, conflict-update list, placeholders, and bound values together.
- [ ] Add a memory-repository test proving an active intermission and its totals survive save/load.
- [ ] Run `npm test -- --run src/lib/persistence.test.ts src/lib/memoryRepository.test.ts`.
- [ ] Run `cargo test migrations --manifest-path src-tauri/Cargo.toml`.
- [ ] Commit: `feat: persist resumable intermissions`

## Task 3: Add Duration Cycling And Shared Controls

**Files:**
- Create: `src/lib/intermissionControls.ts`
- Create: `src/lib/intermissionControls.test.ts`
- Create: `src/lib/IntermissionControls.svelte`
- Create: `src/lib/IntermissionControls.test.ts`
- Modify: `src/lib/Timer.svelte`
- Modify: `src/lib/Timer.test.ts`
- Modify: `src/lib/ActiveTimerBar.svelte`
- Modify: `src/lib/ActiveTimerBar.test.ts`

- [ ] Add failing pure tests for ordered wraparound cycling of both duration sets.
- [ ] Implement one generic `nextIntermissionDuration(kind, currentMs)` using `INTERMISSION_DURATION_OPTIONS_MS`; fall back to that kind's default when given an unknown current value.
- [ ] Add component tests for two action buttons, two neighboring cycle buttons, current-duration accessible names, click callbacks, and narrow-layout structure.
- [ ] Build `IntermissionControls.svelte` as a restrained “Step away” strip. Use clear text labels for the two unfamiliar actions and keep each cycle button adjacent to its action.
- [ ] Accept the shared controls as an optional Svelte snippet in `Timer.svelte` and `ActiveTimerBar.svelte` so App owns one set of callbacks and duration selections.
- [ ] Render the snippet below ordinary timer controls in both full and compact views for focus, paused focus, Flow, paused Flow, and quiet overtime.
- [ ] Do not render it for idle, completed Review, or the existing post-focus Break.
- [ ] Enforce stable 44-pixel minimum targets and stack the two action groups at narrow widths without horizontal overflow.
- [ ] Run `npm test -- --run src/lib/intermissionControls.test.ts src/lib/IntermissionControls.test.ts src/lib/Timer.test.ts src/lib/ActiveTimerBar.test.ts`.
- [ ] Commit: `feat: add always available intermission controls`

## Task 4: Build The Sparse Intermission Timer Surface

**Files:**
- Create: `src/lib/IntermissionTimer.svelte`
- Create: `src/lib/IntermissionTimer.test.ts`
- Modify: `src/lib/ActiveTimerBar.svelte`
- Modify: `src/lib/ActiveTimerBar.test.ts`

- [ ] Add failing component tests for Break and Touch Grass labels, exact prompt copy, countdown, overtime, and `I'm back`.
- [ ] Implement a full timer surface with:
  - `Break` plus practical away-from-screen copy;
  - `Touch Grass` plus `Go for a frickin' walk.`;
  - remaining countdown before the deadline;
  - upward quiet overtime after the deadline;
  - one `I'm back` command.
- [ ] Announce the intermission change once with a polite live region; do not move focus.
- [ ] Use a warm but restrained Touch Grass treatment with text/icon distinction in addition to color.
- [ ] Extend the compact bar with an `intermission` mode and `I'm back`, retaining navigation and Settings access from the app shell.
- [ ] Verify long task text truncates/wraps without resizing controls.
- [ ] Run `npm test -- --run src/lib/IntermissionTimer.test.ts src/lib/ActiveTimerBar.test.ts`.
- [ ] Commit: `feat: add intermission timer surfaces`

## Task 5: Add A Separate Return-Tone Setting

**Files:**
- Modify: `src/lib/sound.ts`
- Modify: `src/lib/sound.test.ts`
- Modify: `src/lib/appearance.ts`
- Modify: `src/lib/appearance.test.ts`
- Modify: `src/lib/settingsController.svelte.ts`
- Modify: `src/lib/settingsController.test.ts`
- Modify: `src/lib/SettingsDrawer.svelte`
- Modify: `src/lib/SettingsDrawer.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

- [ ] Add a return-tone catalog with a calm default and a plainly labeled `Sad Trombone` option. Keep it separate from `TONE_CATALOG` so focus-completion choices do not silently change.
- [ ] Reuse the existing Web Audio scheduling/player path for both catalogs; add catalog-specific validation and fallback helpers.
- [ ] Add `selectedReturnToneId` to `AppSettings`, `APP_SETTING_KEYS`, defaults, parsing, controller request sequencing, and startup hydration.
- [ ] Add a second selector in the Audio section of Settings with preview behavior and per-key retry state.
- [ ] Ensure preview plays once, changes no timer state, and nothing plays during application startup.
- [ ] Keep playback errors nonblocking and logged consistently with existing tone failures.
- [ ] Run `npm test -- --run src/lib/sound.test.ts src/lib/appearance.test.ts src/lib/settingsController.test.ts src/lib/SettingsDrawer.test.ts src/App.test.ts`.
- [ ] Commit: `feat: add return tone preference`

## Task 6: Integrate Intermission Lifecycle, Alarm, And Notification

**Files:**
- Modify: `src/lib/nativeNotifications.ts`
- Modify: `src/lib/nativeNotifications.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

- [ ] Add failing application tests for starting both intermission kinds from active/paused focus and active/paused Flow.
- [ ] Add failing tests for one-shot deadline behavior, three return-tone plays, silent background notification, quiet overtime, no automatic resume, and no replay after recovery.
- [ ] Add failing tests for `I'm back` from active and paused return statuses and for duplicate clicks.
- [ ] Keep the selected Break and Touch Grass durations in App memory only, initialized to 5 and 15 minutes.
- [ ] Add one `startSelectedIntermission(kind)` handler that:
  - cancels the focus warning and focus completion alarm;
  - calls the pure transition;
  - applies the result through the existing `applyTransition()` persistence path;
  - does not touch notes, parked thoughts, revision state, session ID, or workspace navigation.
- [ ] Add one `handleReturnFromIntermission()` handler using the pure transition and existing persistence path.
- [ ] Add an independent return `alarmSequence` using `selectedReturnToneId`; stop it on `I'm back`, replacement session, deletion, and teardown.
- [ ] Detect a live deadline once per intermission identity/deadline, play the return tone exactly three times, and send one silent native notification only while backgrounded.
- [ ] Mark recovered intermissions as already observed during startup so overdue recovery is silent.
- [ ] Extend `NativeNotificationAdapter` with a narrowly named intermission-return method while preserving permission-denial-as-no-op behavior.
- [ ] Render `IntermissionControls` through one App-owned snippet in both full and compact timers.
- [ ] Render `IntermissionTimer` on the focus workspace while `status === 'intermission'`; keep the compact version visible over History/Revisions.
- [ ] Treat `intermission` as an active session everywhere current code narrows `idle`/`complete`, including note editing, thought parking, revision access, and delete/reset cleanup.
- [ ] Expose the explicit `intermission` session status as the Phase 5D soundscape lifecycle hook; do not add a soundscape controller yet.
- [ ] Run `npm test -- --run src/App.test.ts src/lib/nativeNotifications.test.ts`.
- [ ] Commit: `feat: integrate resumable intermission lifecycle`

## Task 7: Surface Totals In Review, History, And Export

**Files:**
- Modify: `src/lib/SessionReview.svelte`
- Modify: `src/lib/SessionReview.test.ts`
- Modify: `src/lib/history.ts`
- Modify: `src/lib/history.test.ts`
- Modify: `src/lib/HistoryView.svelte`
- Modify: `src/lib/export.ts`
- Modify: `src/lib/export.test.ts`

- [ ] Add failing tests for omitted zero totals and visible nonzero `Breaks` and `Touch Grass` totals.
- [ ] Carry both totals into `CompleteState` through every completion path.
- [ ] Extend `SessionSummary` and history rendering with the two optional metrics while retaining post-focus `Break`.
- [ ] Extend JSON and Markdown export entries with the two totals, omitting zero values consistently.
- [ ] Bump `EXPORT_FORMAT_VERSION` because the exported schema gains fields.
- [ ] Confirm `totalElapsedMs` remains unchanged wall-clock elapsed time and already includes intermissions.
- [ ] Run `npm test -- --run src/lib/SessionReview.test.ts src/lib/history.test.ts src/lib/export.test.ts`.
- [ ] Commit: `feat: report intermission time`

## Task 8: Full Verification And Documentation

**Files:**
- Modify: `README.md` only if user-facing usage text requires it
- Modify: `.changelog`
- Modify: `docs/superpowers/specs/2026-07-30-phase-5c-resumable-intermissions-design.md` only for implementation-discovered clarifications that do not change approved behavior

- [ ] Update `.changelog` with Phase 5C behavior and migration version.
- [ ] Run `npm run check`.
- [ ] Run `npm test -- --run`.
- [ ] Run `npm run build`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] Run `cargo check --manifest-path src-tauri/Cargo.toml`.
- [ ] Start the app and manually verify desktop and 360 by 640 layouts.
- [ ] Verify all theme families in light/dark/system where applicable, long task text, keyboard order, 44-pixel targets, and reduced motion.
- [ ] Verify active and paused focus return, active and paused Flow return, quiet-overtime return, early return, intermission overtime, and quit/relaunch recovery.
- [ ] Verify the return tone plays three times only for live expiry, `Sad Trombone` is optional and plainly labeled, and background notification is silent.
- [ ] Verify notes, parked thoughts, session ID, History/Revisions navigation, and settings remain usable while the timer is running.
- [ ] Inspect `git diff --check`, `git status`, and the final diff against `origin/main`.
- [ ] Request an independent code review before opening the pull request.
- [ ] Commit any final documentation or verification fixes with a scoped message.

## Self-Review Checklist

- [ ] No intermission code duplicates focus remaining-time or Flow elapsed-time formulas.
- [ ] Cumulative totals exist on all live/complete states and cannot disappear after a second intermission.
- [ ] Existing post-focus Break behavior and labels are unchanged.
- [ ] No timer, note, thought, revision, or setting write bypasses the shared queue.
- [ ] No recovered deadline triggers old audio or a synthetic notification.
- [ ] Return tone and focus-completion tone are independently persisted and previewed.
- [ ] Full and compact controls invoke the same handlers.
- [ ] No Phase 5D soundscape engine or deferred reminder/planner scope leaked into the implementation.
