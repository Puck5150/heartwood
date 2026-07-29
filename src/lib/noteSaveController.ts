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
// Pending saves are tracked *per session id* (a Map), not in one shared
// slot. That matters specifically around carrying a note forward: the
// completed session's final flush and the new session's first save are two
// different sessions' writes that can genuinely overlap in time (App.svelte
// prefers to serialize them by awaiting the old flush before scheduling the
// new one, but this module doesn't assume callers always do that — a single
// shared slot would let one session's in-flight failure silently steal or
// discard the other's content the moment both happened to be outstanding at
// once). Each session also gets its own flush chain, so repeated flush()
// calls for the *same* session always wait for whatever's already in
// flight for it instead of assuming there's nothing left to do.
//
// The deletion race this exists to close: a save can already be enqueued
// (past the point where invalidate() could cancel it) when its session is
// deleted. If it then fails and naively repopulates itself for a retry, a
// later flush — another debounce tick, a blur, or window close — would
// write a note back for a session that no longer exists. `generation` and
// `invalidatedSessionIds` record *what's been deleted since this particular
// save was scheduled*, checked again at the moment of failure (not just at
// schedule time), so it doesn't matter whether the delete's invalidate()
// call lands before, during, or after the save's own failure.
//
// Failures are classified (Phase 4B) via an injected `classifyFailure`
// function so this module doesn't need to know about noteStorage.ts's error
// shapes directly. Only a `transient` failure counts against the bounded
// auto-retry budget; `conflict`, `missing`, and `unreadable` are non-
// transient — the draft is kept pending for an explicit user action (a
// conflict's Reload/Keep-mine choice, a missing-file retry) rather than
// being silently retried on a timer, since retrying those automatically
// would either resurrect a stale write over an external edit or paper over
// a file problem the user needs to actually see.

import type { NoteFailureKind } from './noteStorage';

export interface NoteSaveFailure {
  kind: NoteFailureKind;
  error: unknown;
}

export interface NoteSaveFlushResult {
  /** True if the save succeeded, there was nothing pending, or the pending
   * save was invalidated (its session/everything was deleted) — in every
   * one of these cases it's safe to proceed, e.g. to let a window close. */
  ok: boolean;
  /** True only when a real, still-relevant failure occurred: not invalidated. */
  invalidated: boolean;
  /** How many consecutive *transient* failures the current content has now
   * hit. 0 after a success, when invalidated, or for a non-transient
   * failure (those don't count against the auto-retry budget). */
  attempt: number;
  /** True once `attempt` has exceeded the configured bound for a transient
   * failure — the caller should stop auto-retrying and offer a manual
   * retry action instead. Always false for a non-transient failure; those
   * need a specific user decision (reload/keep-mine, or fixing the file),
   * not a generic "retry same thing again". */
  exhausted: boolean;
  /** The classified failure behind a non-ok result, or null on success/
   * invalidation. */
  failure: NoteSaveFailure | null;
}

export interface NoteSaveController {
  /** Records new content to autosave for `sessionId`, replacing any earlier
   * unflushed content for it and resetting its retry count. */
  schedule(sessionId: string, content: string): void;
  /** Flushes the pending save for `sessionId`, or — with no argument —
   * every session currently pending or still in flight. Never rejects. */
  flush(sessionId?: string): Promise<NoteSaveFlushResult>;
  /** Invalidates one session's pending/retryable save (it was deleted), or
   * every pending/retryable save regardless of session id when called with
   * no argument (delete-all). A save scheduled *after* this call is
   * unaffected — invalidation only applies to what was already scheduled. */
  invalidate(sessionId?: string): void;
  /** Discards a session's pending draft (e.g. the user chose "Reload file"
   * over a conflict) *without* marking the session as deleted — unlike
   * invalidate(), a future schedule()/flush() for this same session id
   * behaves completely normally afterward. */
  discard(sessionId: string): void;
  /** Whether `sessionId` currently has an unflushed or retryable edit, or —
   * with no argument — whether *any* session does. */
  hasPending(sessionId?: string): boolean;
}

const DEFAULT_MAX_AUTO_RETRIES = 3;

