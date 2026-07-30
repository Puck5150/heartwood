import { describe, expect, it } from 'vitest';
import {
  deserializeParkedThoughtRow,
  deserializeSessionRow,
  recoverSessionState,
  serializeParkedThought,
  serializeSessionState,
  type SessionRow,
} from './persistence';
import {
  completeFocusIntoFlow,
  createIdleState,
  endBreak,
  finishFlow,
  pause,
  restartFocusCycle,
  resume,
  startFocus,
  takeBreakFromFlow,
  takeBreakFromFocus,
  type SessionState,
} from './session';

function expectOk(result: { ok: boolean; state?: SessionState; error?: string }): SessionState {
  if (!result.ok) throw new Error(`Expected ok transition, got error: ${result.error}`);
  return result.state as SessionState;
}

const FOCUS_MS = 25 * 60 * 1000;
const SID = 'session-1';
const T0 = 1_700_000_000_000;

describe('session state <-> row round trip', () => {
  it('serializes idle to null (nothing to persist yet)', () => {
    expect(serializeSessionState(createIdleState(), T0)).toBeNull();
  });

  it('round-trips a focusing state', () => {
    const state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, T0, SID));
    const row = serializeSessionState(state, T0 + 1)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a paused state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Design review', FOCUS_MS, T0, SID));
    state = expectOk(pause(state, T0 + 10_000));
    const row = serializeSessionState(state, T0 + 10_000)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips an awaitingDecision state (compatibility only — no live transition creates this)', () => {
    const state: SessionState = {
      status: 'awaitingDecision',
      sessionId: SID,
      task: 'Ship it',
      startedAt: T0,
      plannedDurationMs: FOCUS_MS,
      accumulatedPauseMs: 0,
      focusCompletedAt: T0 + FOCUS_MS,
    };
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a flow state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Ship it', FOCUS_MS, T0, SID));
    state = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS + 1)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a flowPaused state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Ship it', FOCUS_MS, T0, SID));
    state = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS));
    state = expectOk(pause(state, T0 + FOCUS_MS + 30_000));
    const row = serializeSessionState(state, T0 + FOCUS_MS + 30_000)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a break state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(takeBreakFromFocus(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a complete state, including the tookBreak boolean through 0/1', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(takeBreakFromFocus(state, T0 + FOCUS_MS));
    state = expectOk(endBreak(state, T0 + FOCUS_MS + 300_000));
    const row = serializeSessionState(state, T0 + FOCUS_MS + 300_000)!;
    expect(row.took_break).toBe(1);
    expect(deserializeSessionRow(row)).toEqual(state);
  });
});

describe('parked thought row round trip', () => {
  it('round-trips id/sessionId/text/createdAt through snake_case columns', () => {
    const thought = { id: 't1', sessionId: SID, text: 'Check the deploy', createdAt: T0 };
    const row = serializeParkedThought(thought);
    expect(row).toEqual({ id: 't1', session_id: SID, text: 'Check the deploy', created_at: T0 });
    expect(deserializeParkedThoughtRow(row)).toEqual(thought);
  });
});

describe('recoverSessionState', () => {
  it('recovers to idle when there is no stored session', () => {
    expect(recoverSessionState(null, T0)).toEqual(createIdleState());
  });

  it('restores a still-running focusing session unchanged', () => {
    const state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, T0, SID));
    const row = serializeSessionState(state, T0)!;
    const recovered = recoverSessionState(row, T0 + 5 * 60_000); // 5 minutes in, not due yet
    expect(recovered).toEqual(state);
  });

  it('promotes an expired focus session straight to quiet Flow on recovery (Phase 5B), using the deadline not the reopen time', () => {
    const state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, T0, SID));
    const row = serializeSessionState(state, T0)!;
    const plannedEndAt = T0 + FOCUS_MS;
    const reopenedAt = plannedEndAt + 10 * 60_000; // app was reopened 10 minutes after the planned end
    const recovered = recoverSessionState(row, reopenedAt);
    expect(recovered).toMatchObject({
      status: 'flow',
      sessionId: SID,
      task: 'Write the report',
      focusCompletedAt: plannedEndAt, // not reopenedAt — completion happened when the timer expired
      flowStartedAt: plannedEndAt,
    });
  });

  it('accounts for accumulated pause time when computing the deadline on recovery', () => {
    let state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, T0, SID));
    state = expectOk(pause(state, T0 + 10_000));
    state = expectOk(resume(state, T0 + 70_000)); // 60s paused
    const row = serializeSessionState(state, T0 + 70_000)!;
    const plannedEndAt = T0 + FOCUS_MS + 60_000; // planned end pushed back by the pause
    const recovered = recoverSessionState(row, plannedEndAt + 15 * 60_000);
    expect(recovered).toMatchObject({
      status: 'flow',
      focusCompletedAt: plannedEndAt,
    });
  });

  it('restores a paused session frozen at its pausedAt timestamp', () => {
    let state = expectOk(startFocus(createIdleState(), 'Design review', FOCUS_MS, T0, SID));
    state = expectOk(pause(state, T0 + 10_000));
    const row = serializeSessionState(state, T0 + 10_000)!;
    const recovered = recoverSessionState(row, T0 + 999_999); // long after relaunch
    expect(recovered).toEqual(state);
  });

  it('restores a flow session so elapsed time still recomputes live from timestamps', () => {
    let state = expectOk(startFocus(createIdleState(), 'Ship it', FOCUS_MS, T0, SID));
    state = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    const recovered = recoverSessionState(row, T0 + FOCUS_MS + 60_000);
    // Recovery restores the tagged state as-is; elapsed flow time is a live
    // selector (getFlowElapsedMs), not something stored or recomputed here.
    expect(recovered).toEqual(state);
  });

  it('restores a completed session back to its review screen, not a fresh idle start', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS));
    state = expectOk(finishFlow(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    expect(recoverSessionState(row, T0 + FOCUS_MS + 60_000)).toEqual(state);
  });
});

