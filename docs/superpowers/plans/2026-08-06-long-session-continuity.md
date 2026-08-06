# Long Session Continuity & Automatic Touch Grass Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Heartwood session resume into a new focus cycle after a post-focus Break instead of always completing, and proactively suggest a Touch Grass stand-up break once a configurable amount of continuous focus has passed since the last one.

**Architecture:** Extend the pure `session.ts` state machine with a `resumeFromBreak` transition and two new session-lifetime totals (`breakMs`, `lastTouchGrassAt`), thread them through SQLite persistence (one additive migration), add a configurable Settings threshold, and surface the threshold as a highlighted suggestion inside the existing `FocusCompletionPrompt` component plus a Resume/End choice on the Break screen.

**Tech Stack:** Tauri 2, Svelte 5 (runes), TypeScript, SQLite via `tauri-plugin-sql`/sqlx, Vitest, Rust/cargo test.

## Global Constraints

- 44px minimum touch targets for every new interactive control (existing `.actions button`/`.controls button` CSS already enforces this — reuse those classes, don't invent new sizing).
- New settings persist through the existing `settingsController` plumbing (`AppSettingKey`, `APP_SETTING_KEYS`, `DEFAULT_APP_SETTINGS`, per-key `parse*` functions) — never a bespoke persistence path.
- Run full validation after every task: `npm run check`, `npm test -- --run`, and (for any `src-tauri/` change) `cargo check`/`cargo test` from `src-tauri/`.
- Do a live Playwright browser verification pass for the interactive/visual changes (break screen Resume/End buttons, Touch Grass suggestion) before considering the branch done — not just unit tests.
- Never delete or reset persistent user data without explicit confirmation; migration 9 is purely additive (`ALTER TABLE ... ADD COLUMN`), matching migrations 5, 6, and 7's existing style — no recreate-table needed.
- Match established codebase conventions exactly: the `ok`/`reject`/`TransitionResult` pattern in `session.ts`, the `EMPTY_ROW_FIELDS` + explicit-field-list pattern in `persistence.ts`, the `<label class="option select-option"><select>...` pattern in `SettingsDrawer.svelte`, and the `.actions button`/`.controls button` CSS conventions already in `FocusCompletionPrompt.svelte`/`Timer.svelte`.

---

## Task 1: Session state machine — `resumeFromBreak` and session-lifetime totals

**Files:**
- Modify: `src/lib/session.ts`
- Test: `src/lib/session.test.ts`

**Interfaces:**
- Produces: `SessionTotals` interface (renamed from `IntermissionTotals`) with four fields: `breakIntermissionMs: number`, `touchGrassMs: number`, `breakMs: number` (new — cumulative post-focus Break time across every break/resume cycle in the session), `lastTouchGrassAt: number` (new — timestamp of the last completed `touchGrass` intermission, or the session's `startedAt` if none yet). Every state interface in this file (`FocusingState`, `PausedState`, `AwaitingDecisionState`, `FlowState`, `FlowPausedState`, `BreakState`, `CompleteState`, `IntermissionState`) extends `SessionTotals` instead of `IntermissionTotals`.
- Produces: `resumeFromBreak(state: SessionState, now: number): TransitionResult` — valid only from `BreakState`; returns to `'focusing'` with a fresh `focusDeadlineAt = now + plannedDurationMs`, same `sessionId`/`task`/`accumulatedPauseMs`, and `breakMs` incremented by this break's elapsed time.
- Consumes: nothing from other tasks (this is the foundational task).

- [ ] **Step 1: Rename `IntermissionTotals` to `SessionTotals` and add the two new fields**

Replace lines 14–30 (the `IntermissionTotals` interface and `EMPTY_INTERMISSION_TOTALS` constant) with:

```typescript
export interface SessionTotals {
  breakIntermissionMs: number;
  touchGrassMs: number;
  /** Cumulative post-focus Break time across every break/resume cycle in
   * this session (see resumeFromBreak) — distinct from
   * breakIntermissionMs, which is mid-focus intermission time. Reflects
   * only *completed* breaks; the currently-open Break's own elapsed time
   * is derived separately via getBreakElapsedMs. */
  breakMs: number;
  /** Timestamp of the last completed touchGrass intermission, or this
   * session's startedAt if none has happened yet. Drives the automatic
   * "time to stand up" suggestion in FocusCompletionPrompt. */
  lastTouchGrassAt: number;
}

export type IntermissionKind = 'break' | 'touchGrass';
export type IntermissionReturnStatus = 'focusing' | 'paused' | 'flow' | 'flowPaused';

export const INTERMISSION_DURATION_OPTIONS_MS = {
  break: [5 * 60_000, 10 * 60_000],
  touchGrass: [15 * 60_000, 30 * 60_000, 45 * 60_000, 60 * 60_000],
} as const satisfies Record<IntermissionKind, readonly number[]>;

/** breakIntermissionMs/touchGrassMs/breakMs all start at zero; lastTouchGrassAt
 * can't be part of this static constant (it depends on the session's own
 * startedAt) — startFocus sets it explicitly alongside this spread. */
const EMPTY_SESSION_TOTALS: Omit<SessionTotals, 'lastTouchGrassAt'> = {
  breakIntermissionMs: 0,
  touchGrassMs: 0,
  breakMs: 0,
};
```

Then replace every `extends IntermissionTotals` in this file (on `FocusingState`, `PausedState`, `AwaitingDecisionState`, `FlowState`, `FlowPausedState`, `BreakState`, `CompleteState`, `IntermissionState`) with `extends SessionTotals`. Do not change any other field in those interfaces.

- [ ] **Step 2: Update `startFocus` to seed the new totals**

In `startFocus` (around line 180), replace:

```typescript
    ...EMPTY_INTERMISSION_TOTALS,
  });
```

with:

```typescript
    ...EMPTY_SESSION_TOTALS,
    lastTouchGrassAt: now,
  });
```

- [ ] **Step 3: Run the existing suite to confirm compile errors point only at the remaining totals-carrying call sites**

Run: `npx vitest run src/lib/session.test.ts`
Expected: FAIL — TypeScript errors in `finishFocusEarly`, `finishFlow`, `endBreak`, `takeBreakFromFocus`, `completeFocusIntoFlow`, `takeBreakFromFlow`, `startIntermission`, `returnFromIntermission` (each is missing the new required `breakMs`/`lastTouchGrassAt` fields on its returned object literal). This confirms nothing was missed before Step 4 fixes them one by one.

- [ ] **Step 4: Add `breakMs`/`lastTouchGrassAt` to every existing totals-carrying transition**

In `finishFocusEarly` (around line 262), the `CompleteState` literal currently has `breakMs: 0,` and `tookBreak: false,`. Since a session that already resumed from at least one break carries a nonzero `breakMs` on its `FocusingState`/`PausedState`, finishing early now must report that accumulated total (not hardcode 0), and `tookBreak` must reflect whether *any* break happened this session, not just whether the immediately-preceding action was a break — `SessionReview.svelte`'s `{#if tookBreak}` gate would otherwise hide a real accumulated break total. Change:

```typescript
    tookBreak: false,
    breakMs: 0,
```

to:

```typescript
    tookBreak: state.breakMs > 0,
    breakMs: state.breakMs,
```

and add `lastTouchGrassAt: state.lastTouchGrassAt,` alongside the existing `breakIntermissionMs: state.breakIntermissionMs, touchGrassMs: state.touchGrassMs,` lines.

In `finishFlow` (around line 295), make the identical change: `tookBreak: false,` → `tookBreak: state.breakMs > 0,`, `breakMs: 0,` → `breakMs: state.breakMs,`, and add `lastTouchGrassAt: state.lastTouchGrassAt,`.

In `endBreak` (around line 331), change:

```typescript
  const breakMs = Math.max(0, now - state.breakStartedAt);
```

to:

```typescript
  const breakMs = state.breakMs + Math.max(0, now - state.breakStartedAt);
```

and add `lastTouchGrassAt: state.lastTouchGrassAt,` to the returned `CompleteState` object (alongside the existing `breakIntermissionMs`/`touchGrassMs` lines). `tookBreak: true,` stays unchanged — `endBreak` always means at least this break was taken.

In `takeBreakFromFocus` (around line 375) and `takeBreakFromFlow` (around line 426), add two lines to each returned `BreakState` object, alongside the existing `breakIntermissionMs: state.breakIntermissionMs, touchGrassMs: state.touchGrassMs,` lines:

```typescript
    breakMs: state.breakMs,
    lastTouchGrassAt: state.lastTouchGrassAt,
```

In `completeFocusIntoFlow` (around line 401), add the same two lines to the returned `FlowState` object.

In `startIntermission` (around line 456), the returned `IntermissionState` object currently has `breakIntermissionMs: returnState.breakIntermissionMs, touchGrassMs: returnState.touchGrassMs,`. Add:

```typescript
    breakMs: returnState.breakMs,
    lastTouchGrassAt: returnState.lastTouchGrassAt,
```

In `returnFromIntermission` (around line 497), change:

```typescript
  const totals: IntermissionTotals = {
    breakIntermissionMs:
      state.breakIntermissionMs + (state.kind === 'break' ? elapsedMs : 0),
    touchGrassMs:
      state.touchGrassMs + (state.kind === 'touchGrass' ? elapsedMs : 0),
  };
```

to:

```typescript
  const totals: SessionTotals = {
    breakIntermissionMs:
      state.breakIntermissionMs + (state.kind === 'break' ? elapsedMs : 0),
    touchGrassMs:
      state.touchGrassMs + (state.kind === 'touchGrass' ? elapsedMs : 0),
    breakMs: state.breakMs,
    lastTouchGrassAt: state.kind === 'touchGrass' ? now : state.lastTouchGrassAt,
  };
```

This is the one place `lastTouchGrassAt` actually advances — only when returning from a `'touchGrass'`-kind intermission, never a `'break'`-kind one.

`pause`, `resume`, and `restartFocusCycle` need no changes at all: each spreads the entire prior state (`{ ...state, ... }` / `{ ...rest, ... }`), so once the state interfaces carry the new fields (Step 1), these functions already carry them forward correctly.

- [ ] **Step 5: Run the suite again to confirm it compiles**

Run: `npx vitest run src/lib/session.test.ts`
Expected: still failing (no `resumeFromBreak` yet, and no test coverage for it), but with zero TypeScript errors — every existing test should pass unchanged (they use `toMatchObject`, which ignores extra fields).

- [ ] **Step 6: Write the failing tests for `resumeFromBreak`**

Add this new `describe` block at the end of `src/lib/session.test.ts` (the file already imports `startFocus`, `createIdleState`, `takeBreakFromFocus`, `takeBreakFromFlow`, `completeFocusIntoFlow`, `endBreak`, and has `expectOk`/`SID`/`FOCUS_MS` helpers defined near the top — reuse them, do not redefine):

```typescript
describe('resumeFromBreak', () => {
  const t0 = 1_000_000;

  it('is rejected outside Break', () => {
    expect(resumeFromBreak(createIdleState(), t0).ok).toBe(false);
    const focusing = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    expect(resumeFromBreak(focusing, t0).ok).toBe(false);
  });

  it('returns to focusing with a fresh full-duration deadline, keeping session identity', () => {
    let state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, t0, SID));
    state = expectOk(takeBreakFromFocus(state, t0 + FOCUS_MS));
    const resumed = expectOk(resumeFromBreak(state, t0 + FOCUS_MS + 300_000));

    expect(resumed).toMatchObject({
      status: 'focusing',
      sessionId: SID,
      task: 'Write the report',
      startedAt: t0,
      plannedDurationMs: FOCUS_MS,
      focusDeadlineAt: t0 + FOCUS_MS + 300_000 + FOCUS_MS,
    });
  });

  it('accumulates breakMs across multiple break/resume cycles, and endBreak reports the running total', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(takeBreakFromFocus(state, t0 + FOCUS_MS));
    state = expectOk(resumeFromBreak(state, t0 + FOCUS_MS + 300_000)); // first break: 5 min

    expect(state).toMatchObject({ status: 'focusing', breakMs: 300_000 });

    state = expectOk(takeBreakFromFocus(state, t0 + FOCUS_MS + 300_000 + FOCUS_MS));
    const secondBreakEndsAt = t0 + FOCUS_MS + 300_000 + FOCUS_MS + 600_000; // second break: 10 min
    const complete = expectOk(endBreak(state, secondBreakEndsAt));

    expect(complete).toMatchObject({
      status: 'complete',
      tookBreak: true,
      breakMs: 900_000, // 300_000 + 600_000 summed, not just the last break
    });
  });

  it('finishFocusEarly and finishFlow report the accumulated breakMs from a prior break/resume cycle and set tookBreak accordingly', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(takeBreakFromFocus(state, t0 + FOCUS_MS));
    state = expectOk(resumeFromBreak(state, t0 + FOCUS_MS + 300_000));

    const complete = expectOk(finishFocusEarly(state, t0 + FOCUS_MS + 300_000 + 10_000));
    expect(complete).toMatchObject({
      status: 'complete',
      tookBreak: true,
      breakMs: 300_000,
    });
  });

  it('preserves parked-thought scoping and notes by keeping the same sessionId across a resume', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(takeBreakFromFocus(state, t0 + FOCUS_MS));
    const resumed = expectOk(resumeFromBreak(state, t0 + FOCUS_MS + 60_000));
    expect((resumed as { sessionId: string }).sessionId).toBe(SID);
  });
});

describe('lastTouchGrassAt', () => {
  const t0 = 1_000_000;

  it('initializes to startedAt when a session begins', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    expect(state).toMatchObject({ lastTouchGrassAt: t0 });
  });

  it('updates only on returning from a touchGrass intermission, never a break intermission', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(startIntermission(state, 'break', 5 * 60_000, t0 + 100_000));
    state = expectOk(returnFromIntermission(state, t0 + 100_000 + 5 * 60_000));
    expect(state).toMatchObject({ lastTouchGrassAt: t0 }); // unchanged by a plain break

    const touchGrassStartAt = t0 + 100_000 + 5 * 60_000 + 50_000;
    state = expectOk(startIntermission(state, 'touchGrass', 15 * 60_000, touchGrassStartAt));
    const returnedAt = touchGrassStartAt + 15 * 60_000;
    state = expectOk(returnFromIntermission(state, returnedAt));
    expect(state).toMatchObject({ lastTouchGrassAt: returnedAt });
  });
});
```

Add `resumeFromBreak` to the existing `import { ... } from './session'` block at the top of the test file.

- [ ] **Step 7: Add `resumeFromBreak` to `session.ts`**

Insert this new function directly after `endBreak` (after its closing `}`, around line 356):

```typescript
/** The counterpart to endBreak(): resumes the session into a new focus
 * cycle instead of completing it. Keeps session identity, task, and
 * accumulated pauses, and folds this break's elapsed time into the
 * running breakMs total rather than discarding it. */
export function resumeFromBreak(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'break') {
    return reject(`Cannot resume from status "${state.status}".`);
  }
  return ok({
    status: 'focusing',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusDeadlineAt: now + state.plannedDurationMs,
    breakIntermissionMs: state.breakIntermissionMs,
    touchGrassMs: state.touchGrassMs,
    breakMs: state.breakMs + Math.max(0, now - state.breakStartedAt),
    lastTouchGrassAt: state.lastTouchGrassAt,
  });
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/lib/session.test.ts`
Expected: PASS, all tests including the new `resumeFromBreak` and `lastTouchGrassAt` describe blocks.

- [ ] **Step 9: Type-check the whole project**

Run: `npm run check`
Expected: 0 errors. (`persistence.ts` will still fail at this point — that's Task 2's job; if `npm run check` reports errors only in `persistence.ts`/`persistence.test.ts` referencing missing `breakMs`/`lastTouchGrassAt`/`IntermissionTotals`, that confirms Task 1 is complete and correctly isolated.)

- [ ] **Step 10: Commit**

```bash
git add src/lib/session.ts src/lib/session.test.ts
git commit -m "feat: add resumeFromBreak and session-lifetime break/touch-grass totals"
```

---

## Task 2: SQLite migration 9 — `last_touch_grass_at` column

**Files:**
- Modify: `src-tauri/src/migrations.rs`

**Interfaces:**
- Consumes: nothing (independent of Task 1's TypeScript changes).
- Produces: a new nullable `sessions.last_touch_grass_at INTEGER` column, migration version 9.

- [ ] **Step 1: Add the migration**

In the `vec![Migration { ... }]` list in `migrations()`, add a new entry after the version-8 migration (after its closing `}, ` and before the final `]`):

```rust
    }, Migration {
        version: 9,
        description: "persist last touch grass timestamp for the auto-reminder threshold",
        sql: "ALTER TABLE sessions ADD COLUMN last_touch_grass_at INTEGER;",
        kind: MigrationKind::Up,
    }]
```

(Replace the existing final `}]` that closes the vec after migration 8 with `}, Migration { ... }]` as shown — migration 8 keeps its own trailing `}` unchanged, this just appends one more entry before the list closes.)

- [ ] **Step 2: Write the failing test**

Add to the `#[cfg(test)] mod tests` block, after `version_seven_adds_intermission_state_and_zeroed_totals` (or anywhere alongside the other `version_*` tests — match their existing style):

```rust
    #[tokio::test]
    async fn version_nine_adds_a_nullable_last_touch_grass_at_column() {
        let pool = migrated_pool().await;

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('sessions')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(columns.contains(&"last_touch_grass_at".to_string()));

        // A pre-existing row (inserted before this column existed) survives
        // with a null value rather than failing the insert.
        insert_session(&pool, "legacy-1").await;
        let last_touch_grass_at: Option<i64> =
            sqlx::query_scalar("SELECT last_touch_grass_at FROM sessions WHERE id = 'legacy-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(last_touch_grass_at, None);
    }
```

- [ ] **Step 3: Run the test to verify it currently fails**

Run: `cd src-tauri && cargo test version_nine_adds_a_nullable_last_touch_grass_at_column`
Expected: FAIL (compiles fine since this is pure SQL/no Rust struct changes, but the column doesn't exist yet — actually, since Step 1 and Step 2 are both being applied before the first test run in this workflow, run this command *before* Step 1 if executing strictly TDD; otherwise confirm the test passes cleanly after both steps as the "step 4" verification below).

- [ ] **Step 4: Run the full migrations test suite to verify everything passes**

Run: `cd src-tauri && cargo test migrations::`
Expected: PASS, all migration tests including the new version 9 test.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/migrations.rs
git commit -m "feat: add migration 9 for last_touch_grass_at column"
```

---

## Task 3: Persistence layer — `SessionRow`, serialize/deserialize, and the Tauri repository INSERT

**Files:**
- Modify: `src/lib/persistence.ts`
- Modify: `src/lib/tauriRepository.ts`
- Test: `src/lib/persistence.test.ts`

**Interfaces:**
- Consumes: `SessionTotals`, `resumeFromBreak` from Task 1 (`session.ts`); migration 9's `last_touch_grass_at` column from Task 2.
- Produces: `SessionRow.last_touch_grass_at: number | null`; `serializeSessionState`/`deserializeSessionRow` correctly round-trip `breakMs`/`lastTouchGrassAt` for every status; `saveSession` in `tauriRepository.ts` persists the new column.

- [ ] **Step 1: Update `SessionRow` and `EMPTY_ROW_FIELDS`**

In `src/lib/persistence.ts`, add a new field to the `SessionRow` interface, directly after `touch_grass_ms: number | null;` (around line 52):

```typescript
  /** Timestamp of the last completed touchGrass intermission. Null for a
   * row written before this column existed, or a session that hasn't done
   * one yet — deserialization falls back to the row's own started_at in
   * both cases (see totalsFromRow). */
  last_touch_grass_at: number | null;
```

Add `last_touch_grass_at: null,` to `EMPTY_ROW_FIELDS` (around line 87), alongside the existing `touch_grass_ms: null,` line.

- [ ] **Step 2: Update `totalsFromRow` and the shared `base` object in `serializeSessionState`**

Change `totalsFromRow` (around line 214) from:

```typescript
function totalsFromRow(row: SessionRow): IntermissionTotals {
  return {
    breakIntermissionMs: row.break_intermission_ms ?? 0,
    touchGrassMs: row.touch_grass_ms ?? 0,
  };
}
```

to:

```typescript
function totalsFromRow(row: SessionRow): SessionTotals {
  return {
    breakIntermissionMs: row.break_intermission_ms ?? 0,
    touchGrassMs: row.touch_grass_ms ?? 0,
    breakMs: row.break_ms ?? 0,
    lastTouchGrassAt: row.last_touch_grass_at ?? row.started_at!,
  };
}
```

Update the `import { ... } from './session'` block at the top of the file: replace `type IntermissionTotals` with `type SessionTotals`.

In `serializeSessionState`'s `base` object (around line 94–102), add `break_ms` and `last_touch_grass_at` alongside the existing `break_intermission_ms`/`touch_grass_ms` lines:

```typescript
  const base = {
    id: state.sessionId,
    task: state.task,
    status: state.status,
    updated_at: updatedAt,
    ...EMPTY_ROW_FIELDS,
    break_intermission_ms: state.breakIntermissionMs,
    touch_grass_ms: state.touchGrassMs,
    break_ms: state.breakMs,
    last_touch_grass_at: state.lastTouchGrassAt,
  };
```

Then remove the now-redundant explicit `break_ms: state.breakMs,` line from the `'complete'` case block (around line 207) — `base` already sets it to the same value, and every other case (`'break'`, `'focusing'`, etc.) relies on `base` for this field rather than repeating it.

- [ ] **Step 3: Fix the two hand-constructed test literals that will now fail to type-check**

In `src/lib/persistence.test.ts`, the `'round-trips an awaitingDecision state'` test (around line 53) builds a `SessionState` object literal directly. Add two fields to it, alongside the existing `breakIntermissionMs: 0, touchGrassMs: 0,`:

```typescript
      breakIntermissionMs: 0,
      touchGrassMs: 0,
      breakMs: 0,
      lastTouchGrassAt: T0,
```

The `'derives the deadline for a legacy focusing/paused row...'` test (around line 359) and the `'derives zero prior Flow and plannedDurationMs actual focus for a legacy break row...'` test (around line 395) each build a `SessionRow` object literal directly. Add `last_touch_grass_at: null,` to both, alongside the existing `touch_grass_ms: 0,` line.

- [ ] **Step 4: Write the new fallback test**

Add this test to the `describe('focus_deadline_at persistence (Phase 5B)', ...)` block in `persistence.test.ts` (reuse its existing imports/helpers — `expectOk`, `startFocus`, `createIdleState`, `SID`, `FOCUS_MS`, `T0`), placed after the two existing "legacy row" tests:

```typescript
  it('falls back lastTouchGrassAt to startedAt for a legacy row missing the column', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, T0, SID));
    const row = serializeSessionState(state, T0)!;
    const legacyRow: SessionRow = { ...row, last_touch_grass_at: null };

    const restored = deserializeSessionRow(legacyRow);
    expect(restored).toMatchObject({ lastTouchGrassAt: T0 });
  });
```

- [ ] **Step 5: Write a round-trip test for `resumeFromBreak` through persistence**

Add this test to the `describe('session state <-> row round trip', ...)` block, after the existing `'round-trips a break state'` test. Import `resumeFromBreak` in the test file's `import { ... } from './session'` block.

```typescript
  it('round-trips a focusing state resumed from a break, including the accumulated breakMs', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(takeBreakFromFocus(state, T0 + FOCUS_MS));
    state = expectOk(resumeFromBreak(state, T0 + FOCUS_MS + 300_000));
    const row = serializeSessionState(state, T0 + FOCUS_MS + 300_000)!;
    expect(row.break_ms).toBe(300_000);
    expect(deserializeSessionRow(row)).toEqual(state);
  });
