// Pure session/timer state machine. No Date.now() calls in here — every
// function takes `now` as an argument so the whole module is deterministic
// and testable without a real clock or a browser.
//
// Every non-idle state carries a `sessionId` (supplied by the caller, e.g.
// crypto.randomUUID() in the UI layer) that stays constant for the life of
// one focus session. The UI uses it to scope parked thoughts to the session
// that captured them — see parkingLot.ts.

interface IdleState {
  status: 'idle';
}

interface FocusingState {
  status: 'focusing';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
}

interface PausedState {
  status: 'paused';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  pausedAt: number;
}

interface AwaitingDecisionState {
  status: 'awaitingDecision';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  focusCompletedAt: number;
}

interface FlowState {
  status: 'flow';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  focusCompletedAt: number;
  flowStartedAt: number;
  flowAccumulatedPauseMs: number;
}

interface FlowPausedState {
  status: 'flowPaused';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  focusCompletedAt: number;
  flowStartedAt: number;
  flowAccumulatedPauseMs: number;
  flowPausedAt: number;
}

interface BreakState {
  status: 'break';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  focusCompletedAt: number;
  breakStartedAt: number;
}

interface CompleteState {
  status: 'complete';
  sessionId: string;
  task: string;
  /** Raw historical fields carried over from the focus phase, kept for
   * future history/review features (e.g. Phase 3) — distinct from the
   * derived stats below, which exist for the current review screen. */
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  /** The instant the focus phase ended, whether by reaching the planned
   * duration or by finishing early. */
  focusCompletedAt: number;
  /** The originally chosen focus duration, regardless of how the session
   * actually played out. */
  plannedFocusMs: number;
  /** Focus time actually accrued. Equal to plannedFocusMs unless the
   * session was ended early via finishFocusEarly(). */
  actualFocusMs: number;
  flowMs: number;
  tookBreak: boolean;
  breakMs: number;
  /** Wall-clock time from session start to completion — includes active
   * focus, pauses, decision-screen dwell, flow, and break time. */
  totalElapsedMs: number;
  completedAt: number;
}

export type SessionState =
  | IdleState
  | FocusingState
  | PausedState
  | AwaitingDecisionState
  | FlowState
  | FlowPausedState
  | BreakState
  | CompleteState;

export type TransitionResult =
  | { ok: true; state: SessionState }
  | { ok: false; error: string };

function ok(state: SessionState): TransitionResult {
  return { ok: true, state };
}

function reject(error: string): TransitionResult {
  return { ok: false, error };
}

export function createIdleState(): SessionState {
  return { status: 'idle' };
}

export function startFocus(
  state: SessionState,
  task: string,
  plannedDurationMs: number,
  now: number,
  sessionId: string,
): TransitionResult {
  if (state.status !== 'idle' && state.status !== 'complete') {
    return reject(`Cannot start a focus session from status "${state.status}".`);
  }
  const trimmedTask = task.trim();
  if (!trimmedTask) {
    return reject('Focus task must not be empty.');
  }
  if (plannedDurationMs <= 0) {
    return reject('Planned duration must be positive.');
  }
  return ok({
    status: 'focusing',
    sessionId,
    task: trimmedTask,
    startedAt: now,
    plannedDurationMs,
    accumulatedPauseMs: 0,
  });
}

export function pause(state: SessionState, now: number): TransitionResult {
  if (state.status === 'focusing') {
    return ok({ ...state, status: 'paused', pausedAt: now });
  }
  if (state.status === 'flow') {
    return ok({ ...state, status: 'flowPaused', flowPausedAt: now });
  }
  return reject(`Cannot pause from status "${state.status}".`);
}

export function resume(state: SessionState, now: number): TransitionResult {
  if (state.status === 'paused') {
    const { pausedAt, ...rest } = state;
    return ok({
      ...rest,
      status: 'focusing',
      accumulatedPauseMs: rest.accumulatedPauseMs + (now - pausedAt),
    });
  }
  if (state.status === 'flowPaused') {
    const { flowPausedAt, ...rest } = state;
    return ok({
      ...rest,
      status: 'flow',
      flowAccumulatedPauseMs: rest.flowAccumulatedPauseMs + (now - flowPausedAt),
    });
  }
  return reject(`Cannot resume from status "${state.status}".`);
}

