import { describe, expect, it } from 'vitest';
import {
  isValidDurationMinutes,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  reviewDefaultDurationMinutes,
  startFocusWithDurationMinutes,
} from './duration';
import { chooseFinish, createIdleState, startFocus, type SessionState } from './session';
import { recoverSessionState, serializeSessionState } from './persistence';

function expectOk(result: { ok: boolean; state?: SessionState; error?: string }): SessionState {
  if (!result.ok) throw new Error(`Expected ok transition, got error: ${result.error}`);
  return result.state as SessionState;
}

describe('isValidDurationMinutes', () => {
  it('rejects 0', () => {
    expect(isValidDurationMinutes(0)).toBe(false);
  });

  it('rejects a duration one minute over the cap (181)', () => {
    expect(isValidDurationMinutes(181)).toBe(false);
  });

  it('accepts the boundary values 1 and 180', () => {
    expect(isValidDurationMinutes(MIN_DURATION_MINUTES)).toBe(true);
    expect(isValidDurationMinutes(MAX_DURATION_MINUTES)).toBe(true);
  });

  it('accepts a typical value in range', () => {
    expect(isValidDurationMinutes(45)).toBe(true);
  });

  it('rejects non-integer minutes', () => {
    expect(isValidDurationMinutes(25.5)).toBe(false);
  });

  it('rejects negative numbers and NaN', () => {
    expect(isValidDurationMinutes(-5)).toBe(false);
    expect(isValidDurationMinutes(Number.NaN)).toBe(false);
  });
});

describe('startFocusWithDurationMinutes', () => {
  const t0 = 1_000_000;

  it('does not start a session for a duration of 0', () => {
    const result = startFocusWithDurationMinutes(createIdleState(), 'Some task', 0, t0, 'sid');
    expect(result.ok).toBe(false);
  });

  it('does not start a session for a duration over the cap (181)', () => {
    const result = startFocusWithDurationMinutes(createIdleState(), 'Some task', 181, t0, 'sid');
    expect(result.ok).toBe(false);
  });

  it('starts a session for a valid custom duration', () => {
    const result = startFocusWithDurationMinutes(createIdleState(), 'Some task', 45, t0, 'sid');
    expect(result.ok).toBe(true);
    expect(result.ok && result.state).toMatchObject({
      status: 'focusing',
      task: 'Some task',
      plannedDurationMs: 45 * 60_000,
    });
  });
});

describe('reviewDefaultDurationMinutes', () => {
  it('converts planned focus ms back to whole minutes', () => {
    expect(reviewDefaultDurationMinutes(45 * 60_000)).toBe(45);
    expect(reviewDefaultDurationMinutes(60_000)).toBe(1);
  });

  it('preserves the originally planned duration through recovery after the app was closed mid-session', () => {
    // Simulates: user starts a 45-minute session, the app is closed while
    // it's still focusing, reopened well past the planned end (recovering
    // straight to awaitingDecision), and the user finishes from there. The
    // review screen's default duration should reflect the original 45
    // minutes, not some other value.
    const startedAt = 1_000_000;
    const plannedDurationMs = 45 * 60_000;
    const started = expectOk(
      startFocus(createIdleState(), 'Write the report', plannedDurationMs, startedAt, 'sid'),
    );
    const row = serializeSessionState(started, startedAt)!;

    const reopenedAt = startedAt + plannedDurationMs + 20 * 60_000; // reopened 20 minutes late
    const recovered = recoverSessionState(row, reopenedAt);
    expect(recovered.status).toBe('awaitingDecision');

    const completed = expectOk(chooseFinish(recovered, reopenedAt + 5_000));
    expect(completed.status).toBe('complete');
    expect(completed).toMatchObject({ plannedFocusMs: plannedDurationMs });

    expect(
      reviewDefaultDurationMinutes((completed as { plannedFocusMs: number }).plannedFocusMs),
    ).toBe(45);
  });
});
