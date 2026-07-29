import { describe, expect, it } from 'vitest';
import { createRevisionOperationController } from './revisionOperationController';
import type { CreateRevisionRequest } from './revisions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe('createRevisionOperationController', () => {
  it('submits and executes a request successfully', async () => {
    const calls: CreateRevisionRequest[] = [];
    const controller = createRevisionOperationController(async (req) => {
      calls.push(req);
    });

    const ok = await controller.submit(request());

    expect(ok).toBe(true);
    expect(calls).toEqual([request()]);
    expect(controller.hasPending('s1')).toBe(false);
  });

  it('retains exact boundary content even if unrelated external state changes before execution runs', async () => {
    const gate = deferred<void>();
    const calls: CreateRevisionRequest[] = [];
    const controller = createRevisionOperationController(async (req) => {
      await gate.promise;
      calls.push(req);
    });

    const original = request({ content: 'at completion', contentHash: 'hash-at-completion' });
    const pending = controller.submit(original);
    // Simulate unrelated app state changing while the request is in flight.
    let editorContent = 'changed during review';
    void editorContent;

    gate.resolve();
    await pending;

    expect(calls).toEqual([original]);
  });

  it('retries a transient failure with the original reason/timestamp/hash and eventually succeeds', async () => {
    let shouldFail = true;
    const calls: CreateRevisionRequest[] = [];
    const controller = createRevisionOperationController(async (req) => {
      calls.push(req);
      if (shouldFail) throw new Error('disk unavailable');
    });

    const req = request();
    const first = await controller.submit(req);
    expect(first).toBe(false);
    expect(controller.hasPending('s1')).toBe(true);

    shouldFail = false;
    const retried = await controller.retry();

    expect(retried).toBe(true);
    expect(controller.hasPending('s1')).toBe(false);
    expect(calls).toEqual([req, req]);
  });

  it('classifies a non-transient failure as terminal: no automatic retry, but remains pending', async () => {
    const calls: CreateRevisionRequest[] = [];
    const controller = createRevisionOperationController(
      async (req) => {
        calls.push(req);
        throw new Error('hash mismatch');
      },
      3,
      () => 'terminal',
    );

    const req = request();
    await controller.submit(req);
    expect(controller.hasPending('s1')).toBe(true);
    expect(controller.isExhausted('s1')).toBe(true);

    // A bulk retry() must not re-attempt a terminal failure.
    await controller.retry();
    expect(calls).toHaveLength(1);
  });

  it('marks a transient failure exhausted only after exceeding the configured bound', async () => {
    const controller = createRevisionOperationController(
      async () => {
        throw new Error('disk unavailable');
      },
      2,
    );

    const req = request();
    await controller.submit(req); // attempt 1
    expect(controller.isExhausted('s1')).toBe(false);
    await controller.retry(); // attempt 2
    expect(controller.isExhausted('s1')).toBe(false);
    await controller.retry(); // attempt 3 > bound of 2
    expect(controller.isExhausted('s1')).toBe(true);
    expect(controller.hasPending('s1')).toBe(true); // still available for manual retry
  });

  it('flush() reports false while relevant work still fails', async () => {
    const controller = createRevisionOperationController(async () => {
      throw new Error('disk unavailable');
    });

    await controller.submit(request());
    const result = await controller.flush();

    expect(result).toBe(false);
  });

  it('a fresh submit for the same session supersedes a prior terminal failure', async () => {
    let mode: 'fail' | 'succeed' = 'fail';
    const calls: CreateRevisionRequest[] = [];
    const controller = createRevisionOperationController(
      async (req) => {
        calls.push(req);
        if (mode === 'fail') throw new Error('hash mismatch');
      },
      3,
      () => 'terminal',
    );

    await controller.submit(request({ content: 'first', contentHash: 'hash-first' }));
    expect(controller.isExhausted('s1')).toBe(true);

    mode = 'succeed';
    const second = await controller.submit(request({ content: 'second', contentHash: 'hash-second' }));

    expect(second).toBe(true);
    expect(controller.hasPending('s1')).toBe(false);
    expect(calls.map((c) => c.content)).toEqual(['first', 'second']);
  });

  it('a request scheduled before invalidate() stays invalidated, but a fresh request for the same session id afterward retries normally', async () => {
    const gate = deferred<void>();
    let shouldFail = true;
    const controller = createRevisionOperationController(
      async (req) => {
        if (req.content === 'before') {
          await gate.promise;
        }
        if (shouldFail) throw new Error('disk unavailable');
      },
      3,
    );

    // A request is in flight (past the point invalidate() could cancel it
    // synchronously) when the session's revision history gets deleted.
    const before = controller.submit(request({ content: 'before' }));
    controller.invalidate('s1');
    gate.resolve();
    const beforeResult = await before;

    expect(beforeResult).toBe(true); // invalidated counts as safe, not a failure
    expect(controller.hasPending('s1')).toBe(false); // never resurrected for retry

    // Deleting revision history never deletes the session itself — a
    // brand-new request for the exact same session id afterward must
    // behave with completely normal bounded-retry semantics, not be
    // silently treated as permanently invalidated.
    const after = await controller.submit(request({ content: 'after' }));
    expect(after).toBe(false);
    expect(controller.hasPending('s1')).toBe(true);
    expect(controller.isExhausted('s1')).toBe(false);

    shouldFail = false;
    const retried = await controller.retry();
    expect(retried).toBe(true);
    expect(controller.hasPending('s1')).toBe(false);
  });

  it('an invalidate() that runs even though the underlying deletion failed still discards the pre-deletion request, while a post-deletion request is unaffected', async () => {
    // Models App.svelte's handleDeleteRevisionHistory: invalidate() is
    // called both before *and* after the delete attempt regardless of
    // whether the native delete command itself succeeds or throws.
    const gate = deferred<void>();
    const controller = createRevisionOperationController(async (req) => {
      if (req.content === 'stale') {
        await gate.promise;
        throw new Error('disk unavailable');
      }
    });

    const stale = controller.submit(request({ content: 'stale' }));
    controller.invalidate('s1'); // called before attempting the delete

    let deletionFailed = false;
    try {
      throw new Error('delete command rejected');
    } catch {
      deletionFailed = true;
    } finally {
      controller.invalidate('s1'); // called again after, even on failure
    }
    expect(deletionFailed).toBe(true);

    gate.resolve();
    const staleResult = await stale;
    expect(staleResult).toBe(true); // discarded, not resurrected
    expect(controller.hasPending('s1')).toBe(false);

    // A fresh request submitted after the (failed) deletion attempt is
    // still perfectly valid — the session/its notes were never touched.
    const fresh = await controller.submit(request({ content: 'fresh' }));
    expect(fresh).toBe(true);
    expect(controller.hasPending('s1')).toBe(false);
  });

  it('invalidating one session does not affect another session pending at the same time', async () => {
    const controller = createRevisionOperationController(async () => {
      throw new Error('disk unavailable');
    });

    await controller.submit(request({ sessionId: 's1' }));
    await controller.submit(request({ sessionId: 's2' }));
    expect(controller.hasPending('s1')).toBe(true);
    expect(controller.hasPending('s2')).toBe(true);

    controller.invalidate('s1');

    expect(controller.hasPending('s1')).toBe(false);
    expect(controller.hasPending('s2')).toBe(true);
  });

  it('a failing request invalidated mid-flight does not resurrect on a later retry', async () => {
    const controller = createRevisionOperationController(async () => {
      controller.invalidate('s1');
      throw new Error('disk unavailable');
    });

    const result = await controller.submit(request());

    expect(result).toBe(true); // invalidated counts as "safe", not a real failure
    expect(controller.hasPending('s1')).toBe(false);
  });

  it('invalidate() with no session id clears every pending session', async () => {
    const controller = createRevisionOperationController(async () => {
      throw new Error('disk unavailable');
    });

    await controller.submit(request({ sessionId: 's1' }));
    await controller.submit(request({ sessionId: 's2' }));

    controller.invalidate();

    expect(controller.hasPending('s1')).toBe(false);
    expect(controller.hasPending('s2')).toBe(false);
    expect(controller.hasPending()).toBe(false);
  });

  it('a request scheduled after delete-all remains valid — invalidation does not leak into the future', async () => {
    const calls: CreateRevisionRequest[] = [];
    const controller = createRevisionOperationController(async (req) => {
      calls.push(req);
    });

    controller.invalidate();
    const ok = await controller.submit(request({ sessionId: 'new-session' }));

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('overlapping submits for two different sessions never share one pending slot, even when both fail', async () => {
    const oldGate = deferred<void>();
    let oldShouldFail = true;
    let newShouldFail = true;
    const calls: { sessionId: string; content: string }[] = [];

    const controller = createRevisionOperationController(async (req) => {
      calls.push({ sessionId: req.sessionId, content: req.content });
      if (req.sessionId === 'old-session') {
        await oldGate.promise;
        if (oldShouldFail) throw new Error('old failed');
        return;
      }
      if (newShouldFail) throw new Error('new failed');
    });

    const oldSubmit = controller.submit(request({ sessionId: 'old-session', content: 'old content' }));
    const newSubmit = controller.submit(request({ sessionId: 'new-session', content: 'new content' }));

    oldGate.resolve();
    const [oldResult, newResult] = await Promise.all([oldSubmit, newSubmit]);

    expect(oldResult).toBe(false);
    expect(newResult).toBe(false);
    expect(controller.hasPending('old-session')).toBe(true);
    expect(controller.hasPending('new-session')).toBe(true);

    oldShouldFail = false;
    newShouldFail = false;
    const retryResult = await controller.retry();

    expect(retryResult).toBe(true);
    expect(calls.filter((c) => c.sessionId === 'old-session')).toHaveLength(2);
    expect(calls.filter((c) => c.sessionId === 'new-session')).toHaveLength(2);
  });

  it('flush() reports false while a terminal entry remains pending, even when every attempted target succeeds', async () => {
    const controller = createRevisionOperationController(
      async (req) => {
        if (req.sessionId === 'bad-session') throw new Error('hash mismatch');
      },
      3,
      (error) => (error instanceof Error && error.message === 'hash mismatch' ? 'terminal' : 'transient'),
    );

    await controller.submit(request({ sessionId: 'bad-session' }));
    expect(controller.isTerminal('bad-session')).toBe(true);

    // The terminal entry is never included in a bulk round's targets, so
    // the loop inside flush() runs zero iterations and must not fall back
    // to reporting success just because nothing was actually attempted.
    const result = await controller.flush();

    expect(result).toBe(false);
    expect(controller.hasPending('bad-session')).toBe(true);
  });

  it('isExhausted()/isTerminal() with no session id report across every pending session', async () => {
    const controller = createRevisionOperationController(
      async (req) => {
        throw new Error(req.sessionId === 'bad-session' ? 'hash mismatch' : 'disk unavailable');
      },
      3,
      (error) => (error instanceof Error && error.message === 'hash mismatch' ? 'terminal' : 'transient'),
    );

    expect(controller.isExhausted()).toBe(false);
    expect(controller.isTerminal()).toBe(false);

    await controller.submit(request({ sessionId: 'ok-session' }));
    expect(controller.isExhausted()).toBe(false);
    expect(controller.isTerminal()).toBe(false);

    await controller.submit(request({ sessionId: 'bad-session' }));
    expect(controller.isExhausted()).toBe(true);
    expect(controller.isTerminal()).toBe(true);
    // Per-session queries still distinguish which one is actually terminal.
    expect(controller.isTerminal('ok-session')).toBe(false);
    expect(controller.isTerminal('bad-session')).toBe(true);
  });

  it('an older attempt that fails after being superseded never resurrects over the newer, already-successful submission', async () => {
    const aGate = deferred<void>();
    const calls: string[] = [];
    const controller = createRevisionOperationController(async (req) => {
      calls.push(req.content);
      if (req.content === 'v1') {
        await aGate.promise;
        throw new Error('disk unavailable');
      }
    });

    // B is submitted while A's attempt is already claimed and in flight —
    // B's own attempt is chained behind A's, not concurrent with it.
    const first = controller.submit(request({ content: 'v1', contentHash: 'hash-v1' }));
    const second = controller.submit(request({ content: 'v2', contentHash: 'hash-v2' }));

    aGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(true); // A's failure is discarded, not surfaced as its own failure
    expect(secondResult).toBe(true); // B succeeded
    expect(calls).toEqual(['v1', 'v2']);
    // The crucial assertion: A's stale failure must never resurrect a
    // pending retry now that B has already succeeded for this session.
    expect(controller.hasPending('s1')).toBe(false);
  });

  it('an entry invalidated while queued behind another in-flight attempt for the same session never calls execute, even though it would have succeeded', async () => {
    const gate = deferred<void>();
    const calls: string[] = [];
    const controller = createRevisionOperationController(async (req) => {
      calls.push(req.content);
      if (req.content === 'blocker') await gate.promise;
    });

    const blocker = controller.submit(request({ content: 'blocker' }));
    // Let blocker's attempt actually reach its own execute() call (and
    // start awaiting the gate) before queuing anything else behind it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['blocker']);

    const stale = controller.submit(request({ content: 'stale' }));

    // Invalidated while "stale" is still queued behind "blocker"'s
    // in-flight attempt — it hasn't even reached its own execute() call.
    controller.invalidate('s1');

    gate.resolve();
    const [blockerResult, staleResult] = await Promise.all([blocker, stale]);

    expect(blockerResult).toBe(true);
    expect(staleResult).toBe(true); // invalidated counts as safe
    // The crucial assertion: execute() must never have been called for the
    // invalidated entry at all — not merely have its *failure* discarded.
    expect(calls).toEqual(['blocker']);
    expect(controller.hasPending('s1')).toBe(false);
  });

  it('a submit for a session already in flight waits for it instead of assuming nothing is pending', async () => {
    const gate = deferred<void>();
    let callCount = 0;
    const controller = createRevisionOperationController(async () => {
      callCount += 1;
      await gate.promise;
    });

    const first = controller.submit(request());
    const second = controller.flush();

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);
    expect(callCount).toBe(1);
  });

  it('hasAutoRetryableWork() stays true for a still-retryable session even while a different session is terminal', async () => {
    const controller = createRevisionOperationController(
      async (req) => {
        throw new Error(req.sessionId === 'bad-session' ? 'hash mismatch' : 'disk unavailable');
      },
      3,
      (error) => (error instanceof Error && error.message === 'hash mismatch' ? 'terminal' : 'transient'),
    );

    await controller.submit(request({ sessionId: 'bad-session' }));
    expect(controller.isTerminal()).toBe(true);
    expect(controller.hasAutoRetryableWork()).toBe(false); // nothing else pending yet

    await controller.submit(request({ sessionId: 'ok-session' }));
    expect(controller.isTerminal()).toBe(true); // still true — 'bad-session' didn't go anywhere
    // The crucial assertion: 'ok-session' is still auto-retryable even
    // though a *different* session is terminal.
    expect(controller.hasAutoRetryableWork()).toBe(true);
  });

  it('hasAutoRetryableWork() is false once a session is exhausted, even though it remains pending', async () => {
    const controller = createRevisionOperationController(
      async () => {
        throw new Error('disk unavailable');
      },
      1,
    );

    await controller.submit(request()); // attempt 1
    expect(controller.hasAutoRetryableWork()).toBe(true);
    await controller.retry(); // attempt 2 > bound of 1 — exhausted
    expect(controller.isExhausted('s1')).toBe(true);
    expect(controller.hasPending('s1')).toBe(true);
    expect(controller.hasAutoRetryableWork()).toBe(false);
  });
});
