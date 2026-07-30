import { describe, expect, it, vi } from 'vitest';
import { createFocusWarningCoordinator } from './focusWarning';
import { createIdleState, pause, resume, restartFocusCycle, startFocus, type SessionState } from './session';

function expectOk(result: { ok: boolean; state?: SessionState; error?: string }): SessionState {
  if (!result.ok) throw new Error(`Expected ok transition, got error: ${result.error}`);
  return result.state as SessionState;
}

const t0 = 1_000_000;
const SID = 'sid';

function focusing(plannedDurationMs: number) {
  return expectOk(startFocus(createIdleState(), 'Write the report', plannedDurationMs, t0, SID));
}

describe('createFocusWarningCoordinator — pure threshold', () => {
  it('is not visible for every preset before the threshold is crossed', () => {
    const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn() });
    for (const [lead, leadMs] of [
      ['30000', 30_000],
      ['60000', 60_000],
      ['120000', 120_000],
      ['300000', 300_000],
    ] as const) {
      const state = focusing(10 * 60_000);
      const view = coordinator.evaluate({ session: state, now: t0 + 10 * 60_000 - leadMs - 1, lead, isForeground: true });
      expect(view.visible).toBe(false);
    }
  });

  it('becomes visible at exactly the threshold, for every preset', () => {
    for (const [lead, leadMs] of [
      ['30000', 30_000],
      ['60000', 60_000],
      ['120000', 120_000],
      ['300000', 300_000],
    ] as const) {
      const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn() });
      const state = focusing(10 * 60_000);
      const view = coordinator.evaluate({ session: state, now: t0 + 10 * 60_000 - leadMs, lead, isForeground: true });
      expect(view.visible).toBe(true);
    }
  });

  it('Off never warns, regardless of remaining time', () => {
    const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn() });
    const state = focusing(60_000);
    const view = coordinator.evaluate({ session: state, now: t0 + 60_000, lead: 'off', isForeground: true });
    expect(view.visible).toBe(false);
  });

  it('warns immediately after the interval begins when the lead is >= the interval duration', () => {
    const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn() });
    const state = focusing(20_000); // shorter than the 30s lead
    const view = coordinator.evaluate({ session: state, now: t0, lead: '30000', isForeground: true });
    expect(view.visible).toBe(true);
  });

  it('is not visible for idle, paused, or any non-focusing state', () => {
    const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn() });
    expect(coordinator.evaluate({ session: createIdleState(), now: t0, lead: '30000', isForeground: true }).visible).toBe(
      false,
    );

    const paused = expectOk(pause(focusing(60_000), t0 + 40_000));
    // 20s remaining when paused — within the 30s lead window, but paused
    // hides the prompt because the countdown isn't advancing.
    expect(
      coordinator.evaluate({ session: paused, now: t0 + 999_999, lead: '30000', isForeground: true }).visible,
    ).toBe(false);
  });

  it('is visible exactly at the threshold boundary, not one tick early or late', () => {
    const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn() });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;
    expect(
      coordinator.evaluate({ session: state, now: deadline - 30_000 - 1, lead: '30000', isForeground: true }).visible,
    ).toBe(false);
    expect(
      coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: true }).visible,
    ).toBe(true);
  });
});

