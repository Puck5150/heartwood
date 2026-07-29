import { afterEach, describe, expect, it } from 'vitest';
import { createTaskQueue } from './taskQueue';
import { deleteAllData, insertParkedThought, loadAllParkedThoughts, resetMemoryStore } from './memoryRepository';
import { DEFAULT_APP_SETTINGS } from './appearance';
import { createSettingsController } from './settingsController.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createTaskQueue', () => {
  it('runs operations strictly in enqueue order, even when an earlier one resolves later', async () => {
    const order: string[] = [];
    const queue = createTaskQueue();
    const first = deferred<void>();

    const firstDone = queue.enqueue(async () => {
      await first.promise;
      order.push('first');
    });
    const secondDone = queue.enqueue(async () => {
      order.push('second');
    });

    // Give the second operation every chance to run early if ordering
    // weren't enforced — it must still wait for the first to finish.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);

    first.resolve();
    await Promise.all([firstDone, secondDone]);
    expect(order).toEqual(['first', 'second']);
  });

  it('does not let a failed operation block ones queued after it', async () => {
    const queue = createTaskQueue();
    const failing = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const after = queue.enqueue(async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });

  it('resolves/rejects each caller with that operation’s own outcome', async () => {
    const queue = createTaskQueue();
    const a = queue.enqueue(async () => 1);
    const b = queue.enqueue(async () => 2);
    expect(await a).toBe(1);
    expect(await b).toBe(2);
  });

  it('a delete enqueued while a save is still in flight runs after that save, so the delete always wins', async () => {
    // This is the scenario a delete must be safe against: a session save
    // that was already queued/in-flight must not be able to land *after*
    // a delete and silently recreate the data the user just removed.
    const store: Record<string, string> = {};
    const queue = createTaskQueue();
    const saveStarted = deferred<void>();

    const savePromise = queue.enqueue(async () => {
      saveStarted.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10)); // simulate a slow write
      store.session = 'recreated-by-pending-save';
    });

    await saveStarted.promise; // the save has started but not finished yet

    const deletePromise = queue.enqueue(async () => {
      delete store.session;
    });

    await Promise.all([savePromise, deletePromise]);

    expect(store.session).toBeUndefined();
  });
});

describe('createTaskQueue drain', () => {
  it('resolves only after every operation enqueued so far has settled', async () => {
    const order: string[] = [];
    const queue = createTaskQueue();
    const slow = deferred<void>();

    queue.enqueue(async () => {
      await slow.promise;
      order.push('slow-op');
    });
    queue.enqueue(async () => {
      order.push('second-op');
    });

    const drained = queue.drain();
    let drainResolved = false;
    drained.then(() => {
      drainResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drainResolved).toBe(false); // the slow op hasn't finished yet

    slow.resolve();
    await drained;
    expect(drainResolved).toBe(true);
    expect(order).toEqual(['slow-op', 'second-op']);
  });

  it('resolves without rejecting even when the last-enqueued operation fails', async () => {
    const queue = createTaskQueue();
    const failing = queue.enqueue(async () => {
      throw new Error('boom');
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('resolves immediately for a queue with nothing enqueued', async () => {
    const queue = createTaskQueue();
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});

describe('createTaskQueue with the real repository', () => {
  afterEach(() => {
    resetMemoryStore();
  });

  it('does not let an in-flight parked-thought insert resurrect data after deleteAllData', async () => {
    // The exact regression this guards against: park a thought (a slow
    // insert that's still in flight), then delete everything before that
    // insert lands. Without routing both through the same queue, the
    // insert could complete after the delete and leave a "resurrected"
    // parked thought behind in an otherwise-wiped store.
    const queue = createTaskQueue();
    const thought = { id: 't1', sessionId: 's1', text: 'Should not survive', createdAt: 1_000 };
    const insertStarted = deferred<void>();

    const insertPromise = queue.enqueue(async () => {
      insertStarted.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10)); // simulate a slow write
      await insertParkedThought(thought);
    });

    await insertStarted.promise; // the insert has started but not finished yet

    const deletePromise = queue.enqueue(() => deleteAllData());

    await Promise.all([insertPromise, deletePromise]);

    expect(await loadAllParkedThoughts()).toEqual([]);
  });

  it('a settings write shares this exact queue with a note/session-style mutation, not a settings-only queue', async () => {
    // Catches the specific mistake of constructing a separate TaskQueue
    // for settings: if that happened, this test's real, shared queue would
    // never see the settings write at all, and `order` would only ever
    // contain 'note mutation'.
    const queue = createTaskQueue();
    const order: string[] = [];
    const noteStarted = deferred<void>();

    const notePromise = queue.enqueue(async () => {
      noteStarted.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10)); // simulate a slow write
      order.push('note mutation');
    });

    await noteStarted.promise; // the note write has started but not finished yet

    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: queue,
      persist: async (key, value) => {
        order.push(`setting ${key}:${value}`);
      },
    });
    controller.set('themeFamily', 'graphite');

    const drain = queue.drain();
    await notePromise;
    await drain;

    expect(order).toEqual(['note mutation', 'setting themeFamily:graphite']);
  });
});