const OK_RESULT: NoteSaveFlushResult = {
  ok: true,
  invalidated: false,
  attempt: 0,
  exhausted: false,
  failure: null,
};

function worstResult(results: NoteSaveFlushResult[]): NoteSaveFlushResult {
  if (results.length === 1) return results[0];
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    return failures.reduce((worst, r) => (r.attempt > worst.attempt ? r : worst));
  }
  // Every target either succeeded outright or was invalidated (deleted
  // mid-flight) — report invalidated if any was, so a caller relying on
  // that flag (e.g. to skip showing an error) still sees it.
  return results.some((r) => r.invalidated) ? { ...OK_RESULT, invalidated: true } : OK_RESULT;
}

interface SessionEntry {
  content: string;
  generation: number;
  attempt: number;
  /** Monotonic counter bumped only by schedule(), never by a retry
   * repopulation (those preserve the original entry's seq). Lets a no-arg
   * flush() loop tell a genuinely new edit — scheduled by the caller while
   * this same flush() call is still awaiting something else — apart from
   * an entry attemptOnce() just repopulated after a failure, so the former
   * is picked up before this flush() call returns and the latter isn't
   * retried in a tight loop (that's the external auto-retry timer's job,
   * not this call's). */
  seq: number;
}

const DEFAULT_CLASSIFY_FAILURE = (): NoteFailureKind => 'transient';

