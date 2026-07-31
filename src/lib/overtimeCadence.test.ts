import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from './session';
import { createOvertimeCadenceCoordinator } from './overtimeCadence';

const t0 = 1_000_000;
const durationMs = 25 * 60_000;

function flowSession(
  overrides: Partial<Extract<SessionState, { status: 'flow' }>> = {},
): Extract<SessionState, { status: 'flow' }> {
  return {
    status: 'flow',
    sessionId: 'session-1',
    task: 'Write the report',
    startedAt: t0 - durationMs,
    plannedDurationMs: durationMs,
    accumulatedPauseMs: 0,
    focusCompletedAt: t0,
    flowStartedAt: t0,
    flowAccumulatedPauseMs: 0,
    breakIntermissionMs: 0,
    touchGrassMs: 0,
    ...overrides,
  };
}

function inputAt(now: number, session: SessionState = flowSession()) {
  return { session, now, lead: '30000' as const, isForeground: true };
}

const coordinatorOptions = {
  notifyWarning: async () => {},
};

describe('createOvertimeCadenceCoordinator', () => {
  it('shows the next marker warning and acknowledgement suppresses that marker alarm', () => {
    const coordinator = createOvertimeCadenceCoordinator(coordinatorOptions);

    expect(coordinator.evaluate(inputAt(t0 + 24 * 60_000 + 29_999))).toMatchObject({
      visible: false,
      alarmDue: false,
    });

    expect(coordinator.evaluate(inputAt(t0 + 24 * 60_000 + 30_000))).toMatchObject({
      visible: true,
      phase: 'warning',
      markerNumber: 2,
      leadLabel: '30 seconds',
      alarmDue: false,
    });

    coordinator.acknowledge();
    expect(coordinator.evaluate(inputAt(t0 + 25 * 60_000))).toMatchObject({
      visible: false,
      alarmDue: false,
    });

    expect(coordinator.evaluate(inputAt(t0 + 49 * 60_000 + 30_000))).toMatchObject({
      visible: true,
      phase: 'warning',
      markerNumber: 3,
    });
  });

  it('emits each ignored due marker alarm once and keeps the due prompt visible', () => {
    const coordinator = createOvertimeCadenceCoordinator(coordinatorOptions);
    coordinator.activateLiveExpiry('session-1');

    expect(coordinator.evaluate(inputAt(t0))).toMatchObject({
      visible: true,
      phase: 'initial',
      markerNumber: 1,
      alarmDue: true,
    });
    expect(coordinator.evaluate(inputAt(t0))).toMatchObject({
      visible: true,
      phase: 'initial',
      markerNumber: 1,
      alarmDue: false,
    });
    expect(coordinator.evaluate(inputAt(t0 + durationMs))).toMatchObject({
      visible: true,
      phase: 'due',
      markerNumber: 2,
      alarmDue: true,
    });
  });

  it('suppresses advance warnings but not a due marker when the lead is off', () => {
    const coordinator = createOvertimeCadenceCoordinator(coordinatorOptions);
    const markerAt = t0 + durationMs;

    coordinator.evaluate(inputAt(markerAt - 1));
    expect(coordinator.evaluate({ ...inputAt(markerAt - 1), lead: 'off' })).toMatchObject({
      visible: false,
      alarmDue: false,
    });
    expect(coordinator.evaluate({ ...inputAt(markerAt), lead: 'off' })).toMatchObject({
      visible: true,
      phase: 'due',
      alarmDue: true,
    });
  });

  it('freezes elapsed Flow while flowPaused and cannot cross a marker', () => {
    const coordinator = createOvertimeCadenceCoordinator(coordinatorOptions);
    const markerAt = t0 + durationMs;
    const pausedBeforeMarker: SessionState = {
      ...flowSession(),
      status: 'flowPaused',
      flowPausedAt: markerAt - 30_001,
    };

    expect(coordinator.evaluate({ session: pausedBeforeMarker, now: markerAt + 60_000, lead: '30000', isForeground: true })).toMatchObject({
      visible: false,
      alarmDue: false,
    });
  });

  it('recovers silently, then warns and alarms only at the next future marker', () => {
    const recovered = createOvertimeCadenceCoordinator(coordinatorOptions);
    expect(recovered.evaluate(inputAt(t0 + 25 * 60_000 + 1))).toMatchObject({
      visible: false,
      alarmDue: false,
    });
    expect(recovered.evaluate(inputAt(t0 + 49 * 60_000 + 30_000))).toMatchObject({
      visible: true,
      phase: 'warning',
      markerNumber: 3,
      alarmDue: false,
    });
    expect(recovered.evaluate(inputAt(t0 + 50 * 60_000))).toMatchObject({
      visible: true,
      phase: 'due',
      markerNumber: 3,
      alarmDue: true,
    });
  });

  it('fast-forwards a delayed live evaluation to one current alarm instead of replaying skipped markers', () => {
    const coordinator = createOvertimeCadenceCoordinator(coordinatorOptions);
    coordinator.activateLiveExpiry('session-1');

    expect(coordinator.evaluate(inputAt(t0 + 75 * 60_000 + 1))).toMatchObject({
      visible: true,
      phase: 'due',
      markerNumber: 4,
      alarmDue: true,
    });
    expect(coordinator.evaluate(inputAt(t0 + 75 * 60_000 + 1))).toMatchObject({
      visible: true,
      markerNumber: 4,
      alarmDue: false,
    });
  });

  it('announces and notifies a background warning only once for its marker', async () => {
    const notifyWarning = vi.fn(async () => {});
    const coordinator = createOvertimeCadenceCoordinator({ notifyWarning });
    const backgroundInput = { ...inputAt(t0 + 24 * 60_000 + 30_000), isForeground: false };

    expect(coordinator.evaluate(backgroundInput).announcement).toBe('30 seconds to next focus check-in');
    expect(coordinator.evaluate(backgroundInput).announcement).toBeNull();
    await Promise.resolve();
    expect(notifyWarning).toHaveBeenCalledTimes(1);
    expect(notifyWarning).toHaveBeenCalledWith('Write the report', '30 seconds');
  });

  it('clears runtime state after leaving Flow and ignores notification failures after disposal', async () => {
    let rejectNotification!: (reason: unknown) => void;
    const notifyWarning = vi.fn(() => new Promise<void>((_, reject) => { rejectNotification = reject; }));
    const logError = vi.fn();
    const coordinator = createOvertimeCadenceCoordinator({ notifyWarning, logError });

    coordinator.evaluate({ ...inputAt(t0 + 24 * 60_000 + 30_000), isForeground: false });
    coordinator.evaluate({ ...inputAt(t0 + 24 * 60_000 + 30_001), session: { status: 'idle' } });
    expect(coordinator.evaluate(inputAt(t0 + 24 * 60_000 + 30_000)).announcement).toBe('30 seconds to next focus check-in');

    coordinator.dispose();
    rejectNotification(new Error('notification failed'));
    await Promise.resolve();
    expect(logError).not.toHaveBeenCalled();
  });
});
