import { describe, expect, it } from 'vitest';
import { createNoteSaveController } from './noteSaveController';
import { NoteStorageError, normalizeNoteStorageError } from './noteStorage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createNoteSaveController', () => {
  it('flush() with nothing scheduled is a no-op success', async () => {
    const controller = createNoteSaveController(async () => {});
    const result = await controller.flush();
    expect(result).toEqual({ ok: true, invalidated: false, attempt: 0, exhausted: false, failure: null });
  });

  it('flushes a scheduled save through the injected save function', async () => {
    const calls: Array<[string, string]> = [];
    const controller = createNoteSaveController(async (sessionId, content) => {
      calls.push([sessionId, content]);
    });

    controller.schedule('s1', 'hello');
    const result = await controller.flush();

    expect(result.ok).toBe(true);
    expect(calls).toEqual([['s1', 'hello']]);
    expect(controller.hasPending()).toBe(false);
  });

  it('a later schedule() replaces earlier unflushed content for the same session', async () => {
    const calls: string[] = [];
    const controller = createNoteSaveController(async (_id, content) => {
      calls.push(content);
    });

    controller.schedule('s1', 'first draft');
    controller.schedule('s1', 'final draft');
    await controller.flush();

    expect(calls).toEqual(['final draft']);
  });

  it('keeps a failed save pending for retry, and does not treat it as invalidated', async () => {
    const controller = createNoteSaveController(async () => {
      throw new Error('write failed');
    });

    controller.schedule('s1', 'content');
    const result = await controller.flush();

    expect(result.ok).toBe(false);
    expect(result.invalidated).toBe(false);
    expect(result.attempt).toBe(1);
    expect(result.exhausted).toBe(false);
    expect(controller.hasPending()).toBe(true);
  });

  it('marks a repeatedly-failing save exhausted once attempts exceed the configured bound', async () => {
    const controller = createNoteSaveController(async () => {
      throw new Error('write failed');
    }, 2);

    controller.schedule('s1', 'content');
    expect((await controller.flush()).exhausted).toBe(false); // attempt 1
    expect((await controller.flush()).exhausted).toBe(false); // attempt 2
    const third = await controller.flush(); // attempt 3 > max of 2
    expect(third.exhausted).toBe(true);
    expect(controller.hasPending()).toBe(true); // still retained for a manual retry
  });

  it('a successful retry after failures clears pending and resets the attempt count', async () => {
    let shouldFail = true;
    const controller = createNoteSaveController(async () => {
      if (shouldFail) throw new Error('write failed');
    });

    controller.schedule('s1', 'content');
    await controller.flush(); // fails, attempt 1
    shouldFail = false;
    const result = await controller.flush(); // succeeds

    expect(result.ok).toBe(true);
    expect(result.attempt).toBe(0);
    expect(controller.hasPending()).toBe(false);
  });

  it('the deterministic race: a queued save fails, its session is deleted, and a later flush never resurrects it', async () => {
    // This is the exact scenario a delete must be safe against: a save for
    // session s1 is already in flight (past the point a pre-delete cancel
    // could stop it) when the delete happens. It fails, and — without this
    // guard — would repopulate itself for retry. A subsequent flush (the
    // next debounce tick, a blur, or window close) must not write it back.
    const saveCalls: string[] = [];
    let shouldFail = true;
    const controller = createNoteSaveController(async (_id, content) => {
      saveCalls.push(content);
      if (shouldFail) throw new Error('write failed');
    });

    controller.schedule('s1', 'will be lost if resurrected');
    const first = await controller.flush();
    expect(first.ok).toBe(false);
    expect(saveCalls).toEqual(['will be lost if resurrected']);

    // The delete runs while the failed save was "waiting to retry" — this
    // models calling invalidate() again after the queued deletion commits.
    // It clears the repopulated pending content outright, so there is
    // nothing left for a later flush to even consider resurrecting.
    controller.invalidate('s1');
    shouldFail = false; // if a retry slipped through, it would now "succeed"
    expect(controller.hasPending()).toBe(false);

    const second = await controller.flush();
    expect(second.ok).toBe(true);
    expect(saveCalls).toEqual(['will be lost if resurrected']); // save() never called again
    expect(controller.hasPending()).toBe(false);
  });

  it('invalidating a session while its own save is still in flight also prevents a repopulate', async () => {
    // Proves ordering doesn't matter: even if the delete's invalidate() call
    // lands *during* the failing save (not safely before or after it), the
    // failure handler still sees it as invalidated.
    const controller = createNoteSaveController(async () => {
      controller.invalidate('s1');
      throw new Error('write failed');
    });

    controller.schedule('s1', 'content');
    const result = await controller.flush();

    expect(result.invalidated).toBe(true);
    expect(controller.hasPending()).toBe(false);
  });

  it('invalidating one session does not affect a pending save for a different session', async () => {
    const controller = createNoteSaveController(async () => {
      throw new Error('write failed');
    });

    controller.schedule('s2', 'unrelated content');
    await controller.flush(); // fails, repopulates for s2

    controller.invalidate('s1'); // a different session is deleted

    expect(controller.hasPending()).toBe(true); // s2's retry is untouched
  });

  it('invalidate() with no id (delete-all) invalidates every pending/retryable save', async () => {
    const controller = createNoteSaveController(async () => {
      throw new Error('write failed');
    });

    controller.schedule('s1', 'content');
    await controller.flush(); // fails, repopulates for retry

    controller.invalidate(); // delete-all — clears the repopulated retry outright
    expect(controller.hasPending()).toBe(false);

    const result = await controller.flush();
    expect(result.ok).toBe(true);
  });

  it('a save scheduled after a delete-all remains valid — invalidation does not leak into the future', async () => {
    const saveCalls: string[] = [];
    const controller = createNoteSaveController(async (_id, content) => {
      saveCalls.push(content);
    });

    controller.invalidate(); // delete-all happens first
    controller.schedule('new-session', 'brand new note');
    const result = await controller.flush();

    expect(result.ok).toBe(true);
    expect(result.invalidated).toBe(false);
    expect(saveCalls).toEqual(['brand new note']);
  });

  it('overlapping saves for two different sessions never share one pending slot, even when both fail', async () => {
    // Models App.svelte's carry-forward path: the just-completed session's
    // final flush is still in flight (not yet resolved) when the new
    // session's carried note is scheduled and its own flush requested.
    // Neither session's content may be discarded just because the other
    // was outstanding at the same time, and each must retry with its own
    // correct content afterward.
    const saveCalls: Array<{ sessionId: string; content: string }> = [];
    const oldGate = deferred<void>();
    let oldShouldFail = true;
    let newShouldFail = true;

    const controller = createNoteSaveController(async (sessionId, content) => {
      saveCalls.push({ sessionId, content });
      if (sessionId === 'old-session') {
        await oldGate.promise; // held open until the test releases it
        if (oldShouldFail) throw new Error('old save failed');
        return;
      }
      if (newShouldFail) throw new Error('new save failed');
    });

    controller.schedule('old-session', 'old content');
    const oldFlushPromise = controller.flush(); // starts, awaiting oldGate

    // While the old session's save is still in flight, the new session's
    // carried note is scheduled and flushed — without waiting for the old
    // one to finish.
    controller.schedule('new-session', 'new content');
    const newFlushPromise = controller.flush();

    oldGate.resolve(); // let the old save's write proceed (and fail)
    const [oldResult, newResult] = await Promise.all([oldFlushPromise, newFlushPromise]);

    expect(oldResult.ok).toBe(false);
    expect(newResult.ok).toBe(false);

    // Both sessions' failed content must have survived independently.
    expect(controller.hasPending()).toBe(true);

    // Retrying now must persist the correct content under each session id.
    oldShouldFail = false;
    newShouldFail = false;
    const retryResult = await controller.flush();
    expect(retryResult.ok).toBe(true);
    expect(controller.hasPending()).toBe(false);

    const oldSaveContents = saveCalls.filter((c) => c.sessionId === 'old-session').map((c) => c.content);
    const newSaveContents = saveCalls.filter((c) => c.sessionId === 'new-session').map((c) => c.content);
    expect(oldSaveContents).toEqual(['old content', 'old content']); // failed attempt, then retry
    expect(newSaveContents).toEqual(['new content', 'new content']);
  });

  it('flush() for a session already in flight waits for it instead of assuming nothing is pending', async () => {
    const gate = deferred<void>();
    let callCount = 0;
    const controller = createNoteSaveController(async () => {
      callCount += 1;
      await gate.promise;
    });

    controller.schedule('s1', 'content');
    const first = controller.flush(); // claims the entry; pending is now empty

    // A second flush() call while the first is still in flight must not
    // treat the empty pending map as "nothing to save" — it should wait
    // for the same in-flight attempt and report its real outcome.
    const second = controller.flush();

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(callCount).toBe(1); // save() was only ever called once, not twice
  });

  it('retains a conflict draft but does not increment or auto-retry it', async () => {
    const conflict = new NoteStorageError('conflict', { diskContent: 'disk', diskHash: 'hash' });
    const controller = createNoteSaveController(
      async () => {
        throw conflict;
      },
      3,
      (error) => normalizeNoteStorageError(error).kind,
    );

    controller.schedule('s1', 'local draft');
    const result = await controller.flush();

    expect(result.failure?.kind).toBe('conflict');
    expect(result.attempt).toBe(0);
    expect(result.exhausted).toBe(false);
    expect(controller.hasPending()).toBe(true);
  });

  it('discard clears the draft without permanently invalidating the session', async () => {
    const calls: string[] = [];
    const controller = createNoteSaveController(async (_id, content) => {
      calls.push(content);
    });

    controller.schedule('s1', 'discard me');
    controller.discard('s1');
    await controller.flush();
    controller.schedule('s1', 'future edit');
    await controller.flush();

    expect(calls).toEqual(['future edit']);
  });

  it.each(['missing', 'unreadable'] as const)(
    'keeps a %s-file draft pending without an automatic empty save',
    async (kind) => {
      const savedContents: string[] = [];
      const controller = createNoteSaveController(
        async (_id, content) => {
          savedContents.push(content);
          throw new NoteStorageError(kind, { relativePath: 's1.md' });
        },
        3,
        (error) => normalizeNoteStorageError(error).kind,
      );

      controller.schedule('s1', 'preserve this draft');
      const result = await controller.flush();

      expect(result.failure?.kind).toBe(kind);
      expect(result.attempt).toBe(0);
      expect(controller.hasPending()).toBe(true);
      expect(savedContents).toEqual(['preserve this draft']);
    },
  );

  it('a transient failure still increments attempt and bounds auto-retry as before', async () => {
    const controller = createNoteSaveController(
      async () => {
        throw new Error('disk unavailable');
      },
      2,
      (error) => normalizeNoteStorageError(error).kind,
    );

    controller.schedule('s1', 'content');
    const first = await controller.flush();
    expect(first.failure?.kind).toBe('transient');
    expect(first.attempt).toBe(1);
    expect(first.exhausted).toBe(false);

    await controller.flush();
    const third = await controller.flush();
    expect(third.exhausted).toBe(true);
  });
});
