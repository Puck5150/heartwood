<script lang="ts">
  import {
    chooseBreak,
    chooseFinish,
    chooseFlow,
    completeFocus,
    createIdleState,
    endBreak,
    finishFlow,
    finishFocusEarly,
    getBreakElapsedMs,
    getFlowElapsedMs,
    getFocusRemainingMs,
    isFocusDue,
    pause,
    resume,
    startFocus,
    type SessionState,
    type TransitionResult,
  } from './lib/session';
  import {
    addParkedThought,
    removeParkedThought,
    splitBySession,
    type ParkedThought,
  } from './lib/parkingLot';
  import { recoverSessionState } from './lib/persistence';
  import { reviewDefaultDurationMinutes, startFocusWithDurationMinutes } from './lib/duration';
  import { buildSessionHistory, type SessionSummary } from './lib/history';
  import { hasNoteContent } from './lib/notes';
  import { createNoteSaveController } from './lib/noteSaveController';
  import { normalizeNoteStorageError, type NoteFailureKind } from './lib/noteStorage';
  import { createTaskQueue } from './lib/taskQueue';
  import { DEFAULT_TONE_ID, playTone } from './lib/sound';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import {
    deleteAllData,
    deleteParkedThoughtRow,
    deleteSessionRow,
    getSetting,
    initializeNoteStorage,
    insertParkedThought,
    loadAllParkedThoughts,
    loadAllSessionNotes,
    loadCompletedSessions,
    loadLatestSessionRow,
    loadNoteRecordForSession,
    saveNote,
    saveSession,
    setSetting,
  } from './lib/repository';
  import Timer from './lib/Timer.svelte';
  import ParkingLot from './lib/ParkingLot.svelte';
  import DecisionScreen from './lib/DecisionScreen.svelte';
  import SessionReview from './lib/SessionReview.svelte';
  import History from './lib/History.svelte';
  import ToneSelector from './lib/ToneSelector.svelte';
  import SessionNotes from './lib/SessionNotes.svelte';

  const DEFAULT_DURATION_MINUTES = 25;
  const SELECTED_TONE_SETTING_KEY = 'selectedToneId';
  const NOTE_AUTOSAVE_DEBOUNCE_MS = 600;
  const NOTE_SAVE_RETRY_DELAY_MS = 3000;

  let session = $state<SessionState>(createIdleState());
  let parkedThoughts = $state<ParkedThought[]>([]);
  let now = $state(Date.now());
  let taskDraft = $state('');
  let durationMinutes = $state(DEFAULT_DURATION_MINUTES);
  let error = $state<string | null>(null);
  let ready = $state(false);
  let view = $state<'main' | 'history'>('main');
  let historySummaries = $state<SessionSummary[]>([]);
  let selectedToneId = $state(DEFAULT_TONE_ID);
  let noteContent = $state('');
  let noteSaveNeedsManualRetry = $state(false);
  /** Non-error, non-blocking status: a deletion/clear committed but a
   * secondary file-cleanup step failed and will retry at next startup.
   * Deliberately separate from `error` — a successful `flushPendingNoteSave`
   * clears `error`, which would otherwise silently erase this notice. */
  let cleanupWarning = $state<string | null>(null);

  /** A non-transient note-save failure needing an explicit user decision:
   * an external edit conflict (offer Reload file / Keep my version), or a
   * missing/unreadable file (offer Retry — editing stays disabled until
   * it resolves). Never auto-retried, unlike a transient failure. */
  type NoteStorageIssue = {
    sessionId: string;
    kind: Exclude<NoteFailureKind, 'transient'>;
    diskContent: string | null;
    diskHash: string | null;
  };
  let noteStorageIssue = $state<NoteStorageIssue | null>(null);
  let confirmingConflictReload = $state(false);
  /** Sessions whose next save must bypass the expected-hash conflict check
   * — set by "Keep my version", cleared once that forced save succeeds. */
  const forceNextNoteSave = new Set<string>();

  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 250);
    return () => clearInterval(id);
  });

  $effect(() => {
    if (session.status === 'focusing' && isFocusDue(session, now)) {
      const result = completeFocus(session, now);
      // Only for a focus session completing live, in front of the user —
      // not when recovery jumps straight to awaitingDecision after the
      // app was reopened well after the timer actually expired. Playing
      // a sound the instant a long-closed app relaunches would surprise
      // rather than notify.
      if (result.ok) playTone(selectedToneId);
      applyResult(result);
    }
  });

  // Every repository write goes through this one queue — session saves,
  // parked-thought inserts/deletes, session deletes, and delete-all alike
  // — so a slow write that's already in flight (e.g. parking a thought)
  // can never land after a later delete and silently recreate the data
  // that delete just removed. The upsert's own updated_at guard is a
  // second line of defense on top of this ordering guarantee. A
  // file-backed note *load* that refreshes SQLite's content_hash counts as
  // a write for this ordering purpose too, so loadNoteRecordForSession and
  // loadAllSessionNotes are enqueued here rather than called directly.
  const writeQueue = createTaskQueue();

  /** The last content hash this session's note is known to have on disk,
   * used as the expected-hash for its next save's optimistic conflict
   * check. `null` means "no note exists yet" (or none has been loaded). */
  const noteHashBySession = new Map<string, string | null>();

  // Runs once on mount: initialize native note storage (staged-deletion
  // recovery, then legacy Phase 4A migration) before anything else touches
  // notes, then recover the last active/incomplete session (if any), the
  // full parked-thought pool, and the persisted alarm-tone choice.
  $effect(() => {
    let cancelled = false;
    (async () => {
      await initializeNoteStorage();
      if (cancelled) return;
      const [row, thoughts, toneId] = await Promise.all([
        loadLatestSessionRow(),
        loadAllParkedThoughts(),
        getSetting(SELECTED_TONE_SETTING_KEY),
      ]);
      if (cancelled) return;
      session = recoverSessionState(row, Date.now());
      parkedThoughts = thoughts;
      if (toneId) selectedToneId = toneId;
      // Covers 'complete' too, now that a recovered completed session
      // restores to its review screen instead of idle — see
      // recoverSessionState's own comment for why that changed.
      if (session.status !== 'idle') {
        const recoveredSessionId = session.sessionId;
        const record = await writeQueue.enqueue(() => loadNoteRecordForSession(recoveredSessionId));
        if (cancelled) return;
        noteContent = record?.content ?? '';
        noteHashBySession.set(recoveredSessionId, record?.content_hash ?? null);
      }
      ready = true;
    })().catch((err) => {
      console.error('Failed to recover session state:', err);
      ready = true;
    });
    return () => {
      cancelled = true;
    };
  });

  function queueSaveSession(state: SessionState, updatedAt: number) {
    writeQueue.enqueue(() => saveSession(state, updatedAt)).catch((err) => {
      console.error('Failed to persist session:', err);
    });
  }

  // Debounced note autosave, built on noteSaveController.ts (see that
  // module for the full race it closes: a save already enqueued when its
  // session is deleted must never repopulate itself and resurrect the note
  // once it fails). This file only owns the actual saveNote() call, the
  // debounce/auto-retry *timers*, and turning the controller's result into
  // UI state (the error banner, the manual-retry affordance).
  const noteSaveController = createNoteSaveController(
    async (sessionId, content) => {
      const result = await writeQueue.enqueue(() =>
        saveNote(sessionId, content, Date.now(), {
          expectedHash: noteHashBySession.get(sessionId) ?? null,
          force: forceNextNoteSave.has(sessionId),
        }),
      );
      // Only reached on success — a thrown save skips straight to the
      // controller's catch, so the flag survives for the next attempt.
      forceNextNoteSave.delete(sessionId);
      if (result.note) noteHashBySession.set(sessionId, result.note.content_hash);
      else noteHashBySession.delete(sessionId);
      if (result.cleanupPending) {
        cleanupWarning = 'Note cleared, but file cleanup will retry when the app restarts.';
      }
    },
    undefined,
    (error) => normalizeNoteStorageError(error).kind,
  );
  let noteSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let noteRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearNoteTimers() {
    if (noteSaveTimeout !== null) {
      clearTimeout(noteSaveTimeout);
      noteSaveTimeout = null;
    }
    if (noteRetryTimeout !== null) {
      clearTimeout(noteRetryTimeout);
      noteRetryTimeout = null;
    }
  }

  /** Flushes any pending note edit. Resolves `true` once it's safe to move
   * on — the save succeeded, there was nothing pending, or the pending save
   * had been invalidated by a deletion — and `false` only for a real,
   * still-relevant failure. Never rejects, so callers (including the
   * window-close handler) can always await it safely. A real failure
   * schedules a bounded number of automatic retries; once those are
   * exhausted, the error message switches to prompt a manual retry instead
   * of continuing to claim it'll retry itself. */
  /** The session the currently-visible note editor belongs to, or null
   * when there's no note editor on screen at all (idle). Used to attach a
   * non-transient failure to the right session — App.svelte only ever
   * shows one note editor at a time. */
  function currentNoteSessionId(): string | null {
    return session.status === 'idle' ? null : session.sessionId;
  }

  async function flushPendingNoteSave(): Promise<boolean> {
    clearNoteTimers();
    const result = await noteSaveController.flush();
    if (result.ok) {
      error = null;
      noteSaveNeedsManualRetry = false;
      noteStorageIssue = null;
      return true;
    }
    const kind = result.failure?.kind ?? 'transient';
    if (kind !== 'transient') {
      // Non-transient: stop auto-retrying outright and surface a specific
      // recovery choice instead of the generic retry banner — retrying a
      // conflict automatically would silently overwrite an external edit,
      // and retrying a missing/unreadable file automatically would just
      // paper over a problem the user needs to actually see.
      console.error('Note save requires a decision:', kind);
      noteSaveNeedsManualRetry = false;
      const sessionId = currentNoteSessionId();
      const normalized = result.failure ? normalizeNoteStorageError(result.failure.error) : null;
      if (sessionId) {
        noteStorageIssue = {
          sessionId,
          kind,
          diskContent: normalized?.diskContent ?? null,
          diskHash: normalized?.diskHash ?? null,
        };
      }
      error =
        kind === 'conflict'
          ? 'This note was changed outside the app.'
          : "This note's file could not be found or read.";
      return false;
    }
    console.error('Failed to save note');
    if (!result.exhausted) {
      error = 'Failed to save your note. Retrying…';
      noteSaveNeedsManualRetry = false;
      noteRetryTimeout = setTimeout(() => {
        noteRetryTimeout = null;
        void flushPendingNoteSave();
      }, NOTE_SAVE_RETRY_DELAY_MS);
    } else {
      error = 'Failed to save your note.';
      noteSaveNeedsManualRetry = true;
    }
    return false;
  }

  function handleRetryNoteSave() {
    noteSaveNeedsManualRetry = false;
    void flushPendingNoteSave();
  }

  /** Re-reads the affected session's note from disk, discarding whatever
   * unsaved draft was pending for it. Serves both of the non-transient
   * recovery actions: "Reload file" for a conflict (after explicit
   * Cancel/Confirm, since it discards the user's own edit), and "Retry"
   * for a missing/unreadable file (nothing to discard there — the point
   * is just to see whether the file is readable now). If the file is
   * still missing/unreadable, the issue is re-shown with the fresh kind
   * rather than assumed resolved. */
  async function handleReloadExternalNote() {
    if (!noteStorageIssue) return;
    const sessionId = noteStorageIssue.sessionId;
    try {
      const record = await writeQueue.enqueue(() => loadNoteRecordForSession(sessionId));
      noteSaveController.discard(sessionId);
      noteContent = record?.content ?? '';
      noteHashBySession.set(sessionId, record?.content_hash ?? null);
      noteStorageIssue = null;
      confirmingConflictReload = false;
      error = null;
    } catch (err) {
      const normalized = normalizeNoteStorageError(err);
      confirmingConflictReload = false;
      if (normalized.kind === 'missing' || normalized.kind === 'unreadable') {
        noteStorageIssue = { sessionId, kind: normalized.kind, diskContent: null, diskHash: null };
      }
    }
  }

  /** Explicitly forces the in-memory draft to overwrite the external
   * version — the opposite choice from Reload. Re-flushes the same
   * pending content that was kept around after the conflict (non-
   * transient failures stay pending; see noteSaveController.ts). */
  function handleKeepAppNote() {
    if (!noteStorageIssue || !noteStorageIssue.diskHash) return;
    noteHashBySession.set(noteStorageIssue.sessionId, noteStorageIssue.diskHash);
    forceNextNoteSave.add(noteStorageIssue.sessionId);
    noteStorageIssue = null;
    void flushPendingNoteSave();
  }

  /** True only when the *current* note editor's file is missing/unreadable
   * — a conflict deliberately keeps editing enabled (the user's draft is
   * exactly what "Keep my version" would submit), but there's nowhere safe
   * for new keystrokes to land when the file itself can't be read. */
  const noteEditingDisabled = $derived.by(() => {
    if (!noteStorageIssue) return false;
    if (noteStorageIssue.kind === 'conflict') return false;
    return noteStorageIssue.sessionId === currentNoteSessionId();
  });

  function scheduleNoteSave(sessionId: string, content: string) {
    noteSaveController.schedule(sessionId, content);
    noteSaveNeedsManualRetry = false;
    clearNoteTimers();
    noteSaveTimeout = setTimeout(() => {
      noteSaveTimeout = null;
      void flushPendingNoteSave();
    }, NOTE_AUTOSAVE_DEBOUNCE_MS);
  }

  /** Invalidates a note edit that's pending or waiting on a retry, so it can
   * never fire later and write a note back for a session that's about to be
   * (or already was) deleted. Pass no id to invalidate everything
   * (delete-all). Deliberately called *twice* around a delete: once before
   * enqueuing it (covers a save still sitting in a debounce/retry timer,
   * not yet enqueued at all) and once after it commits (covers a save that
   * was already enqueued — in flight — when the delete started, and only
   * repopulates itself for retry *after* failing, possibly while the
   * delete was still waiting its turn in the queue). */
  function cancelPendingNoteSave(sessionId?: string) {
    noteSaveController.invalidate(sessionId);
    if (!noteSaveController.hasPending()) {
      clearNoteTimers();
      noteSaveNeedsManualRetry = false;
    }
    // A conflict/missing-file issue for a session that's being (or was
    // just) deleted has nothing left to reload or keep — drop it rather
    // than leaving a dangling recovery prompt for data that's gone.
    if (noteStorageIssue && (sessionId === undefined || noteStorageIssue.sessionId === sessionId)) {
      forceNextNoteSave.delete(noteStorageIssue.sessionId);
      noteStorageIssue = null;
      confirmingConflictReload = false;
    }
  }

  // Tauri only: hold the window open long enough to flush every pending
  // note edit and drain the rest of the write queue before actually
  // closing, so a note typed right before quitting can't be dropped
  // mid-save. If the note flush reports a real failure, the close is
  // aborted entirely — the window stays open, the edit stays pending, and
  // the error (with a retry action once auto-retries are exhausted) stays
  // visible. destroy() (unlike close()) doesn't re-emit close-requested, so
  // there's no risk of looping back into this same handler.
  $effect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        const noteFlushOk = await flushPendingNoteSave();
        await writeQueue.drain();
        if (!noteFlushOk) return; // keep the window open; the error is already showing
        await win.destroy();
      });
    })();
    return () => unlisten?.();
  });

  function applyResult(result: TransitionResult) {
    // Flush first: any transition (pause, finish, finish-early, etc.)
    // should never leave an un-persisted, debounce-pending note edit
    // behind.
    void flushPendingNoteSave();
    if (result.ok) {
      session = result.state;
      error = null;
      queueSaveSession(result.state, Date.now());
    } else {
      error = result.error;
    }
  }

  function handleNoteChange(content: string) {
    noteContent = content;
    // 'complete' is included deliberately: the review screen's note is
    // editable, not read-only, so edits made there need to autosave too.
    if (session.status === 'idle') return;
    scheduleNoteSave(session.sessionId, content);
  }

  /** Applied after starting the next session from the review screen (either
   * path). If the user opted to carry the just-reviewed note forward, it's
   * scheduled and flushed through the exact same noteSaveController as any
   * other note edit — not a bespoke one-off write — so a failure here gets
   * the same bounded auto-retry, manual-retry action, and close-blocking
   * behavior as normal autosave, rather than leaving the carried text
   * visible only in this component's in-memory state if the write fails.
   * Flushed immediately rather than going through the debounce timer, since
   * there's nothing left to batch — this *is* the final content. The
   * original session's note row is never touched either way; this only
   * ever writes to `newSessionId`. */
  function applyCarriedNote(newSessionId: string, finalizedNote: string, carryForward: boolean) {
    if (carryForward && hasNoteContent(finalizedNote)) {
      noteContent = finalizedNote;
      noteSaveController.schedule(newSessionId, finalizedNote);
      clearNoteTimers();
      void flushPendingNoteSave();
    } else {
      noteContent = ''; // fresh session, blank notes editor
    }
  }

  function handleStart(event: Event) {
    event.preventDefault();
    const result = startFocus(
      session,
      taskDraft,
      durationMinutes * 60_000,
      Date.now(),
      crypto.randomUUID(),
    );
    applyResult(result);
    if (result.ok) {
      taskDraft = '';
      noteContent = ''; // fresh session, blank notes editor
    }
  }

  function handlePause() {
    applyResult(pause(session, Date.now()));
  }

  function handleResume() {
    applyResult(resume(session, Date.now()));
  }

  function handleChooseBreak() {
    applyResult(chooseBreak(session, Date.now()));
  }

  function handleChooseFlow() {
    applyResult(chooseFlow(session, Date.now()));
  }

  function handleChooseFinish() {
    applyResult(chooseFinish(session, Date.now()));
  }

  function handleFinishFlow() {
    applyResult(finishFlow(session, Date.now()));
  }

  function handleEndBreak() {
    applyResult(endBreak(session, Date.now()));
  }

  function handleFinishFocusEarly() {
    applyResult(finishFocusEarly(session, Date.now()));
  }

  function handlePark(text: string) {
    if (session.status === 'idle' || session.status === 'complete') return;
    const next = addParkedThought(parkedThoughts, crypto.randomUUID(), text, Date.now(), session.sessionId);
    if (next === parkedThoughts) return; // blank/whitespace text; addParkedThought no-opped
    parkedThoughts = next;
    const added = next[next.length - 1];
    writeQueue.enqueue(() => insertParkedThought(added)).catch((err) => {
      console.error('Failed to persist parked thought:', err);
    });
  }

  function handleDeleteThought(id: string) {
    parkedThoughts = removeParkedThought(parkedThoughts, id);
    writeQueue.enqueue(() => deleteParkedThoughtRow(id)).catch((err) => {
      console.error('Failed to delete parked thought:', err);
    });
  }

  /** Promotes a parked thought into the next session. Returns whether it
   * actually happened, so SessionReview.svelte only clears/advances its own
   * local UI state on success. Deliberately awaits the just-reviewed
   * session's own note flush *before* creating the new session or
   * scheduling its carried note: this serializes the two sessions' saves
   * rather than letting them run concurrently, and if the old note can't
   * be finalized, the review screen stays exactly as it was — no next
   * session starts — until the user retries it successfully (the existing
   * error banner and retry action already surface that). */
  async function handlePromoteThought(id: string, minutes: number, carryNoteForward: boolean): Promise<boolean> {
    const thought = parkedThoughts.find((t) => t.id === id);
    if (!thought) return false;
    const finalizedNote = noteContent; // the just-reviewed session's finalized note text
    const oldNoteFlushedOk = await flushPendingNoteSave();
    if (!oldNoteFlushedOk) return false; // stay on review; error + retry UI already surfaced
    const newSessionId = crypto.randomUUID();
    const result = startFocusWithDurationMinutes(session, thought.text, minutes, Date.now(), newSessionId);
    applyResult(result);
    if (!result.ok) return false; // keep the thought — nothing succeeded, nothing should be lost
    durationMinutes = minutes;
    applyCarriedNote(newSessionId, finalizedNote, carryNoteForward);
    parkedThoughts = removeParkedThought(parkedThoughts, id);
    writeQueue.enqueue(() => deleteParkedThoughtRow(id)).catch((err) => {
      console.error('Failed to delete promoted parked thought:', err);
    });
    return true;
  }

  /** Starts the next session from a typed task. See handlePromoteThought's
   * doc for why the old session's note is flushed and awaited first. */
  async function handleStartNext(task: string, minutes: number, carryNoteForward: boolean): Promise<boolean> {
    const finalizedNote = noteContent; // the just-reviewed session's finalized note text
    const oldNoteFlushedOk = await flushPendingNoteSave();
    if (!oldNoteFlushedOk) return false; // stay on review; error + retry UI already surfaced
    const newSessionId = crypto.randomUUID();
    const result = startFocusWithDurationMinutes(session, task, minutes, Date.now(), newSessionId);
    applyResult(result);
    if (!result.ok) return false;
    durationMinutes = minutes;
    applyCarriedNote(newSessionId, finalizedNote, carryNoteForward);
    return true;
  }

  async function handleViewHistory() {
    // Flush any pending note edit and let the rest of the write queue
    // drain *before* reading history — otherwise loadCompletedSessions()/
    // loadAllSessionNotes() (plain SELECTs, outside the write queue) could
    // read a stale view: the just-completed session's own save, or the
    // note just edited on this review screen, might not have landed yet.
    // If the note flush itself fails, stay on review rather than opening
    // history with content that doesn't match what's actually saved.
    const noteFlushedOk = await flushPendingNoteSave();
    if (!noteFlushedOk) return; // stay on review; error + retry UI already surfaced
    await writeQueue.drain();
    try {
      const [rows, notes] = await Promise.all([
        loadCompletedSessions(),
        writeQueue.enqueue(() => loadAllSessionNotes()),
      ]);
      historySummaries = buildSessionHistory(rows, parkedThoughts, notes);
      error = null;
      view = 'history';
    } catch (err) {
      // Stay on the current screen and surface the failure — switching to
      // the history view here would show "No completed sessions yet.",
      // which is indistinguishable from a real empty history.
      console.error('Failed to load session history:', err);
      error = 'Failed to load session history.';
    }
  }

  function handleBackFromHistory() {
    view = 'main';
  }

  async function handleDeleteSessionFromHistory(id: string) {
    try {
      // Invalidated twice, deliberately: once now (covers a save still
      // waiting out its debounce/retry timer, not yet enqueued at all —
      // this cancels it outright), and once again after the delete
      // actually commits below (covers a save that was already enqueued
      // — in flight — when this ran, which only repopulates itself for
      // retry *after* failing, possibly while this delete was still
      // waiting its turn in the queue; without the second call that
      // repopulated retry would survive to resurrect the note later).
      cancelPendingNoteSave(id);
      const outcome = await writeQueue.enqueue(() => deleteSessionRow(id));
      cancelPendingNoteSave(id);
      historySummaries = historySummaries.filter((s) => s.id !== id);
      error = null;
      cleanupWarning = outcome.cleanupPending
        ? 'Session deleted, but note file cleanup will retry when the app restarts.'
        : null;
    } catch (err) {
      // Don't remove it from view until the delete is confirmed — leaving
      // it visible on failure is safer than pretending it's gone.
      console.error('Failed to delete session:', err);
      error = 'Failed to delete session.';
    }
  }

  async function handleDeleteAllData() {
    // Confirmation happens in History.svelte's own UI before this is ever
    // called — window.confirm() isn't reliably supported across Tauri's
    // WebView backends, so we don't rely on it here.
    try {
      cancelPendingNoteSave(); // every note is about to be wiped; nothing to save
      const outcome = await writeQueue.enqueue(() => deleteAllData());
      cancelPendingNoteSave(); // recheck: a racing failed save may have repopulated one while we waited
      historySummaries = [];
      parkedThoughts = [];
      // Return to a clean idle state — whatever session/review was showing
      // referenced data that no longer exists, and there's no "current
      // session" left to be in.
      session = createIdleState();
      view = 'main';
      taskDraft = '';
      durationMinutes = DEFAULT_DURATION_MINUTES;
      noteContent = '';
      noteHashBySession.clear();
      error = null;
      cleanupWarning = outcome.cleanupPending
        ? 'Data deleted, but note file cleanup will retry when the app restarts.'
        : null;
    } catch (err) {
      console.error('Failed to delete all data:', err);
      error = 'Failed to delete all data.';
    }
  }

  function handleSelectTone(id: string) {
    selectedToneId = id;
    writeQueue.enqueue(() => setSetting(SELECTED_TONE_SETTING_KEY, id)).catch((err) => {
      console.error('Failed to persist selected tone:', err);
    });
  }

  function handlePreviewTone(id: string) {
    playTone(id);
  }
