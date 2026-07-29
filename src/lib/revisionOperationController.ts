// Pending-automatic-revision bookkeeping, modeled directly on
// noteSaveController.ts's proven race-safety (see that module's own doc for
// the full rationale). The two closed races are identical in shape:
//
// 1. A create-revision request can already be enqueued (past the point
//    where invalidate() could cancel it) when its session is deleted. If it
//    then fails and naively repopulates itself for retry, a later retry()/
//    flush() would try to create a revision for a session that no longer
//    exists. `generation`/`invalidatedSessionIds` close this exactly like
//    noteSaveController's do.
// 2. A no-arg retry()/flush() call must not snapshot its target session list
//    once — an edit scheduled (submit() called) while that same call is
//    still awaiting an earlier batch must still be picked up before the
//    call resolves, without either double-attempting a session a
//    concurrently-running call already claimed, or tight-looping a retry of
//    something that just failed within this same call. See
//    noteSaveController.ts's flush() for the full reasoning behind the
//    seq/attemptedSeq/refcounted-shared-round design reused verbatim here.
//
// Unlike noteSaveController, a failure is classified only as `transient`
// (bounded auto-retry, then exhausted-but-still-pending for manual retry)
// or `terminal` (e.g. the retained bytes don't hash to the retained
// expected hash — an integrity problem, not something retrying the same
// bytes could ever fix). A terminal entry remains pending — surfaced via
// hasPending()/isExhausted() so the caller can show a blocking error — but
// is never included in a bulk retry()/flush() round. Submitting a fresh
// request for the same session (a genuinely new event, not a retry of the
// same bytes) always supersedes it.

import type { CreateRevisionRequest } from './revisions';

export type RevisionFailureKind = 'transient' | 'terminal';

export interface RevisionOperationController {
  /** Retains `request` (replacing any earlier unflushed request for the
   * same session) and attempts it immediately. Resolves to whether that
   * attempt succeeded, was a no-op success (native-side dedup), or was
   * invalidated — never rejects. */
  submit(request: CreateRevisionRequest): Promise<boolean>;
  /** Re-attempts every session's pending/retryable request. Never rejects. */
  retry(): Promise<boolean>;
  /** Identical to retry() — see this module's doc for why a single
   * implementation correctly serves both the manual/auto-retry case and
   * the window-close-blocking case. */
  flush(): Promise<boolean>;
  /** Invalidates one session's pending/retryable request (it was deleted),
   * or every one when called with no argument (delete-all). A request
   * submitted *after* this call is unaffected. */
  invalidate(sessionId?: string): void;
  /** Whether `sessionId` currently has an unflushed or retryable request,
   * or — with no argument — whether *any* session does. */
  hasPending(sessionId?: string): boolean;
  /** True once `sessionId`'s pending request has either exceeded the
   * configured automatic-retry bound or been classified terminal — no
   * further automatic retry will happen for it; only a fresh submit() (a
   * new event) or an explicit external action can move it forward. */
  isExhausted(sessionId: string): boolean;
}

const DEFAULT_MAX_AUTO_RETRIES = 3;

interface PendingRevisionEntry {
  request: Readonly<CreateRevisionRequest>;
  generation: number;
  attempt: number;
  /** Monotonic, bumped only by submit() — lets a no-arg retry()/flush()
   * loop tell a genuinely new request (submitted while this same call is
   * still awaiting something else) apart from an entry attemptOnce() just
   * repopulated after a failure, matching noteSaveController.ts's `seq`. */
  seq: number;
  /** Set once classifyFailure() reports a non-transient error for this
   * entry. Kept pending (for hasPending()/isExhausted() visibility) but
   * excluded from every future bulk retry()/flush() round. */
  terminal: boolean;
}

const DEFAULT_CLASSIFY_FAILURE = (): RevisionFailureKind => 'transient';

