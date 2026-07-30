# Phase 5B Gentle Focus Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable, nonblocking focus warning; same-session focus restarts; exact-deadline quiet overtime; a cancellable three-tone completion alarm; and best-effort silent native notifications without weakening timer recovery or the existing responsive experience.

**Architecture:** Keep `src/lib/session.ts` as the deterministic, timestamp-injected source of timer truth. Persist the current focus-cycle deadline in SQLite and derive all countdown, recovery, actual-focus, Flow, and break totals from timestamps. Put warning coordination, alarm sequencing, and native notifications in separate injected controllers; `src/App.svelte` remains the composition root that feeds them current state and applies pure transitions. Reuse one prompt component in the full timer and compact timer presentations so navigation and Settings never reset completion behavior.

**Tech Stack:** Svelte 5 runes, TypeScript 6, Vitest 4, Testing Library Svelte, Tauri 2, Rust 2021, SQLite migrations through `tauri-plugin-sql`, Web Audio API, and the official Tauri notification plugin.

## Global Constraints

- Treat `docs/superpowers/specs/2026-07-29-phase-5b-gentle-focus-completion-design.md` as authoritative.
- Rebase onto the merged Phase 5A result before implementation if PR #13 is not yet the branch base.
- Use TDD for every task. Run the focused test first and verify that it fails for the intended reason before implementation.
- Keep the timer wall-clock based. Never persist a decrementing remaining-time value.
- Keep the existing 250 ms clock tick independent of `workspaceView`, Settings visibility, notes, and Parking Lot.
- Keep exactly one application `TaskQueue`; all session and setting writes continue through it.
- Keep `awaitingDecision` deserialization compatibility for old rows, but no Phase 5B live transition may create that status.
- Do not replay alarms or warning announcements during startup recovery.
- Notification permission and delivery must never block a timer transition.
- Notification bodies may contain the task but never note or parked-thought content.
- Keep the existing tone IDs and one-shot Settings preview behavior.
- Do not add notification action buttons. The official Tauri action API is mobile-only; verify normal desktop notification activation on the primary platform and record any platform limitation.
- Keep all prompt actions nonmodal, in normal document order, at least 44 by 44 CSS pixels, and usable at 360 by 640.
- Do not add Touch Grass, stand/walk prompts, soundscapes, volume controls, new audio assets, tray behavior, global shortcuts, start-at-login, planner/calendar work, or per-cycle analytics.
- Never delete or reset the user's SQLite database, app-managed Markdown notes, revisions, settings, or other persistent app data as part of development or manual validation. Use temporary databases, test fixtures, or an explicitly isolated development profile for destructive-path tests.
- Keep approved specs, plans, migration history, and changelog entries under version control. They are project records, not temporary implementation debris.
- Remove tracked source files only when the plan explicitly identifies them as obsolete, `rg` proves there are no remaining callers, focused tests pass, and the deletion is staged visibly with Git. Do not use broad filesystem deletion commands.
- Stop temporary development servers after validation. Remove a temporary worktree only when it is clean and its commits are safely present on a pushed branch.
- Keep the feature branch and worktree throughout implementation, review, and requested revisions. After the PR is merged and no further updates are expected, verify the merge, use non-forcing Git/worktree cleanup (`git worktree remove`, `git branch -d`), and remove the remote branch only when repository policy or explicit approval allows it. Never use `git branch -D`, `git reset --hard`, or manual directory deletion for lifecycle cleanup.
- Commit after each independently green task.

## Implementation Deviations

