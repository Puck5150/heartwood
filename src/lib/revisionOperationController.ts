// Pending-automatic-revision bookkeeping, modeled directly on
// noteSaveController.ts's proven race-safety (see that module's own doc for
// the full rationale). The two closed races are identical in shape:
//
// 1. A create-revision request can already be enqueued (past the point
//    where invalidate() could cancel it) when its session's revision
//    history is deleted. If it then fails and naively repopulates itself
//    for retry, a later retry()/flush() would try to resurrect a revision
//    for history that's since been cleared. Closed by a *per-session
//    generation token* (`sessionGenerations`), not a permanent
//    denylist-by-id: unlike a whole session row, deleting revision history
//    never deletes the session itself, so the exact same session id can
//    (and routinely does — another checkpoint, another automatic snapshot)
//    submit perfectly valid new requests afterward. Each entry captures its
//    session's generation at submit() time; invalidate(sessionId) bumps
//    that counter. A later failure only discards the entry if the
//    session's *current* generation has moved past what it captured —
//    i.e. an invalidate() truly happened *after* this exact request was
//    scheduled — so a fresh submit() made after that invalidate() (which
//    captures the *new*, bumped generation) is never mistaken for the
//    stale one and behaves with completely normal bounded-retry semantics.
//    The global (no-argument) `generation` counter below is the delete-all
//    analog and was always a counter, never a permanent set.
// 2. A no-arg retry()/flush() call must not snapshot its target session list
//    once — an edit scheduled (submit() called) while that same call is
//    still awaiting an earlier batch must still be picked up before the
//    call resolves, without either double-attempting a session a
//    concurrently-running call already claimed, or tight-looping a retry of
//    something that just failed within this same call. See
//    noteSaveController.ts's flush() for the full reasoning behind the
//    seq/attemptedSeq/refcounted-shared-round design reused verbatim here.
//
// Two more invariants, closed by attemptOnce() specifically:
// - isValid() is checked *before* execute() runs, not only in the catch
//   branch — an entry invalidated before its own attempt ever starts must
//   never touch storage at all, regardless of whether that attempt would
//   have succeeded.
// - `latestSeq` (per session, updated unconditionally by submit(), never
//   cleared by a claim or a retry repopulation) is what a retry
//   repopulation checks itself against — not `!pending.has(sessionId)`.
//   Claiming an entry (flushSession's pending.delete()) happens
//   synchronously, long before that entry's own attempt actually settles,
//   so `pending`'s contents alone can't tell "nothing newer was ever
//   submitted" apart from "something newer was submitted and is already in
//   flight, or has already succeeded" — exactly the gap that would
//   otherwise let an older failed attempt's retry resurrect stale content
//   over a newer, already-successful submission for the same session.
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
  /** Invalidates one session's pending/retryable request (its revision
   * history — or the whole session — was deleted), or every one when
   * called with no argument (delete-all). Implemented as a per-session
   * generation bump, not a permanent per-id block: a request *submitted
   * after* this call is completely unaffected and gets normal bounded-retry
   * behavior, even for the exact same session id (deleting revision
   * history never deletes the session itself, so the same id can — and
   * routinely does — submit valid new requests afterward). */
  invalidate(sessionId?: string): void;
  /** Whether `sessionId` currently has an unflushed or retryable request,
   * or — with no argument — whether *any* session does. */
  hasPending(sessionId?: string): boolean;
  /** True once `sessionId`'s pending request has either exceeded the
   * configured automatic-retry bound or been classified terminal — no
   * further automatic retry will happen for it; only a fresh submit() (a
   * new event) or an explicit external action can move it forward. With no
   * argument, true if *any* session is in this state — for a single global
   * "needs manual retry" banner that doesn't track which session. */
  isExhausted(sessionId?: string): boolean;
  /** True once `sessionId`'s pending request has been classified terminal
   * (an integrity failure — retrying the same bytes could never fix it),
   * distinct from merely exhausted-but-still-retryable-in-principle. With
   * no argument, true if *any* session is in this state — for a single
   * global "data integrity" banner that doesn't track which session. */
  isTerminal(sessionId?: string): boolean;
  /** True if any session has pending work that's both non-terminal and
   * not yet exhausted — i.e. genuinely eligible for another automatic
   * retry attempt. Deliberately independent of isTerminal()/isExhausted():
   * a caller scheduling an automatic-retry timer must keep doing so for
   * this even when some *other* session is terminal or already exhausted,
   * so one session's stuck failure never silently stops another's
   * retries. */
  hasAutoRetryableWork(): boolean;
}

const DEFAULT_MAX_AUTO_RETRIES = 3;

