import type { SessionState } from './session';
import type { SoundscapeLifecycle, SoundscapePhase } from './soundscapeController.svelte';

const PHASE_BY_STATUS: Record<SessionState['status'], SoundscapePhase> = {
  idle: 'inactive',
  focusing: 'focus',
  paused: 'focus',
  flow: 'flow',
  flowPaused: 'flow',
  intermission: 'intermission',
  awaitingDecision: 'complete',
  break: 'postFocusBreak',
  complete: 'complete',
};

export function soundscapeLifecycleFor(
  session: SessionState,
  alarmActive: boolean,
): SoundscapeLifecycle {
  return {
    phase: PHASE_BY_STATUS[session.status],
    alarmActive,
  };
}
