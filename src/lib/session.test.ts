import { describe, expect, it } from 'vitest';
import {
  chooseBreak,
  chooseFinish,
  chooseFlow,
  completeFocus,
  completeFocusIntoFlow,
  createIdleState,
  endBreak,
  finishFlow,
  finishFocusEarly,
  getBreakElapsedMs,
  getFlowElapsedMs,
  getFocusRemainingMs,
  isFocusDue,
  pause,
  resume,
  restartFocusCycle,
  startFocus,
  takeBreakFromFlow,
  takeBreakFromFocus,
  type SessionState,
} from './session';
import { addParkedThought, removeParkedThought } from './parkingLot';

function expectOk(result: { ok: boolean; state?: SessionState; error?: string }): SessionState {
  if (!result.ok) throw new Error(`Expected ok transition, got error: ${result.error}`);
  return result.state as SessionState;
}

const FOCUS_MS = 25 * 60 * 1000;
const SID = 'session-1';

describe('session state machine', () => {
  it('runs a normal completion: start -> complete focus -> finish', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, t0, SID));
    expect(state).toMatchObject({ status: 'focusing', task: 'Write the report', sessionId: SID });

    expect(isFocusDue(state, t0 + FOCUS_MS - 1)).toBe(false);
    expect(isFocusDue(state, t0 + FOCUS_MS)).toBe(true);

    state = expectOk(completeFocus(state, t0 + FOCUS_MS));
    expect(state.status).toBe('awaitingDecision');

    state = expectOk(chooseFinish(state, t0 + FOCUS_MS + 5_000));
    expect(state).toMatchObject({
      status: 'complete',
      sessionId: SID,
      startedAt: t0,
      focusCompletedAt: t0 + FOCUS_MS, // preserved raw timestamp, not overwritten by chooseFinish's `now`
      plannedFocusMs: FOCUS_MS,
      actualFocusMs: FOCUS_MS, // completed naturally, so actual equals planned
      flowMs: 0,
      totalElapsedMs: FOCUS_MS + 5_000, // includes the 5s spent on the decision screen
    });
  });

  it('pauses and resumes, excluding paused time from remaining-time math', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Design review', FOCUS_MS, t0, SID));

    state = expectOk(pause(state, t0 + 10_000));
    expect(getFocusRemainingMs(state, t0 + 999_999)).toBe(FOCUS_MS - 10_000);

    state = expectOk(resume(state, t0 + 70_000));
    expect(state).toMatchObject({ accumulatedPauseMs: 60_000 });
    expect(getFocusRemainingMs(state, t0 + 70_000)).toBe(FOCUS_MS - 10_000);
  });

  it('accumulates pause time correctly across repeated pause/resume cycles', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Deep work', FOCUS_MS, t0, SID));

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
    let state = expectOk(startFocus(createIdleState(), 'Ship the feature', FOCUS_MS, t0, SID));
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
      sessionId: SID,
      startedAt: t0,
      focusCompletedAt: t0 + FOCUS_MS,
      plannedFocusMs: FOCUS_MS,
      actualFocusMs: FOCUS_MS,
      flowMs: 80_000, // excludes the 10s flow-pause
      totalElapsedMs: FOCUS_MS + 90_000, // wall-clock span, includes the flow-pause
    });
  });

  it('supports the break branch through to session completion, including break time in totalElapsedMs', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Plan the sprint', FOCUS_MS, t0, SID));
    state = expectOk(completeFocus(state, t0 + FOCUS_MS));
    state = expectOk(chooseBreak(state, t0 + FOCUS_MS));
    expect(state.status).toBe('break');
    expect(getBreakElapsedMs(state, t0 + FOCUS_MS + 120_000)).toBe(120_000);

    state = expectOk(endBreak(state, t0 + FOCUS_MS + 300_000));
    expect(state).toMatchObject({
      status: 'complete',
      sessionId: SID,
      startedAt: t0,
      focusCompletedAt: t0 + FOCUS_MS,
      plannedFocusMs: FOCUS_MS,
      actualFocusMs: FOCUS_MS,
      tookBreak: true,
      breakMs: 300_000,
      totalElapsedMs: FOCUS_MS + 300_000, // was incorrectly just FOCUS_MS before this fix
    });
  });

  it('finishes a focusing session early via the escape hatch, recording only the accrued focus time', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Draft the email', FOCUS_MS, t0, SID));

    state = expectOk(finishFocusEarly(state, t0 + 7 * 60_000)); // quit after 7 minutes
    expect(state).toMatchObject({
      status: 'complete',
      sessionId: SID,
      startedAt: t0,
      focusCompletedAt: t0 + 7 * 60_000, // the instant focus ended, early or not
      plannedFocusMs: FOCUS_MS, // the original 25-minute target, unchanged
      actualFocusMs: 7 * 60_000, // what was actually accrued before quitting
      flowMs: 0,
      tookBreak: false,
      breakMs: 0,
      totalElapsedMs: 7 * 60_000,
    });
  });

  it('finishes a paused session early, excluding the paused dwell from accrued focus time', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Draft the email', FOCUS_MS, t0, SID));
    state = expectOk(pause(state, t0 + 5 * 60_000));

    state = expectOk(finishFocusEarly(state, t0 + 20 * 60_000)); // sat paused for 15 minutes, then quit
    expect(state).toMatchObject({
      status: 'complete',
      startedAt: t0,
      focusCompletedAt: t0 + 20 * 60_000, // the quit instant, not the earlier pause instant
      plannedFocusMs: FOCUS_MS, // the original target, unchanged
      actualFocusMs: 5 * 60_000, // only the active focus time before the pause
      totalElapsedMs: 20 * 60_000, // but the wall-clock span includes the pause
    });
  });

  it('rejects invalid transitions instead of silently changing state', () => {
    const t0 = 1_000_000;
    const idle = createIdleState();

    expect(pause(idle, t0).ok).toBe(false);
    expect(resume(idle, t0).ok).toBe(false);
    expect(chooseFlow(idle, t0).ok).toBe(false);
    expect(completeFocus(idle, t0).ok).toBe(false);
    expect(finishFocusEarly(idle, t0).ok).toBe(false);

    const focusing = expectOk(startFocus(idle, 'Focused task', FOCUS_MS, t0, SID));
    expect(startFocus(focusing, 'Second task', FOCUS_MS, t0 + 1, SID).ok).toBe(false);
    expect(resume(focusing, t0 + 1).ok).toBe(false);
    expect(completeFocus(focusing, t0 + 1).ok).toBe(false); // too early

    const paused = expectOk(pause(focusing, t0 + 1_000));
    expect(pause(paused, t0 + 2_000).ok).toBe(false);
    expect(chooseFinish(paused, t0 + 2_000).ok).toBe(false);

    const awaitingDecision = expectOk(completeFocus(focusing, t0 + FOCUS_MS));
    expect(finishFocusEarly(awaitingDecision, t0 + FOCUS_MS).ok).toBe(false);

    const flow = expectOk(chooseFlow(awaitingDecision, t0 + FOCUS_MS));
    expect(finishFocusEarly(flow, t0 + FOCUS_MS).ok).toBe(false);
  });

  it('starts the next session from a parked thought after review', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'First task', FOCUS_MS, t0, SID));

    let thoughts = addParkedThought([], 'p1', 'Check on the deploy', t0 + 5_000, SID);
    thoughts = addParkedThought(thoughts, 'p2', 'Reply to Sam', t0 + 6_000, SID);

    state = expectOk(completeFocus(state, t0 + FOCUS_MS));
    state = expectOk(chooseFinish(state, t0 + FOCUS_MS));
    expect(state.status).toBe('complete');

    const promoted = thoughts.find((thought) => thought.id === 'p1')!;
    thoughts = removeParkedThought(thoughts, promoted.id);
    expect(thoughts.map((t) => t.id)).toEqual(['p2']);

    state = expectOk(
      startFocus(state, promoted.text, FOCUS_MS, t0 + FOCUS_MS + 10_000, 'session-2'),
    );
    expect(state).toMatchObject({ status: 'focusing', task: 'Check on the deploy' });
  });

  it('computes remaining focus time correctly across a DST transition boundary', () => {
    // 2026-03-08 is the US spring-forward transition (clocks skip 2:00-3:00 AM
    // Eastern). Timestamps are plain epoch ms throughout this module, so a
    // real-world DST jump must not perturb the arithmetic at all - this test
    // guards against a future rewrite that starts doing local-calendar math.
    const startedAt = Date.UTC(2026, 2, 8, 6, 30, 0); // 01:30 EST, just before the jump
    const plannedDurationMs = 60 * 60 * 1000; // a 60-minute focus session

    let state = expectOk(
      startFocus(createIdleState(), 'Cross the DST boundary', plannedDurationMs, startedAt, SID),
    );

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

describe('focus cycle deadline (Phase 5B)', () => {
  const t0 = 1_000_000;

  it('owns an initial deadline of startedAt + plannedDurationMs', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    expect(state).toMatchObject({ focusDeadlineAt: t0 + FOCUS_MS });
  });

  it('freezes the deadline while paused, and shifts both it and accumulatedPauseMs on resume', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(pause(state, t0 + 10_000));
    expect(state).toMatchObject({ focusDeadlineAt: t0 + FOCUS_MS }); // unchanged while paused

    state = expectOk(resume(state, t0 + 70_000)); // 60s pause
    expect(state).toMatchObject({
      accumulatedPauseMs: 60_000,
      focusDeadlineAt: t0 + FOCUS_MS + 60_000,
    });
  });

  it('derives remaining time from the deadline alone, focusing and paused', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    expect(getFocusRemainingMs(state, t0 + FOCUS_MS - 5_000)).toBe(5_000);

    state = expectOk(pause(state, t0 + FOCUS_MS - 5_000));
    expect(getFocusRemainingMs(state, t0 + 999_999_999)).toBe(5_000); // frozen regardless of `now`
  });

  it('is due exactly at, and only at or after, the deadline', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    expect(isFocusDue(state, t0 + FOCUS_MS - 1)).toBe(false);
    expect(isFocusDue(state, t0 + FOCUS_MS)).toBe(true);
  });
});