export function createRevisionOperationController(
  execute: (request: CreateRevisionRequest) => Promise<void>,
  maxAutoRetries = DEFAULT_MAX_AUTO_RETRIES,
  classifyFailure: (error: unknown) => RevisionFailureKind = DEFAULT_CLASSIFY_FAILURE,
): RevisionOperationController {
  const pending = new Map<string, PendingRevisionEntry>();
  // One flush chain per session id, so a call already in flight for that
  // session is always waited on by a later call rather than assumed done.
  const chains = new Map<string, Promise<boolean>>();
  let generation = 0;
  const invalidatedSessionIds = new Set<string>();
  let scheduleSeq = 0;

  function isValid(sessionId: string, savedGeneration: number): boolean {
    return savedGeneration === generation && !invalidatedSessionIds.has(sessionId);
  }

  function invalidate(sessionId?: string): void {
    if (sessionId === undefined) {
      generation += 1;
      pending.clear();
    } else {
      invalidatedSessionIds.add(sessionId);
      pending.delete(sessionId);
    }
  }

  function hasPending(sessionId?: string): boolean {
    return sessionId === undefined ? pending.size > 0 : pending.has(sessionId);
  }

  function isExhausted(sessionId: string): boolean {
    const entry = pending.get(sessionId);
    if (!entry) return false;
    return entry.terminal || entry.attempt > maxAutoRetries;
  }

  async function attemptOnce(sessionId: string, entry: PendingRevisionEntry): Promise<boolean> {
    try {
      await execute(entry.request);
      return true;
    } catch (error) {
      if (!isValid(sessionId, entry.generation)) {
        // Deleted while this request was in flight — nothing to retry,
        // and nothing should be resurrected.
        return true;
      }
      const kind = classifyFailure(error);
      if (kind !== 'transient') {
        if (!pending.has(sessionId)) pending.set(sessionId, { ...entry, terminal: true });
        return false;
      }
      const nextAttempt = entry.attempt + 1;
      // Only repopulate if nothing newer has been submitted for this exact
      // session in the meantime (submit() always wins over a stale retry).
      // Reuses entry.seq, not a fresh one — this is a retry of the same
      // event, not a new one.
      if (!pending.has(sessionId)) {
        pending.set(sessionId, { ...entry, attempt: nextAttempt });
      }
      return false;
    }
  }

  function flushSession(sessionId: string): Promise<boolean> {
    const entry = pending.get(sessionId);
    if (!entry) {
      // Nothing new to claim for this session — wait for whatever's
      // already in flight for it, if anything, instead of assuming
      // there's nothing to do.
      return chains.get(sessionId) ?? Promise.resolve(true);
    }
    // Claim synchronously, before any awaiting happens, so a second call
    // made in the same tick (e.g. for a different session) can never see
    // — and re-claim — this same entry.
    pending.delete(sessionId);
    const previous = chains.get(sessionId) ?? Promise.resolve(true);
    const next = previous.then(() => attemptOnce(sessionId, entry));
    chains.set(sessionId, next);
    next.finally(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId);
    });
    return next;
  }

  // Shared by every *currently overlapping* no-arg retry()/flush() call —
  // see noteSaveController.ts's flush() for the full reasoning. Recreated
  // fresh once no round is in flight, so a later, non-overlapping call
  // still starts from a clean slate and can retry whatever's still pending.
  let sharedAttemptedSeq: Map<string, number> | null = null;
  let activeRounds = 0;

  async function attemptAllPending(): Promise<boolean> {
    const attemptedSeq = sharedAttemptedSeq ?? new Map<string, number>();
    sharedAttemptedSeq = attemptedSeq;
    activeRounds += 1;
    try {
      const results: boolean[] = [];
      for (;;) {
        const ids = new Set([...pending.keys(), ...chains.keys()]);
        const targets = [...ids].filter((id) => {
          const current = pending.get(id);
          if (!current) return true; // in-flight only; flushSession() shares the existing promise
          if (current.terminal) return false; // never auto-retry an integrity failure
          return (attemptedSeq.get(id) ?? -1) < current.seq;
        });
        if (targets.length === 0) break;
        for (const id of targets) {
          const current = pending.get(id);
          if (current) attemptedSeq.set(id, current.seq);
        }
        const batch = await Promise.all(targets.map((id) => flushSession(id)));
        results.push(...batch);
      }
      return results.every(Boolean);
    } finally {
      activeRounds -= 1;
      if (activeRounds === 0) sharedAttemptedSeq = null;
    }
  }

  async function submit(request: CreateRevisionRequest): Promise<boolean> {
    scheduleSeq += 1;
    pending.set(request.sessionId, {
      request: Object.freeze({ ...request }),
      generation,
      attempt: 0,
      seq: scheduleSeq,
      terminal: false,
    });
    return flushSession(request.sessionId);
  }

  return {
    submit,
    retry: attemptAllPending,
    flush: attemptAllPending,
    invalidate,
    hasPending,
    isExhausted,
  };
}
