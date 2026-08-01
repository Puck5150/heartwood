# Repeating Quiet-Overtime Markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dismissible **Stay with it** action and repeat the warning/alarm decision cadence at every selected-duration marker during continuous quiet overtime.

**Architecture:** Keep persisted `SessionState` unchanged. Add a pure, runtime-only overtime cadence coordinator that derives marker identity from active Flow elapsed time, emits idempotent warning/alarm events, and is explicitly primed only for a live focus expiry so recovered sessions stay silent. `App.svelte` owns the existing alarm and native-notification side effects while the shared prompt component owns copy and action presentation.

**Tech Stack:** Svelte 5 runes, TypeScript 6, Vitest 4, Testing Library for Svelte, Tauri 2, existing settings controller, alarm sequence, notification adapter, and session state machine.

## Global Constraints

- Do not add a SQLite field, migration, history row, or persisted marker acknowledgement.
- Keep quiet overtime as existing `flow` / `flowPaused` session state and continuous Flow elapsed time.
- Derive cadence from active overtime elapsed time so Flow pauses delay future markers.
- Use `focusWarningLeadMs` as the only warning preference, with exact values `off`, `15000`, and `30000`; default to `30000`.
- Off suppresses advance warnings and their silent native notifications, never expiry prompts or alarms.
- Play the selected completion tone three times at each unacknowledged marker through the existing `alarmSequence`.
- Prevent stale warning or alarm replay when recovering an already-running quiet-overtime session.
- Preserve access to navigation, notes, Parking Lot, Settings, pause, Break, and Touch Grass while prompts are visible.
- Do not add dependencies.

---

### Task 1: Tighten the focus-warning setting

**Files:**
- Modify: `src/lib/appearance.ts:46-169`
- Modify: `src/lib/appearance.test.ts:126-175`
- Modify: `src/lib/SettingsDrawer.svelte:150-171`
- Modify: `src/lib/SettingsDrawer.test.ts:136-184`

**Interfaces:**
- Produces: `FocusWarningLeadMs = 'off' | '15000' | '30000'`
- Produces: `FOCUS_WARNING_OPTIONS` ordered as Off, 15 seconds, 30 seconds
- Preserves: `parseFocusWarningLeadMs(value): FocusWarningLeadMs`
- Preserves: `focusWarningLeadToMs(value): number | null`

- [ ] **Step 1: Write failing domain tests for the new closed preset set**

Replace the warning-value expectations with assertions equivalent to:

```ts
expect(parseFocusWarningLeadMs('off')).toBe('off');
expect(parseFocusWarningLeadMs('15000')).toBe('15000');
expect(parseFocusWarningLeadMs(30_000)).toBe('30000');
expect(parseFocusWarningLeadMs('60000')).toBe('30000');
expect(parseFocusWarningLeadMs('120000')).toBe('30000');
expect(parseFocusWarningLeadMs('300000')).toBe('30000');
expect(FOCUS_WARNING_OPTIONS).toEqual([
  { value: 'off', label: 'Off' },
  { value: '15000', label: '15 seconds' },
  { value: '30000', label: '30 seconds' },
]);
```

- [ ] **Step 2: Write failing Settings tests for explicit timing semantics**

Update the Settings tests to require a combobox named **Focus warning before expiry**, the three exact options, a default of `30000`, and persistence of `15000`:

```ts
const select = screen.getByRole('combobox', {
  name: 'Focus warning before expiry',
}) as HTMLSelectElement;
expect([...select.options].map(({ value, text }) => [value, text])).toEqual([
  ['off', 'Off'],
  ['15000', '15 seconds'],
  ['30000', '30 seconds'],
]);

await fireEvent.change(select, { target: { value: '15000' } });
expect(controller.current.focusWarningLeadMs).toBe('15000');
```

- [ ] **Step 3: Run the focused tests and confirm the old preset set fails**

Run:

```bash
npx vitest run src/lib/appearance.test.ts src/lib/SettingsDrawer.test.ts
```

Expected: failures for missing `15000`, retired minute presets, and the old field label.

- [ ] **Step 4: Implement the new preset union, validator, options, and label**

Use:

