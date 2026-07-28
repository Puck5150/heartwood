// Pure(ish) bookkeeping for the note-autosave-vs-deletion race: a note save
// that failed and is waiting to retry must never be allowed to resurrect a
// note for a session (or for everything, after delete-all) that was deleted
// while that save was in flight. The only side effect this module performs
// is calling the injected `save` function — no timers, no direct repository
// or DOM access — so the invalidation logic is unit-testable without a real
// clock or a Svelte component. App.svelte owns the actual debounce/auto-retry
// *timing* (setTimeout) and calls schedule()/flush()/invalidate() at the
// right moments.
//
// The race this exists to close: a save can already be enqueued (past the
// point where invalidate() could cancel it) when its session is deleted. If
// it then fails and naively repopulates itself for a retry, a later flush —
// another debounce tick, a blur, or window close — would write a note back
// for a session that no longer exists. `generation` and
// `invalidatedSessionIds` record *what's been deleted since this particular
// save was scheduled*, checked again at the moment of failure (not just at
// schedule time), so it doesn't matter whether the delete's invalidate()
// call lands before, during, or after the save's own failure.

export interface NoteSaveFlushResult {
  /** True if the save succeeded, there was nothing pending, or the pending
   * save was invalidated (its session/everything was deleted) — in every
   * one of these cases it's safe to proceed, e.g. to let a window close. */
  ok: boolean;
  /** True only when a real, still-relevant failure occurred: not invalidated. */
  invalidated: boolean;
  /** How many consecutive failures the current content has now hit. 0 after
   * a success or when invalidated. */
  attempt: number;
  /** True once `attempt` has exceeded the configured bound — the caller
   * should stop auto-retrying and offer a manual retry action instead. */
  exhausted: boolean;
}

export interface NoteSaveController {
  /** Records new content to autosave for `sessionId`, replacing any earlier
   * unflushed content for it and resetting the retry count. */
  schedule(sessionId: string, content: string): void;
  /** Attempts to persist whatever's currently pending. Never rejects. */
  flush(): Promise<NoteSaveFlushResult>;
  /** Invalidates one session's pending/retryable save (it was deleted), or
   * every pending/retryable save regardless of session id when called with
   * no argument (delete-all). A save scheduled *after* this call is
   * unaffected — invalidation only applies to what was already scheduled. */
  invalidate(sessionId?: string): void;
  /** Whether a save is currently waiting to be flushed or retried. */
  hasPending(): boolean;
}

const DEFAULT_MAX_AUTO_RETRIES = 3;

export function createNoteSaveController(
  save: (sessionId: string, content: string) => Promise<void>,
  maxAutoRetries = DEFAULT_MAX_AUTO_RETRIES,
): NoteSaveController {
  let pending: { sessionId: string; content: string; generation: number } | null = null;
  let attempt = 0;
  let generation = 0;
  const invalidatedSessionIds = new Set<string>();

  function isValid(sessionId: string, savedGeneration: number): boolean {
    return savedGeneration === generation && !invalidatedSessionIds.has(sessionId);
  }

  function schedule(sessionId: string, content: string): void {
    pending = { sessionId, content, generation };
    attempt = 0;
  }

  function invalidate(sessionId?: string): void {
    if (sessionId === undefined) {
      generation += 1;
    } else {
      invalidatedSessionIds.add(sessionId);
    }
    if (pending && (sessionId === undefined || pending.sessionId === sessionId)) {
      pending = null;
      attempt = 0;
    }
  }

  function hasPending(): boolean {
    return pending !== null;
  }

  async function flush(): Promise<NoteSaveFlushResult> {
    if (!pending) return { ok: true, invalidated: false, attempt: 0, exhausted: false };
    const { sessionId, content, generation: savedGeneration } = pending;
    pending = null;
    try {
      await save(sessionId, content);
      attempt = 0;
      return { ok: true, invalidated: false, attempt: 0, exhausted: false };
    } catch {
      if (!isValid(sessionId, savedGeneration)) {
        // Deleted while this save was in flight — nothing to retry, and
        // nothing should be resurrected.
        return { ok: true, invalidated: true, attempt: 0, exhausted: false };
      }
      attempt += 1;
      if (!pending) pending = { sessionId, content, generation: savedGeneration };
      return { ok: false, invalidated: false, attempt, exhausted: attempt > maxAutoRetries };
    }
  }

  return { schedule, flush, invalidate, hasPending };
}
