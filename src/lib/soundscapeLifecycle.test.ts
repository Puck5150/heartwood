import { describe, expect, it } from 'vitest';
import {
  completeFocusIntoFlow,
  createIdleState,
  finishFlow,
  pause,
  startFocus,
  startIntermission,
  takeBreakFromFlow,
  type SessionState,
  type TransitionResult,
} from './session';
import { soundscapeLifecycleFor } from './soundscapeLifecycle';

function state(result: TransitionResult): SessionState {
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

describe('soundscapeLifecycleFor', () => {
  it('maps every timer branch without reading presentation state', () => {
    const startedAt = 1_000;
    const duration = 60_000;
    const focusing = state(startFocus(createIdleState(), 'Write', duration, startedAt, 's1'));
    const paused = state(pause(focusing, startedAt + 10_000));
    const flow = state(completeFocusIntoFlow(focusing, startedAt + duration));
    const intermission = state(startIntermission(flow, 'break', 5 * 60_000, startedAt + duration));
    const breakState = state(takeBreakFromFlow(flow, startedAt + duration + 1_000));
    const complete = state(finishFlow(flow, startedAt + duration + 1_000));

    expect(soundscapeLifecycleFor(createIdleState(), false)).toEqual({
      sessionId: null,
      phase: 'inactive',
      alarmActive: false,
    });
    expect(soundscapeLifecycleFor(focusing, false).phase).toBe('focus');
    expect(soundscapeLifecycleFor(paused, false).phase).toBe('focus');
    expect(soundscapeLifecycleFor(flow, true)).toEqual({
      sessionId: 's1',
      phase: 'flow',
      alarmActive: true,
    });
    expect(soundscapeLifecycleFor(intermission, false).phase).toBe('intermission');
    expect(soundscapeLifecycleFor(breakState, false).phase).toBe('postFocusBreak');
    expect(soundscapeLifecycleFor(complete, false).phase).toBe('complete');
  });
});