export function createNoteSaveController(
  save: (sessionId: string, content: string) => Promise<void>,
  maxAutoRetries = DEFAULT_MAX_AUTO_RETRIES,
  classifyFailure: (error: unknown) => NoteFailureKind = DEFAULT_CLASSIFY_FAILURE,
): NoteSaveController {
  const pending = new Map<string, SessionEntry>();
  // One flush chain per session id, so a flush already in flight for that
  // session is always waited on by a later call rather than assumed done.
  const chains = new Map<string, Promise<NoteSaveFlushResult>>();
  let generation = 0;
  const invalidatedSessionIds = new Set<string>();
  let scheduleSeq = 0;

  function isValid(sessionId: string, savedGeneration: number): boolean {
    return savedGeneration === generation && !invalidatedSessionIds.has(sessionId);
  }

  function schedule(sessionId: string, content: string): void {
    scheduleSeq += 1;
    pending.set(sessionId, { content, generation, attempt: 0, seq: scheduleSeq });
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

  function discard(sessionId: string): void {
    pending.delete(sessionId);
  }

  function hasPending(sessionId?: string): boolean {
    return sessionId === undefined ? pending.size > 0 : pending.has(sessionId);
  }

  async function attemptOnce(sessionId: string, entry: SessionEntry): Promise<NoteSaveFlushResult> {
    try {
      await save(sessionId, entry.content);
      return OK_RESULT;
    } catch (error) {
      if (!isValid(sessionId, entry.generation)) {
        // Deleted while this save was in flight — nothing to retry, and
        // nothing should be resurrected.
        return { ok: true, invalidated: true, attempt: 0, exhausted: false, failure: null };
      }
      const kind = classifyFailure(error);
      if (kind !== 'transient') {
        // Non-transient: keep the draft pending for an explicit user
        // decision, but don't count it against the auto-retry budget or
        // mark it exhausted — that framing is specific to "the same retry
        // keeps failing", not "this needs a different kind of resolution".
        if (!pending.has(sessionId)) pending.set(sessionId, entry);
        return { ok: false, invalidated: false, attempt: entry.attempt, exhausted: false, failure: { kind, error } };
      }
      const nextAttempt = entry.attempt + 1;
      // Only repopulate if nothing newer has been scheduled for this exact
      // session in the meantime (schedule() always wins over a stale
      // retry). Reuses entry.seq, not a fresh one — this is a retry of the
      // same edit, not a new one, so a concurrent no-arg flush() loop must
      // not treat it as newly-arrived work to pick up again immediately.
      if (!pending.has(sessionId)) {
        pending.set(sessionId, {
          content: entry.content,
          generation: entry.generation,
          attempt: nextAttempt,
          seq: entry.seq,
        });
      }
      return {
        ok: false,
        invalidated: false,
        attempt: nextAttempt,
        exhausted: nextAttempt > maxAutoRetries,
        failure: { kind: 'transient', error },
      };
    }
  }

  function flushSession(sessionId: string): Promise<NoteSaveFlushResult> {
    const entry = pending.get(sessionId);
    if (!entry) {
      // Nothing new to claim for this session — wait for whatever's
      // already in flight for it, if anything, instead of assuming
      // there's nothing to do. Never fabricates a fresh attempt.
      return chains.get(sessionId) ?? Promise.resolve(OK_RESULT);
    }
    // Claim synchronously, before any awaiting happens, so a second
    // flush() call made in the same tick (e.g. for a different session)
    // can never see — and re-claim — this same entry.
    pending.delete(sessionId);
    const previous = chains.get(sessionId) ?? Promise.resolve(OK_RESULT);
    const next = previous.then(() => attemptOnce(sessionId, entry));
    chains.set(sessionId, next);
    next.finally(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId);
    });
    return next;
  }

  // Shared by every *currently overlapping* no-arg flush() call — see
  // flush() below. Recreated fresh once no no-arg call is in flight, so a
  // later, non-overlapping call (e.g. an external auto-retry timer) still
  // starts from a clean slate and can retry whatever's still pending.
  let sharedAttemptedSeq: Map<string, number> | null = null;
  let activeNoArgFlushes = 0;

  async function flush(sessionId?: string): Promise<NoteSaveFlushResult> {
    if (sessionId !== undefined) {
      return flushSession(sessionId);
    }
    // No-arg: `pending`/`chains` are re-read after every batch, not
    // snapshotted once, so an edit scheduled by the caller while this same
    // call is still awaiting an earlier batch (e.g. the user typing one
    // more character right as a window-close flush is in progress) is
    // still picked up before this call resolves — otherwise it could
    // report ok:true while that edit sits unflushed in `pending`,
    // misleading a caller (like the window-close handler) that treats
    // ok:true as "everything is safely saved".
    //
    // `attemptedSeq` stops this loop from also re-attempting an entry
    // attemptOnce() just repopulated after a failure of *this same* round
    // — that's a retry of the same seq, not new work, and retrying it
    // belongs to the external auto-retry timer, not a tight loop here. It
    // has to be shared (via refcounting, not a fresh Map per call) across
    // every no-arg flush() call *overlapping in time* with this one —
    // App.svelte's carry-forward path and the window-close handler both
    // rely on two concurrent flush() calls never double-attempting a
    // session the other one already claimed. A session with no `pending`
    // entry (already claimed, still in flight) is always safe to include
    // regardless of this bookkeeping: flushSession() shares the existing
    // in-flight promise rather than starting a second attempt, so a
    // sibling call still waits for and reports its real outcome.
    const attemptedSeq = sharedAttemptedSeq ?? new Map<string, number>();
    sharedAttemptedSeq = attemptedSeq;
    activeNoArgFlushes += 1;
    try {
      const results: NoteSaveFlushResult[] = [];
      for (;;) {
        const ids = new Set([...pending.keys(), ...chains.keys()]);
        const targets = [...ids].filter((id) => {
          const current = pending.get(id);
          if (!current) return true;
          return (attemptedSeq.get(id) ?? -1) < current.seq;
        });
        if (targets.length === 0) break;
        // Marked synchronously, before awaiting anything, so a sibling
        // no-arg flush() call started later in this same tick (no `await`
        // in between) sees the mark immediately and won't also target it.
        for (const id of targets) {
          const current = pending.get(id);
          if (current) attemptedSeq.set(id, current.seq);
        }
        const batch = await Promise.all(targets.map((id) => flushSession(id)));
        results.push(...batch);
      }
      if (results.length === 0) return OK_RESULT;
      return worstResult(results);
    } finally {
      activeNoArgFlushes -= 1;
      if (activeNoArgFlushes === 0) sharedAttemptedSeq = null;
    }
  }

  return { schedule, flush, invalidate, discard, hasPending };
}