```

- [ ] **Step 6: Run the persistence tests**

Run: `npx vitest run src/lib/persistence.test.ts`
Expected: PASS, all tests.

- [ ] **Step 7: Update the Tauri repository INSERT**

In `src/lib/tauriRepository.ts`'s `saveSession` function, add `last_touch_grass_at` to the column list, `$29` to the `VALUES` placeholders, a new `ON CONFLICT DO UPDATE SET` line, and the bound value:

Change the column list (around line 39–47):

```typescript
    `INSERT INTO sessions (
      id, task, status, started_at, planned_duration_ms, accumulated_pause_ms,
      paused_at, focus_completed_at, flow_started_at, flow_accumulated_pause_ms,
      flow_paused_at, break_started_at, planned_focus_ms, actual_focus_ms,
      flow_ms, took_break, break_ms, total_elapsed_ms, completed_at, focus_deadline_at,
      review_acknowledged_at, intermission_kind, intermission_started_at,
      intermission_deadline_at, intermission_return_status, break_intermission_ms,
      touch_grass_ms, last_touch_grass_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
```

Add a new line to the `ON CONFLICT(id) DO UPDATE SET` block (after the existing `touch_grass_ms = excluded.touch_grass_ms,` line):

```typescript
      touch_grass_ms = excluded.touch_grass_ms,
      last_touch_grass_at = excluded.last_touch_grass_at,
      updated_at = excluded.updated_at
```

