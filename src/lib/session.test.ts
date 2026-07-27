import { describe, expect, it } from 'vitest';
import {
  chooseBreak,
  chooseFinish,
  chooseFlow,
  completeFocus,
  createIdleState,
  endBreak,
  finishFlow,
  getBreakElapsedMs,
  getFlowElapsedMs,
  getFocusRemainingMs,
  isFocusDue,
  pause,
  resume,
  startFocus,
  type SessionState,
} from './session';
import { addParkedThought, removeParkedThought } from './parkingLot';

function expectOk(result: { ok: boolean; state?: SessionState; error?: string }): SessionState {
  if (!result.ok) throw new Error(`Expected ok transition, got error: ${result.error}`);
  return result.state as SessionState;
}

const FOCUS_MS = 25 * 60 * 1000;

describe('session state machine', () => {
  it('runs a normal completion: start -> complete focus -> finish', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, t0));
    expect(state).toMatchObject({ status: 'focusing', task: 'Write the report' });

    expect(isFocusDue(state, t0 + FOCUS_MS - 1)).toBe(false);
    expect(isFocusDue(state, t0 + FOCUS_MS)).toBe(true);

    state = expectOk(completeFocus(state, t0 + FOCUS_MS));
    expect(state.status).toBe('awaitingDecision');

    state = expectOk(chooseFinish(state, t0 + FOCUS_MS + 5_000));
    expect(state).toMatchObject({
      status: 'complete',
      plannedFocusMs: FOCUS_MS,
      flowMs: 0,
      totalElapsedMs: FOCUS_MS,
    });
  });

  it('pauses and resumes, excluding paused time from remaining-time math', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Design review', FOCUS_MS, t0));

    state = expectOk(pause(state, t0 + 10_000));
    expect(getFocusRemainingMs(state, t0 + 999_999)).toBe(FOCUS_MS - 10_000);

    state = expectOk(resume(state, t0 + 70_000));
    expect(state).toMatchObject({ accumulatedPauseMs: 60_000 });
    expect(getFocusRemainingMs(state, t0 + 70_000)).toBe(FOCUS_MS - 10_000);
  });

  it('accumulates pause time correctly across repeated pause/resume cycles', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Deep work', FOCUS_MS, t0));

    state = expectOk(pause(state, t0 + 5_000));
    state = expectOk(resume(state, t0 + 8_000)); // +3s paused
    state = expectOk(pause(state, t0 + 20_000));
    state = expectOk(resume(state, t0 + 25_000)); // +5s paused
    state = expectOk(pause(state, t0 + 100_000));
    state = expectOk(resume(state, t0 + 112_000)); // +12s paused

    expect(state).toMatchObject({ accumulatedPauseMs: 20_000 });

    const dueAt = t0 + FOCUS_MS + 20_000;
    expect(isFocusDue(state, dueAt - 1)).toBe(false);
    expect(isFocusDue(state, dueAt)).toBe(true);
  });

  it('transitions into flow mode and counts up, including a pause inside flow', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Ship the feature', FOCUS_MS, t0));
    state = expectOk(completeFocus(state, t0 + FOCUS_MS));
    state = expectOk(chooseFlow(state, t0 + FOCUS_MS));
    expect(state.status).toBe('flow');
    expect(getFlowElapsedMs(state, t0 + FOCUS_MS + 30_000)).toBe(30_000);

    state = expectOk(pause(state, t0 + FOCUS_MS + 30_000));
    expect(state.status).toBe('flowPaused');
    expect(getFlowElapsedMs(state, t0 + FOCUS_MS + 999_999)).toBe(30_000);

    state = expectOk(resume(state, t0 + FOCUS_MS + 40_000)); // 10s flow-paused
    expect(getFlowElapsedMs(state, t0 + FOCUS_MS + 90_000)).toBe(80_000);

    state = expectOk(finishFlow(state, t0 + FOCUS_MS + 90_000));
    expect(state).toMatchObject({
      status: 'complete',
      plannedFocusMs: FOCUS_MS,
      flowMs: 80_000,
      totalElapsedMs: FOCUS_MS + 80_000,
    });
  });

  it('supports the break branch through to session completion', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Plan the sprint', FOCUS_MS, t0));
    state = expectOk(completeFocus(state, t0 + FOCUS_MS));
    state = expectOk(chooseBreak(state, t0 + FOCUS_MS));
    expect(state.status).toBe('break');
    expect(getBreakElapsedMs(state, t0 + FOCUS_MS + 120_000)).toBe(120_000);

    state = expectOk(endBreak(state, t0 + FOCUS_MS + 300_000));
    expect(state).toMatchObject({
      status: 'complete',
      tookBreak: true,
      breakMs: 300_000,
      totalElapsedMs: FOCUS_MS,
    });
  });

  it('rejects invalid transitions instead of silently changing state', () => {
    const t0 = 1_000_000;
    const idle = createIdleState();

    expect(pause(idle, t0).ok).toBe(false);
    expect(resume(idle, t0).ok).toBe(false);
    expect(chooseFlow(idle, t0).ok).toBe(false);
    expect(completeFocus(idle, t0).ok).toBe(false);

    const focusing = expectOk(startFocus(idle, 'Focused task', FOCUS_MS, t0));
    expect(startFocus(focusing, 'Second task', FOCUS_MS, t0 + 1).ok).toBe(false);
    expect(resume(focusing, t0 + 1).ok).toBe(false);
    expect(completeFocus(focusing, t0 + 1).ok).toBe(false); // too early

    const paused = expectOk(pause(focusing, t0 + 1_000));
    expect(pause(paused, t0 + 2_000).ok).toBe(false);
    expect(chooseFinish(paused, t0 + 2_000).ok).toBe(false);
  });

  it('starts the next session from a parked thought after review', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'First task', FOCUS_MS, t0));

    let thoughts = addParkedThought([], 'p1', 'Check on the deploy', t0 + 5_000);
    thoughts = addParkedThought(thoughts, 'p2', 'Reply to Sam', t0 + 6_000);

    state = expectOk(completeFocus(state, t0 + FOCUS_MS));
    state = expectOk(chooseFinish(state, t0 + FOCUS_MS));
    expect(state.status).toBe('complete');

    const promoted = thoughts.find((thought) => thought.id === 'p1')!;
    thoughts = removeParkedThought(thoughts, promoted.id);
    expect(thoughts.map((t) => t.id)).toEqual(['p2']);

    state = expectOk(startFocus(state, promoted.text, FOCUS_MS, t0 + FOCUS_MS + 10_000));
    expect(state).toMatchObject({ status: 'focusing', task: 'Check on the deploy' });
  });

  it('computes remaining focus time correctly across a DST transition boundary', () => {
    // 2026-03-08 is the US spring-forward transition (clocks skip 2:00-3:00 AM
    // Eastern). Timestamps are plain epoch ms throughout this module, so a
    // real-world DST jump must not perturb the arithmetic at all - this test
    // guards against a future rewrite that starts doing local-calendar math.
    const startedAt = Date.UTC(2026, 2, 8, 6, 30, 0); // 01:30 EST, just before the jump
    const plannedDurationMs = 60 * 60 * 1000; // a 60-minute focus session

    let state = expectOk(startFocus(createIdleState(), 'Cross the DST boundary', plannedDurationMs, startedAt));

    const midway = startedAt + 40 * 60 * 1000;
    expect(getFocusRemainingMs(state, midway)).toBe(20 * 60 * 1000);
    expect(isFocusDue(state, midway)).toBe(false);

    const dueAt = startedAt + plannedDurationMs;
    expect(getFocusRemainingMs(state, dueAt)).toBe(0);
    expect(isFocusDue(state, dueAt)).toBe(true);

    state = expectOk(completeFocus(state, dueAt));
    expect(state.status).toBe('awaitingDecision');
  });
});