```ts
export type FocusWarningLeadMs = 'off' | '15000' | '30000';

const FOCUS_WARNING_VALUES = new Set<FocusWarningLeadMs>([
  'off',
  '15000',
  '30000',
]);

export const FOCUS_WARNING_OPTIONS: ReadonlyArray<{
  value: FocusWarningLeadMs;
  label: string;
}> = [
  { value: 'off', label: 'Off' },
  { value: '15000', label: '15 seconds' },
  { value: '30000', label: '30 seconds' },
];
```

Change only the visible Settings field label to `Focus warning before expiry` so `focusWarning.ts` can continue using concise values such as `15 seconds` in `${leadLabel} left` copy and native notification titles.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npx vitest run src/lib/appearance.test.ts src/lib/SettingsDrawer.test.ts src/lib/settingsController.test.ts src/lib/focusWarning.test.ts
git add src/lib/appearance.ts src/lib/appearance.test.ts src/lib/SettingsDrawer.svelte src/lib/SettingsDrawer.test.ts src/lib/settingsController.test.ts src/lib/focusWarning.test.ts
git commit -m "feat: tighten focus warning presets"
```

Expected: all selected tests pass; update existing fixtures from retired values to `15000` where the test needs a nondefault valid value.

---

### Task 2: Build the pure overtime cadence coordinator

**Files:**
- Create: `src/lib/overtimeCadence.ts`
- Create: `src/lib/overtimeCadence.test.ts`

**Interfaces:**
- Consumes: `FocusWarningLeadMs`, `FOCUS_WARNING_OPTIONS`, `SessionState`, and `getFlowElapsedMs`
- Produces: `OvertimeCadenceInput`, `OvertimeCadenceView`, and `OvertimeCadenceCoordinator`
- Produces: `createOvertimeCadenceCoordinator(options): OvertimeCadenceCoordinator`
- Produces: immutable `EMPTY_OVERTIME_CADENCE_VIEW: OvertimeCadenceView`

- [ ] **Step 1: Write failing tests for marker math and acknowledgement**

Define a Flow fixture with `plannedDurationMs: 25 * 60_000`, `focusCompletedAt` and `flowStartedAt` equal to `t0`, and no Flow pause. Cover these exact observations:

```ts
expect(coordinator.evaluate(inputAt(t0 + 24 * 60_000 + 29_999))).toMatchObject({
  visible: false,
  alarmDue: false,
});

expect(coordinator.evaluate(inputAt(t0 + 24 * 60_000 + 30_000))).toMatchObject({
  visible: true,
  phase: 'warning',
  markerNumber: 2,
  leadLabel: '30 seconds',
  alarmDue: false,
});

coordinator.acknowledge();
expect(coordinator.evaluate(inputAt(t0 + 25 * 60_000))).toMatchObject({
  visible: false,
  alarmDue: false,
});

expect(coordinator.evaluate(inputAt(t0 + 49 * 60_000 + 30_000))).toMatchObject({
  visible: true,
  phase: 'warning',
  markerNumber: 3,
});
```

Also prove that an ignored marker emits `alarmDue: true` once, remains visible with `phase: 'due'`, emits false on repeated evaluation, and emits true again at the next full-duration marker if still unacknowledged.

- [ ] **Step 2: Write failing tests for Off, pause, delayed evaluation, and recovery**

Cover:

```ts
// Off: no warning, but the future marker is still due.
expect(coordinator.evaluate({ ...inputAt(markerAt - 1), lead: 'off' }).visible).toBe(false);
expect(coordinator.evaluate({ ...inputAt(markerAt), lead: 'off' })).toMatchObject({
  visible: true,
  phase: 'due',
  alarmDue: true,
});

// flowPaused freezes active overtime and cannot cross a marker.
expect(coordinator.evaluate({ session: pausedBeforeMarker, now: markerAt + 60_000, ...base })).toMatchObject({
  visible: false,
  alarmDue: false,
});