Add `row.last_touch_grass_at,` to the bound-values array (after the existing `row.touch_grass_ms,` line, before `row.updated_at,`).

No change is needed in `src/lib/memoryRepository.ts` — it stores the whole `SessionRow` object directly in a `Map` rather than an explicit column list, so it already carries the new field once `SessionRow`'s type includes it.

- [ ] **Step 8: Type-check and run the full suite**

Run: `npm run check`
Expected: 0 errors.

Run: `npm test -- --run`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/persistence.ts src/lib/persistence.test.ts src/lib/tauriRepository.ts
git commit -m "feat: persist breakMs total and lastTouchGrassAt through SQLite"
```

---

## Task 4: Touch Grass reminder threshold setting

**Files:**
- Modify: `src/lib/appearance.ts`
- Modify: `src/lib/settingsController.svelte.ts`
- Modify: `src/lib/SettingsDrawer.svelte`
- Modify: `src/App.svelte` (startup hydration only — the threshold isn't *consumed* by the completion prompt until Task 7)
- Test: `src/lib/appearance.test.ts`
- Test: `src/lib/settingsController.test.ts`
- Test: `src/lib/SettingsDrawer.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–3 (independent — this is a plain new setting, unrelated to the session state machine until Task 7 reads it).
- Produces: `TouchGrassReminderThresholdMs` type, `TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS`, `parseTouchGrassReminderThresholdMs(value: unknown): TouchGrassReminderThresholdMs`, `touchGrassReminderThresholdToMs(value: TouchGrassReminderThresholdMs): number | null`, `AppSettings.touchGrassReminderThresholdMs`, `APP_SETTING_KEYS.touchGrassReminderThresholdMs`, `DEFAULT_APP_SETTINGS.touchGrassReminderThresholdMs` (= `'3600000'`, 60 minutes).

