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
  it('a submit() called while deleteHistory() is in flight (real TaskQueue) is deferred until the deletion settles, then behaves as genuinely new', async () => {
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

    const deletion = coordinator.deleteHistory('s1');
    // Let deleteHistory's own writeQueue job actually start (reach the
    // point of awaiting deleteGate) before submitting anything.
    await tick();
    expect(calls).toEqual(['delete:s1']);

    // Submitted *during* the deletion — this must not execute until the
    // deletion has fully settled, regardless of how the shared TaskQueue
    // would otherwise have ordered it.
    const submitted = coordinator.submit(request({ content: 'during-delete' }));
    await tick();
    expect(calls).toEqual(['delete:s1']); // still hasn't run

    deleteGate.resolve();
    await deletion;
    const ok = await submitted;

    expect(ok).toBe(true);
    expect(calls).toEqual(['delete:s1', 'create:during-delete']);
  });

  it('a submission scheduled before a successful deletion never executes afterward, but a fresh one right after does', async () => {
    const writeQueue = createTaskQueue();
    const calls: string[] = [];
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        // A transient failure leaves 'stale' genuinely pending — scheduled
        // "before" the deletion below, not yet resolved by it.
        if (req.content === 'stale') throw new Error('disk unavailable');
        calls.push(req.content);
        return null;
      },
      deleteRevisionHistory: async (): Promise<DeleteOutcome> => ({ cleanupPending: false }),
    });

    await coordinator.submit(request({ content: 'stale' }));
    await coordinator.deleteHistory('s1');
    // The stale entry must never resurrect via a later bulk retry either.
    await coordinator.retry();

    const ok = await coordinator.submit(request({ content: 'fresh' }));

    expect(ok).toBe(true);
    expect(calls).toEqual(['fresh']);
  });

  it('flushForClose() waits for a producer that has not reached submit() yet before flushing', async () => {
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

    const gate = deferred<void>();
    // Models an automatic snapshot: tracked from its intent boundary, but
    // still awaiting its own note-flush before it ever calls submit().
    const producer = coordinator.trackProducer(
      (async () => {
        await gate.promise;
        await coordinator.submit(request({ content: 'late-snapshot' }));
      })(),
    );

    const closePromise = coordinator.flushForClose();
    // If flushForClose() didn't wait for the producer, it would have
    // nothing pending yet and could resolve right here.
    await tick();
    expect(calls).toEqual([]);

    gate.resolve();
    const [closeOk] = await Promise.all([closePromise, producer]);

    expect(closeOk).toBe(true);
    expect(calls).toEqual(['late-snapshot']);
  });

  it('a terminal failure for one session does not suppress the notice priority or the automatic retry timer for a different, transiently-failing session', async () => {
    const writeQueue = createTaskQueue();
    let okAttempts = 0;
    const coordinator = createRevisionSaveCoordinator({
      writeQueue,
      createRevision: async (req) => {
        if (req.sessionId === 'bad-session') throw new Error('hash mismatch');
        okAttempts += 1;
        if (okAttempts < 2) throw new Error('disk unavailable');
        return null;
      },
      deleteRevisionHistory: async (): Promise<DeleteOutcome> => ({ cleanupPending: false }),
      retryDelayMs: 10,
      classifyFailure: (error) =>
        error instanceof Error && error.message === 'hash mismatch' ? 'terminal' : 'transient',
    });

    await coordinator.submit(request({ sessionId: 'bad-session', content: 'bad' }));
    expect(coordinator.status.integrityIssue).toBe(true);
    expect(coordinator.status.failing).toBe(false);

    await coordinator.submit(request({ sessionId: 'ok-session', content: 'ok' }));
    expect(okAttempts).toBe(1);
    // The integrity banner still takes display priority...
    expect(coordinator.status.integrityIssue).toBe(true);

    // ...but the automatic-retry timer must still be running for
    // 'ok-session' regardless — wait past the retry delay and confirm a
    // second attempt happened on its own, with no manual retry() call.
    await tick(50);
    expect(okAttempts).toBe(2);
    // 'bad-session' is still pending (terminal entries are never cleared
    // by another session's unrelated success), so the banner still shows
    // the integrity notice — but nothing is left failing/retrying.
    expect(coordinator.status.integrityIssue).toBe(true);
    expect(coordinator.status.failing).toBe(false);
  });
});