/** Remaining focus time in ms, or null if not currently in a countdown state. */
export function getFocusRemainingMs(state: SessionState, now: number): number | null {
  if (state.status !== 'focusing' && state.status !== 'paused') return null;
  const referenceNow = state.status === 'paused' ? state.pausedAt : now;
  const elapsedActive = referenceNow - state.startedAt - state.accumulatedPauseMs;
  return Math.max(0, state.plannedDurationMs - elapsedActive);
}

/** True once the planned focus interval has fully elapsed and is ready to complete. */
export function isFocusDue(state: SessionState, now: number): boolean {
  if (state.status !== 'focusing') return false;
  return now >= state.startedAt + state.plannedDurationMs + state.accumulatedPauseMs;
}

export function completeFocus(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'focusing') {
    return reject(`Cannot complete focus from status "${state.status}".`);
  }
  if (!isFocusDue(state, now)) {
    return reject('Planned focus duration has not elapsed yet.');
  }
  return ok({
    status: 'awaitingDecision',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: now,
  });
}

/**
 * Escape hatch out of an active focus session, before the planned interval
 * elapses. Goes straight to Complete (like a natural finish) but records the
 * focus time actually accrued instead of the originally planned duration.
 */
export function finishFocusEarly(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'focusing' && state.status !== 'paused') {
    return reject(`Cannot finish focus early from status "${state.status}".`);
  }
  const referenceNow = state.status === 'paused' ? state.pausedAt : now;
  const actualFocusMs = Math.max(0, referenceNow - state.startedAt - state.accumulatedPauseMs);
  return ok({
    status: 'complete',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: now,
    plannedFocusMs: state.plannedDurationMs,
    actualFocusMs,
    flowMs: 0,
    tookBreak: false,
    breakMs: 0,
    totalElapsedMs: now - state.startedAt,
    completedAt: now,
  });
}

export function chooseBreak(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'awaitingDecision') {
    return reject(`Cannot choose a break from status "${state.status}".`);
  }
  return ok({ ...state, status: 'break', breakStartedAt: now });
}

export function chooseFlow(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'awaitingDecision') {
    return reject(`Cannot choose flow from status "${state.status}".`);
  }
  return ok({
    ...state,
    status: 'flow',
    flowStartedAt: now,
    flowAccumulatedPauseMs: 0,
  });
}

export function chooseFinish(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'awaitingDecision') {
    return reject(`Cannot finish from status "${state.status}".`);
  }
  return ok({
    status: 'complete',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: state.focusCompletedAt,
    plannedFocusMs: state.plannedDurationMs,
    actualFocusMs: state.plannedDurationMs,
    flowMs: 0,
    tookBreak: false,
    breakMs: 0,
    totalElapsedMs: now - state.startedAt,
    completedAt: now,
  });
}

/** Elapsed flow time in ms, or null if not currently in flow. */
export function getFlowElapsedMs(state: SessionState, now: number): number | null {
  if (state.status !== 'flow' && state.status !== 'flowPaused') return null;
  const referenceNow = state.status === 'flowPaused' ? state.flowPausedAt : now;
  return Math.max(0, referenceNow - state.flowStartedAt - state.flowAccumulatedPauseMs);
}

export function finishFlow(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'flow' && state.status !== 'flowPaused') {
    return reject(`Cannot finish flow from status "${state.status}".`);
  }
  const referenceNow = state.status === 'flowPaused' ? state.flowPausedAt : now;
  const flowMs = Math.max(0, referenceNow - state.flowStartedAt - state.flowAccumulatedPauseMs);
  return ok({
    status: 'complete',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: state.focusCompletedAt,
    plannedFocusMs: state.plannedDurationMs,
    actualFocusMs: state.plannedDurationMs,
    flowMs,
    tookBreak: false,
    breakMs: 0,
    totalElapsedMs: now - state.startedAt,
    completedAt: now,
  });
}

/** Elapsed break time in ms, or null if not currently on a break. */
export function getBreakElapsedMs(state: SessionState, now: number): number | null {
  if (state.status !== 'break') return null;
  return Math.max(0, now - state.breakStartedAt);
}

export function endBreak(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'break') {
    return reject(`Cannot end a break from status "${state.status}".`);
  }
  const breakMs = Math.max(0, now - state.breakStartedAt);
  return ok({
    status: 'complete',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: state.focusCompletedAt,
    plannedFocusMs: state.plannedDurationMs,
    actualFocusMs: state.plannedDurationMs,
    flowMs: 0,
    tookBreak: true,
    breakMs,
    totalElapsedMs: now - state.startedAt,
    completedAt: now,
  });
}
