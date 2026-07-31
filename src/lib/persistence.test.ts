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
  returnFromIntermission,
  resume,
  startFocus,
  startIntermission,
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
      breakIntermissionMs: 0,
      touchGrassMs: 0,
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

  it('round-trips active intermissions with focus and Flow return snapshots', () => {
    let focus = expectOk(startFocus(createIdleState(), 'Focus return', FOCUS_MS, T0, SID));
    const focusIntermission = expectOk(
      startIntermission(focus, 'break', 5 * 60_000, T0 + 10_000),
    );
    const focusRow = serializeSessionState(focusIntermission, T0 + 10_000)!;
    expect(focusRow).toMatchObject({
      status: 'intermission',
      intermission_kind: 'break',
      intermission_return_status: 'focusing',
      paused_at: T0 + 10_000,
      focus_deadline_at: T0 + FOCUS_MS,
    });
    expect(deserializeSessionRow(focusRow)).toEqual(focusIntermission);

    focus = expectOk(completeFocusIntoFlow(focus, T0 + FOCUS_MS));
    const flowPaused = expectOk(pause(focus, T0 + FOCUS_MS + 20_000));
    const flowIntermission = expectOk(
      startIntermission(flowPaused, 'touchGrass', 15 * 60_000, T0 + FOCUS_MS + 30_000),
    );
    const flowRow = serializeSessionState(flowIntermission, T0 + FOCUS_MS + 30_000)!;
    expect(flowRow).toMatchObject({
      status: 'intermission',
      intermission_kind: 'touchGrass',
      intermission_return_status: 'flowPaused',
      flow_paused_at: T0 + FOCUS_MS + 20_000,
      focus_deadline_at: null,
    });
    expect(deserializeSessionRow(flowRow)).toEqual(flowIntermission);
  });

  it('clears active intermission columns after return while retaining totals', () => {
    let state = expectOk(startFocus(createIdleState(), 'Return', FOCUS_MS, T0, SID));
    state = expectOk(startIntermission(state, 'break', 5 * 60_000, T0 + 10_000));
    state = expectOk(returnFromIntermission(state, T0 + 70_000));

    const row = serializeSessionState(state, T0 + 70_000)!;
    expect(row).toMatchObject({
      status: 'focusing',
      intermission_kind: null,
      intermission_started_at: null,
      intermission_deadline_at: null,
      intermission_return_status: null,
      break_intermission_ms: 60_000,
      touch_grass_ms: 0,
    });
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('rejects partial, contradictory, and unknown active intermission rows', () => {
    const source = expectOk(startFocus(createIdleState(), 'Malformed', FOCUS_MS, T0, SID));
    const intermission = expectOk(startIntermission(source, 'break', 5 * 60_000, T0 + 10_000));
    const valid = serializeSessionState(intermission, T0 + 10_000)!;

    expect(() => deserializeSessionRow({ ...valid, intermission_deadline_at: null })).toThrow(
      /intermission_deadline_at is required/,
    );
    expect(() => deserializeSessionRow({ ...valid, intermission_kind: 'nap' })).toThrow(
      /unknown or missing intermission_kind/,
    );
    expect(() => deserializeSessionRow({ ...valid, flow_started_at: T0 })).toThrow(
      /focus return contains Flow fields/,
    );
    expect(() => deserializeSessionRow({ ...valid, status: 'focusing' })).toThrow(
      /active intermission fields require status/,
    );
    expect(() =>
      deserializeSessionRow({
        ...valid,
        intermission_deadline_at: valid.intermission_started_at! + 12 * 60_000,
      }),
    ).toThrow(/approved duration/);
    expect(() => deserializeSessionRow({ ...valid, focus_deadline_at: null })).toThrow(
      /focus_deadline_at is required/,
    );
    expect(() =>
      deserializeSessionRow({
        ...valid,
        paused_at: valid.intermission_started_at! - 1,
      }),
    ).toThrow(/active focus return must freeze at the intermission start/);
    expect(() =>
      deserializeSessionRow({
        ...valid,
        intermission_return_status: 'paused',
        paused_at: valid.intermission_started_at! + 1,
      }),
    ).toThrow(/paused focus return cannot start after the intermission/);

    const flow = expectOk(completeFocusIntoFlow(source, T0 + FOCUS_MS));
    const flowIntermission = expectOk(
      startIntermission(flow, 'touchGrass', 15 * 60_000, T0 + FOCUS_MS + 10_000),
    );
    const flowRow = serializeSessionState(flowIntermission, T0 + FOCUS_MS + 10_000)!;
    expect(() =>
      deserializeSessionRow({
        ...flowRow,
        flow_paused_at: flowRow.intermission_started_at! - 1,
      }),
    ).toThrow(/active Flow return must freeze at the intermission start/);
    expect(() =>
      deserializeSessionRow({
        ...flowRow,
        intermission_return_status: 'flowPaused',
        flow_paused_at: flowRow.intermission_started_at! + 1,
      }),
    ).toThrow(/paused Flow return cannot start after the intermission/);
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

  it('recovers an intermission unchanged before and after its deadline', () => {
    const source = expectOk(startFocus(createIdleState(), 'Recover break', FOCUS_MS, T0, SID));
    const state = expectOk(startIntermission(source, 'break', 5 * 60_000, T0 + 10_000));
    const row = serializeSessionState(state, T0 + 10_000)!;

    expect(recoverSessionState(row, T0 + 60_000)).toEqual(state);
    expect(recoverSessionState(row, T0 + 20 * 60_000)).toEqual(state);
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
      review_acknowledged_at: null,
      intermission_kind: null,
      intermission_started_at: null,
      intermission_deadline_at: null,
      intermission_return_status: null,
      break_intermission_ms: 0,
      touch_grass_ms: 0,
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
      review_acknowledged_at: null,
      intermission_kind: null,
      intermission_started_at: null,
      intermission_deadline_at: null,
      intermission_return_status: null,
      break_intermission_ms: 0,
      touch_grass_ms: 0,
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
      review_acknowledged_at: null,
      intermission_kind: null,
      intermission_started_at: null,
      intermission_deadline_at: null,
      intermission_return_status: null,
      break_intermission_ms: 0,
      touch_grass_ms: 0,
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
      breakIntermissionMs: 0,
      touchGrassMs: 0,
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

describe('review acknowledgement recovery (PR #14 review fix)', () => {
  function completedRow(overrides: Partial<SessionRow> = {}): SessionRow {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS));
    state = expectOk(finishFlow(state, T0 + FOCUS_MS));
    return { ...serializeSessionState(state, T0 + FOCUS_MS)!, ...overrides };
  }

  it('serializes a fresh completed session with review_acknowledged_at null', () => {
    const row = completedRow();
    expect(row.review_acknowledged_at).toBeNull();
  });

  it('recovers an unacknowledged completed session to Review, unchanged', () => {
    const row = completedRow({ review_acknowledged_at: null });
    const recovered = recoverSessionState(row, T0 + FOCUS_MS + 999_999);
    expect(recovered).toMatchObject({ status: 'complete', sessionId: SID });
  });

  it('recovers an acknowledged completed session to idle instead of Review', () => {
    const row = completedRow({ review_acknowledged_at: T0 + FOCUS_MS + 500 });
    const recovered = recoverSessionState(row, T0 + FOCUS_MS + 999_999);
    expect(recovered).toEqual(createIdleState());
  });

  it('never acknowledges a non-complete row (the gate only ever applies to status = complete)', () => {
    // An unrelated column happening to be non-null on a differently-statused
    // row (which recoverSessionState should never actually see in practice,
    // since only 'complete' rows are ever acknowledged) must not accidentally
    // trip the idle gate.
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, T0, SID));
    const row = { ...serializeSessionState(state, T0)!, review_acknowledged_at: T0 };
    const recovered = recoverSessionState(row, T0 + 5_000);
    expect(recovered).toMatchObject({ status: 'focusing', sessionId: SID });
  });
});