describe('restartFocusCycle (Phase 5B)', () => {
  const t0 = 1_000_000;

  it('sets a full new deadline while keeping session identity, task, start, duration, and accumulated pauses', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(pause(state, t0 + 5_000));
    state = expectOk(resume(state, t0 + 15_000)); // 10s accumulated pause

    state = expectOk(restartFocusCycle(state, t0 + 20_000));
    expect(state).toMatchObject({
      status: 'focusing',
      sessionId: SID,
      task: 'Task',
      startedAt: t0,
      plannedDurationMs: FOCUS_MS,
      accumulatedPauseMs: 10_000,
      focusDeadlineAt: t0 + 20_000 + FOCUS_MS,
    });
  });

  it('can be restarted an unlimited number of times', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    let restartAt = t0;
    for (let i = 0; i < 5; i += 1) {
      restartAt += FOCUS_MS - 1; // restart just before each deadline
      state = expectOk(restartFocusCycle(state, restartAt));
    }
    expect(state).toMatchObject({ status: 'focusing', sessionId: SID, focusDeadlineAt: restartAt + FOCUS_MS });
  });

  it('is rejected outside active, unpaused focus', () => {
    const idle = createIdleState();
    expect(restartFocusCycle(idle, t0).ok).toBe(false);

    let state = expectOk(startFocus(idle, 'Task', FOCUS_MS, t0, SID));
    state = expectOk(pause(state, t0 + 1_000));
    expect(restartFocusCycle(state, t0 + 2_000).ok).toBe(false);
  });
});