- [ ] **Step 1: Write the failing tests in `appearance.test.ts`**

Add these `describe` blocks to `src/lib/appearance.test.ts`, following the exact style of the existing `parseFocusWarningLeadMs`/`focusWarningLeadToMs`/`FOCUS_WARNING_OPTIONS` blocks (around line 140–179):

```typescript
describe('parseTouchGrassReminderThresholdMs', () => {
  it.each([
    ['off', 'off'],
    ['1800000', '1800000'],
    ['2700000', '2700000'],
    ['3600000', '3600000'],
    ['5400000', '5400000'],
    ['7200000', '7200000'],
    [3600000, '3600000'],
    ['60000', '3600000'],
    ['not-a-value', '3600000'],
    [null, '3600000'],
    [undefined, '3600000'],
    [{}, '3600000'],
  ])('parses touch grass reminder threshold %p as %s', (input, expected) => {
    expect(parseTouchGrassReminderThresholdMs(input)).toBe(expected);
  });

  it('defaults to 60 minutes, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.touchGrassReminderThresholdMs).toBe('3600000');
  });
});

describe('touchGrassReminderThresholdToMs', () => {
  it('converts the stored presets to milliseconds, and Off to null', () => {
    expect(touchGrassReminderThresholdToMs('off')).toBeNull();
    expect(touchGrassReminderThresholdToMs('1800000')).toBe(1_800_000);
    expect(touchGrassReminderThresholdToMs('3600000')).toBe(3_600_000);
  });
});

describe('TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS', () => {
  it('lists exactly Off, 30/45/60/90/120 minutes with labels', () => {
    expect(TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS).toEqual([
      { value: 'off', label: 'Off' },
      { value: '1800000', label: '30 minutes' },
      { value: '2700000', label: '45 minutes' },
      { value: '3600000', label: '60 minutes' },
      { value: '5400000', label: '90 minutes' },
      { value: '7200000', label: '120 minutes' },
    ]);
  });
});
```

