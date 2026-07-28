// A minimal FIFO async task queue. Operations run strictly in the order
// they were enqueued — a slow earlier operation is always awaited before
// a later one starts — and a failure in one operation never blocks the
// ones queued after it.
//
// Used in App.svelte to serialize every repository write (session saves
// *and* deletes) against a single queue. That ordering guarantee is what
// makes it safe to delete data at all: without it, a session save that
// was already in flight when a delete-all fires could still land after
// the delete completes, silently recreating the very data the user just
// asked to remove. Routing deletes through the same queue means they
// always run after anything already pending, never before it.

export interface TaskQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
}

export function createTaskQueue(): TaskQueue {
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = tail.then(operation);
    // Keep the chain alive regardless of whether this task succeeded, so
    // one failure doesn't stall everything queued after it. The caller
    // still sees the real outcome via the returned `task` promise.
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  return { enqueue };
}
