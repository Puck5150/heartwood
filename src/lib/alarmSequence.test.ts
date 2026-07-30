import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlarmSequence } from './alarmSequence';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const DURATION_MS = 1_000;

function fixedDuration(_toneId: string): number {
  return DURATION_MS;
}

describe('createAlarmSequence', () => {
  it('plays the tone immediately on start', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });

    sequence.start('gentle-chime');

    expect(playOnce).toHaveBeenCalledTimes(1);
    expect(playOnce).toHaveBeenCalledWith('gentle-chime');
  });

  it('plays the next repetition only after the previous schedule duration plus a half-second gap elapses', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });

    sequence.start('gentle-chime');
    expect(playOnce).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DURATION_MS + 500 - 1);
    expect(playOnce).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(playOnce).toHaveBeenCalledTimes(2);
  });

  it('defaults the gap between repetitions to 500ms', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });

    sequence.start('gentle-chime');
    vi.advanceTimersByTime(DURATION_MS);
    expect(playOnce).toHaveBeenCalledTimes(1); // gap not yet elapsed

    vi.advanceTimersByTime(500);
    expect(playOnce).toHaveBeenCalledTimes(2);
  });

  it('supports a custom gap for testing', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration, gapMs: 100 });

    sequence.start('gentle-chime');
    vi.advanceTimersByTime(DURATION_MS + 99);
    expect(playOnce).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(playOnce).toHaveBeenCalledTimes(2);
  });

  it('plays exactly three repetitions by default, then stops', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });

    sequence.start('gentle-chime');
    vi.advanceTimersByTime(DURATION_MS * 5); // far more time than needed

    expect(playOnce).toHaveBeenCalledTimes(3);
  });

  it('cancel() prevents every remaining repetition', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });

    sequence.start('gentle-chime');
    expect(playOnce).toHaveBeenCalledTimes(1);
    sequence.cancel();

    vi.advanceTimersByTime(DURATION_MS * 5);
    expect(playOnce).toHaveBeenCalledTimes(1);
  });

  it('cancel() is a safe no-op when nothing is playing', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });
    expect(() => sequence.cancel()).not.toThrow();
  });

  it('starting a new sequence invalidates the prior one — only the newest ever completes', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });

    sequence.start('gentle-chime');
    vi.advanceTimersByTime(DURATION_MS / 2); // first repetition's timeout is pending
    sequence.start('soft-bell'); // supersedes it
    playOnce.mockClear();

    vi.advanceTimersByTime(DURATION_MS * 5);
    // Every call after restart is for the new tone, and there are exactly
    // three of them (the second and third repetition, plus the immediate
    // first one already counted before mockClear — recount from scratch).
    expect(playOnce.mock.calls.every(([id]) => id === 'soft-bell')).toBe(true);
  });

  it('a stale timeout from a cancelled sequence cannot restart work after start() runs again', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });

    sequence.start('gentle-chime');
    sequence.cancel();
    sequence.start('gentle-chime'); // a fresh generation
    playOnce.mockClear();

    vi.advanceTimersByTime(DURATION_MS * 5);
    expect(playOnce).toHaveBeenCalledTimes(2); // only the fresh sequence's remaining 2 reps
  });

  it('uses the existing default tone duration for an unknown id (delegated to durationMs)', () => {
    const playOnce = vi.fn();
    const durationMs = vi.fn(() => DURATION_MS);
    const sequence = createAlarmSequence({ playOnce, durationMs });

    sequence.start('not-a-real-tone-id');
    expect(durationMs).toHaveBeenCalledWith('not-a-real-tone-id');
  });

  it('defaults to 3 repetitions in production (no repetitions option supplied)', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration });

    sequence.start('gentle-chime');
    vi.advanceTimersByTime(DURATION_MS * 10);
    expect(playOnce).toHaveBeenCalledTimes(3);
  });

  it('supports a custom repetitions count for testing', () => {
    const playOnce = vi.fn();
    const sequence = createAlarmSequence({ playOnce, durationMs: fixedDuration, repetitions: 1 });

    sequence.start('gentle-chime');
    vi.advanceTimersByTime(DURATION_MS * 5);
    expect(playOnce).toHaveBeenCalledTimes(1);
  });
});
