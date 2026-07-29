// Owns everything App.svelte previously had to manage by hand around the
// background revision-snapshot system: the underlying
// revisionOperationController instance, the bounded-auto-retry *timer*,
// the visible failure banner's reactive status, invalidation, tracking
// every revision-producing promise from its intent boundary, and the
// window-close flush sequence. App.svelte's own job shrinks to calling
// these methods at the right lifecycle moments and rendering `status`.
//
// Three corrections this module exists to close, beyond what
// revisionOperationController.ts already guarantees on its own:
//
// 1. Deletion exclusive with creation. deleteHistory() raises a per-session
//    barrier for its entire duration (including while the native delete
//    command is in flight in the shared write queue) — any submit() for
//    that same session, whether already queued or newly called, awaits
//    that barrier before ever reaching the controller. That guarantees a
//    request "scheduled during" a history deletion is never merely raced
//    through the queue by timing luck: it's deterministically deferred
//    until the deletion (and its post-delete invalidate()) has actually
//    settled, at which point it's captured against the *new* generation
//    and behaves as a genuinely fresh request — never a permanent block on
//    the session id (see revisionOperationController.ts's invalidate()
//    doc for why deleting history never deletes the session itself).
//
// 2. Producer tracking. trackProducer() records a revision-producing
//    promise (an automatic snapshot or a manual checkpoint) from the exact
//    moment it's created — its "intent boundary" — not from whenever it
//    first happens to call submit(). An automatic snapshot commonly awaits
//    its own note-flush *before* ever calling submit(); without tracking
//    from the intent boundary, flushForClose() could see nothing pending
//    yet and let the window close before that snapshot even attempts its
//    write. flushForClose() waits out every currently-tracked producer
//    first, then flushes the controller, matching noteSaveController.ts's
//    own "re-scan after every batch" pattern in case settling a producer
//    is itself what makes new work pending.
//
// 3. Status aggregation is independent of retry scheduling. A terminal
//    failure for one session takes priority in what the banner *shows*,
//    but must never suppress the automatic-retry timer for a *different*
//    session's still-retryable failure — refreshStatus() always checks
//    hasAutoRetryableWork() after setting the banner's display fields,
//    regardless of which branch set them.

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
   * the notice shows a manual "Retry" action instead of "Retrying…". */
  needsManualRetry: boolean;
  /** True once some session's revision failure has been classified
   * terminal (a data-integrity problem). Takes priority over the other
   * two flags for the notice's own display. */
  integrityIssue: boolean;
}

export interface RevisionSaveCoordinator {
  /** Submits one revision request — an automatic snapshot or a manual
   * checkpoint. Waits out any in-flight deleteHistory() for the same
   * session first (see this module's doc, point 1). Never rejects. */
  submit(request: CreateRevisionRequest): Promise<boolean>;
  /** Deletes `sessionId`'s revision history, exclusive with revision
   * creation for that session for the deletion's entire duration,
   * regardless of whether the delete itself succeeds. A submit() called
   * strictly after this resolves is unaffected and behaves as a genuinely
   * new request. Rethrows whatever the underlying delete throws — callers
   * decide how to surface that. */
  deleteHistory(sessionId: string): Promise<DeleteOutcome>;
  /** Invalidates one session's pending/retryable request (its whole
   * session was deleted), or every one when called with no argument
   * (delete-all). Does not raise the exclusion barrier deleteHistory()
   * does — a deleted session has no "genuinely new request afterward"
   * case to protect the way history-only deletion does. */
  invalidate(sessionId?: string): void;
  /** Tracks `promise` as an in-flight revision "producer" from the moment
   * it's created — see this module's doc, point 2. Returns the same
   * promise unchanged so callers can still await/chain it normally. */
  trackProducer<T>(promise: Promise<T>): Promise<T>;
  /** Manual/automatic bulk retry of every session's pending/retryable
   * request. Never rejects. */
  retry(): Promise<boolean>;
  /** Window-close sequence: waits for every tracked producer to settle,
   * then flushes the controller — see this module's doc, point 2. Never
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
  // intent boundary (see this module's doc, point 2).
  const producers = new Set<Promise<unknown>>();
  // One barrier per session currently mid-deleteHistory() — see submit()'s
  // and deleteHistory()'s docs for why this, not queue-ordering luck, is
  // what makes deletion exclusive with creation (this module's doc, point 1).
  const deletionBarriers = new Map<string, Promise<void>>();

  function clearRetryTimer() {
    if (retryTimeout !== null) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
  }

  /** Single source of truth for the notice's visible state, recomputed
   * after every submit/retry/invalidate/deleteHistory. The banner-priority
   * chain below (integrity > exhausted > retrying > none) only decides
   * *display*; the automatic-retry timer is scheduled independently of it
   * (see this module's doc, point 3), so a terminal failure for one
   * session never stops a different session's automatic retries. */
  function refreshStatus() {
    if (controller.isTerminal()) {
      status.integrityIssue = true;
      status.failing = false;
      status.needsManualRetry = false;
    } else if (!controller.hasPending()) {
      status.integrityIssue = false;
      status.failing = false;
      status.needsManualRetry = false;
    } else {
      status.integrityIssue = false;
      status.failing = true;
      status.needsManualRetry = controller.isExhausted();
    }
    if (controller.hasAutoRetryableWork() && retryTimeout === null) {
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        void retry();
      }, retryDelayMs);
    }
  }

  async function submit(request: CreateRevisionRequest): Promise<boolean> {
    // Re-checked in a loop: a *new* deleteHistory() for this exact session
    // could start for the first time (or start again) while this call was
    // already waiting on an earlier one.
    for (;;) {
      const barrier = deletionBarriers.get(request.sessionId);
      if (!barrier) break;
      await barrier;
    }
    const ok = await controller.submit(request);
    refreshStatus();
    return ok;
  }

  async function deleteHistory(sessionId: string): Promise<DeleteOutcome> {
    controller.invalidate(sessionId);
    refreshStatus();
    let release!: () => void;
    deletionBarriers.set(
      sessionId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      return await options.writeQueue.enqueue(() => options.deleteRevisionHistory(sessionId));
    } finally {
      // Runs whether the delete succeeded or threw — a request scheduled
      // before or during this attempt must never survive it either way
      // (see this module's doc, point 1).
      controller.invalidate(sessionId);
      refreshStatus();
      deletionBarriers.delete(sessionId);
      release();
    }
  }

  function invalidate(sessionId?: string): void {
    controller.invalidate(sessionId);
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
    // Wait for every currently-tracked producer to actually reach the
    // point of calling submit() — otherwise controller.flush() below could
    // see nothing pending yet and let the window close before that
    // producer ever attempts its write. Re-scanned in a loop rather than
    // snapshotted once: settling a producer can itself be what makes new
    // controller work pending, and a new producer could in principle be
    // tracked while this waits (matches noteSaveController.ts's own
    // re-scan-after-every-batch reasoning).
    for (;;) {
      const inFlight = [...producers];
      if (inFlight.length === 0) break;
      await Promise.allSettled(inFlight);
      if (producers.size === 0) break;
    }
    const ok = await controller.flush();
    refreshStatus();
    return ok;
  }

  return {
    submit,
    deleteHistory,
    invalidate,
    trackProducer,
    retry,
    flushForClose,
    status,
  };
}