interface PendingRevisionEntry {
  request: Readonly<CreateRevisionRequest>;
  generation: number;
  /** This session's own generation counter (see `sessionGenerations`),
   * captured at submit() time — not the same thing as `generation`, which
   * only tracks delete-*all*. A retry repopulation reuses the original
   * value (matching `generation`'s own repopulation behavior), so it keeps
   * comparing against what was true when this exact request was scheduled. */
  sessionGeneration: number;
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
  // Per-session generation tokens — bumped, never reset, by
  // invalidate(sessionId). Absent means generation 0 (never invalidated).
  const sessionGenerations = new Map<string, number>();
  let scheduleSeq = 0;
  // The most recent seq submit() has handed out *per session*, updated
  // unconditionally — unlike `pending`, this is never cleared by a claim
  // (flushSession's pending.delete()) or a retry repopulation, so it stays
  // the one reliable answer to "is this exact entry still the newest thing
  // submitted for this session" regardless of what pending/chains currently
  // hold. Needed because pending.delete() happens synchronously the moment
  // an entry is *claimed* for an attempt, long before that attempt (or a
  // newer one queued right behind it) actually settles — checking
  // `!pending.has(sessionId)` alone can't tell "nothing newer was ever
  // submitted" apart from "something newer was submitted and is already
  // in flight (or has already succeeded)", which is exactly the gap that let
  // an older failed attempt's retry repopulation resurrect stale content
  // over a newer, already-successful submission for the same session.
  const latestSeq = new Map<string, number>();

  function currentSessionGeneration(sessionId: string): number {
    return sessionGenerations.get(sessionId) ?? 0;
  }

  function isValid(sessionId: string, savedGeneration: number, savedSessionGeneration: number): boolean {
    return savedGeneration === generation && savedSessionGeneration === currentSessionGeneration(sessionId);
  }

  function invalidate(sessionId?: string): void {
    if (sessionId === undefined) {
      generation += 1;
      pending.clear();
    } else {
      sessionGenerations.set(sessionId, currentSessionGeneration(sessionId) + 1);
      pending.delete(sessionId);
    }
  }

  function hasPending(sessionId?: string): boolean {
    return sessionId === undefined ? pending.size > 0 : pending.has(sessionId);
  }

  function isExhausted(sessionId?: string): boolean {
    if (sessionId !== undefined) {
      const entry = pending.get(sessionId);
      if (!entry) return false;
      return entry.terminal || entry.attempt > maxAutoRetries;
    }
    return [...pending.values()].some((entry) => entry.terminal || entry.attempt > maxAutoRetries);
  }

  function isTerminal(sessionId?: string): boolean {
    if (sessionId !== undefined) return pending.get(sessionId)?.terminal ?? false;
    return [...pending.values()].some((entry) => entry.terminal);
  }

  function hasAutoRetryableWork(): boolean {
    return [...pending.values()].some((entry) => !entry.terminal && entry.attempt <= maxAutoRetries);
  }

  async function attemptOnce(sessionId: string, entry: PendingRevisionEntry): Promise<boolean> {
    if (!isValid(sessionId, entry.generation, entry.sessionGeneration)) {
      // Invalidated (delete-all, or this session's history deleted) before
      // this attempt ever started — never touch storage for it at all,
      // regardless of whether it later would have succeeded or failed.
      return true;
    }
    try {
      await execute(entry.request);
      return true;
    } catch (error) {
      if (!isValid(sessionId, entry.generation, entry.sessionGeneration)) {
        // Invalidated (delete-all, or this session's history deleted)
        // while this request was in flight — nothing to retry, and
        // nothing should be resurrected.
        return true;
      }
      // A newer request for this exact session, submitted since this one
      // started, owns this session's pending slot now (whether it's
      // already succeeded or is still in flight behind this one in the
      // chain) — checked against `latestSeq`, not `pending`/`chains`,
      // since a newer submission claims (and removes from `pending`) its
      // own entry synchronously long before its own attempt settles. This
      // stale failure must never resurrect over it.
      if (entry.seq !== (latestSeq.get(sessionId) ?? entry.seq)) {
        return true;
      }
      const kind = classifyFailure(error);
      if (kind !== 'transient') {
        if (!pending.has(sessionId)) pending.set(sessionId, { ...entry, terminal: true });
        return false;
      }
      const nextAttempt = entry.attempt + 1;
      // Only repopulate if nothing newer has been submitted for this exact
      // session in the meantime (submit() always wins over a stale retry;
      // isCurrent() above already guarantees that here). Reuses entry.seq,
      // not a fresh one — this is a retry of the same event, not a new one.
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
      // A terminal entry is deliberately excluded from `targets` above (it's
      // never auto-retried), so it would otherwise never appear in
      // `results` at all — e.g. if it was the *only* pending entry, the
      // loop above runs zero iterations and `[].every(Boolean)` is
      // vacuously true. Checked separately so flush()/retry() correctly
      // report false while any terminal (unresolved integrity) entry
      // remains pending, e.g. to keep a window-close blocked on it.
      return results.every(Boolean) && !isTerminal();
    } finally {
      activeRounds -= 1;
      if (activeRounds === 0) sharedAttemptedSeq = null;
    }
  }

  async function submit(request: CreateRevisionRequest): Promise<boolean> {
    scheduleSeq += 1;
    latestSeq.set(request.sessionId, scheduleSeq);
    pending.set(request.sessionId, {
      request: Object.freeze({ ...request }),
      generation,
      sessionGeneration: currentSessionGeneration(request.sessionId),
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
    isTerminal,
    hasAutoRetryableWork,
  };
}