describe('focus_deadline_at persistence (Phase 5B)', () => {
  it('round-trips focusing and paused rows with an explicit focus_deadline_at', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, T0, SID));
    let row = serializeSessionState(state, T0)!;
    expect(row.focus_deadline_at).toBe(T0 + FOCUS_MS);
    expect(deserializeSessionRow(row)).toEqual(state);

    state = expectOk(pause(state, T0 + 10_000));
    row = serializeSessionState(state, T0 + 10_000)!;
    expect(row.focus_deadline_at).toBe(T0 + FOCUS_MS);
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('serializes a null focus_deadline_at for Flow, FlowPaused, Break, and Complete', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, T0, SID));
    const flow = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS));
    expect(serializeSessionState(flow, T0 + FOCUS_MS)!.focus_deadline_at).toBeNull();

    const flowPaused = expectOk(pause(flow, T0 + FOCUS_MS + 5_000));
    expect(serializeSessionState(flowPaused, T0 + FOCUS_MS + 5_000)!.focus_deadline_at).toBeNull();

    const broken = expectOk(takeBreakFromFlow(flow, T0 + FOCUS_MS + 10_000));
    expect(serializeSessionState(broken, T0 + FOCUS_MS + 10_000)!.focus_deadline_at).toBeNull();

    const complete = expectOk(endBreak(broken, T0 + FOCUS_MS + 700_000));
    expect(serializeSessionState(complete, T0 + FOCUS_MS + 700_000)!.focus_deadline_at).toBeNull();
  });

  it('round-trips Break with actualFocusMs and flowMsBeforeBreak through the existing actual_focus_ms/flow_ms columns', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, T0, SID));
    state = expectOk(restartFocusCycle(state, T0 + FOCUS_MS - 1_000));
    let flow = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS - 1_000 + FOCUS_MS));
    const focusCompletedAt = (flow as { focusCompletedAt: number }).focusCompletedAt;
    const broken = expectOk(takeBreakFromFlow(flow, focusCompletedAt + 45_000));

    const row = serializeSessionState(broken, focusCompletedAt + 45_000)!;
    expect(row.actual_focus_ms).toBe(focusCompletedAt - T0);
    expect(row.flow_ms).toBe(45_000);
    expect(deserializeSessionRow(row)).toEqual(broken);
  });

  it('round-trips a break taken directly from focus (Take break now) with zero prior Flow', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, T0, SID));
    const broken = expectOk(takeBreakFromFocus(state, T0 + 5_000));
    const row = serializeSessionState(broken, T0 + 5_000)!;
    expect(row.actual_focus_ms).toBe(5_000);
    expect(row.flow_ms).toBe(0);
    expect(deserializeSessionRow(row)).toEqual(broken);
  });

  it('derives the deadline for a legacy focusing/paused row with a null focus_deadline_at', () => {
    const legacyRow: SessionRow = {
      id: SID,
      task: 'Legacy task',
      status: 'focusing',
      started_at: T0,
      planned_duration_ms: FOCUS_MS,
      accumulated_pause_ms: 5_000,
      paused_at: null,
      focus_completed_at: null,
      flow_started_at: null,
      flow_accumulated_pause_ms: null,
      flow_paused_at: null,
      break_started_at: null,
      planned_focus_ms: null,
      actual_focus_ms: null,
      flow_ms: null,
      took_break: null,
      break_ms: null,
      total_elapsed_ms: null,
      completed_at: null,
      focus_deadline_at: null,
      updated_at: T0,
    };

    const restored = deserializeSessionRow(legacyRow);
    expect(restored).toMatchObject({ status: 'focusing', focusDeadlineAt: T0 + FOCUS_MS + 5_000 });
  });

  it('derives zero prior Flow and plannedDurationMs actual focus for a legacy break row missing the new totals', () => {
    const legacyRow: SessionRow = {
      id: SID,
      task: 'Legacy task',
      status: 'break',
      started_at: T0,
      planned_duration_ms: FOCUS_MS,
      accumulated_pause_ms: 0,
      paused_at: null,
      focus_completed_at: T0 + FOCUS_MS,
      flow_started_at: null,
      flow_accumulated_pause_ms: null,
      flow_paused_at: null,
      break_started_at: T0 + FOCUS_MS,
      planned_focus_ms: null,
      actual_focus_ms: null,
      flow_ms: null,
      took_break: null,
      break_ms: null,
      total_elapsed_ms: null,
      completed_at: null,
      focus_deadline_at: null,
      updated_at: T0,
    };

    const restored = deserializeSessionRow(legacyRow);
    expect(restored).toMatchObject({ status: 'break', actualFocusMs: FOCUS_MS, flowMsBeforeBreak: 0 });
  });

  it('recovers a live overdue focusing row directly into quiet Flow at the exact deadline, no awaitingDecision', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, T0, SID));
    const row = serializeSessionState(state, T0)!;
    const reopenedAt = T0 + FOCUS_MS + 10 * 60_000; // reopened 10 minutes after the deadline

    const recovered = recoverSessionState(row, reopenedAt);
    expect(recovered).toMatchObject({
      status: 'flow',
      focusCompletedAt: T0 + FOCUS_MS, // the deadline, not the reopen instant
      flowStartedAt: T0 + FOCUS_MS,
      flowAccumulatedPauseMs: 0,
    });
  });

  it('recovers a legacy overdue focusing row (no focus_deadline_at) into Flow at the derived deadline', () => {
    const legacyRow: SessionRow = {
      id: SID,
      task: 'Legacy task',
      status: 'focusing',
      started_at: T0,
      planned_duration_ms: FOCUS_MS,
      accumulated_pause_ms: 0,
      paused_at: null,
      focus_completed_at: null,
      flow_started_at: null,
      flow_accumulated_pause_ms: null,
      flow_paused_at: null,
      break_started_at: null,
      planned_focus_ms: null,
      actual_focus_ms: null,
      flow_ms: null,
      took_break: null,
      break_ms: null,
      total_elapsed_ms: null,
      completed_at: null,
      focus_deadline_at: null,
      updated_at: T0,
    };
    const reopenedAt = T0 + FOCUS_MS + 60_000;

    const recovered = recoverSessionState(legacyRow, reopenedAt);
    expect(recovered).toMatchObject({ status: 'flow', focusCompletedAt: T0 + FOCUS_MS, flowStartedAt: T0 + FOCUS_MS });
  });

  it('recovers a legacy awaitingDecision row into Flow at its stored focus_completed_at', () => {
    // A genuinely legacy row shape, predating Phase 5B — no live transition
    // creates 'awaitingDecision' anymore, so this is built directly rather
    // than via any session.ts transition.
    const state: SessionState = {
      status: 'awaitingDecision',
      sessionId: SID,
      task: 'Task',
      startedAt: T0,
      plannedDurationMs: FOCUS_MS,
      accumulatedPauseMs: 0,
      focusCompletedAt: T0 + FOCUS_MS,
    };
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    const reopenedAt = T0 + FOCUS_MS + 15 * 60_000;

    const recovered = recoverSessionState(row, reopenedAt);
    expect(recovered).toMatchObject({
      status: 'flow',
      focusCompletedAt: T0 + FOCUS_MS,
      flowStartedAt: T0 + FOCUS_MS,
      flowAccumulatedPauseMs: 0,
    });
  });

  it('never carries a focus deadline into recovered Flow', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, T0, SID));
    const row = serializeSessionState(state, T0)!;
    const recovered = recoverSessionState(row, T0 + FOCUS_MS + 1_000);
    expect(recovered).not.toHaveProperty('focusDeadlineAt');
  });

  it('leaves completed history rows unchanged by recovery', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS));
    state = expectOk(finishFlow(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    expect(recoverSessionState(row, T0 + FOCUS_MS + 999_999)).toEqual(state);
  });
});
