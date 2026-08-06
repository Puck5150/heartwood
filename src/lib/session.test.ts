import { describe, expect, it } from 'vitest';
import {
  completeFocusIntoFlow,
  createIdleState,
  endBreak,
  finishFlow,
  finishFocusEarly,
  getBreakElapsedMs,
  getFlowElapsedMs,
  getFocusRemainingMs,
  getIntermissionOvertimeMs,
  getIntermissionRemainingMs,
  isFocusDue,
  isIntermissionDue,
  isIntermissionDuration,
  pause,
  resumeFromBreak,
  returnFromIntermission,
  resume,
  restartFocusCycle,
  startFocus,
  startIntermission,
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
  it('runs a normal completion: start -> complete focus -> finish (no flow, no break)', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, t0, SID));
    expect(state).toMatchObject({ status: 'focusing', task: 'Write the report', sessionId: SID });

    expect(isFocusDue(state, t0 + FOCUS_MS - 1)).toBe(false);
    expect(isFocusDue(state, t0 + FOCUS_MS)).toBe(true);

    state = expectOk(completeFocusIntoFlow(state, t0 + FOCUS_MS));
    expect(state.status).toBe('flow');

    state = expectOk(finishFlow(state, t0 + FOCUS_MS));
    expect(state).toMatchObject({
      status: 'complete',
      sessionId: SID,
      startedAt: t0,
      focusCompletedAt: t0 + FOCUS_MS,
      plannedFocusMs: FOCUS_MS,
      actualFocusMs: FOCUS_MS, // completed naturally, so actual equals planned
      flowMs: 0, // ended the exact instant Flow began
      totalElapsedMs: FOCUS_MS,
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
    state = expectOk(completeFocusIntoFlow(state, t0 + FOCUS_MS));
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
    state = expectOk(takeBreakFromFocus(state, t0 + FOCUS_MS));
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
    expect(completeFocusIntoFlow(idle, t0).ok).toBe(false);
    expect(takeBreakFromFocus(idle, t0).ok).toBe(false);
    expect(finishFocusEarly(idle, t0).ok).toBe(false);

    const focusing = expectOk(startFocus(idle, 'Focused task', FOCUS_MS, t0, SID));
    expect(startFocus(focusing, 'Second task', FOCUS_MS, t0 + 1, SID).ok).toBe(false);
    expect(resume(focusing, t0 + 1).ok).toBe(false);
    expect(completeFocusIntoFlow(focusing, t0 + 1).ok).toBe(false); // too early

    const paused = expectOk(pause(focusing, t0 + 1_000));
    expect(pause(paused, t0 + 2_000).ok).toBe(false);
    expect(takeBreakFromFlow(paused, t0 + 2_000).ok).toBe(false);

    const flow = expectOk(completeFocusIntoFlow(focusing, t0 + FOCUS_MS));
    expect(finishFocusEarly(flow, t0 + FOCUS_MS).ok).toBe(false);
  });

  it('starts the next session from a parked thought after review', () => {
    const t0 = 1_000_000;
    let state = expectOk(startFocus(createIdleState(), 'First task', FOCUS_MS, t0, SID));

    let thoughts = addParkedThought([], 'p1', 'Check on the deploy', t0 + 5_000, SID);
    thoughts = addParkedThought(thoughts, 'p2', 'Reply to Sam', t0 + 6_000, SID);

    state = expectOk(completeFocusIntoFlow(state, t0 + FOCUS_MS));
    state = expectOk(finishFlow(state, t0 + FOCUS_MS));
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

    state = expectOk(completeFocusIntoFlow(state, dueAt));
    expect(state.status).toBe('flow');
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

describe('resumable intermissions (Phase 5C)', () => {
  const t0 = 1_000_000;
  const BREAK_MS = 5 * 60_000;
  const TOUCH_GRASS_MS = 15 * 60_000;

  function focusing(): SessionState {
    return expectOk(startFocus(createIdleState(), 'Stay in context', FOCUS_MS, t0, SID));
  }

  function flow(): SessionState {
    return expectOk(completeFocusIntoFlow(focusing(), t0 + FOCUS_MS));
  }

  it.each([
    ['break', BREAK_MS],
    ['break', 10 * 60_000],
    ['touchGrass', TOUCH_GRASS_MS],
    ['touchGrass', 30 * 60_000],
    ['touchGrass', 45 * 60_000],
    ['touchGrass', 60 * 60_000],
  ] as const)('accepts the approved %s duration %d', (kind, durationMs) => {
    expect(isIntermissionDuration(kind, durationMs)).toBe(true);
    expect(startIntermission(focusing(), kind, durationMs, t0 + 10_000).ok).toBe(true);
  });

  it('rejects invalid kinds and durations without changing the source state', () => {
    const source = focusing();

    expect(isIntermissionDuration('break', 0)).toBe(false);
    expect(isIntermissionDuration('break', -1)).toBe(false);
    expect(isIntermissionDuration('break', 15 * 60_000)).toBe(false);
    expect(isIntermissionDuration('unknown' as never, BREAK_MS)).toBe(false);
    expect(startIntermission(source, 'break', 0, t0 + 1).ok).toBe(false);
    expect(startIntermission(source, 'break', 15 * 60_000, t0 + 1).ok).toBe(false);
    expect(source).toMatchObject({ status: 'focusing', breakIntermissionMs: 0, touchGrassMs: 0 });
  });

  it('starts from active focus with a frozen paused snapshot and returns active', () => {
    const startAt = t0 + 10_000;
    let state = expectOk(startIntermission(focusing(), 'break', BREAK_MS, startAt));

    expect(state).toMatchObject({
      status: 'intermission',
      sessionId: SID,
      kind: 'break',
      intermissionStartedAt: startAt,
      intermissionDeadlineAt: startAt + BREAK_MS,
      intermissionReturnStatus: 'focusing',
      returnState: { status: 'paused', pausedAt: startAt },
    });
    expect(getIntermissionRemainingMs(state, startAt + 1_000)).toBe(BREAK_MS - 1_000);

    state = expectOk(returnFromIntermission(state, startAt + 60_000));
    expect(state).toMatchObject({
      status: 'focusing',
      accumulatedPauseMs: 60_000,
      focusDeadlineAt: t0 + FOCUS_MS + 60_000,
      breakIntermissionMs: 60_000,
      touchGrassMs: 0,
    });
  });

  it('returns an already-paused focus session to paused without extending it twice', () => {
    const pausedAt = t0 + 10_000;
    const paused = expectOk(pause(focusing(), pausedAt));
    let state = expectOk(startIntermission(paused, 'break', BREAK_MS, t0 + 30_000));

    expect(state).toMatchObject({
      status: 'intermission',
      intermissionReturnStatus: 'paused',
      returnState: { status: 'paused', pausedAt },
    });

    state = expectOk(returnFromIntermission(state, t0 + 90_000));
    expect(state).toMatchObject({
      status: 'paused',
      pausedAt,
      focusDeadlineAt: t0 + FOCUS_MS,
      breakIntermissionMs: 60_000,
    });
  });

  it('freezes active Flow and excludes the intermission from Flow elapsed time', () => {
    const flowStartedAt = t0 + FOCUS_MS;
    const intermissionAt = flowStartedAt + 30_000;
    let state = expectOk(startIntermission(flow(), 'touchGrass', TOUCH_GRASS_MS, intermissionAt));

    expect(state).toMatchObject({
      status: 'intermission',
      intermissionReturnStatus: 'flow',
      returnState: { status: 'flowPaused', flowPausedAt: intermissionAt },
    });

    state = expectOk(returnFromIntermission(state, intermissionAt + 90_000));
    expect(state).toMatchObject({
      status: 'flow',
      flowAccumulatedPauseMs: 90_000,
      touchGrassMs: 90_000,
    });
    expect(getFlowElapsedMs(state, intermissionAt + 120_000)).toBe(60_000);
  });

  it('returns already-paused Flow to the original paused snapshot', () => {
    const flowPausedAt = t0 + FOCUS_MS + 20_000;
    const pausedFlow = expectOk(pause(flow(), flowPausedAt));
    let state = expectOk(startIntermission(pausedFlow, 'break', BREAK_MS, flowPausedAt + 40_000));
    state = expectOk(returnFromIntermission(state, flowPausedAt + 100_000));

    expect(state).toMatchObject({
      status: 'flowPaused',
      flowPausedAt,
      flowAccumulatedPauseMs: 0,
      breakIntermissionMs: 60_000,
    });
    expect(getFlowElapsedMs(state, flowPausedAt + 999_999)).toBe(20_000);
  });

  it('stays in intermission at zero and reports quiet overtime until explicit return', () => {
    const startAt = t0 + 10_000;
    const state = expectOk(startIntermission(focusing(), 'break', BREAK_MS, startAt));
    const deadline = startAt + BREAK_MS;

    expect(isIntermissionDue(state, deadline - 1)).toBe(false);
    expect(isIntermissionDue(state, deadline)).toBe(true);
    expect(getIntermissionRemainingMs(state, deadline + 45_000)).toBe(0);
    expect(getIntermissionOvertimeMs(state, deadline + 45_000)).toBe(45_000);
    expect(state.status).toBe('intermission');
  });

  it('records actual early and overtime durations in separate cumulative totals', () => {
    let state = expectOk(startIntermission(focusing(), 'break', BREAK_MS, t0 + 10_000));
    state = expectOk(returnFromIntermission(state, t0 + 40_000)); // 30s early return
    state = expectOk(startIntermission(state, 'touchGrass', TOUCH_GRASS_MS, t0 + 50_000));
    state = expectOk(returnFromIntermission(state, t0 + 50_000 + TOUCH_GRASS_MS + 20_000));
    state = expectOk(startIntermission(state, 'break', BREAK_MS, t0 + 60_000 + TOUCH_GRASS_MS + 20_000));
    state = expectOk(returnFromIntermission(state, t0 + 60_000 + TOUCH_GRASS_MS + 60_000));

    expect(state).toMatchObject({
      status: 'focusing',
      breakIntermissionMs: 70_000,
      touchGrassMs: TOUCH_GRASS_MS + 20_000,
    });

    const complete = expectOk(finishFocusEarly(state, t0 + 2 * TOUCH_GRASS_MS));
    expect(complete).toMatchObject({
      status: 'complete',
      breakIntermissionMs: 70_000,
      touchGrassMs: TOUCH_GRASS_MS + 20_000,
    });
  });

  it('rejects nested, post-focus, complete, legacy decision, and non-intermission returns', () => {
    const activeIntermission = expectOk(startIntermission(focusing(), 'break', BREAK_MS, t0 + 1_000));
    expect(startIntermission(activeIntermission, 'break', BREAK_MS, t0 + 2_000).ok).toBe(false);
    expect(returnFromIntermission(focusing(), t0 + 2_000).ok).toBe(false);

    const postFocusBreak = expectOk(takeBreakFromFocus(focusing(), t0 + 10_000));
    expect(startIntermission(postFocusBreak, 'break', BREAK_MS, t0 + 11_000).ok).toBe(false);

    const complete = expectOk(finishFocusEarly(focusing(), t0 + 10_000));
    expect(startIntermission(complete, 'break', BREAK_MS, t0 + 11_000).ok).toBe(false);

    const legacyDecision = {
      status: 'awaitingDecision',
      sessionId: SID,
      task: 'Legacy',
      startedAt: t0,
      plannedDurationMs: FOCUS_MS,
      accumulatedPauseMs: 0,
      focusCompletedAt: t0 + FOCUS_MS,
      breakIntermissionMs: 0,
      touchGrassMs: 0,
      breakMs: 0,
      lastTouchGrassAt: t0,
    } satisfies SessionState;
    expect(startIntermission(legacyDecision, 'break', BREAK_MS, t0 + FOCUS_MS).ok).toBe(false);
  });
});

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

  it('survives a break/resume cycle after a touchGrass intermission, rather than resetting to startedAt', () => {
    let state = expectOk(startFocus(createIdleState(), 'Task', FOCUS_MS, t0, SID));

    const touchGrassStartAt = t0 + 100_000;
    state = expectOk(startIntermission(state, 'touchGrass', 15 * 60_000, touchGrassStartAt));
    const returnedAt = touchGrassStartAt + 15 * 60_000;
    state = expectOk(returnFromIntermission(state, returnedAt));
    expect(state).toMatchObject({ lastTouchGrassAt: returnedAt });

    state = expectOk(takeBreakFromFocus(state, returnedAt + FOCUS_MS));
    const resumed = expectOk(resumeFromBreak(state, returnedAt + FOCUS_MS + 300_000));
    expect(resumed).toMatchObject({ lastTouchGrassAt: returnedAt });
  });
});
