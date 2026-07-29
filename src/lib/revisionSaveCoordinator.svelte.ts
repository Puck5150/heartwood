// Owns everything App.svelte previously had to manage by hand around the
// background revision-snapshot system: the underlying
// revisionOperationController instance, the bounded-auto-retry *timer*,
// the visible failure banner's reactive status, invalidation, tracking
// every revision-producing promise from its intent boundary, and the
// window-close flush sequence. App.svelte's own job shrinks to calling
// these methods at the right lifecycle moments and rendering `status`.
//
// Four corrections this module exists to close, beyond what
// revisionOperationController.ts already guarantees on its own:
//
// 1. Deletion exclusive with creation, by discarding — not deferring.
//    deleteHistory() marks its session "being deleted" for the delete's
//    entire duration (including while the native command is in flight in
//    the shared write queue). Any submit() whose token was captured while
//    that mark is set is discarded outright, the same instant it's
//    attempted — never queued to run once the deletion settles. Only a
//    submit() whose *token* was captured after deleteHistory() has fully
//    resolved is genuinely new and proceeds normally (see point 2 for what
//    the token is and why plain "session id" isn't precise enough).
//
// 2. Producers are invalidated before they ever reach the controller.
//    beginIntent(sessionId) hands a producer a generation snapshot at its
//    true intent boundary — before it does any of its own note-flush,
//    hashing, or dedup-lookup work — and submit(token, request) checks
//    that snapshot against the *current* generation right before ever
//    calling the controller. invalidate(sessionId)/invalidate() bump
//    those same generations. Without this, a producer already in flight
//    when a session (or everything) is invalidated has no way to observe
//    that: revisionOperationController's own generation check only
//    protects an entry that already reached `pending`, not a producer
//    still doing its own prep work with no controller entry yet.
//
// 3. Status flags are independent, not a priority `if`/`else if` chain.
//    integrityIssue, failing, and needsManualRetry are each computed from
//    their own controller query — a terminal failure for one session can
//    make integrityIssue true without ever forcing failing/needsManualRetry
//    false for a *different*, still-exhausted-but-transient session. The
//    notice only uses integrityIssue for *display priority* (which message
//    reads first), never to hide the other's Retry action.
//
// 4. Window-close is one sealed loop, not a fixed sequence. flushForClose()
//    itself owns draining producers, flushing the controller, *and*
//    draining the shared write queue, re-scanning after every full pass:
//    settling a producer can itself add new controller work, and a new
//    producer could in principle be tracked while a pass is still running.
//    It only reports back once a full producers→controller→queue pass
//    leaves zero producers behind, so nothing can slip in between the last
//    scan and the caller actually closing the window.

import {
  createRevisionOperationController,
  type RevisionFailureKind,
} from './revisionOperationController';
import type { CreateRevisionRequest } from './revisions';
import type { DeleteOutcome } from './notes';
import type { TaskQueue } from './taskQueue';

export interface RevisionSaveStatus {
  /** True whenever some session has pending, non-terminal revision work —
   * still auto-retrying, or exhausted and awaiting a manual retry. */
  failing: boolean;
  /** True once that pending work has exceeded the automatic-retry bound —
   * the notice shows a manual "Retry" action instead of "Retrying…".
   * Independent of integrityIssue — see this module's doc, point 3. */
  needsManualRetry: boolean;
  /** True once some session's revision failure has been classified
   * terminal (a data-integrity problem). Takes display priority over the
   * other two flags, but never suppresses them for a different session. */
  integrityIssue: boolean;
}

/** A generation snapshot captured at a producer's intent boundary — see
 * beginIntent(). Opaque to callers; pass it straight through to submit(). */
export interface RevisionIntentToken {
  sessionId: string;
  generation: number;
  sessionGeneration: number;
}

export interface RevisionSaveCoordinator {
  /** Captures the current generation for `sessionId` (and globally) at a
   * producer's intent boundary — call this before any of the producer's
   * own note-flush/hashing/lookup work begins, and pass the result to
   * submit() once it's ready. See this module's doc, point 2. */
  beginIntent(sessionId: string): RevisionIntentToken;
  /** Submits one revision request — an automatic snapshot or a manual
   * checkpoint. Discarded outright (never deferred) if `token`'s session
   * has been invalidated (by name or globally) or is currently mid-
   * deleteHistory() since the token was captured. Never rejects. */
  submit(token: RevisionIntentToken, request: CreateRevisionRequest): Promise<boolean>;
  /** Deletes `sessionId`'s revision history, exclusive with revision
   * creation for that session for the deletion's entire duration,
   * regardless of whether the delete itself succeeds. A submit() whose
   * token is captured strictly after this resolves is unaffected and
   * behaves as a genuinely new request. Rethrows whatever the underlying
   * delete throws — callers decide how to surface that. */
  deleteHistory(sessionId: string): Promise<DeleteOutcome>;
  /** Invalidates one session's pending/retryable request and bumps its
   * intent generation (its whole session was deleted), or does both
   * globally when called with no argument (delete-all). Unlike
   * deleteHistory(), this never resolves back to "genuinely new" for the
   * same session — a deleted session has no such case to protect. */
  invalidate(sessionId?: string): void;
  /** Tracks `promise` as an in-flight revision "producer" from the moment
   * it's created. Returns the same promise unchanged so callers can still
   * await/chain it normally. flushForClose() waits for every currently-
   * tracked producer before flushing (see this module's doc, point 4). */
  trackProducer<T>(promise: Promise<T>): Promise<T>;
  /** Manual/automatic bulk retry of every session's pending/retryable
   * request. Never rejects. */
  retry(): Promise<boolean>;
  /** Window-close sequence — see this module's doc, point 4. Never
   * rejects. */
  flushForClose(): Promise<boolean>;
  /** Reactive status for the failure notice. */
  readonly status: RevisionSaveStatus;
}

