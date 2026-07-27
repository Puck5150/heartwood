import { describe, expect, it } from 'vitest';
import { buildSessionHistory, toSessionSummary } from './history';
import { serializeSessionState } from './persistence';
import { chooseBreak, chooseFinish, completeFocus, createIdleState, endBreak, startFocus, type SessionState } from './session';
import type { ParkedThought } from './parkingLot';

function expectOk(result: { ok: boolean; state?: SessionState; error?: string }): SessionState {
  if (!result.ok) throw new Error(`Expected ok transition, got error: ${result.error}`);
  return result.state as SessionState;
}

const FOCUS_MS = 25 * 60 * 1000;
const T0 = 1_700_000_000_000;

function completedRow(sessionId: string, task: string, completedAt: number) {
  let state = expectOk(startFocus(createIdleState(), task, FOCUS_MS, T0, sessionId));
  state = expectOk(completeFocus(state, T0 + FOCUS_MS));
  state = expectOk(chooseFinish(state, completedAt));
  return serializeSessionState(state, completedAt)!;
}

describe('toSessionSummary', () => {
  it('returns null for a non-complete row', () => {
    const state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, T0, 'sid'));
    const row = serializeSessionState(state, T0)!;
    expect(toSessionSummary(row, 0)).toBeNull();
  });

  it('derives a correct summary from a real completed session row, including a break', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan the sprint', FOCUS_MS, T0, 'sid'));
    state = expectOk(completeFocus(state, T0 + FOCUS_MS));
    state = expectOk(chooseBreak(state, T0 + FOCUS_MS));
    state = expectOk(endBreak(state, T0 + FOCUS_MS + 300_000));
    const row = serializeSessionState(state, T0 + FOCUS_MS + 300_000)!;

    const summary = toSessionSummary(row, 2);
    expect(summary).toEqual({
      id: 'sid',
      task: 'Plan the sprint',
      completedAt: T0 + FOCUS_MS + 300_000,
      plannedFocusMs: FOCUS_MS,
      actualFocusMs: FOCUS_MS,
      flowMs: 0,
      tookBreak: true,
      breakMs: 300_000,
      totalElapsedMs: FOCUS_MS + 300_000,
      parkedThoughtCount: 2,
    });
  });
});

describe('buildSessionHistory', () => {
  it('filters out non-complete rows', () => {
    const activeState = expectOk(startFocus(createIdleState(), 'Still going', FOCUS_MS, T0, 'active'));
    const activeRow = serializeSessionState(activeState, T0)!;
    const completed = completedRow('done-1', 'Finished one', T0 + 1000);

    const history = buildSessionHistory([activeRow, completed], []);
    expect(history.map((s) => s.id)).toEqual(['done-1']);
  });

  it('orders completed sessions most-recently-completed first, regardless of input order', () => {
    const earliest = completedRow('s1', 'First', T0 + 1_000);
    const middle = completedRow('s2', 'Second', T0 + 2_000);
    const latest = completedRow('s3', 'Third', T0 + 3_000);

    const history = buildSessionHistory([middle, earliest, latest], []);
    expect(history.map((s) => s.id)).toEqual(['s3', 's2', 's1']);
  });

  it('counts currently-parked thoughts per session id', () => {
    const s1 = completedRow('s1', 'First', T0 + 1_000);
    const s2 = completedRow('s2', 'Second', T0 + 2_000);
    const thoughts: ParkedThought[] = [
      { id: 't1', sessionId: 's1', text: 'a', createdAt: T0 },
      { id: 't2', sessionId: 's1', text: 'b', createdAt: T0 },
      { id: 't3', sessionId: 's2', text: 'c', createdAt: T0 },
    ];

    const history = buildSessionHistory([s1, s2], thoughts);
    const bySessionId = new Map(history.map((s) => [s.id, s.parkedThoughtCount]));
    expect(bySessionId.get('s1')).toBe(2);
    expect(bySessionId.get('s2')).toBe(1);
  });

  it('returns an empty list when there are no completed sessions', () => {
    expect(buildSessionHistory([], [])).toEqual([]);
  });
});
