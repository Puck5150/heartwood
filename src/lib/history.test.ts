import { describe, expect, it } from 'vitest';
import { buildSessionHistory, toSessionSummary } from './history';
import type { SessionNoteRow } from './notes';
import { serializeSessionState } from './persistence';
import {
  completeFocusIntoFlow,
  createIdleState,
  endBreak,
  finishFlow,
  restartFocusCycle,
  startFocus,
  takeBreakFromFocus,
  type SessionState,
} from './session';
import type { ParkedThought } from './parkingLot';

function expectOk(result: { ok: boolean; state?: SessionState; error?: string }): SessionState {
  if (!result.ok) throw new Error(`Expected ok transition, got error: ${result.error}`);
  return result.state as SessionState;
}

const FOCUS_MS = 25 * 60 * 1000;
const T0 = 1_700_000_000_000;

function completedRow(sessionId: string, task: string, completedAt: number) {
  let state = expectOk(startFocus(createIdleState(), task, FOCUS_MS, T0, sessionId));
  state = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS));
  state = expectOk(finishFlow(state, completedAt));
  return serializeSessionState(state, completedAt)!;
}

function noteRow(sessionId: string, content: string): SessionNoteRow {
  return {
    id: `note-${sessionId}`,
    session_id: sessionId,
    content,
    file_path: `notes/${sessionId}.md`,
    content_hash: `hash-${sessionId}`,
    created_at: T0,
    updated_at: T0,
  };
}

describe('toSessionSummary', () => {
  it('returns null for a non-complete row', () => {
    const state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, T0, 'sid'));
    const row = serializeSessionState(state, T0)!;
    expect(toSessionSummary(row, 0, null, 0)).toBeNull();
  });

  it('derives a correct summary from a real completed session row, including a break', () => {
    let state = expectOk(startFocus(createIdleState(), 'Plan the sprint', FOCUS_MS, T0, 'sid'));
    state = expectOk(takeBreakFromFocus(state, T0 + FOCUS_MS));
    state = expectOk(endBreak(state, T0 + FOCUS_MS + 300_000));
    const row = serializeSessionState(state, T0 + FOCUS_MS + 300_000)!;

    const summary = toSessionSummary(row, 2, 'Went well overall', 3);
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
      noteContent: 'Went well overall',
      revisionCount: 3,
    });
  });

  it('reports actual focus greater than planned focus after a same-session restart (Phase 5B)', () => {
    let state = expectOk(startFocus(createIdleState(), 'Deep work', FOCUS_MS, T0, 'sid'));
    state = expectOk(restartFocusCycle(state, T0 + FOCUS_MS - 1_000)); // restart 1s before due
    state = expectOk(completeFocusIntoFlow(state, T0 + FOCUS_MS - 1_000 + FOCUS_MS));
    const completedAt = (state as { focusCompletedAt: number }).focusCompletedAt + 5_000;
    state = expectOk(finishFlow(state, completedAt));
    const row = serializeSessionState(state, completedAt)!;

    const summary = toSessionSummary(row, 0, null, 0)!;
    expect(summary.plannedFocusMs).toBe(FOCUS_MS);
    expect(summary.actualFocusMs).toBeGreaterThan(summary.plannedFocusMs);
  });
});

describe('buildSessionHistory', () => {
  it('filters out non-complete rows', () => {
    const activeState = expectOk(startFocus(createIdleState(), 'Still going', FOCUS_MS, T0, 'active'));
    const activeRow = serializeSessionState(activeState, T0)!;
    const completed = completedRow('done-1', 'Finished one', T0 + 1000);

    const history = buildSessionHistory([activeRow, completed], [], []);
    expect(history.map((s) => s.id)).toEqual(['done-1']);
  });

  it('orders completed sessions most-recently-completed first, regardless of input order', () => {
    const earliest = completedRow('s1', 'First', T0 + 1_000);
    const middle = completedRow('s2', 'Second', T0 + 2_000);
    const latest = completedRow('s3', 'Third', T0 + 3_000);

    const history = buildSessionHistory([middle, earliest, latest], [], []);
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

    const history = buildSessionHistory([s1, s2], thoughts, []);
    const bySessionId = new Map(history.map((s) => [s.id, s.parkedThoughtCount]));
    expect(bySessionId.get('s1')).toBe(2);
    expect(bySessionId.get('s2')).toBe(1);
  });

  it('reports a parked-thought count of exactly 0 when none are parked (not omitted)', () => {
    const row = completedRow('s1', 'No thoughts here', T0 + 1_000);
    const history = buildSessionHistory([row], [], []);
    expect(history[0].parkedThoughtCount).toBe(0);
  });

  it('returns an empty list when there are no completed sessions', () => {
    expect(buildSessionHistory([], [], [])).toEqual([]);
  });

  it('attaches a session note by session id', () => {
    const s1 = completedRow('s1', 'First', T0 + 1_000);
    const s2 = completedRow('s2', 'Second', T0 + 2_000);
    const notes = [noteRow('s1', 'Remembered to follow up with Sam')];

    const history = buildSessionHistory([s1, s2], [], notes);
    const bySessionId = new Map(history.map((s) => [s.id, s.noteContent]));
    expect(bySessionId.get('s1')).toBe('Remembered to follow up with Sam');
    expect(bySessionId.get('s2')).toBeNull();
  });

  it('treats an empty/whitespace-only note the same as no note', () => {
    const row = completedRow('s1', 'First', T0 + 1_000);
    const history = buildSessionHistory([row], [], [noteRow('s1', '   ')]);
    expect(history[0].noteContent).toBeNull();
  });

  it('attaches a revision count by session id', () => {
    const s1 = completedRow('s1', 'First', T0 + 1_000);
    const s2 = completedRow('s2', 'Second', T0 + 2_000);

    const history = buildSessionHistory([s1, s2], [], [], new Map([['s1', 2]]));
    const bySessionId = new Map(history.map((s) => [s.id, s.revisionCount]));
    expect(bySessionId.get('s1')).toBe(2);
    expect(bySessionId.get('s2')).toBe(0);
  });

  it('defaults every revision count to 0 when no map is provided', () => {
    const row = completedRow('s1', 'First', T0 + 1_000);
    const history = buildSessionHistory([row], [], []);
    expect(history[0].revisionCount).toBe(0);
  });
});
