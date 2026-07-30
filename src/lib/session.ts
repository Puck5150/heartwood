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
  /** The current focus cycle's own deadline — the sole authority for
   * remaining time and due detection (Phase 5B). Distinct from
   * `startedAt + plannedDurationMs`: a restart (restartFocusCycle) moves
   * this forward without touching `startedAt`, so "this cycle" and "this
   * session" can diverge across unlimited restarts. */
  focusDeadlineAt: number;
}

interface PausedState {
  status: 'paused';
  sessionId: string;
  task: string;
  startedAt: number;
  plannedDurationMs: number;
  accumulatedPauseMs: number;
  focusDeadlineAt: number;
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
  /** Total active focus accrued before this break, across every restarted
   * cycle. Carried forward (not recomputed) so endBreak() never needs to
   * re-derive it from a state that no longer has the original numbers. */
  actualFocusMs: number;
  /** Flow time accrued before this break — zero for a break taken directly
   * from focus (Take break now), the elapsed Flow duration for one taken
   * from quiet overtime (Take a break). */
  flowMsBeforeBreak: number;
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
    focusDeadlineAt: now + plannedDurationMs,
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
    const pauseDurationMs = now - pausedAt;
    return ok({
      ...rest,
      status: 'focusing',
      accumulatedPauseMs: rest.accumulatedPauseMs + pauseDurationMs,
      focusDeadlineAt: rest.focusDeadlineAt + pauseDurationMs,
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

/** Remaining focus time in ms, or null if not currently in a countdown state.
 * Derived from `focusDeadlineAt` alone — the deadline already accounts for
 * every pause and restart, so no separate elapsed-time computation is
 * needed here. */
export function getFocusRemainingMs(state: SessionState, now: number): number | null {
  if (state.status !== 'focusing' && state.status !== 'paused') return null;
  const referenceNow = state.status === 'paused' ? state.pausedAt : now;
  return Math.max(0, state.focusDeadlineAt - referenceNow);
}

/** True once the current focus cycle's deadline has been reached. */
export function isFocusDue(state: SessionState, now: number): boolean {
  if (state.status !== 'focusing') return false;
  return now >= state.focusDeadlineAt;
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

/** Legacy-only: reachable solely by recovering an old `awaitingDecision`
 * row (see persistence.ts). No live Phase 5B transition creates
 * `awaitingDecision`, so this can never run against fresh state. */
export function chooseBreak(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'awaitingDecision') {
    return reject(`Cannot choose a break from status "${state.status}".`);
  }
  return ok({
    ...state,
    status: 'break',
    breakStartedAt: now,
    actualFocusMs: state.plannedDurationMs,
    flowMsBeforeBreak: 0,
  });
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
  // Actual focus across every restarted cycle, not the originally planned
  // duration — a session that restarted its focus cycle one or more times
  // before reaching Flow accrues more active focus than plannedDurationMs.
  const actualFocusMs = Math.max(0, state.focusCompletedAt - state.startedAt - state.accumulatedPauseMs);
  return ok({
    status: 'complete',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: state.focusCompletedAt,
    plannedFocusMs: state.plannedDurationMs,
    actualFocusMs,
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
    // Carried from the Break state rather than recomputed — it already
    // recorded the exact totals as of the moment the break started.
    actualFocusMs: state.actualFocusMs,
    flowMs: state.flowMsBeforeBreak,
    tookBreak: true,
    breakMs,
    totalElapsedMs: now - state.startedAt,
    completedAt: now,
  });
}

/** Restarts the current focus cycle with a full new deadline, keeping
 * session identity, task, note-relevant `startedAt`, planned duration, and
 * accumulated pauses. Valid only from active, unpaused focus — the warning
 * prompt offering this action is hidden while paused, so there is no path
 * to call this from `paused`. Can be called an unlimited number of times
 * within the same session. */
export function restartFocusCycle(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'focusing') {
    return reject(`Cannot restart the focus cycle from status "${state.status}".`);
  }
  return ok({ ...state, focusDeadlineAt: now + state.plannedDurationMs });
}

/** Successful early completion of the *current* focus cycle — distinct
 * from `finishFocusEarly`'s give-up escape hatch. Ends focus at the action
 * timestamp, records actual focus across every restarted cycle, and goes
 * straight to Break (never through the legacy `awaitingDecision`). */
export function takeBreakFromFocus(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'focusing') {
    return reject(`Cannot take a break from status "${state.status}".`);
  }
  const actualFocusMs = Math.max(0, now - state.startedAt - state.accumulatedPauseMs);
  return ok({
    status: 'break',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: now,
    breakStartedAt: now,
    actualFocusMs,
    flowMsBeforeBreak: 0,
  });
}

/** The exact-deadline transition from an unanswered focus expiry straight
 * into quiet Flow overtime. Requires the deadline to actually be due.
 * `focusCompletedAt`/`flowStartedAt` are the deadline itself, never `now`
 * — Flow elapsed time then stays correct even if the caller's render tick
 * notices the expiry late. */
export function completeFocusIntoFlow(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'focusing') {
    return reject(`Cannot complete focus from status "${state.status}".`);
  }
  if (!isFocusDue(state, now)) {
    return reject('The focus deadline has not been reached yet.');
  }
  return ok({
    status: 'flow',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: state.focusDeadlineAt,
    flowStartedAt: state.focusDeadlineAt,
    flowAccumulatedPauseMs: 0,
  });
}

/** Takes a break from Flow (in practice, quiet overtime), snapshotting
 * elapsed Flow time and total actual focus into the Break state rather
 * than discarding either. */
export function takeBreakFromFlow(state: SessionState, now: number): TransitionResult {
  if (state.status !== 'flow' && state.status !== 'flowPaused') {
    return reject(`Cannot take a break from status "${state.status}".`);
  }
  const flowMsBeforeBreak = getFlowElapsedMs(state, now) ?? 0;
  const actualFocusMs = Math.max(0, state.focusCompletedAt - state.startedAt - state.accumulatedPauseMs);
  return ok({
    status: 'break',
    sessionId: state.sessionId,
    task: state.task,
    startedAt: state.startedAt,
    plannedDurationMs: state.plannedDurationMs,
    accumulatedPauseMs: state.accumulatedPauseMs,
    focusCompletedAt: state.focusCompletedAt,
    breakStartedAt: now,
    actualFocusMs,
    flowMsBeforeBreak,
  });
}
