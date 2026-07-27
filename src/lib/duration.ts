// Pure duration validation and the "start with a user-supplied minutes
// value" decision, shared by every place a focus session can be started
// with an adjustable duration. Centralized here so an invalid duration is
// rejected before it ever reaches the state machine, and callers can rely
// on "not ok" meaning nothing changed — see App.svelte's promote handler,
// which only removes a parked thought after this returns ok.

import { startFocus, type SessionState, type TransitionResult } from './session';

export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 180;

/** Durations must be a whole number of minutes within [1, 180]. Not relying
 * on the <input min/max> attributes alone, since those don't stop invalid
 * values from reaching application state. */
export function isValidDurationMinutes(minutes: number): boolean {
  return (
    Number.isInteger(minutes) && minutes >= MIN_DURATION_MINUTES && minutes <= MAX_DURATION_MINUTES
  );
}

/**
 * Starts a focus session from a user-supplied minutes value. Rejects an
 * invalid duration before calling startFocus at all, so the session state
 * is guaranteed untouched on failure.
 */
export function startFocusWithDurationMinutes(
  state: SessionState,
  task: string,
  minutes: number,
  now: number,
  sessionId: string,
): TransitionResult {
  if (!isValidDurationMinutes(minutes)) {
    return {
      ok: false,
      error: `Duration must be a whole number of minutes between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}.`,
    };
  }
  return startFocus(state, task, minutes * 60_000, now, sessionId);
}

/** The duration (in minutes) to show as the review screen's default,
 * derived from the completed session's own planned duration rather than
 * app-level state — so it's correct even after the app was closed and
 * reopened mid-session, since the planned duration is recovered from
 * storage along with everything else. */
export function reviewDefaultDurationMinutes(plannedFocusMs: number): number {
  return Math.round(plannedFocusMs / 60_000);
}