// Recovery acknowledges the latest passed marker and selects the next future one.
const recovered = createOvertimeCadenceCoordinator(options);
expect(recovered.evaluate(inputAt(t0 + 25 * 60_000 + 1))).toMatchObject({
  visible: false,
  alarmDue: false,
});
```

Verify a recovered session inside the next future warning window shows that warning and can alarm when the future marker arrives. Verify delayed live evaluation fast-forwards to the latest marker and emits only one alarm event rather than one per skipped marker.

- [ ] **Step 3: Run the new test file and confirm the module is missing**

Run:

```bash
npx vitest run src/lib/overtimeCadence.test.ts
```

Expected: failure because `./overtimeCadence` does not exist.

- [ ] **Step 4: Implement the coordinator as runtime-only state**

Create these public types:

```ts
export interface OvertimeCadenceInput {
  session: SessionState;
  now: number;
  lead: FocusWarningLeadMs;
  isForeground: boolean;
}

export interface OvertimeCadenceView {
  visible: boolean;
  phase: 'initial' | 'warning' | 'due' | null;
  markerNumber: number | null;
  leadLabel: string | null;
  announcement: string | null;
  alarmDue: boolean;
}

export interface OvertimeCadenceCoordinator {
  activateLiveExpiry(sessionId: string): void;
  evaluate(input: OvertimeCadenceInput): OvertimeCadenceView;
  acknowledge(): OvertimeCadenceView;
  dispose(): void;
}

export const EMPTY_OVERTIME_CADENCE_VIEW: OvertimeCadenceView = Object.freeze({
  visible: false,
  phase: null,
  markerNumber: null,
  leadLabel: null,
  announcement: null,
  alarmDue: false,
});
```

Use active Flow elapsed time:

```ts
const elapsed = getFlowElapsedMs(session, now) ?? 0;
const latestDueMarker = Math.floor(elapsed / session.plannedDurationMs) + 1;
const nextMarker = latestDueMarker + 1;
const nextMarkerElapsed = (nextMarker - 1) * session.plannedDurationMs;
```

On the first evaluation for a session:

- If `activateLiveExpiry(sessionId)` was called, initialize `acknowledgedThrough = 0` so marker 1 emits one alarm event and an initial prompt.
- Otherwise initialize `acknowledgedThrough = latestDueMarker` and `lastAlarmedMarker = latestDueMarker` so recovery is silent.

For every evaluation:

- If a newer marker is due and not acknowledged, expose it as `phase: 'due'` and emit `alarmDue: true` only when its marker identity differs from `lastAlarmedMarker`.
- Otherwise, if warnings are enabled and the next marker's warning threshold is crossed, expose `phase: 'warning'` for that next marker.
- Otherwise return the shared hidden view.
- Send at most one silent warning notification per `sessionId:markerNumber` when backgrounded.
- Return a non-null polite announcement only once per marker identity.
- `acknowledge()` records the currently exposed marker, clears its prompt, and returns the hidden view.
- Leaving Flow clears session-local runtime state. `dispose()` suppresses late notification errors.

- [ ] **Step 5: Run coordinator tests and commit**

Run:

```bash
npx vitest run src/lib/overtimeCadence.test.ts
git add src/lib/overtimeCadence.ts src/lib/overtimeCadence.test.ts
git commit -m "feat: coordinate repeating overtime markers"
```

Expected: all coordinator tests pass with fake timestamps and no real timers.

---

### Task 3: Add the three-action overtime prompt

**Files:**
- Modify: `src/lib/FocusCompletionPrompt.svelte:1-110`
- Modify: `src/lib/FocusCompletionPrompt.test.ts:58-180`

**Interfaces:**
- Consumes: `OvertimeCadenceView['phase']` and its concise `leadLabel`
- Produces overtime callbacks: `onStay`, `onBreak`, and `onEnd`
- Preserves the existing `kind: 'warning'` API for the original focus warning

- [ ] **Step 1: Write failing component tests for copy, action order, and callbacks**

Render all three overtime phases and assert:

```ts
render(FocusCompletionPrompt, {
  kind: 'overtime',
  phase: 'warning',
  leadLabel: '30 seconds',
  announcement: '30 seconds to next focus check-in',
  onStay,
  onBreak,
  onEnd,
});

