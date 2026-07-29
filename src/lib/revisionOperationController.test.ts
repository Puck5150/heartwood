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
});