const DEFAULT_RETRY_DELAY_MS = 3000;

export function createRevisionSaveCoordinator(options: {
  writeQueue: TaskQueue;
  createRevision: (request: CreateRevisionRequest) => Promise<unknown>;
  deleteRevisionHistory: (sessionId: string) => Promise<DeleteOutcome>;
  maxAutoRetries?: number;
  retryDelayMs?: number;
  classifyFailure?: (error: unknown) => RevisionFailureKind;
}): RevisionSaveCoordinator {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const controller = createRevisionOperationController(
    async (request) => {
      await options.writeQueue.enqueue(() => options.createRevision(request));
    },
    options.maxAutoRetries,
    options.classifyFailure,
  );

  const status = $state<RevisionSaveStatus>({
    failing: false,
    needsManualRetry: false,
    integrityIssue: false,
  });
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  // Every currently in-flight revision-producing promise, tracked from its
  // intent boundary (this module's doc, point 4).
  const producers = new Set<Promise<unknown>>();
  // Session ids currently mid-deleteHistory() — checked by submit() to
  // discard (not defer) anything attempted during that window (point 1).
  const sessionsBeingDeleted = new Set<string>();
  // Intent generations a producer's token is checked against (point 2) —
  // separate from revisionOperationController's own internal generations,
  // which only ever see a request *after* submit() calls in. Bumped by the
  // exact same invalidate() calls, so both layers always agree.
  let generation = 0;
  const sessionGenerations = new Map<string, number>();

  function currentSessionGeneration(sessionId: string): number {
    return sessionGenerations.get(sessionId) ?? 0;
  }

  function clearRetryTimer() {
    if (retryTimeout !== null) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
  }

  /** Single source of truth for the notice's visible state, recomputed
   * after every submit/retry/invalidate/deleteHistory. Each flag is its
   * own independent controller query (this module's doc, point 3) — none
   * of them are set inside an `if`/`else` chain that could suppress
   * another session's still-relevant state. */
  function refreshStatus() {
    status.integrityIssue = controller.isTerminal();
    const autoRetryable = controller.hasAutoRetryableWork();
    const exhausted = controller.hasExhaustedNonTerminalWork();
    status.failing = autoRetryable || exhausted;
    status.needsManualRetry = exhausted;
    if (autoRetryable && retryTimeout === null) {
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        void retry();
      }, retryDelayMs);
    }
  }

  function beginIntent(sessionId: string): RevisionIntentToken {
    return { sessionId, generation, sessionGeneration: currentSessionGeneration(sessionId) };
  }

  async function submit(token: RevisionIntentToken, request: CreateRevisionRequest): Promise<boolean> {
    if (
      sessionsBeingDeleted.has(token.sessionId) ||
      token.generation !== generation ||
      token.sessionGeneration !== currentSessionGeneration(token.sessionId)
    ) {
      // Invalidated (this session's history deleted, the whole session
      // deleted, or delete-all) since this producer's intent began, or a
      // deletion is running for it right now — discarded outright, before
      // ever reaching the operation controller with it.
      return true;
    }
    const ok = await controller.submit(request);
    refreshStatus();
    return ok;
  }

  async function deleteHistory(sessionId: string): Promise<DeleteOutcome> {
    controller.invalidate(sessionId);
    sessionGenerations.set(sessionId, currentSessionGeneration(sessionId) + 1);
    refreshStatus();
    sessionsBeingDeleted.add(sessionId);
    try {
      return await options.writeQueue.enqueue(() => options.deleteRevisionHistory(sessionId));
    } finally {
      // Runs whether the delete succeeded or threw — a request scheduled
      // before or during this attempt must never survive it either way
      // (this module's doc, point 1).
      controller.invalidate(sessionId);
      sessionGenerations.set(sessionId, currentSessionGeneration(sessionId) + 1);
      refreshStatus();
      sessionsBeingDeleted.delete(sessionId);
    }
  }

  function invalidate(sessionId?: string): void {
    controller.invalidate(sessionId);
    if (sessionId === undefined) {
      generation += 1;
    } else {
      sessionGenerations.set(sessionId, currentSessionGeneration(sessionId) + 1);
    }
    refreshStatus();
  }

  function trackProducer<T>(promise: Promise<T>): Promise<T> {
    producers.add(promise);
    promise.finally(() => producers.delete(promise));
    return promise;
  }

  async function retry(): Promise<boolean> {
    clearRetryTimer();
    status.needsManualRetry = false;
    const ok = await controller.retry();
    refreshStatus();
    return ok;
  }

  async function flushForClose(): Promise<boolean> {
    clearRetryTimer();
    let ok = true;
    // One sealed loop: drain every tracked producer, flush the controller,
    // drain the shared queue, then check whether anything slipped in
    // during that exact pass (a new producer tracked while flushing or
    // draining) before ever reporting back — see this module's doc,
    // point 4.
    for (;;) {
      for (;;) {
        const inFlight = [...producers];
        if (inFlight.length === 0) break;
        await Promise.allSettled(inFlight);
      }
      ok = await controller.flush();
      await options.writeQueue.drain();
      if (producers.size === 0) break;
    }
    refreshStatus();
    return ok;
  }

  return {
    beginIntent,
    submit,
    deleteHistory,
    invalidate,
    trackProducer,
    retry,
    flushForClose,
    status,
  };
}