describe('takeBreakFromFocus (Phase 5B)', () => {
  const t0 = 1_000_000;

  it('ends focus at the action time, records actual focus excluding pauses, and starts Break with zero prior Flow', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(pause(state, t0 + 5_000));
    state = expectOk(resume(state, t0 + 15_000)); // 10s accumulated pause

    state = expectOk(takeBreakFromFocus(state, t0 + 20_000));
    expect(state).toMatchObject({
      status: 'break',
      sessionId: SID,
      focusCompletedAt: t0 + 20_000,
      breakStartedAt: t0 + 20_000,
      actualFocusMs: 10_000, // 20s elapsed minus 10s paused
      flowMsBeforeBreak: 0,
    });
  });

  it('is rejected outside active focus', () => {
    expect(takeBreakFromFocus(createIdleState(), t0).ok).toBe(false);
  });
});

describe('completeFocusIntoFlow (Phase 5B)', () => {
  const t0 = 1_000_000;

  it('rejects a call before the deadline', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    expect(completeFocusIntoFlow(state, t0 + FOCUS_MS - 1).ok).toBe(false);
  });

  it('sets focusCompletedAt and flowStartedAt to the exact deadline, not a late render tick', () => {
    const state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    const lateTick = t0 + FOCUS_MS + 4_000; // the effect noticed 4s after the real deadline

    const flow = expectOk(completeFocusIntoFlow(state, lateTick));
    expect(flow).toMatchObject({
      status: 'flow',
      focusCompletedAt: t0 + FOCUS_MS,
      flowStartedAt: t0 + FOCUS_MS,
      flowAccumulatedPauseMs: 0,
    });
    // Flow elapsed time is measured from the exact deadline, so the late
    // tick doesn't manufacture 4 extra seconds of overtime.
    expect(getFlowElapsedMs(flow, lateTick)).toBe(4_000);
  });
});

