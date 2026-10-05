import { describe, expect, it, vi } from 'vitest';
import { createTaskQueue, type TaskQueue } from './taskQueue';
import { DEFAULT_APP_SETTINGS } from './appearance';
import { createSettingsController, type MatchMediaSource } from './settingsController.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A macrotask flush rather than a fixed microtask-tick count: TaskQueue's
// own enqueue() plus this controller's own .then() each add at least one
// promise-chain hop, so counting exact ticks is fragile. A setTimeout(0)
// reliably drains everything already scheduled.
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A deliberately reorderable TaskQueue test double — unlike the real
 * queue, `run(index)` lets a test choose exactly which enqueued operation
 * actually executes next, so an out-of-order settle (request 2 succeeds
 * before request 1's own failure lands) can be driven deterministically. */
function createReorderableQueue() {
  const pending: Array<() => Promise<void>> = [];
  const queue: TaskQueue = {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = deferred<T>();
      pending.push(async () => {
        try {
          result.resolve(await operation());
        } catch (error) {
          result.reject(error);
        }
      });
      return result.promise;
    },
    async drain() {
      await Promise.allSettled(pending.map((run) => run()));
    },
  };
  return { queue, run: (index: number) => pending[index]() };
}

function fakeMatchMedia(initialMatches: boolean): {
  source: MatchMediaSource;
  fire: (matches: boolean) => void;
  listenerCount: () => number;
} {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const source: MatchMediaSource = () =>
    ({
      get matches() {
        return matches;
      },
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    }) as unknown as Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  return {
    source,
    fire: (next: boolean) => {
      matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

describe('createSettingsController', () => {
  it('accepts the already-validated startup settings as its initial state', () => {
    const controller = createSettingsController({
      initial: { ...DEFAULT_APP_SETTINGS, themeFamily: 'graphite' },
      writeQueue: createTaskQueue(),
      persist: async () => {},
    });

    expect(controller.current).toEqual({ ...DEFAULT_APP_SETTINGS, themeFamily: 'graphite' });
    expect(controller.errors).toEqual({});
  });

  it('applies immediately but persists behind work already in the shared queue', async () => {
    const queue = createTaskQueue();
    const release = deferred<void>();
    const order: string[] = [];
    void queue.enqueue(async () => {
      await release.promise;
      order.push('session');
    });
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: queue,
      persist: async (key, value) => {
        order.push(`${key}:${value}`);
      },
    });

    controller.set('themeFamily', 'cozy');
    expect(controller.current.themeFamily).toBe('cozy');
    expect(order).toEqual([]);

    release.resolve();
    await queue.drain();
    expect(order).toEqual(['session', 'themeFamily:cozy']);
  });

  it('keeps the current value and retries that value after failure', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });

    controller.set('timerAccent', 'green');
    await flushPromises();
    expect(controller.current.timerAccent).toBe('green');
    expect(controller.errors.timerAccent).toBeTruthy();

    controller.retry('timerAccent');
    await flushPromises();
    expect(persist).toHaveBeenLastCalledWith('timerAccent', 'green');
    expect(controller.errors.timerAccent).toBeUndefined();
  });

  it('never rolls back to a prior value — a failed write leaves the newly chosen value in place', async () => {
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist: async () => {
        throw new Error('disk full');
      },
    });

    controller.set('themeFamily', 'moon-garden');
    await flushPromises();

    expect(controller.current.themeFamily).toBe('moon-garden');
    expect(controller.errors.themeFamily).toBeTruthy();
  });

  it("ignores an older failure after a newer value for that key has already persisted — no rollback framework, just sequence-based staleness", async () => {
    const { queue, run } = createReorderableQueue();
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: queue,
      persist: async (_key, value) => {
        if (value === 'stale-request') throw new Error('disk full');
      },
    });

    controller.set('themeFamily', 'stale-request' as never); // request 1 (will fail)
    controller.set('themeFamily', 'graphite'); // request 2 (will succeed), supersedes request 1

    // Run request 2 to success *before* request 1 rejects.
    await run(1);
    await flushPromises();
    expect(controller.current.themeFamily).toBe('graphite');
    expect(controller.errors.themeFamily).toBeUndefined();

    // Request 1's own (now-stale) rejection must not resurrect an error
    // for a value the user no longer has selected.
    await run(0);
    await flushPromises();
    expect(controller.current.themeFamily).toBe('graphite');
    expect(controller.errors.themeFamily).toBeUndefined();
  });

  it('tracks the new focusWarningLeadMs key through the same set/retry/staleness machinery as every other setting', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });

    controller.set('focusWarningLeadMs', '15000');
    await flushPromises();
    expect(controller.current.focusWarningLeadMs).toBe('15000');
    expect(controller.errors.focusWarningLeadMs).toBeTruthy();

    controller.retry('focusWarningLeadMs');
    await flushPromises();
    expect(persist).toHaveBeenLastCalledWith('focusWarningLeadMs', '15000');
    expect(controller.errors.focusWarningLeadMs).toBeUndefined();
  });

  it('tracks the new touchGrassReminderThresholdMs key through the same set/retry/staleness machinery as every other setting', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(undefined);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });

    controller.set('touchGrassReminderThresholdMs', '1800000');
    await flushPromises();
    expect(controller.current.touchGrassReminderThresholdMs).toBe('1800000');
    expect(controller.errors.touchGrassReminderThresholdMs).toBeTruthy();

    controller.retry('touchGrassReminderThresholdMs');
    await flushPromises();
    expect(persist).toHaveBeenLastCalledWith('touchGrassReminderThresholdMs', '1800000');
    expect(controller.errors.touchGrassReminderThresholdMs).toBeUndefined();
  });

  it('tracks the new licenseKey key through the same set/retry/staleness machinery as every other setting', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });

    controller.set('licenseKey', 'some-signed-key-string');
    await flushPromises();
    expect(controller.current.licenseKey).toBe('some-signed-key-string');
    expect(controller.errors.licenseKey).toBeTruthy();

    controller.retry('licenseKey');
    await flushPromises();
    expect(persist).toHaveBeenLastCalledWith('licenseKey', 'some-signed-key-string');
    expect(controller.errors.licenseKey).toBeUndefined();
  });

  it('persists the return tone independently from the focus alarm tone', async () => {
    const persist = vi.fn();
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });

    controller.set('selectedReturnToneId', 'sad-trombone');
    await flushPromises();
    expect(controller.current.selectedReturnToneId).toBe('sad-trombone');
    expect(controller.current.selectedToneId).toBe(DEFAULT_APP_SETTINGS.selectedToneId);
    expect(persist).toHaveBeenCalledWith('selectedReturnToneId', 'sad-trombone');
  });

  it('persists soundscape selection and volume through the same per-key retry path', async () => {
    const persist = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });

    controller.set('selectedSoundscapeId', 'rain-room');
    controller.set('soundscapeVolume', '0.7');
    await flushPromises();

    expect(controller.current.selectedSoundscapeId).toBe('rain-room');
    expect(controller.current.soundscapeVolume).toBe('0.7');
    expect(controller.errors.soundscapeVolume).toBe('Not saved');

    controller.retry('soundscapeVolume');
    await flushPromises();
    expect(persist).toHaveBeenLastCalledWith('soundscapeVolume', '0.7');
    expect(controller.errors.soundscapeVolume).toBeUndefined();
  });

  it('calls onPersistenceError for a real failure, but not for a stale/superseded one', async () => {
    const { queue, run } = createReorderableQueue();
    const onPersistenceError = vi.fn();
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: queue,
      persist: async () => {
        throw new Error('disk full');
      },
      onPersistenceError,
    });

    controller.set('timerAccent', 'red');
    await run(0);
    await flushPromises();

    expect(onPersistenceError).toHaveBeenCalledTimes(1);
    expect(onPersistenceError).toHaveBeenCalledWith('timerAccent', expect.any(Error));
  });

  it('resolves resolvedAppearance through the system observer once subscribed', () => {
    const media = fakeMatchMedia(true);
    const controller = createSettingsController({
      initial: { ...DEFAULT_APP_SETTINGS, appearanceMode: 'system' },
      writeQueue: createTaskQueue(),
      persist: async () => {},
    });

    expect(controller.resolvedAppearance).toBe('light'); // no observer attached yet — default false

    const unsubscribe = controller.subscribeToSystemAppearance(media.source);
    expect(controller.resolvedAppearance).toBe('dark'); // matches the initial media state

    media.fire(false);
    expect(controller.resolvedAppearance).toBe('light');

    unsubscribe();
  });

  it('ignores system changes while an explicit Light/Dark mode is selected', () => {
    const media = fakeMatchMedia(false);
    const controller = createSettingsController({
      initial: { ...DEFAULT_APP_SETTINGS, appearanceMode: 'light' },
      writeQueue: createTaskQueue(),
      persist: async () => {},
    });
    controller.subscribeToSystemAppearance(media.source);

    media.fire(true); // system switched to dark
    expect(controller.resolvedAppearance).toBe('light'); // explicit Light ignores it
  });

  it('disposes the system media-query listener on unsubscribe', () => {
    const media = fakeMatchMedia(false);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist: async () => {},
    });

    const unsubscribe = controller.subscribeToSystemAppearance(media.source);
    expect(media.listenerCount()).toBe(1);

    unsubscribe();
    expect(media.listenerCount()).toBe(0);

    // No further updates after disposal.
    media.fire(true);
    expect(controller.resolvedAppearance).toBe('light');
  });
});