describe('createFocusWarningCoordinator — coordination', () => {
  it('announces exactly once per deadline, returning null on every subsequent visible evaluation', () => {
    const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn(async () => {}) });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    const first = coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: true });
    expect(first.announcement).not.toBeNull();

    const second = coordinator.evaluate({ session: state, now: deadline - 20_000, lead: '30000', isForeground: true });
    expect(second.announcement).toBeNull();
    expect(second.visible).toBe(true); // still visible, just no repeated announcement
  });

  it('sends exactly one background notification per deadline', async () => {
    const notifyWarning = vi.fn(async () => {});
    const coordinator = createFocusWarningCoordinator({ notifyWarning });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: false });
    coordinator.evaluate({ session: state, now: deadline - 20_000, lead: '30000', isForeground: false });
    coordinator.evaluate({ session: state, now: deadline - 10_000, lead: '30000', isForeground: false });
    await Promise.resolve();

    expect(notifyWarning).toHaveBeenCalledTimes(1);
    expect(notifyWarning).toHaveBeenCalledWith('Write the report', '30 seconds');
  });

  it('suppresses the native notification while foregrounded, without hiding the in-app prompt', async () => {
    const notifyWarning = vi.fn(async () => {});
    const coordinator = createFocusWarningCoordinator({ notifyWarning });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    const view = coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: true });
    await Promise.resolve();

    expect(view.visible).toBe(true);
    expect(notifyWarning).not.toHaveBeenCalled();
  });

  it('still sends the notification once backgrounded, even if it started foregrounded in the same cycle', async () => {
    const notifyWarning = vi.fn(async () => {});
    const coordinator = createFocusWarningCoordinator({ notifyWarning });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: true });
    coordinator.evaluate({ session: state, now: deadline - 20_000, lead: '30000', isForeground: false });
    await Promise.resolve();

    expect(notifyWarning).toHaveBeenCalledTimes(1);
  });

  it('hides on pause and re-shows on resume within the same window, without a duplicate announcement or notification', async () => {
    const notifyWarning = vi.fn(async () => {});
    const coordinator = createFocusWarningCoordinator({ notifyWarning });
    let state = focusing(60_000);
    const deadline = t0 + 60_000;

    const beforePause = coordinator.evaluate({
      session: state,
      now: deadline - 30_000,
      lead: '30000',
      isForeground: false,
    });
    expect(beforePause.visible).toBe(true);
    expect(beforePause.announcement).not.toBeNull();

    state = expectOk(pause(state, deadline - 25_000));
    const whilePaused = coordinator.evaluate({
      session: state,
      now: deadline - 25_000,
      lead: '30000',
      isForeground: false,
    });
    expect(whilePaused.visible).toBe(false);

    state = expectOk(resume(state, deadline - 20_000)); // shifts the deadline forward by the pause duration
    const afterResume = coordinator.evaluate({
      session: state,
      now: deadline - 15_000,
      lead: '30000',
      isForeground: false,
    });
    expect(afterResume.visible).toBe(true);
    expect(afterResume.announcement).toBeNull(); // same deadline — no duplicate announcement
    await Promise.resolve();
    expect(notifyWarning).toHaveBeenCalledTimes(1); // no duplicate notification either
  });

  it('treats a restarted focus cycle as a distinct deadline, announcing and notifying again', async () => {
    const notifyWarning = vi.fn(async () => {});
    const coordinator = createFocusWarningCoordinator({ notifyWarning });
    let state = focusing(60_000);
    const firstDeadline = t0 + 60_000;

    coordinator.evaluate({ session: state, now: firstDeadline - 30_000, lead: '30000', isForeground: false });
    await Promise.resolve();
    expect(notifyWarning).toHaveBeenCalledTimes(1);

    state = expectOk(restartFocusCycle(state, firstDeadline - 5_000));
    const secondDeadline = firstDeadline - 5_000 + 60_000;
    const restarted = coordinator.evaluate({
      session: state,
      now: secondDeadline - 30_000,
      lead: '30000',
      isForeground: false,
    });
    expect(restarted.visible).toBe(true);
    expect(restarted.announcement).not.toBeNull(); // a new cycle, so a fresh announcement
    await Promise.resolve();
    expect(notifyWarning).toHaveBeenCalledTimes(2);
  });

  it('shows immediately when changing from Off to an already-crossed threshold', () => {
    const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn(async () => {}) });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    const whileOff = coordinator.evaluate({ session: state, now: deadline - 30_000, lead: 'off', isForeground: true });
    expect(whileOff.visible).toBe(false);

    const afterEnabling = coordinator.evaluate({
      session: state,
      now: deadline - 30_000,
      lead: '30000',
      isForeground: true,
    });
    expect(afterEnabling.visible).toBe(true);
    expect(afterEnabling.announcement).not.toBeNull();
  });

  it('hides immediately when changed to Off', () => {
    const coordinator = createFocusWarningCoordinator({ notifyWarning: vi.fn(async () => {}) });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: true });
    const afterOff = coordinator.evaluate({ session: state, now: deadline - 20_000, lead: 'off', isForeground: true });
    expect(afterOff.visible).toBe(false);
  });

  it('does not duplicate across repeated evaluations that model unrelated workspace/Settings re-renders', async () => {
    const notifyWarning = vi.fn(async () => {});
    const coordinator = createFocusWarningCoordinator({ notifyWarning });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    for (let i = 0; i < 5; i += 1) {
      coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: false });
    }
    await Promise.resolve();
    expect(notifyWarning).toHaveBeenCalledTimes(1);
  });

  it('logs, rather than throws, a rejected notification send', async () => {
    const logError = vi.fn();
    const notifyWarning = vi.fn(async () => {
      throw new Error('send failed');
    });
    const coordinator = createFocusWarningCoordinator({ notifyWarning, logError });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(logError).toHaveBeenCalled();
  });

  it('a stale rejection after a deadline reset only logs, never re-applies to the new cycle', async () => {
    let rejectFirst!: (err: unknown) => void;
    const notifyWarning = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectFirst = reject)))
      .mockImplementationOnce(async () => {});
    const logError = vi.fn();
    const coordinator = createFocusWarningCoordinator({ notifyWarning, logError });
    let state = focusing(60_000);
    const firstDeadline = t0 + 60_000;

    coordinator.evaluate({ session: state, now: firstDeadline - 30_000, lead: '30000', isForeground: false });

    state = expectOk(restartFocusCycle(state, firstDeadline - 5_000));
    const secondDeadline = firstDeadline - 5_000 + 60_000;
    coordinator.evaluate({ session: state, now: secondDeadline - 30_000, lead: '30000', isForeground: false });

    rejectFirst(new Error('stale send failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(logError).toHaveBeenCalledTimes(1); // logged, not thrown, and didn't disturb the second cycle
  });

  it('dispose() prevents a pending evaluate() from dispatching a late notification', async () => {
    const notifyWarning = vi.fn(async () => {});
    const coordinator = createFocusWarningCoordinator({ notifyWarning });
    const state = focusing(60_000);
    const deadline = t0 + 60_000;

    coordinator.dispose();
    coordinator.evaluate({ session: state, now: deadline - 30_000, lead: '30000', isForeground: false });
    await Promise.resolve();

    expect(notifyWarning).not.toHaveBeenCalled();
  });
});