Add the new imports (`parseTouchGrassReminderThresholdMs`, `touchGrassReminderThresholdToMs`, `TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS`) to the file's existing `import { ... } from './appearance'` block.

Update the existing `'exposes exactly the ten persisted keys'` test (around line 122) to `'exposes exactly the eleven persisted keys'`, adding `'touchGrassReminderThresholdMs'` to the sorted array.

- [ ] **Step 2: Run to verify the tests fail**

Run: `npx vitest run src/lib/appearance.test.ts`
Expected: FAIL — the new exports don't exist yet.

- [ ] **Step 3: Add the setting to `appearance.ts`**

Add the new type, directly after `FocusWarningLeadMs` (around line 54):

```typescript
/** Minutes of continuous focus since the last Touch Grass before
 * FocusCompletionPrompt starts suggesting one — stored as a string like
 * every other setting. */
export type TouchGrassReminderThresholdMs = 'off' | '1800000' | '2700000' | '3600000' | '5400000' | '7200000';
```

Add `touchGrassReminderThresholdMs: TouchGrassReminderThresholdMs;` to the `AppSettings` interface (after `focusWarningLeadMs`).

Add `touchGrassReminderThresholdMs: 'touchGrassReminderThresholdMs',` to `APP_SETTING_KEYS` (after `focusWarningLeadMs`).

Add `touchGrassReminderThresholdMs: '3600000',` to `DEFAULT_APP_SETTINGS` (after `focusWarningLeadMs`).

Add the values set, after `FOCUS_WARNING_VALUES`:

```typescript
const TOUCH_GRASS_REMINDER_THRESHOLD_VALUES = new Set<TouchGrassReminderThresholdMs>([
  'off',
  '1800000',
  '2700000',
  '3600000',
  '5400000',
  '7200000',
]);
```

Add the options array, after `FOCUS_WARNING_OPTIONS`:

```typescript
export const TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS: ReadonlyArray<{ value: TouchGrassReminderThresholdMs; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: '1800000', label: '30 minutes' },
  { value: '2700000', label: '45 minutes' },
  { value: '3600000', label: '60 minutes' },
  { value: '5400000', label: '90 minutes' },
  { value: '7200000', label: '120 minutes' },
];
```

Add the parse/convert functions, after `parseFocusWarningLeadMs`/`focusWarningLeadToMs`:

```typescript
export function parseTouchGrassReminderThresholdMs(value: unknown): TouchGrassReminderThresholdMs {
  const candidate = typeof value === 'number' ? String(value) : value;
  return typeof candidate === 'string' && TOUCH_GRASS_REMINDER_THRESHOLD_VALUES.has(candidate as TouchGrassReminderThresholdMs)
    ? (candidate as TouchGrassReminderThresholdMs)
    : DEFAULT_APP_SETTINGS.touchGrassReminderThresholdMs;
}

export function touchGrassReminderThresholdToMs(value: TouchGrassReminderThresholdMs): number | null {
  return value === 'off' ? null : Number(value);
}
```

- [ ] **Step 4: Run to verify `appearance.test.ts` passes**

Run: `npx vitest run src/lib/appearance.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test in `settingsController.test.ts`**

Add this test after the existing `'tracks the new focusWarningLeadMs key...'` test (around line 180), matching its exact structure:

```typescript
  it('tracks the new touchGrassReminderThresholdMs key through the same set/retry/staleness machinery as every other setting', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });

    controller.set('touchGrassReminderThresholdMs', '1800000');
    await vi.waitFor(() => expect(controller.errors.touchGrassReminderThresholdMs).toBeTruthy());
    expect(controller.current.touchGrassReminderThresholdMs).toBe('1800000');
    expect(controller.errors.touchGrassReminderThresholdMs).toBeTruthy();

    controller.retry('touchGrassReminderThresholdMs');
    await vi.waitFor(() => expect(persist).toHaveBeenLastCalledWith('touchGrassReminderThresholdMs', '1800000'));
    expect(controller.errors.touchGrassReminderThresholdMs).toBeUndefined();
  });