**2026-07-30:** Task 5's `focusMainWindow()`/notification-activation
wiring (referenced in this plan's Task 5 interfaces and Step 4) was
implemented as written, then removed. The installed
`tauri-plugin-notification` 2.3.3's desktop backend does not implement or
emit a notification-activation event — verified against the plugin's own
Rust source, not just its TypeScript declarations — so "normal desktop
notification activation," which Step 4 and the Global Constraints above
both call for verifying manually, cannot be exercised: there is nothing
for the OS to hand back to the app on desktop. The wiring was dead code
that could never fire on macOS, Windows, or Linux, and has been deleted
along with its tests. Notification delivery itself is otherwise
implemented and tested exactly as this plan's Task 5 specifies. See the
matching amendment in the Phase 5B design spec for the product-level
framing (deferred, not an accepted requirement) and README/CHANGELOG for
the user-facing wording.

## File Structure

### New files

- `src/lib/focusWarning.ts`: warning preset labels, pure visibility calculation, and exactly-once deadline coordinator.
- `src/lib/focusWarning.test.ts`: threshold, cycle identity, foreground/background, stale callback, and teardown tests.
- `src/lib/alarmSequence.ts`: injected three-repetition alarm controller with cancellation generation.
- `src/lib/alarmSequence.test.ts`: sequential playback, exact count, replacement, and cancellation tests.
- `src/lib/nativeNotifications.ts`: browser-safe, best-effort Tauri notification adapter and permission state.
- `src/lib/nativeNotifications.test.ts`: permission, denial, send failure, no-op browser, and disposal tests.
- `src/lib/FocusCompletionPrompt.svelte`: shared warning and quiet-overtime prompt.
- `src/lib/FocusCompletionPrompt.test.ts`: copy, semantics, actions, focus behavior, and responsive CSS tests.

### Modified files

- `src/lib/appearance.ts`, `src/lib/appearance.test.ts`: typed `focusWarningLeadMs` setting, default, options, parser, and numeric conversion.
- `src/lib/settingsController.svelte.ts`, `src/lib/settingsController.test.ts`: sequence tracking for the new setting.
- `src/lib/SettingsDrawer.svelte`, `src/lib/SettingsDrawer.test.ts`: Timer section and focus-warning preset selector.
- `src/lib/session.ts`, `src/lib/session.test.ts`: deadline-owned focus states, restart, direct Flow completion, early break, Flow-to-break totals, and exact accounting.
- `src/lib/persistence.ts`, `src/lib/persistence.test.ts`: deadline and break-total serialization plus legacy recovery normalization.
- `src/lib/tauriRepository.ts`, `src/lib/memoryRepository.test.ts`: upsert the deadline column and verify stored behavior.
- `src-tauri/src/migrations.rs`: migration version 5 and schema test.
- `src/lib/sound.ts`, `src/lib/sound.test.ts`: expose exact tone schedule duration while preserving one-shot playback.
- `src/lib/Timer.svelte`, `src/lib/Timer.test.ts`: quiet-overtime label and prompt slot.
- `src/lib/ActiveTimerBar.svelte`, `src/lib/ActiveTimerBar.test.ts`: compact warning/overtime prompt without a special decision state.
- `src/App.svelte`, `src/App.test.ts`: controller composition, permission timing, exact-deadline transition, actions, cancellation, recovery, and shared prompt state.
- `package.json`, `package-lock.json`: official notification JavaScript dependency.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: official notification Rust dependency.
- `src-tauri/src/lib.rs`: notification plugin initialization and capability regression test.
- `src-tauri/capabilities/default.json`: `notification:default`.
- `README.md`, `CHANGELOG.md`: user behavior, setting, notification caveats, and Phase 5B release notes.

---

### Task 1: Focus Warning Setting Domain

**Files:**
- Modify: `src/lib/appearance.ts`
- Modify: `src/lib/appearance.test.ts`
- Modify: `src/lib/settingsController.svelte.ts`
- Modify: `src/lib/settingsController.test.ts`
- Modify: `src/lib/SettingsDrawer.svelte`
- Modify: `src/lib/SettingsDrawer.test.ts`

**Interfaces:**

```ts
export type FocusWarningLeadMs =
  | 'off'
  | '30000'
  | '60000'
  | '120000'
  | '300000';

export const FOCUS_WARNING_OPTIONS: ReadonlyArray<{
  value: FocusWarningLeadMs;
  label: string;
}>;

export function parseFocusWarningLeadMs(value: unknown): FocusWarningLeadMs;
export function focusWarningLeadToMs(value: FocusWarningLeadMs): number | null;
```

`AppSettings` gains `focusWarningLeadMs`. `APP_SETTING_KEYS.focusWarningLeadMs` is exactly `focusWarningLeadMs`. The default is `'30000'`.

- [ ] **Step 1: Write failing setting-domain tests**

Add table-driven assertions for all five stored strings, malformed values, `null`, the 30-second fallback, exact labels, and numeric conversion:

```ts
expect(parseFocusWarningLeadMs('off')).toBe('off');
expect(parseFocusWarningLeadMs('60000')).toBe('60000');
expect(parseFocusWarningLeadMs(30000)).toBe('30000');
expect(parseFocusWarningLeadMs('15')).toBe('30000');
expect(focusWarningLeadToMs('off')).toBeNull();
expect(focusWarningLeadToMs('300000')).toBe(300_000);
expect(APP_SETTING_KEYS.focusWarningLeadMs).toBe('focusWarningLeadMs');
```

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
npx vitest run src/lib/appearance.test.ts src/lib/settingsController.test.ts
```

Expected: FAIL because the setting type, parser, default, and request-sequence key do not exist.

- [ ] **Step 3: Implement the typed setting**

Use stored string values so `SettingsController.persist(key, value: string)` remains type-safe. Extend `DEFAULT_APP_SETTINGS`, `APP_SETTING_KEYS`, and the controller's complete `Record<AppSettingKey, number>`.

- [ ] **Step 4: Write failing Settings drawer tests**

Assert a Timer section appears above Audio, the `Focus warning` control exposes Off/30 seconds/1 minute/2 minutes/5 minutes, selecting a preset calls:

```ts
controller.set('focusWarningLeadMs', '120000');
```

Also assert a failed write shows `Retry focus warning` and calls `controller.retry('focusWarningLeadMs')`.

- [ ] **Step 5: Implement the compact preset selector**

Use a labeled `<select>` in a Timer section. Do not add descriptive feature copy or a card around the section.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run src/lib/appearance.test.ts src/lib/settingsController.test.ts src/lib/SettingsDrawer.test.ts
npm run check
git add src/lib/appearance.ts src/lib/appearance.test.ts src/lib/settingsController.svelte.ts src/lib/settingsController.test.ts src/lib/SettingsDrawer.svelte src/lib/SettingsDrawer.test.ts
git commit -m "feat: add focus warning preference"
```

---

### Task 2: Deadline-Owned Session State Machine

**Files:**
- Modify: `src/lib/session.ts`
- Modify: `src/lib/session.test.ts`
- Modify: `src/lib/duration.test.ts`
- Modify: `src/lib/history.test.ts`

**State changes:**

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

interface BreakState {
  status: 'break';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  focusCompletedAt: number;
  breakStartedAt: number;
  actualFocusMs: number;
  flowMsBeforeBreak: number;
}
```

**Transitions:**

```ts
export function restartFocusCycle(state: SessionState, now: number): TransitionResult;
export function takeBreakFromFocus(state: SessionState, now: number): TransitionResult;
export function completeFocusIntoFlow(state: SessionState, now: number): TransitionResult;
export function takeBreakFromFlow(state: SessionState, now: number): TransitionResult;
```

- [ ] **Step 1: Write failing deadline tests**

Cover initial `focusDeadlineAt = startedAt + plannedDurationMs`, remaining time from the deadline, due detection, pause freezing, and resume shifting both the deadline and accumulated pause:

```ts
state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
expect(state).toMatchObject({ focusDeadlineAt: t0 + FOCUS_MS });

state = expectOk(pause(state, t0 + 10_000));
state = expectOk(resume(state, t0 + 70_000));
expect(state).toMatchObject({
  accumulatedPauseMs: 60_000,
  focusDeadlineAt: t0 + FOCUS_MS + 60_000,
});
```

- [ ] **Step 2: Write failing transition/accounting tests**

Cover:

- unlimited `restartFocusCycle` calls retaining `sessionId`, task, `startedAt`, duration, and accumulated pauses;
- each restart setting `focusDeadlineAt = now + plannedDurationMs`;
- `takeBreakFromFocus` using action time and accumulated pauses for actual focus, with zero Flow;
- `completeFocusIntoFlow` rejecting early calls and assigning both `focusCompletedAt` and `flowStartedAt` from `focusDeadlineAt`, not a late tick;
- `takeBreakFromFlow` preserving active Flow elapsed time, excluding Flow pauses;
- `endBreak` retaining `actualFocusMs` and `flowMsBeforeBreak`;
- `finishFlow` calculating actual focus across restarted cycles rather than assuming planned duration.

- [ ] **Step 3: Run the state tests and verify failure**

```bash
npx vitest run src/lib/session.test.ts src/lib/duration.test.ts src/lib/history.test.ts
```

Expected: FAIL on missing deadline fields and transitions.

- [ ] **Step 4: Implement deadline ownership and transitions**

Use these calculations:

```ts
const actualFocusMs = Math.max(
  0,
  focusCompletedAt - state.startedAt - state.accumulatedPauseMs,
);

export function getFocusRemainingMs(state: SessionState, now: number): number | null {
  if (state.status !== 'focusing' && state.status !== 'paused') return null;
  const referenceNow = state.status === 'paused' ? state.pausedAt : now;
  return Math.max(0, state.focusDeadlineAt - referenceNow);
}
```

`completeFocusIntoFlow` must set:

```ts
focusCompletedAt: state.focusDeadlineAt,
flowStartedAt: state.focusDeadlineAt,
flowAccumulatedPauseMs: 0,
```

Keep `AwaitingDecisionState` in the union for old-row deserialization only. Remove `completeFocus`, `chooseBreak`, `chooseFlow`, and `chooseFinish` from new application workflows; either retain them as explicitly legacy-only helpers or update all tests/callers so no live path reaches them.

- [ ] **Step 5: Update dependent history/duration fixtures**

Build completed fixtures through direct Flow, early break, overtime break, or finish Flow. Add a history assertion where actual focus exceeds planned focus after a restart.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run src/lib/session.test.ts src/lib/duration.test.ts src/lib/history.test.ts
npm run check
git add src/lib/session.ts src/lib/session.test.ts src/lib/duration.test.ts src/lib/history.test.ts
git commit -m "feat: model focus cycles with exact deadlines"
```

---

### Task 3: Deadline Persistence And Legacy Recovery

**Files:**
- Modify: `src/lib/persistence.ts`
- Modify: `src/lib/persistence.test.ts`
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/memoryRepository.test.ts`
- Modify: `src-tauri/src/migrations.rs`

**Row change:**

```ts
export interface SessionRow {
  // existing fields
  focus_deadline_at: number | null;
}
```

- [ ] **Step 1: Write failing migration test**

Add a migration version 5 test that applies all migrations and asserts `sessions` contains nullable `focus_deadline_at`. Also insert a legacy-looking row before applying version 5 and verify the row survives with a null deadline.

- [ ] **Step 2: Run the Rust test and verify failure**

```bash
cargo test migrations --manifest-path src-tauri/Cargo.toml
```

Expected: FAIL because migration 5 and the column do not exist.

- [ ] **Step 3: Add migration version 5**

Append, never modify earlier migrations:

```rust
Migration {
    version: 5,
    description: "persist current focus cycle deadline",
    sql: "ALTER TABLE sessions ADD COLUMN focus_deadline_at INTEGER;",
    kind: MigrationKind::Up,
}
```

- [ ] **Step 4: Write failing persistence tests**

Cover:

- focusing and paused round trips include `focus_deadline_at`;
- Flow, FlowPaused, Break, Complete, and legacy awaiting rows serialize a null deadline;
- Break persists `actual_focus_ms` and `flow_ms`;
- a legacy active row with null deadline derives `started_at + planned_duration_ms + accumulated_pause_ms`;
- an unexpired legacy row resumes with the derived deadline;
- an expired current or legacy row recovers directly to Flow at its exact deadline;
- an `awaitingDecision` legacy row recovers to Flow at `focus_completed_at`;
- recovered Flow never carries a focus deadline;
- completed rows are unchanged.

- [ ] **Step 5: Run persistence tests and verify failure**

```bash
npx vitest run src/lib/persistence.test.ts src/lib/memoryRepository.test.ts
```

- [ ] **Step 6: Implement serialization and recovery normalization**

Deserialize active states with:

```ts
const deadline =
  row.focus_deadline_at ??
  row.started_at! + row.planned_duration_ms! + row.accumulated_pause_ms!;
```

Normalize expired focus and legacy waiting states directly into Flow. Do not call audio or notification code from persistence.

For old Break rows lacking the Phase 5B totals, fall back independently:

```ts
actualFocusMs: row.actual_focus_ms ?? row.planned_duration_ms!,
flowMsBeforeBreak: row.flow_ms ?? 0,
```

- [ ] **Step 7: Extend the SQLite upsert**

Add `focus_deadline_at` to the insert columns, placeholders, conflict update, and bound array in `src/lib/tauriRepository.ts`. Count placeholders and parameters together; add a repository test or source assertion that guards the column's presence.

- [ ] **Step 8: Verify and commit**

```bash
npx vitest run src/lib/persistence.test.ts src/lib/memoryRepository.test.ts
cargo test migrations --manifest-path src-tauri/Cargo.toml
npm run check
git add src/lib/persistence.ts src/lib/persistence.test.ts src/lib/tauriRepository.ts src/lib/memoryRepository.test.ts src-tauri/src/migrations.rs
git commit -m "feat: persist and recover focus deadlines"
```

---

### Task 4: Cancellable Three-Tone Alarm

**Files:**
- Modify: `src/lib/sound.ts`
- Modify: `src/lib/sound.test.ts`
- Create: `src/lib/alarmSequence.ts`
- Create: `src/lib/alarmSequence.test.ts`

**Interfaces:**

```ts
export function getToneDurationMs(toneId: string): number;

export interface AlarmSequence {
  start(toneId: string): void;
  cancel(): void;
}

export function createAlarmSequence(options: {
  playOnce: (toneId: string) => void;
  durationMs: (toneId: string) => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  repetitions?: number;
}): AlarmSequence;
```

- [ ] **Step 1: Write failing tone-duration tests**

Derive duration from the end of the final scheduled note:

```ts
const schedule = buildToneSchedule(getToneDefinition('gentle-chime'));
const last = schedule.at(-1)!;
expect(getToneDurationMs('gentle-chime')).toBe(
  Math.ceil((last.startOffsetS + last.durationS) * 1000),
);
```

- [ ] **Step 2: Write failing alarm-controller tests with fake timers**

Prove:

- start plays once immediately;
- the next play happens only after the previous schedule duration;
- exactly three plays occur;
- `cancel()` prevents every remaining repetition;
- `start()` invalidates a prior sequence and leaves one current sequence;
- stale timeout callbacks cannot restart cancelled work;
- unknown IDs use the existing default duration;
- `repetitions: 3` is the production default.

- [ ] **Step 3: Run and verify failure**

```bash
npx vitest run src/lib/sound.test.ts src/lib/alarmSequence.test.ts
```

- [ ] **Step 4: Implement duration and generation cancellation**

Use one monotonically increasing generation and track the one pending timeout:

```ts
function cancel() {
  generation += 1;
  if (timeout !== null) clearTimeoutFn(timeout);
  timeout = null;
}

function start(toneId: string) {
  cancel();
  const run = generation;
  let played = 0;
  const playNext = () => {
    if (run !== generation || played >= repetitions) return;
    playOnce(toneId);
    played += 1;
    if (played < repetitions) {
      timeout = setTimeoutFn(playNext, durationMs(toneId));
    }
  };
  playNext();
}
```

Do not change `playTone(id)` into the three-tone API. Settings preview must remain one call.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/sound.test.ts src/lib/alarmSequence.test.ts
npm run check
git add src/lib/sound.ts src/lib/sound.test.ts src/lib/alarmSequence.ts src/lib/alarmSequence.test.ts
git commit -m "feat: add cancellable completion alarm sequence"
```

---

### Task 5: Browser-Safe Native Notification Adapter

**Files:**
- Create: `src/lib/nativeNotifications.ts`
- Create: `src/lib/nativeNotifications.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**

```ts
export interface NativeNotificationAdapter {
  ensurePermission(): Promise<boolean>;
  notifyWarning(task: string, leadLabel: string): Promise<void>;
  notifyCompletion(task: string): Promise<void>;
  focusMainWindow(): Promise<void>;
  dispose(): Promise<void>;
}

export function createNativeNotificationAdapter(options?: {
  isTauriFn?: () => boolean;
  loadNotificationPlugin?: () => Promise<NotificationPluginPort>;
  loadWindow?: () => Promise<WindowPort>;
  logError?: (message: string, error: unknown) => void;
}): NativeNotificationAdapter;
```

- [ ] **Step 1: Write failing adapter tests**

Use injected ports to prove:

- browser mode is a no-op and never imports the plugin;
- granted permission is reused;
- a prompt is requested only once per adapter lifetime;
- denied permission is remembered and never re-prompted;
- concurrent `ensurePermission()` calls share one in-flight request;
- warning/completion sends are silent and contain only title, task, and lead label;
- send failures resolve without throwing and are logged;
- `focusMainWindow()` shows, unminimizes, and focuses the existing window;
- `dispose()` invalidates late permission/send completions.

- [ ] **Step 2: Run and verify failure**

```bash
npx vitest run src/lib/nativeNotifications.test.ts
```

- [ ] **Step 3: Install and wire the official plugin**

```bash
npm install @tauri-apps/plugin-notification
cargo add tauri-plugin-notification --manifest-path src-tauri/Cargo.toml
```

Initialize:

```rust
.plugin(tauri_plugin_notification::init())
```

Grant:

```json
"notification:default"
```

Extend the existing Rust capability regression test so it asserts the permission is present.

- [ ] **Step 4: Implement dynamic browser-safe loading**

Only load `@tauri-apps/plugin-notification` after `isTauriFn()` is true. Use documented `isPermissionGranted`, `requestPermission`, and `sendNotification`. Include `silent: true` and omit `sound`.

Only `ensurePermission()` may request permission. `notifyWarning()` and `notifyCompletion()` send only when the adapter already knows permission is granted; they must never trigger a prompt themselves. This preserves the rule that Off never requests permission, including at completion.

Do not register action types: Tauri documents that API as mobile-only and native action buttons are deferred. `focusMainWindow()` is still implemented for supported activation hooks and tests. On desktop, normal notification-click activation must be verified manually.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/nativeNotifications.test.ts
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json src/lib/nativeNotifications.ts src/lib/nativeNotifications.test.ts
git commit -m "feat: add best effort native notifications"
```

---

### Task 6: Exactly-Once Focus Warning Coordinator

**Files:**
- Create: `src/lib/focusWarning.ts`
- Create: `src/lib/focusWarning.test.ts`

**Interfaces:**

```ts
export interface FocusWarningInput {
  session: SessionState;
  now: number;
  lead: FocusWarningLeadMs;
  isForeground: boolean;
}

export interface FocusWarningView {
  visible: boolean;
  deadline: number | null;
  leadLabel: string | null;
  announcement: string | null;
}

export interface FocusWarningCoordinator {
  evaluate(input: FocusWarningInput): FocusWarningView;
  dispose(): void;
}

export function createFocusWarningCoordinator(options: {
  notifyWarning: (task: string, leadLabel: string) => Promise<void>;
  logError?: (message: string, error: unknown) => void;
}): FocusWarningCoordinator;
```

- [ ] **Step 1: Write failing pure threshold tests**

Cover every preset, Off, a lead equal to/longer than duration, paused hiding, due focus hiding, non-focus states, and exact threshold equality.

- [ ] **Step 2: Write failing coordination tests**

Prove:

- one announcement string per `focusDeadlineAt`;
- one background notification per deadline;
- foreground suppresses notification without hiding the in-app prompt;
- pause hides and resume re-shows without duplicate announcement/send;
- a restarted deadline is a new cycle;
- changing Off hides immediately;
- changing from Off to a threshold already crossed shows immediately;
- unrelated repeated evaluations model workspace/Settings changes and do not duplicate;
- a stale rejected notification promise after a new deadline is only logged;
- dispose invalidates late async work.

- [ ] **Step 3: Run and verify failure**

```bash
npx vitest run src/lib/focusWarning.test.ts
```

- [ ] **Step 4: Implement one deadline identity**

Track `lastAnnouncedDeadline`, `lastNotifiedDeadline`, and a disposal generation. `evaluate()` is synchronous for view state; dispatch notification with `void Promise.resolve(...).catch(...)`.

Do not store countdown state or call session transitions here.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/focusWarning.test.ts
npm run check
git add src/lib/focusWarning.ts src/lib/focusWarning.test.ts
git commit -m "feat: coordinate focus warnings per deadline"
```

---

### Task 7: Shared Centered Completion Prompt

**Files:**
- Create: `src/lib/FocusCompletionPrompt.svelte`
- Create: `src/lib/FocusCompletionPrompt.test.ts`
- Modify: `src/lib/Timer.svelte`
- Modify: `src/lib/Timer.test.ts`
- Modify: `src/lib/ActiveTimerBar.svelte`
- Modify: `src/lib/ActiveTimerBar.test.ts`
- Delete after all callers are removed: `src/lib/DecisionScreen.svelte`

**Component contract:**

```ts
type Props =
  | {
      kind: 'warning';
      leadLabel: string;
      announcement: string | null;
      onPrimary: () => void;   // Take break now
      onSecondary: () => void; // Continue focusing
    }
  | {
      kind: 'overtime';
      announcement: string | null;
      onPrimary: () => void;   // Take a break
      onSecondary: () => void; // End session
    };
```

- [ ] **Step 1: Write failing prompt component tests**

Assert exact approved copy and action labels for both variants. Assert:

- no `dialog`, `alertdialog`, `aria-modal`, or scrim;
- one `aria-live="polite"` region receives only the non-null announcement;
- render does not move `document.activeElement`;
- both callbacks fire;
- long text can wrap;
- CSS contains maximum 8 px radius, mobile action stacking, 44 px targets, and reduced-motion handling.

- [ ] **Step 2: Run and verify failure**

```bash
npx vitest run src/lib/FocusCompletionPrompt.test.ts
```

- [ ] **Step 3: Implement the prompt**

Render the framed prompt below timer controls, centered in the timer column. Keep the prompt unmounted when not visible; do not call `.focus()` or use a modal role.

- [ ] **Step 4: Extend timer presentation contracts**

Add `displayLabel?: string` to `Timer.svelte` so overtime reads `Quiet overtime` while retaining `mode="flow"` styling. Add an optional prompt snippet:

```svelte
{#if prompt}
  <div class="completion-prompt">
    {@render prompt()}
  </div>
{/if}
```

Add the equivalent prompt snippet to `ActiveTimerBar.svelte` and remove its `awaitingDecision` prop branch. The compact bar must display the same prompt state above History/Revisions, not a separate decision UI.

- [ ] **Step 5: Update tests and safely retire the old screen**

Update Timer and ActiveTimerBar tests for prompt rendering and the `Quiet overtime` label. Then run:

```bash
rg -n "DecisionScreen" src
```

Remove `DecisionScreen.svelte` with `git rm src/lib/DecisionScreen.svelte` only when the component itself is the sole remaining match and the focused component tests are green. If any live caller remains, keep the file and update the plan/caller first.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run src/lib/FocusCompletionPrompt.test.ts src/lib/Timer.test.ts src/lib/ActiveTimerBar.test.ts
npm run check
git add src/lib/FocusCompletionPrompt.svelte src/lib/FocusCompletionPrompt.test.ts src/lib/Timer.svelte src/lib/Timer.test.ts src/lib/ActiveTimerBar.svelte src/lib/ActiveTimerBar.test.ts src/lib/DecisionScreen.svelte
git commit -m "feat: add centered focus completion prompts"
```

---

### Task 8: Application Integration And Lifecycle Cancellation

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Composition:**

```ts
const notificationAdapter = createNativeNotificationAdapter();
const alarmSequence = createAlarmSequence({
  playOnce: playTone,
  durationMs: getToneDurationMs,
});
const warningCoordinator = createFocusWarningCoordinator({
  notifyWarning: (task, leadLabel) =>
    notificationAdapter.notifyWarning(task, leadLabel),
});
```

- [ ] **Step 1: Extend startup tests for the setting**

Add the fifth `getSetting(APP_SETTING_KEYS.focusWarningLeadMs)` read. Assert malformed/missing values become `'30000'`, valid Off survives, fallback is not automatically persisted, and `ready` still waits for settings hydration.

- [ ] **Step 2: Write failing timer integration tests**

Use fake timers and mocked controllers to prove:

- first focus start with warning enabled starts immediately and invokes `ensurePermission()` without awaiting it;
- Off never requests permission;
- warning visibility follows the same coordinator result in focus and non-focus workspaces;
- Continue focusing keeps session ID, task, note, and parked thoughts, creates a full new deadline, and cancels the alarm;
- Take break now enters Break, records actual focus, sends no alarm, and cancels defensively;
- a late 250 ms tick transitions once into Flow at `focusDeadlineAt`;
- live expiry starts exactly one three-tone sequence;
- background expiry sends one silent completion notification;
- recovery into Flow does not start audio or completion notification;
- overtime Take a break preserves Flow and cancels audio;
- overtime End session uses `finishFlow` and cancels audio;
- pausing overtime cancels remaining repetitions;
- tone preview cancels the completion sequence and calls `playTone` once;
- delete-current, Delete All Data, and component teardown cancel the sequence;
- changing workspace or opening Settings never resets the deadline or warning identity.

- [ ] **Step 3: Run and verify failure**

```bash
npx vitest run src/App.test.ts
```

- [ ] **Step 4: Replace the expiry effect**

The live effect must apply the exact-deadline transition and start side effects only after a successful live transition:

```ts
$effect(() => {
  if (session.status !== 'focusing' || !isFocusDue(session, now)) return;
  const task = session.task;
  const result = completeFocusIntoFlow(session, now);
  if (!result.ok) {
    applyResult(result);
    return;
  }
  applyResult(result);
  alarmSequence.start(settingsController?.current.selectedToneId ?? DEFAULT_TONE_ID);
  if (!windowForeground) {
    void notificationAdapter.notifyCompletion(task);
  }
});
```

Guard the effect against duplicate runs by relying on the immediate state transition away from `focusing`. Never use the late render tick as `focusCompletedAt`.

- [ ] **Step 5: Track foreground state**

Maintain one reactive boolean from `document.visibilityState` plus window focus/blur events. Register and clean up listeners in an effect. Minimized windows must count as backgrounded on the primary platform during manual validation.

- [ ] **Step 6: Evaluate warning state independently of workspace**

Call the coordinator from an effect that writes its returned value into one `warningView` state variable and depends only on session, `now`, the validated warning setting, and foreground state. Do not perform notification side effects inside a `$derived`, and do not include `workspaceView` or drawer state in cycle identity.

Only pass the coordinator's `announcement` on the evaluation that first crosses the threshold; subsequent visible renders pass null while retaining the prompt.

- [ ] **Step 7: Add Phase 5B handlers**

```ts
function handleContinueFocusing() {
  alarmSequence.cancel();
  applyResult(restartFocusCycle(session, Date.now()));
}

function handleTakeBreakNow() {
  alarmSequence.cancel();
  applyResult(takeBreakFromFocus(session, Date.now()));
}

function handleTakeBreakFromOvertime() {
  alarmSequence.cancel();
  applyResult(takeBreakFromFlow(session, Date.now()));
}

function handleEndOvertime() {
  alarmSequence.cancel();
  applyResult(finishFlow(session, Date.now()));
}
```

Cancel before pause, tone preview, deletion, Delete All Data, and teardown. Do not cancel merely because the user navigates or opens Settings.

- [ ] **Step 8: Render one shared prompt state**

In the focus workspace, pass the prompt into `Timer`. In other workspaces, pass the same prompt into `ActiveTimerBar`. During Flow created by deadline expiry, label the mode `Quiet overtime` and render Take a break/End session. Normal explicitly entered or recovered Flow should use the same quiet-overtime treatment when its `flowStartedAt === focusCompletedAt`; do not reintroduce `awaitingDecision`.

Keep notes, Parking Lot, navigation, and Settings mounted and operable while either prompt is visible.

- [ ] **Step 9: Dispose adapters**

The component teardown effect must:

```ts
alarmSequence.cancel();
warningCoordinator.dispose();
void notificationAdapter.dispose();
```

Do not leave a required exec/test process or listener running.

- [ ] **Step 10: Verify and commit**

```bash
npx vitest run src/App.test.ts src/lib/session.test.ts src/lib/persistence.test.ts src/lib/focusWarning.test.ts src/lib/alarmSequence.test.ts src/lib/nativeNotifications.test.ts src/lib/FocusCompletionPrompt.test.ts src/lib/Timer.test.ts src/lib/ActiveTimerBar.test.ts
npm run check
git add src/App.svelte src/App.test.ts
git commit -m "feat: integrate gentle focus completion"
```

---

### Task 9: Regression Coverage, Documentation, And Real Tauri Validation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify as required by defects found during validation: Phase 5B files only

- [ ] **Step 1: Run the complete automated suite**

```bash
npm run check
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all commands exit 0. Record exact test counts in the PR description.

- [ ] **Step 2: Run source consistency checks**

```bash
rg -n "awaitingDecision|DecisionScreen|completeFocus\\(|chooseBreak\\(|chooseFlow\\(|chooseFinish\\(" src
rg -n "TODO|TBD|FIXME|placeholder" src src-tauri README.md CHANGELOG.md
rg -n "focusWarningLeadMs|focus_deadline_at|notification:default" src src-tauri
```

Expected:

- `awaitingDecision` remains only in compatibility deserialization/recovery tests and types.
- No `DecisionScreen` import remains.
- No unresolved Phase 5B placeholders remain.
- The setting key, migration column, and capability are represented in all required layers.

- [ ] **Step 3: Validate in plain browser development**

```bash
npm run dev -- --host 127.0.0.1
```

At desktop and 360 by 640:

- verify no horizontal scrolling or overlap;
- verify prompt actions wrap/stack;
- verify no permission request or Tauri import error occurs;
- verify warning, same-session restart, quiet overtime, notes, Parking Lot, navigation, Settings, and history remain usable;
- verify reduced-motion mode removes prompt transition.

Stop the server after validation.

- [ ] **Step 4: Validate in real Tauri**

```bash
npm run tauri:dev
```

Verify and record:

1. No notification permission prompt at launch.
2. First focus start with warnings enabled requests permission once without delaying the timer.
3. Foreground warning uses only the centered in-app prompt.
4. Background/minimized warning sends one silent notification.
5. Clicking the desktop notification activates/focuses the existing app on the primary platform. If the OS/plugin does not provide this behavior, record the exact limitation; do not add unsupported desktop action buttons.
6. At zero, Flow starts at the exact deadline and the selected tone plays three sequential times.
7. Pause, Take a break, End session, preview, and deletion cancel remaining repetitions.
8. Quit/relaunch before the deadline resumes the countdown correctly.
9. Quit/relaunch after the deadline restores quiet overtime without sound or duplicate notification.
10. Early break, overtime break, and session review show correct actual focus and Flow totals.

Use an isolated development profile or disposable test database for any action that would delete sessions, notes, revisions, or parked thoughts. Do not exercise destructive controls against the user's ordinary app data.

Stop Tauri after validation.

- [ ] **Step 5: Update user-facing documentation**

README:

- explain the Focus warning setting and presets;
- describe Continue focusing, early break, and quiet overtime;
- state that native notifications are best-effort and platform permission dependent;
- keep installation and usage focused, with no implementation-phase narration.

CHANGELOG:

- add a Phase 5B entry covering warning presets, same-session restart, exact-deadline overtime, three-tone alarm, recovery, and native notifications;
- retain explicit deferrals for Touch Grass, soundscapes, tray operation, and planner/calendar work.

- [ ] **Step 6: Re-run final checks after docs or fixes**

```bash
npm run check
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

- [ ] **Step 7: Commit final validation/docs**

```bash
git add README.md CHANGELOG.md
git add src src-tauri package.json package-lock.json
git commit -m "docs: document gentle focus completion"
```

Do not create an empty commit if validation required no code changes and the documentation was already committed with its owning task.

## Final Review Checklist

- [ ] Every acceptance criterion in the Phase 5B design spec has an implementation and a test or named manual check.
- [ ] `focusDeadlineAt` is the only current-cycle countdown authority.
- [ ] Actual focus includes all restarted cycles and excludes focus pauses.
- [ ] Break preserves pre-break Flow.
- [ ] Live expiry and recovery use the deadline, never a render tick or reopen time.
- [ ] Recovery never replays audio or native notifications.
- [ ] Warning and completion prompts are nonmodal and never steal focus.
- [ ] Foreground/background changes do not alter timer state.
- [ ] Exactly one alarm sequence exists and all required lifecycle actions cancel it.
- [ ] Settings preview remains one-shot.
- [ ] Notification denial/failure cannot affect the timer.
- [ ] `awaitingDecision` is compatibility-only.
- [ ] Existing notes, revisions, Parking Lot, deletion queue, history, themes, and responsive navigation remain covered.
- [ ] No persistent user data, approved project record, migration, or still-used source file was removed during development or validation.
- [ ] Temporary servers are stopped; branch/worktree cleanup is deferred until the PR is merged and verified.
- [ ] All automated commands and manual Tauri checks have fresh recorded evidence.

## Post-Merge Cleanup

This is a lifecycle step, not part of implementation or PR review:

- [ ] Confirm the Phase 5B PR is merged and the remote target branch contains the merge.
- [ ] Confirm the feature worktree is clean with `git status --short`.
- [ ] Confirm all feature commits exist on the merged target.
- [ ] Remove the clean temporary worktree with `git worktree remove <path>`.
- [ ] Delete the local feature branch with `git branch -d <branch>`.
- [ ] Delete the remote feature branch only when GitHub did not already do so and repository policy or explicit approval permits it.
- [ ] Keep the committed design spec, implementation plan, changelog, migrations, and all app-managed user data.