expect(screen.getByText('30 seconds to next check-in')).toBeTruthy();
expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
  'Stay with it',
  'Take a break',
  'End session',
]);
```

Assert `phase: 'initial'` uses `Planned focus complete`, `phase: 'due'` uses `Focus check-in`, each button invokes only its named callback, and the component remains nonmodal with a polite live region and no scrim semantics.

- [ ] **Step 2: Run the component tests and confirm the old two-action API fails**

Run:

```bash
npx vitest run src/lib/FocusCompletionPrompt.test.ts
```

Expected: failures for missing props, missing **Stay with it**, and old button order.

- [ ] **Step 3: Implement the discriminated overtime props and presentation**

Use this overtime branch:

```ts
| {
    kind: 'overtime';
    phase: 'initial' | 'warning' | 'due';
    leadLabel: string | null;
    announcement: string | null;
    onStay: () => void;
    onBreak: () => void;
    onEnd: () => void;
  };
```

Use exact headlines:

- Initial: `Planned focus complete`
- Advance warning: `${leadLabel} to next check-in`
- Due marker: `Focus check-in`

Keep `Stay with it, or step away` as the subline. Use `Overtime stays quiet while you decide.` for initial/due detail and `Ignore this and the alarm will sound at the next check-in.` for warning detail.

Render **Stay with it** as the primary accent action, **Take a break** as a neutral action, and **End session** as an outlined action using `var(--danger)` text/border. Preserve 44 px minimum targets, wrapping, stacked mobile actions, reduced motion, and nonmodal semantics.

- [ ] **Step 4: Run prompt tests and commit**

Run:

```bash
npx vitest run src/lib/FocusCompletionPrompt.test.ts
git add src/lib/FocusCompletionPrompt.svelte src/lib/FocusCompletionPrompt.test.ts
git commit -m "feat: add stay-with-it overtime action"
```

Expected: all prompt tests pass at desktop-independent DOM level.

---

### Task 4: Integrate cadence with the live app lifecycle

**Files:**
- Modify: `src/App.svelte:69-326`
- Modify: `src/App.svelte:1289-1320`
- Modify: `src/App.svelte:1822-1840`
- Modify: `src/App.test.ts:1724-1900`

**Interfaces:**
- Consumes: `createOvertimeCadenceCoordinator`, `OvertimeCadenceView`
- Consumes: existing `alarmSequence`, `notificationAdapter`, `completeFocusIntoFlow`, `takeBreakFromFlow`, and `finishFlow`
- Produces: `handleStayWithIt(): void`

- [ ] **Step 1: Add failing app tests for initial dismissal and alarm cancellation**

Extend the existing quiet-overtime tests to prove:

```ts
expect(screen.getByRole('button', { name: 'Stay with it' })).toBeTruthy();
await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));
expect(screen.queryByText('Planned focus complete')).toBeNull();
expect(screen.getByText('Quiet overtime')).toBeTruthy();

await vi.advanceTimersByTimeAsync(5_000);
expect(playTone).toHaveBeenCalledTimes(1);
```

The final assertion proves dismissal cancels the remaining repetitions without ending Flow or resetting elapsed overtime.

- [ ] **Step 2: Add failing app tests for recurring warning and marker behavior**

With a controlled short session duration and fake clock, prove:

- the prompt returns at `next marker - 30 seconds`;
- acknowledging the warning prevents the next marker alarm;
- with `focusWarningLeadMs = 'off'`, no advance prompt appears but the marker alarm and due prompt do;
- ignoring two consecutive markers starts exactly one three-play sequence per marker;
- navigating between Timer, Today, Parking Lot, History, and Settings does not reset acknowledgement or cadence;
- pausing quiet overtime freezes the marker countdown and cancels an active alarm; and
- recovered Flow does not replay a passed marker but can warn/alarm at the next future marker.

- [ ] **Step 3: Run the focused app tests and confirm missing integration**

Run:

```bash
npx vitest run src/App.test.ts
```

Expected: the new tests fail because the prompt has no Stay action and no recurring cadence exists.

- [ ] **Step 4: Wire one coordinator instance into App**

Create it beside `warningCoordinator`:

```ts
const overtimeCadence = createOvertimeCadenceCoordinator({
  notifyWarning: (task, leadLabel) =>
    notificationAdapter.notifyWarning(task, leadLabel),
});