```

If the existing `'tracks the new focusWarningLeadMs key...'` test (read it first) uses a different async-waiting mechanism (e.g. explicit `await Promise.resolve()` flushes instead of `vi.waitFor`), match that exact mechanism instead of introducing `vi.waitFor` — consistency with the neighboring test matters more than this plan's exact wording.

- [ ] **Step 6: Add the key to `requestSequence` in `settingsController.svelte.ts`**

In the `requestSequence` object literal (around line 78–88), add `touchGrassReminderThresholdMs: 0,` after `focusWarningLeadMs: 0,`. This is required for `npm run check` to pass — `requestSequence` is typed `Record<AppSettingKey, number>`, so a missing key is a compile error, not just a runtime gap.

- [ ] **Step 7: Run to verify `settingsController.test.ts` passes**

Run: `npx vitest run src/lib/settingsController.test.ts`
Expected: PASS.

- [ ] **Step 8: Wire startup hydration in `App.svelte`**

In the `import { ... } from './lib/appearance'` block (around line 79–92), add `parseTouchGrassReminderThresholdMs` to the named imports.

In `runStartup()`'s `Promise.all` array (around line 428–450), add a new destructured variable `touchGrassReminderThresholdMs` to the array on the left, and a new `getSetting(APP_SETTING_KEYS.touchGrassReminderThresholdMs).catch(() => null),` line to the `Promise.all([...])` array (matching position — after `focusWarningLeadMs`).

In the `initialSettings` object (around line 452–463), add `touchGrassReminderThresholdMs: parseTouchGrassReminderThresholdMs(touchGrassReminderThresholdMs),` after `focusWarningLeadMs: parseFocusWarningLeadMs(focusWarningLeadMs),`.

- [ ] **Step 9: Write the failing test in `SettingsDrawer.test.ts`**

First read `src/lib/SettingsDrawer.test.ts` to find its existing test(s) for the focus-warning-lead-time `<select>` control (search for `focusWarningLeadMs` or `'Focus warning before expiry'`) and copy its exact render/assert pattern. Add an analogous test:

```typescript
  it('renders the Touch Grass reminder threshold select and persists a change', async () => {
    const controller = realController(); // reuse whatever helper the focusWarningLeadMs test uses to build a real SettingsController
    render(SettingsDrawer, { updateController: fakeUpdateController(), controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    const select = screen.getByRole('combobox', { name: 'Touch Grass reminder' }) as HTMLSelectElement;
    expect(select.value).toBe('3600000');

    await fireEvent.change(select, { target: { value: '1800000' } });
    expect(controller.current.touchGrassReminderThresholdMs).toBe('1800000');
  });
```

Adjust the exact `render(...)` call's props to match whatever this test file's other tests already pass (it was updated in the prior manual-update-check-button work to require `updateController` — confirm that's still the shape before writing this).

- [ ] **Step 10: Add the control to `SettingsDrawer.svelte`**

Add `TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS` and `type TouchGrassReminderThresholdMs` to the existing `import { ... } from './appearance'` block.

In the "Timer" `settings-section` (around line 228–250), add a new `<label class="option select-option">` block directly after the existing Focus warning `</label>...{/if}` (after line 250's closing `</section>` — actually insert it *inside* the same section, after the focus-warning error block and before the section's closing `</section>` tag):

```svelte
      <label class="option select-option">
        Touch Grass reminder
        <select
          value={controller.current.touchGrassReminderThresholdMs}
          onchange={(event) =>
            controller.set('touchGrassReminderThresholdMs', event.currentTarget.value as TouchGrassReminderThresholdMs)}
        >
          {#each TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
      {#if controller.errors.touchGrassReminderThresholdMs}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('touchGrassReminderThresholdMs')}
            >Retry Touch Grass reminder</button
          >
        </p>
      {/if}
```

- [ ] **Step 11: Run the tests**

Run: `npx vitest run src/lib/SettingsDrawer.test.ts`
Expected: PASS.

- [ ] **Step 12: Type-check and run the full suite**

Run: `npm run check`
Expected: 0 errors.

Run: `npm test -- --run`
Expected: all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/lib/appearance.ts src/lib/appearance.test.ts src/lib/settingsController.svelte.ts src/lib/settingsController.test.ts src/lib/SettingsDrawer.svelte src/lib/SettingsDrawer.test.ts src/App.svelte
git commit -m "feat: add configurable Touch Grass reminder threshold setting"
```

---

## Task 5: `FocusCompletionPrompt` — highlighted Touch Grass suggestion

**Files:**
- Modify: `src/lib/FocusCompletionPrompt.svelte`
- Test: `src/lib/FocusCompletionPrompt.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks — this component takes plain boolean/callback props, independent of where the caller derives them.
- Produces: both `Props` variants (`kind: 'warning'` and `kind: 'overtime'`) gain optional `touchGrassSuggested?: boolean` and `onTouchGrass?: () => void`.

- [ ] **Step 1: Write the failing tests**

Read `src/lib/FocusCompletionPrompt.test.ts` first to confirm its exact `render(FocusCompletionPrompt, { ... })` prop shape for both `kind` variants (already partially shown above — `kind: 'warning'` needs `leadLabel`, `announcement`, `onPrimary`, `onSecondary`; `kind: 'overtime'` needs `phase`, `leadLabel`, `announcement`, `onStay`, `onBreak`, `onEnd`). Add these tests, matching the file's existing `describe('FocusCompletionPrompt — warning', ...)` / `describe('FocusCompletionPrompt — overtime', ...)` grouping (add a new `describe` block for the shared behavior, or extend both existing blocks — match whichever grouping style the file already uses for cross-cutting props):

```typescript
describe('FocusCompletionPrompt — Touch Grass suggestion', () => {
  it('does not show the suggestion when touchGrassSuggested is false or omitted, for either kind', () => {
    render(FocusCompletionPrompt, {
      kind: 'warning',
      leadLabel: '30 seconds',
      announcement: null,
      onPrimary: vi.fn(),
      onSecondary: vi.fn(),
    });
    expect(screen.queryByText(/Touch Grass/)).toBeNull();
  });

  it('shows a highlighted Touch Grass option in the warning prompt and fires onTouchGrass', async () => {
    const onTouchGrass = vi.fn();
    render(FocusCompletionPrompt, {
      kind: 'warning',
      leadLabel: '30 seconds',
      announcement: null,
      onPrimary: vi.fn(),
      onSecondary: vi.fn(),
      touchGrassSuggested: true,
      onTouchGrass,
    });

    const button = screen.getByRole('button', { name: 'Time to stand up — Touch Grass?' });
    expect(button).toBeTruthy();
    await fireEvent.click(button);
    expect(onTouchGrass).toHaveBeenCalledOnce();
  });

  it('shows the same suggestion in the overtime prompt', () => {
    render(FocusCompletionPrompt, {
      kind: 'overtime',
      phase: 'initial',
      leadLabel: null,
      announcement: null,
      onStay: vi.fn(),
      onBreak: vi.fn(),
      onEnd: vi.fn(),
      touchGrassSuggested: true,
      onTouchGrass: vi.fn(),
    });
    expect(screen.getByRole('button', { name: 'Time to stand up — Touch Grass?' })).toBeTruthy();
  });

  it('never shows the suggestion when touchGrassSuggested is true but onTouchGrass is missing', () => {
    render(FocusCompletionPrompt, {
      kind: 'warning',
      leadLabel: '30 seconds',
      announcement: null,
      onPrimary: vi.fn(),
      onSecondary: vi.fn(),
      touchGrassSuggested: true,
    });
    expect(screen.queryByText(/Touch Grass/)).toBeNull();
  });
});
```

Add `fireEvent` to the file's existing `@testing-library/svelte` import if not already imported (it's already used elsewhere in this session's established test conventions — check the file's current import line first).

- [ ] **Step 2: Run to verify the tests fail**

Run: `npx vitest run src/lib/FocusCompletionPrompt.test.ts`
Expected: FAIL — no such button exists yet.

- [ ] **Step 3: Add the props and markup**

In `FocusCompletionPrompt.svelte`, add `touchGrassSuggested?: boolean;` and `onTouchGrass?: () => void;` to *both* variants of the `Props` type union.

In the template, add a new conditional button inside `.actions`, for both branches. For the `warning` branch (inside the existing `{#if props.kind === 'warning'}` block's `.actions` div, after the existing two buttons):

```svelte
      {#if props.touchGrassSuggested && props.onTouchGrass}
        <button type="button" class="touch-grass" onclick={props.onTouchGrass}>
          Time to stand up — Touch Grass?
        </button>
      {/if}
```

Add the identical block inside the `overtime` branch's `.actions` div, after its three existing buttons.

- [ ] **Step 4: Add the CSS**

Add a new rule after the existing `.actions button.primary` rule:

```css
  .actions button.touch-grass {
    border-color: var(--break-accent);
    color: var(--break-accent);
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/FocusCompletionPrompt.test.ts`
Expected: PASS, all tests including the new Touch Grass suggestion tests.

- [ ] **Step 6: Type-check**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/FocusCompletionPrompt.svelte src/lib/FocusCompletionPrompt.test.ts
git commit -m "feat: highlight a Touch Grass suggestion in the completion prompt"
```

---

## Task 6: `Timer` — Resume/End choice on the Break screen

**Files:**
- Modify: `src/lib/Timer.svelte`
- Test: `src/lib/Timer.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks — plain prop addition.
- Produces: new optional `onResumeBreak?: () => void` prop; break mode's finish label changes from `'End break'` to `'End session'`; when `mode === 'break'` and `onResumeBreak` is supplied, an additional `'Resume session'` button renders.

- [ ] **Step 1: Update the existing test that asserts the old `'End break'` label**

In `src/lib/Timer.test.ts`, the `'labels the finish action per mode and calls onFinish'` test (around line 71–107) asserts `screen.getByRole('button', { name: 'End break' })`. Change that string to `'End session'`.

- [ ] **Step 2: Write the new failing test for the Resume button**

Add this test after the updated one:

```typescript
  it('shows a Resume session button in break mode only when onResumeBreak is supplied, and calls it', async () => {
    const onResumeBreak = vi.fn();
    const { rerender } = render(Timer, {
      task: 'Task',
      mode: 'break',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Resume session' })).toBeNull();

    await rerender({
      task: 'Task',
      mode: 'break',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
      onResumeBreak,
    });
    const resumeButton = screen.getByRole('button', { name: 'Resume session' });
    await fireEvent.click(resumeButton);
    expect(onResumeBreak).toHaveBeenCalledOnce();
  });

  it('never shows Resume session outside break mode, even if onResumeBreak is supplied', () => {
    render(Timer, {
      task: 'Task',
      mode: 'focus',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
      onResumeBreak: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Resume session' })).toBeNull();
  });
```

- [ ] **Step 3: Run to verify failures**

Run: `npx vitest run src/lib/Timer.test.ts`
Expected: FAIL — old label assertion now mismatches current code, new Resume button doesn't exist.

- [ ] **Step 4: Update `Timer.svelte`**

Change the `finishLabel` record's `break` entry (around line 61) from `'End break'` to `'End session'`.

Add `onResumeBreak?: () => void;` to the props destructuring/type (after `onFinish: () => void;`).

In the template's `.controls` div (around line 81–90), add a new conditional button before the existing finish button:

```svelte
  <div class="controls">
    {#if mode !== 'break'}
      {#if isPaused}
        <button class="primary" onclick={onResume}>Resume</button>
      {:else}
        <button class="primary" onclick={onPause}>Pause</button>
      {/if}
    {/if}
    {#if mode === 'break' && onResumeBreak}
      <button class="primary" onclick={onResumeBreak}>Resume session</button>
    {/if}
    <button class="secondary" onclick={onFinish}>{finishLabel[mode]}</button>
  </div>
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/Timer.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Type-check**

Run: `npm run check`
Expected: 0 errors (note: `App.svelte`'s existing `onFinish={handleEndBreak}` call site for the break screen still compiles fine since `onResumeBreak` is optional — Task 7 wires it).

- [ ] **Step 7: Commit**

```bash
git add src/lib/Timer.svelte src/lib/Timer.test.ts
git commit -m "feat: add Resume session control to Timer's break mode"
```

---

## Task 7: App.svelte integration — wire resume, End session copy, and the Touch Grass threshold

**Files:**
- Modify: `src/App.svelte`
- Test: `src/App.test.ts`

**Interfaces:**
- Consumes: `resumeFromBreak` (Task 1), `touchGrassReminderThresholdToMs`/`AppSettings.touchGrassReminderThresholdMs` (Task 4), `FocusCompletionPrompt`'s `touchGrassSuggested`/`onTouchGrass` props (Task 5), `Timer`'s `onResumeBreak` prop (Task 6).
- Produces: `handleResumeFromBreak()`; a `touchGrassSuggested` derived value; full wiring of both prompts and the break screen.

- [ ] **Step 1: Add imports**

In the `import { ... } from './lib/session'` block (lines 2–25), add `resumeFromBreak` (alphabetically, after `restartFocusCycle` and before `resume` — match the block's existing near-alphabetical ordering by inserting it next to `restartFocusCycle`/`resume`).

In the `import { ... } from './lib/appearance'` block (lines 79–92), add `touchGrassReminderThresholdToMs`.

- [ ] **Step 2: Add the `handleResumeFromBreak` handler**

Add this function directly after `handleEndBreak` (around line 1418–1420):

```typescript
  function handleResumeFromBreak() {
    applyResult(resumeFromBreak(session, Date.now()));
  }
```

- [ ] **Step 3: Add the `touchGrassSuggested` derived value**

Add this near the other session-status derived values (`compactMode`, `isQuietOvertime`, etc., around line 1017–1052):

```typescript
  /** True once continuous focus since the session's last Touch Grass
   * exceeds the configured threshold — drives the highlighted suggestion
   * in FocusCompletionPrompt. Only meaningful during active focus/flow
   * (the only statuses that render that prompt); 'off' never suggests. */
  const touchGrassSuggested = $derived.by(() => {
    if (
      session.status !== 'focusing' &&
      session.status !== 'paused' &&
      session.status !== 'flow' &&
      session.status !== 'flowPaused'
    ) {
      return false;
    }
    const thresholdMs = touchGrassReminderThresholdToMs(
      settingsController?.current.touchGrassReminderThresholdMs ?? 'off',
    );
    if (thresholdMs === null) return false;
    return now - session.lastTouchGrassAt >= thresholdMs;
  });
```

Before writing this, check how the existing `compactMode`/similar derived values guard against `settingsController` being possibly-undefined during startup (search for `settingsController?.` elsewhere in the file) and match that exact null-safety pattern rather than assuming `?? 'off'` is correct — copy the established idiom.

- [ ] **Step 4: Wire the new props into both `FocusCompletionPrompt` render calls**

In the `completionPrompt` snippet (around line 1961–1981), add to both the `warning` and `overtime` branches:

```svelte
    {#if warningView.visible}
        <FocusCompletionPrompt
          kind="warning"
          leadLabel={warningView.leadLabel ?? ''}
          announcement={warningView.announcement}
          onPrimary={handleTakeBreakNow}
          onSecondary={handleContinueFocusing}
          touchGrassSuggested={touchGrassSuggested}
          onTouchGrass={() => handleStartIntermission('touchGrass')}
        />
      {:else if overtimeView.visible && overtimeView.phase}
        <FocusCompletionPrompt
          kind="overtime"
          phase={overtimeView.phase}
          leadLabel={overtimeView.leadLabel}
          announcement={overtimeView.announcement}
          onStay={handleStayWithIt}
          onBreak={handleTakeBreakFromOvertime}
          onEnd={handleEndOvertime}
          touchGrassSuggested={touchGrassSuggested}
          onTouchGrass={() => handleStartIntermission('touchGrass')}
        />
      {/if}
```

- [ ] **Step 5: Wire `onResumeBreak` into the break screen's `Timer`**

At the `{:else if session.status === 'break'}` render branch (around line 2302–2312), add `onResumeBreak={handleResumeFromBreak}`:

```svelte
      {:else if session.status === 'break'}
        <Timer
          task={session.task}
          mode="break"
          isPaused={false}
          displayMs={getBreakElapsedMs(session, now) ?? 0}
          onPause={() => {}}
          onResume={() => {}}
          onFinish={handleEndBreak}
          onResumeBreak={handleResumeFromBreak}
          onViewHistory={handleViewHistory}
        />
```

Leave `compactFinish()`'s `'break'` branch (around line 1066–1074) unchanged — it still calls `handleEndBreak()` only. The compact strip (shown while browsing History/Revisions during an active session) has room for a single tap target; adding a second choice there is out of scope for this plan. The full Break screen above is where Resume/End actually gets offered.

- [ ] **Step 6: Write the integration tests**

Add a new `describe` block to `src/App.test.ts`, placed after the existing `describe('Gentle focus completion integration (Phase 5B Task 8)', ...)` block (reuse that block's `startOneMinuteFocus` helper — either by moving it to module scope if it's currently local to that `describe`, or by duplicating the same four lines into the new block; check the existing file structure first and match whichever is more consistent with this file's conventions elsewhere):

```typescript
describe('Long session continuity — resume from break', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
  });

  it('resumes into a fresh focus cycle with the same task, note, and parked thoughts, and accumulates breakMs across two cycles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(App);
      const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
      await fireEvent.input(taskInput, { target: { value: 'Deep work' } });
      await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

      const parkingInput = screen.getByRole('textbox', { name: 'Plant a thought' });
      await fireEvent.input(parkingInput, { target: { value: 'Ping the design review' } });

      await vi.advanceTimersByTimeAsync(30_250);
      await fireEvent.click(screen.getByRole('button', { name: 'Take break now' }));
      expect(screen.getByRole('button', { name: 'Resume session' })).toBeTruthy();

      await vi.advanceTimersByTimeAsync(300_000); // 5 minutes on this first break
      await fireEvent.click(screen.getByRole('button', { name: 'Resume session' }));

      expect(screen.getByRole('heading', { name: 'Deep work' })).toBeTruthy();
      expect((screen.getByRole('textbox', { name: 'Plant a thought' }) as HTMLInputElement).value).toBe(
        'Ping the design review',
      );

      // A full new minute is available — advancing 30s must not re-trigger the warning.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(screen.queryByText('30 seconds left')).toBeNull();

      await vi.advanceTimersByTimeAsync(30_250);
      await fireEvent.click(screen.getByRole('button', { name: 'Take break now' }));
      await vi.advanceTimersByTimeAsync(600_000); // 10 minutes on this second break
      await fireEvent.click(screen.getByRole('button', { name: 'End session' }));

      expect(screen.getByText('Break')).toBeTruthy();
      // 5 + 10 minutes summed, not just the last break.
      expect(screen.getByText(/15/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('End session still ends the session normally, now labeled End session instead of End break', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(App);
      const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
      await fireEvent.input(taskInput, { target: { value: 'Deep work' } });
      await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

      await vi.advanceTimersByTimeAsync(30_250);
      await fireEvent.click(screen.getByRole('button', { name: 'Take break now' }));
      expect(screen.queryByRole('button', { name: 'End break' })).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'End session' }));

      expect(screen.getByRole('heading', { name: 'Session review' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Touch Grass automatic suggestion', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
  });

  it('highlights Touch Grass in the warning prompt once the configured threshold is exceeded', async () => {
    mocks.getSetting.mockImplementation(async (key: string) =>
      key === APP_SETTING_KEYS.touchGrassReminderThresholdMs ? '1800000' : null,
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(App);
      const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
      await fireEvent.input(taskInput, { target: { value: 'Deep work' } });
      await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

      // Under threshold: still focusing well within 30 minutes.
      await vi.advanceTimersByTimeAsync(30_250);
      expect(screen.queryByRole('button', { name: 'Time to stand up — Touch Grass?' })).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Continue focusing' }));

      // Push elapsed time past the 30-minute threshold via repeated restarts.
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(59_750);
        await fireEvent.click(screen.getByRole('button', { name: 'Continue focusing' }));
      }
      await vi.advanceTimersByTimeAsync(30_250);
      expect(screen.getByRole('button', { name: 'Time to stand up — Touch Grass?' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

Before finalizing these tests, read the existing `'Gentle focus completion integration'` and `'Resumable intermission integration (Phase 5C)'` `describe` blocks in full to confirm the exact `mocks.getSetting`/`mocks.loadLatestSessionRow` mock shapes, whether `screen.getByText('Break')`/similar stat-label lookups match how `SessionReview`'s DOM actually renders (adjust selectors to match reality rather than trusting this plan's guess), and how the file's `beforeEach` blocks are scoped — this plan's snippets are a starting point, not a byte-exact guarantee, given the file's 2986 lines evolve independently of this plan.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/App.test.ts`
Expected: PASS, all tests including the new ones. Iterate on selector mismatches against the real rendered DOM as needed — this is expected given the file's size and the plan author's inability to hand-verify every rendered string.

- [ ] **Step 8: Type-check and run the full suite**

Run: `npm run check`
Expected: 0 errors.

Run: `npm test -- --run`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/App.svelte src/App.test.ts
git commit -m "feat: wire break resume and automatic Touch Grass suggestion into App"
```

---

## Task 8: Final validation and live Tauri verification

**Files:** none (validation only).

- [ ] **Step 1: Full validation suite**

Run, in order, from the repo root:

```bash
npm run check
npm test -- --run
cd src-tauri && cargo check && cargo test && cd ..
```

Expected: all green — 0 type errors, full Vitest suite passing, `cargo check`/`cargo test` clean.

- [ ] **Step 2: Live Tauri/Playwright verification**

Following this project's established verification methodology (a real dev server, not just unit tests, for interactive/visual changes):

1. Start a fresh session, take a break via "Take break now" from the warning prompt, confirm the Break screen shows both "Resume session" and "End session" (not the old "End break").
2. Click "Resume session" — confirm the same task/notes/parked thoughts are still present and a fresh full-duration countdown is running.
3. Take a second break, click "End session" — confirm the review screen's "Break" stat shows the *summed* total of both breaks, not just the second one.
4. In Settings, set the Touch Grass reminder threshold to 30 minutes; start a session, restart the focus cycle repeatedly (or manipulate the system clock/wait) past 30 minutes; confirm the warning/overtime prompt shows the highlighted "Time to stand up — Touch Grass?" option, and that clicking it starts a Touch Grass intermission exactly like the existing manual Touch Grass button does.
5. Confirm an app restart mid-Break (or mid-focus after a resume) correctly recovers the accumulated `breakMs`/`lastTouchGrassAt` — no regression in the existing session-recovery behavior.

- [ ] **Step 3: Report completion**

Summarize what was verified and any deviations from the plan (selector adjustments in Task 7's tests, etc.) back to the user.
