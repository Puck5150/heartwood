import { describe, expect, it } from 'vitest';
import {
  deserializeParkedThoughtRow,
  deserializeSessionRow,
  recoverSessionState,
  serializeParkedThought,
  serializeSessionState,
} from './persistence';
import {
  chooseBreak,
  chooseFinish,
  chooseFlow,
  completeFocus,
  createIdleState,
  endBreak,
  pause,
  startFocus,
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

  it('round-trips an awaitingDecision state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Ship it', FOCUS_MS, T0, SID));
    state = expectOk(completeFocus(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a flow state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Ship it', FOCUS_MS, T0, SID));
    state = expectOk(completeFocus(state, T0 + FOCUS_MS));
    state = expectOk(chooseFlow(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS + 1)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a flowPaused state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Ship it', FOCUS_MS, T0, SID));
    state = expectOk(completeFocus(state, T0 + FOCUS_MS));
    state = expectOk(chooseFlow(state, T0 + FOCUS_MS));
    state = expectOk(pause(state, T0 + FOCUS_MS + 30_000));
    const row = serializeSessionState(state, T0 + FOCUS_MS + 30_000)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a break state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(completeFocus(state, T0 + FOCUS_MS));
    state = expectOk(chooseBreak(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    expect(deserializeSessionRow(row)).toEqual(state);
  });

  it('round-trips a complete state, including the tookBreak boolean through 0/1', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(completeFocus(state, T0 + FOCUS_MS));
    state = expectOk(chooseBreak(state, T0 + FOCUS_MS));
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

  it('promotes an expired focus session straight to awaitingDecision on recovery', () => {
    const state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, T0, SID));
    const row = serializeSessionState(state, T0)!;
    const reopenedAt = T0 + FOCUS_MS + 10 * 60_000; // app was closed past the planned end
    const recovered = recoverSessionState(row, reopenedAt);
    expect(recovered).toMatchObject({
      status: 'awaitingDecision',
      sessionId: SID,
      task: 'Write the report',
      focusCompletedAt: reopenedAt,
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
    state = expectOk(completeFocus(state, T0 + FOCUS_MS));
    state = expectOk(chooseFlow(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    const recovered = recoverSessionState(row, T0 + FOCUS_MS + 60_000);
    // Recovery restores the tagged state as-is; elapsed flow time is a live
    // selector (getFlowElapsedMs), not something stored or recomputed here.
    expect(recovered).toEqual(state);
  });

  it('recovers a completed session to a fresh idle start, not a resurrected review screen', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan sprint', FOCUS_MS, T0, SID));
    state = expectOk(completeFocus(state, T0 + FOCUS_MS));
    state = expectOk(chooseFinish(state, T0 + FOCUS_MS));
    const row = serializeSessionState(state, T0 + FOCUS_MS)!;
    expect(recoverSessionState(row, T0 + FOCUS_MS + 60_000)).toEqual(createIdleState());
  });
});