describe('takeBreakFromFlow (Phase 5B)', () => {
  const t0 = 1_000_000;

  it('preserves elapsed Flow time (excluding Flow pauses) and actual focus across restarts', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(restartFocusCycle(state, t0 + FOCUS_MS - 1_000)); // one restart before this cycle completes
    let flow = expectOk(completeFocusIntoFlow(state, t0 + FOCUS_MS - 1_000 + FOCUS_MS));
    const focusCompletedAt = (flow as { focusCompletedAt: number }).focusCompletedAt;

    flow = expectOk(pause(flow, focusCompletedAt + 30_000));
    flow = expectOk(resume(flow, focusCompletedAt + 40_000)); // 10s flow-paused

    const broken = expectOk(takeBreakFromFlow(flow, focusCompletedAt + 90_000));
    expect(broken).toMatchObject({
      status: 'break',
      focusCompletedAt,
      breakStartedAt: focusCompletedAt + 90_000,
      actualFocusMs: focusCompletedAt - t0, // no focus pauses occurred in this scenario
      flowMsBeforeBreak: 80_000, // 90s elapsed minus the 10s flow-pause
    });
  });

  it('is rejected outside Flow', () => {
    expect(takeBreakFromFlow(createIdleState(), t0).ok).toBe(false);
  });
});

describe('actual focus accounting across restarts (Phase 5B)', () => {
  const t0 = 1_000_000;

  it('finishFlow sums actual focus across every restarted cycle, not just the planned duration', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    state = expectOk(restartFocusCycle(state, t0 + FOCUS_MS - 1_000)); // restart 1s before due
    const flow = expectOk(completeFocusIntoFlow(state, t0 + FOCUS_MS - 1_000 + FOCUS_MS));
    const totalActiveFocusMs = t0 + FOCUS_MS - 1_000 + FOCUS_MS - t0; // ~2x FOCUS_MS, more than one planned interval

    const complete = expectOk(finishFlow(flow, (flow as { focusCompletedAt: number }).focusCompletedAt + 5_000));
    expect(complete).toMatchObject({
      status: 'complete',
      plannedFocusMs: FOCUS_MS,
      actualFocusMs: totalActiveFocusMs,
    });
    expect((complete as { actualFocusMs: number }).actualFocusMs).toBeGreaterThan(
      (complete as { plannedFocusMs: number }).plannedFocusMs,
    );
  });

  it('endBreak carries the actual focus and prior Flow time recorded on the Break state', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));
    const flow = expectOk(completeFocusIntoFlow(state, t0 + FOCUS_MS));
    const flowElapsedAt = (flow as { focusCompletedAt: number }).focusCompletedAt + 45_000;
    const broken = expectOk(takeBreakFromFlow(flow, flowElapsedAt));

    const complete = expectOk(endBreak(broken, flowElapsedAt + 600_000));
    expect(complete).toMatchObject({
      status: 'complete',
      actualFocusMs: FOCUS_MS,
      flowMs: 45_000,
      tookBreak: true,
      breakMs: 600_000,
    });
  });
});