</script>

<main>
  {#if error}
    <p class="error" role="alert">
      {error}
      {#if noteSaveNeedsManualRetry}
        <button type="button" class="retry-link" onclick={handleRetryNoteSave}>Retry</button>
      {/if}
    </p>
  {/if}
  {#if cleanupWarning}
    <p class="cleanup-warning" role="status">{cleanupWarning}</p>
  {/if}
  {#if noteStorageIssue?.kind === 'conflict'}
    <div class="note-issue" role="alert">
      {#if confirmingConflictReload}
        <p>Reload the file and discard your unsaved changes here?</p>
        <div class="note-issue-actions">
          <button type="button" class="note-issue-link" onclick={() => (confirmingConflictReload = false)}>Cancel</button>
          <button type="button" class="note-issue-link danger" onclick={handleReloadExternalNote}>Confirm reload</button>
        </div>
      {:else}
        <p>This note was changed outside the app. Keep your version, or reload the file's version?</p>
        <div class="note-issue-actions">
          <button type="button" class="note-issue-link" onclick={() => (confirmingConflictReload = true)}>Reload file</button>
          <button type="button" class="note-issue-link" onclick={handleKeepAppNote}>Keep my version</button>
        </div>
      {/if}
    </div>
  {:else if noteStorageIssue}
    <div class="note-issue" role="alert">
      <p>
        This note's file could not be {noteStorageIssue.kind === 'missing' ? 'found' : 'read'}. Editing is
        disabled until it's resolved.
      </p>
      <div class="note-issue-actions">
        <button type="button" class="note-issue-link" onclick={handleReloadExternalNote}>Retry</button>
      </div>
    </div>
  {/if}

  {#if view === 'history'}
    <History
      summaries={historySummaries}
      parkedThoughts={parkedThoughts}
      onBack={handleBackFromHistory}
      onDeleteSession={handleDeleteSessionFromHistory}
      onDeleteAll={handleDeleteAllData}
    />
  {:else if !ready}
    <p class="loading">Loading…</p>
  {:else if session.status === 'idle'}
    <section class="setup">
      <h1>Pomodoro Parking Lot</h1>
      <p class="subtitle">Choose one focus task and start the timer.</p>
      <form onsubmit={handleStart}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          placeholder="What are you focusing on?"
          bind:value={taskDraft}
          aria-label="Focus task"
          autofocus
        />
        <label class="duration">
          <span>Minutes</span>
          <input type="number" min="1" max="180" bind:value={durationMinutes} />
        </label>
        <button type="submit" disabled={!taskDraft.trim()}>Start focusing</button>
      </form>
      <button type="button" class="history-link" onclick={handleViewHistory}>View history</button>
      <ToneSelector {selectedToneId} onSelect={handleSelectTone} onPreview={handlePreviewTone} />
    </section>
  {:else if session.status === 'focusing' || session.status === 'paused'}
    {@const remaining = getFocusRemainingMs(session, now) ?? 0}
    {@const sessionId = session.sessionId}
    <Timer
      task={session.task}
      mode="focus"
      isPaused={session.status === 'paused'}
      displayMs={remaining}
      progress={1 - remaining / session.plannedDurationMs}
      onPause={handlePause}
      onResume={handleResume}
      onFinish={handleFinishFocusEarly}
    />
    <ParkingLot
      thoughts={parkedThoughts.filter((t) => t.sessionId === sessionId)}
      onPark={handlePark}
    />
    <SessionNotes content={noteContent} onChange={handleNoteChange} onBlur={flushPendingNoteSave} disabled={noteEditingDisabled} />
  {:else if session.status === 'awaitingDecision'}
    <DecisionScreen
      task={session.task}
      onBreak={handleChooseBreak}
      onFlow={handleChooseFlow}
      onFinish={handleChooseFinish}
    />
  {:else if session.status === 'flow' || session.status === 'flowPaused'}
    {@const sessionId = session.sessionId}
    <Timer
      task={session.task}
      mode="flow"
      isPaused={session.status === 'flowPaused'}
      displayMs={getFlowElapsedMs(session, now) ?? 0}
      onPause={handlePause}
      onResume={handleResume}
      onFinish={handleFinishFlow}
    />
    <ParkingLot
      thoughts={parkedThoughts.filter((t) => t.sessionId === sessionId)}
      onPark={handlePark}
    />
    <SessionNotes content={noteContent} onChange={handleNoteChange} onBlur={flushPendingNoteSave} disabled={noteEditingDisabled} />
  {:else if session.status === 'break'}
    <Timer
      task={session.task}
      mode="break"
      isPaused={false}
      displayMs={getBreakElapsedMs(session, now) ?? 0}
      onPause={() => {}}
      onResume={() => {}}
      onFinish={handleEndBreak}
    />
  {:else if session.status === 'complete'}
    {@const split = splitBySession(parkedThoughts, session.sessionId)}
    <SessionReview
      task={session.task}
      plannedFocusMs={session.plannedFocusMs}
      actualFocusMs={session.actualFocusMs}
      flowMs={session.flowMs}
      tookBreak={session.tookBreak}
      breakMs={session.breakMs}
      totalElapsedMs={session.totalElapsedMs}
      thisSessionThoughts={split.current}
      carriedForwardThoughts={split.carriedForward}
      noteContent={noteContent}
      onNoteChange={handleNoteChange}
      onNoteBlur={flushPendingNoteSave}
      defaultDurationMinutes={reviewDefaultDurationMinutes(session.plannedFocusMs)}
      onDelete={handleDeleteThought}
      onPromote={handlePromoteThought}
      onStartNext={handleStartNext}
      onViewHistory={handleViewHistory}
    />
  {/if}
</main>

<style>
  main {
    max-width: 32rem;
    margin: 0 auto;
    padding: 3rem 1.5rem;
  }

  .error {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.6rem;
    background: color-mix(in srgb, red 12%, transparent);
    color: #b42318;
    font-size: 0.85rem;
  }

  .cleanup-warning {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.6rem;
    background: var(--surface-secondary);
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .note-issue {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.6rem;
    background: color-mix(in srgb, orange 12%, transparent);
    color: var(--text);
    font-size: 0.85rem;
  }

  .note-issue p {
    margin: 0 0 0.5rem;
  }

  .note-issue-actions {
    display: flex;
    gap: 1rem;
  }

  .note-issue-link {
    padding: 0;
    background: none;
    border: none;
    color: var(--accent);
    font-weight: 700;
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    cursor: pointer;
  }

  .note-issue-link.danger {
    color: var(--text-muted);
  }

  .retry-link {
    margin-left: 0.5rem;
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font-weight: 700;
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    cursor: pointer;
  }

  .loading {
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
  }

  .setup {
    text-align: center;
    padding: 3rem 2rem;
    border-radius: 1.25rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .setup h1 {
    margin: 0 0 0.4rem;
    font-size: 1.6rem;
    color: var(--text);
  }

  .subtitle {
    margin: 0 0 2rem;
    color: var(--text-muted);
  }

  .setup form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 22rem;
    margin: 0 auto;
  }

  .setup input[type='text'] {
    padding: 0.75rem 1rem;
    border-radius: 0.7rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 1rem;
  }

  .duration {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    font-size: 0.9rem;
    color: var(--text-muted);
  }

  .duration input {
    width: 4.5rem;
    padding: 0.5rem;
    border-radius: 0.6rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    text-align: center;
  }

  .setup button {
    padding: 0.8rem 1rem;
    border-radius: 0.7rem;
    border: none;
    background: var(--accent);
    color: var(--accent-contrast);
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
  }

  .setup button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .setup .history-link {
    margin-top: 1.25rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
</style>