let overtimeView = $state<OvertimeCadenceView>(EMPTY_OVERTIME_CADENCE_VIEW);
```

Evaluate it from an unconditional effect that depends only on `session`, `now`, validated lead, and foreground state. When `alarmDue` is true, start the existing selected-tone sequence and send `notifyCompletion(session.task)` only when backgrounded.

In the focus-expiry effect, call `overtimeCadence.activateLiveExpiry(session.sessionId)` immediately before applying the successful transition. Remove direct alarm/notification startup from that effect so the coordinator is the single marker-event gate.

Dispose the cadence coordinator with the existing alarm, warning coordinator, and notification teardown.

- [ ] **Step 5: Wire prompt actions without touching persisted session state**

Add:

```ts
function handleStayWithIt() {
  alarmSequence.cancel();
  overtimeView = overtimeCadence.acknowledge();
}
```

Render overtime only when `overtimeView.visible`, passing its phase, label, announcement, and the three handlers. Keep `isQuietOvertime` for timer labeling and elapsed-time behavior, not prompt visibility.

Ensure existing pause, Take a break, End session, Finish, intermission, and teardown paths continue cancelling the alarm sequence. Leaving Flow lets the coordinator clear its runtime session memory on the next evaluation.

- [ ] **Step 6: Run focused lifecycle tests and commit**

Run:

```bash
npx vitest run src/lib/overtimeCadence.test.ts src/lib/FocusCompletionPrompt.test.ts src/App.test.ts
git add src/App.svelte src/App.test.ts
git commit -m "feat: repeat quiet overtime check-ins"
```

Expected: all focused cadence, prompt, and application tests pass.

---

### Task 5: Complete regression and alpha-readiness verification

**Files:**
- Modify only when validation exposes a requirement-related defect
- Review: `CHANGELOG.md`, `README.md`, and soundscape attribution/license files for alpha-readiness findings

**Interfaces:**
- Verifies the entire frontend/Rust contract and real Tauri behavior
- Produces a concise alpha-readiness report; it does not expand this feature's scope

- [ ] **Step 1: Run all static checks and automated tests**

Run:

```bash
npm run check
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: zero Svelte/TypeScript errors or warnings, every Vitest test passes, production build succeeds, Rust check succeeds, and every Rust test passes.

- [ ] **Step 2: Verify browser behavior at desktop and mobile widths**

Start the Vite server on an unused port and inspect at approximately 1280x800 and 390x844. Use a short controlled focus interval to verify:

- original warning and completion;
- **Stay with it** cancelling visible prompt and remaining tones;
- continuous quiet-overtime count;
- warning return before two consecutive markers;
- Off, 15 seconds, and 30 seconds applying immediately;
- three actions fitting without overlap;
- navigation and Settings remaining usable; and
- no console errors or unhandled rejections.

- [ ] **Step 3: Verify the real Tauri app**

Run:

```bash
npm run tauri:dev
```

Use an isolated app instance/database when possible. Verify one acknowledged marker, one ignored marker, background native warning/completion notification behavior, soundscape suppression/restoration, pause semantics, and silent recovery after closing/reopening during overtime. Stop only the process started for this verification.

- [ ] **Step 4: Assess alpha readiness without folding unrelated work into this PR**

Classify findings as:

- Alpha blocker: startup/data loss, timer drift, broken recovery, unusable primary flow, missing audio attribution/license, or packaging failure.
- Alpha follow-up: accessibility polish, optional integrations, expanded music library, planner scope, analytics, or cosmetic refinement.

Report installation/package status, database recovery behavior, delete/export safety, keyboard/screen-reader basics, audio licensing/attribution, platform coverage, and known limitations. Open no new feature scope during this task.

- [ ] **Step 5: Commit any validation-only fixes, push, and request Claude review**

If validation required scoped fixes, rerun the affected focused tests and the full command set before committing them. Then push the complete branch and ask Claude to review the implementation against:

```text
docs/superpowers/specs/2026-07-31-repeating-quiet-overtime-markers-design.md
docs/superpowers/plans/2026-07-31-repeating-quiet-overtime-markers.md
```

Claude's review should prioritize timing boundaries, duplicate alarm/notification prevention, pause/recovery behavior, stale runtime state between sessions, accessibility, mobile action layout, and missing regression tests.
