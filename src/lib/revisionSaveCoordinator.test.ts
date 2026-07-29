import { describe, expect, it } from 'vitest';
import { createRevisionSaveCoordinator } from './revisionSaveCoordinator.svelte';
import { createTaskQueue } from './taskQueue';
import type { CreateRevisionRequest } from './revisions';
import type { DeleteOutcome } from './notes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(overrides: Partial<CreateRevisionRequest> = {}): CreateRevisionRequest {
  return {
    sessionId: 's1',
    content: 'content',
    contentHash: 'hash-content',
    kind: 'automatic',
    reason: 'session_completed',
    createdAt: 1000,
    ...overrides,
  };
}

describe('createRevisionSaveCoordinator', () => {
  it('a token captured before or during a deletion (real TaskQueue) is discarded even after the deletion resolves — a fresh token afterward works normally', async () => {
    const writeQueue = createTaskQueue();
    const deleteGate = deferred<void>();
    const calls: string[] = [];
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        calls.push(`create:${req.content}`);
        return null;
      },
      deleteRevisionHistory: async (sessionId): Promise<DeleteOutcome> => {
        calls.push(`delete:${sessionId}`);
        await deleteGate.promise;
        return { cleanupPending: false };
      },
    });

    // Token captured *before* the deletion starts — its intent boundary.
    const staleToken = coordinator.beginIntent('s1');

    const deletion = coordinator.deleteHistory('s1');
    await tick();
    expect(calls).toEqual(['delete:s1']);

    // A second token captured *during* the deletion (mid-flight) — also
    // stale, and must be discarded the same way, not merely deferred.
    const duringToken = coordinator.beginIntent('s1');

    deleteGate.resolve();
    await deletion;

    const staleOk = await coordinator.submit(staleToken, request({ content: 'stale' }));
    const duringOk = await coordinator.submit(duringToken, request({ content: 'during' }));

    expect(staleOk).toBe(true); // discarded, counts as "safe"
    expect(duringOk).toBe(true);
    expect(calls).toEqual(['delete:s1']); // neither ever executed

    // A token captured *after* deleteHistory() resolves is genuinely new.
    const freshToken = coordinator.beginIntent('s1');
    const freshOk = await coordinator.submit(freshToken, request({ content: 'fresh' }));

    expect(freshOk).toBe(true);
    expect(calls).toEqual(['delete:s1', 'create:fresh']);
  });

  it('a token captured before a FAILED deletion is still discarded, even though the delete itself never actually removed anything', async () => {
    const writeQueue = createTaskQueue();
    const calls: string[] = [];
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        calls.push(req.content);
        return null;
      },
      deleteRevisionHistory: async (): Promise<DeleteOutcome> => {
        throw new Error('delete command rejected');
      },
    });

    const staleToken = coordinator.beginIntent('s1');

    await expect(coordinator.deleteHistory('s1')).rejects.toThrow('delete command rejected');

    const staleOk = await coordinator.submit(staleToken, request({ content: 'stale' }));
    expect(staleOk).toBe(true);
    expect(calls).toEqual([]); // never executed, even on a failed delete attempt

    const freshToken = coordinator.beginIntent('s1');
    const freshOk = await coordinator.submit(freshToken, request({ content: 'fresh' }));
    expect(freshOk).toBe(true);
    expect(calls).toEqual(['fresh']);
  });

  it('a token captured before invalidate(sessionId) is discarded even though it never reached the operation controller', async () => {
    const writeQueue = createTaskQueue();
    const calls: string[] = [];
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        calls.push(req.content);
        return null;
      },
      deleteRevisionHistory: async (): Promise<DeleteOutcome> => ({ cleanupPending: false }),
    });

    // Models a producer still awaiting its own note-flush/hash/lookup —
    // beginIntent() ran, but submit() hasn't happened yet.
    const token = coordinator.beginIntent('s1');

    coordinator.invalidate('s1'); // e.g. the whole session was deleted

    const ok = await coordinator.submit(token, request({ content: 'late' }));

    expect(ok).toBe(true); // discarded, not a real failure
    expect(calls).toEqual([]); // never touched the operation controller at all
  });

  it('a token captured before a global invalidate() (delete-all) is discarded the same way', async () => {
    const writeQueue = createTaskQueue();
    const calls: string[] = [];
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        calls.push(req.content);
        return null;
      },
      deleteRevisionHistory: async (): Promise<DeleteOutcome> => ({ cleanupPending: false }),
    });

    const token = coordinator.beginIntent('s1');
    coordinator.invalidate(); // delete-all

    const ok = await coordinator.submit(token, request({ content: 'late' }));

    expect(ok).toBe(true);
    expect(calls).toEqual([]);

    // A fresh token afterward is unaffected.
    const freshToken = coordinator.beginIntent('s1');
    const freshOk = await coordinator.submit(freshToken, request({ content: 'fresh' }));
    expect(freshOk).toBe(true);
    expect(calls).toEqual(['fresh']);
  });

  it("a terminal failure for one session does not hide a different, exhausted-transient session's manual-retry action", async () => {
    const writeQueue = createTaskQueue();
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        if (req.sessionId === 'bad-session') throw new Error('hash mismatch');
        throw new Error('disk unavailable');
      },
      deleteRevisionHistory: async (): Promise<DeleteOutcome> => ({ cleanupPending: false }),
      maxAutoRetries: 1,
      classifyFailure: (error) =>
        error instanceof Error && error.message === 'hash mismatch' ? 'terminal' : 'transient',
    });

    await coordinator.submit(coordinator.beginIntent('bad-session'), request({ sessionId: 'bad-session', content: 'bad' }));
    expect(coordinator.status.integrityIssue).toBe(true);
    expect(coordinator.status.needsManualRetry).toBe(false);

    await coordinator.submit(coordinator.beginIntent('ok-session'), request({ sessionId: 'ok-session', content: 'ok' }));
    await coordinator.retry(); // attempt 2 > bound of 1 for 'ok-session' — now exhausted

    // The integrity banner still takes display priority...
    expect(coordinator.status.integrityIssue).toBe(true);
    // ...but 'ok-session's exhausted, still-transient failure must still
    // expose its own manual Retry action.
    expect(coordinator.status.needsManualRetry).toBe(true);
    expect(coordinator.status.failing).toBe(true);
  });

  it('a terminal entry is never retried, even by a bulk retry() that also retries a different, transient session', async () => {
    const writeQueue = createTaskQueue();
    const calls: string[] = [];
    let okShouldFail = true;
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        calls.push(req.sessionId);
        if (req.sessionId === 'bad-session') throw new Error('hash mismatch');
        if (okShouldFail) throw new Error('disk unavailable');
      },
      deleteRevisionHistory: async (): Promise<DeleteOutcome> => ({ cleanupPending: false }),
      classifyFailure: (error) =>
        error instanceof Error && error.message === 'hash mismatch' ? 'terminal' : 'transient',
    });

    await coordinator.submit(coordinator.beginIntent('bad-session'), request({ sessionId: 'bad-session' }));
    await coordinator.submit(coordinator.beginIntent('ok-session'), request({ sessionId: 'ok-session' }));
    expect(calls).toEqual(['bad-session', 'ok-session']);

    okShouldFail = false;
    await coordinator.retry();

    // 'bad-session' (terminal) is never retried; 'ok-session' is.
    expect(calls).toEqual(['bad-session', 'ok-session', 'ok-session']);
  });

  it('flushForClose() catches a producer registered while an earlier one is still resolving, before ever reporting back', async () => {
    const writeQueue = createTaskQueue();
    const calls: string[] = [];
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        calls.push(req.content);
        return null;
      },
      deleteRevisionHistory: async (): Promise<DeleteOutcome> => ({ cleanupPending: false }),
    });

    const firstGate = deferred<void>();
    coordinator.trackProducer(
      (async () => {
        await firstGate.promise;
        await coordinator.submit(coordinator.beginIntent('s1'), request({ content: 'first' }));
      })(),
    );

    const closePromise = coordinator.flushForClose();
    await tick();
    expect(calls).toEqual([]);

    // A second producer registers while flushForClose() is still awaiting
    // the first one — it must be caught too, not left to complete after
    // flushForClose() has already reported success to its caller.
    const secondGate = deferred<void>();
    coordinator.trackProducer(
      (async () => {
        await secondGate.promise;
        await coordinator.submit(coordinator.beginIntent('s1'), request({ content: 'second' }));
      })(),
    );

    firstGate.resolve();
    await tick();
    secondGate.resolve();

    const ok = await closePromise;

    expect(ok).toBe(true);
    expect(calls).toEqual(['first', 'second']);
  });
});
