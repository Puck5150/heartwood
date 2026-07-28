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
  import { createTaskQueue } from './lib/taskQueue';
  import { DEFAULT_TONE_ID, playTone } from './lib/sound';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import {
    deleteAllData,
    deleteParkedThoughtRow,
    deleteSessionRow,
    getSetting,
    insertParkedThought,
    loadAllParkedThoughts,
    loadAllSessionNotes,
    loadCompletedSessions,
    loadLatestSessionRow,
    loadNoteForSession,
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

  // Runs once on mount: recover the last active/incomplete session (if any),
  // the full parked-thought pool, and the persisted alarm-tone choice.
  $effect(() => {
    let cancelled = false;
    (async () => {
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
        noteContent = (await loadNoteForSession(session.sessionId)) ?? '';
        if (cancelled) return;
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

  // Every repository write goes through this one queue — session saves,
  // parked-thought inserts/deletes, session deletes, and delete-all alike
  // — so a slow write that's already in flight (e.g. parking a thought)
  // can never land after a later delete and silently recreate the data
  // that delete just removed. The upsert's own updated_at guard is a
  // second line of defense on top of this ordering guarantee.
  const writeQueue = createTaskQueue();

  function queueSaveSession(state: SessionState, updatedAt: number) {
    writeQueue.enqueue(() => saveSession(state, updatedAt)).catch((err) => {
      console.error('Failed to persist session:', err);
    });
  }

  // Debounced note autosave. A pending save is tracked separately from
  // `noteContent` (the live textarea value) so it can be flushed
  // immediately whenever the session transitions, the textarea loses
  // focus, or the window is about to close — otherwise the last few
  // keystrokes before one of those could be lost if the debounce hadn't
  // fired yet.
  let noteSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingNoteSave: { sessionId: string; content: string } | null = null;

  /** Flushes any pending note edit through the write queue. Resolves once
   * that write has settled (success or failure) — never rejects, so
   * callers (including the window-close handler) can always await it
   * safely. On failure, the content is put back into `pendingNoteSave`
   * (unless something newer has already been typed in the meantime) so
   * the next flush retries it instead of the edit silently vanishing. */
  function flushPendingNoteSave(): Promise<void> {
    if (noteSaveTimeout !== null) {
      clearTimeout(noteSaveTimeout);
      noteSaveTimeout = null;
    }
    if (!pendingNoteSave) return Promise.resolve();
    const { sessionId, content } = pendingNoteSave;
    pendingNoteSave = null;
    return writeQueue
      .enqueue(() => saveNote(sessionId, content, Date.now()))
      .then(() => {
        error = null;
      })
      .catch((err) => {
        console.error('Failed to save note:', err);
        error = 'Failed to save your note. It will retry automatically.';
        if (!pendingNoteSave) pendingNoteSave = { sessionId, content };
      });
  }

  function scheduleNoteSave(sessionId: string, content: string) {
    pendingNoteSave = { sessionId, content };
    if (noteSaveTimeout !== null) clearTimeout(noteSaveTimeout);
    noteSaveTimeout = setTimeout(flushPendingNoteSave, NOTE_AUTOSAVE_DEBOUNCE_MS);
  }

  /** Discards a note edit that's still waiting out its debounce — i.e. not
   * yet handed to the write queue at all — before it can fire later and
   * write a note for a session that's about to be deleted. Queuing a
   * delete behind an *enqueued* save is already race-safe (the delete just
   * runs after it), but a save still sitting in setTimeout hasn't been
   * enqueued yet, so it needs to be canceled outright instead. Pass no id
   * to discard unconditionally (delete-all). */
  function cancelPendingNoteSave(sessionId?: string) {
    if (!pendingNoteSave) return;
    if (sessionId !== undefined && pendingNoteSave.sessionId !== sessionId) return;
    if (noteSaveTimeout !== null) {
      clearTimeout(noteSaveTimeout);
      noteSaveTimeout = null;
    }
    pendingNoteSave = null;
  }

  // Tauri only: hold the window open long enough to flush and drain every
  // pending write before actually closing, so a note edit typed right
  // before quitting can't be dropped mid-save. destroy() (unlike close())
  // doesn't re-emit close-requested, so there's no risk of looping back
  // into this same handler.
  $effect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        await flushPendingNoteSave();
        await writeQueue.drain();
        await win.destroy();
      });
    })();
    return () => unlisten?.();
  });

  function applyResult(result: TransitionResult) {
    // Flush first: any transition (pause, finish, finish-early, etc.)
    // should never leave an un-persisted, debounce-pending note edit
    // behind.
    flushPendingNoteSave();
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
   * copied into an independent note row for the new session — persisted
   * immediately, not debounced — and shown pre-filled in the new session's
   * own notes editor. The original session's note row is never touched
   * either way; this only ever writes to `newSessionId`. */
  function applyCarriedNote(newSessionId: string, finalizedNote: string, carryForward: boolean) {
    if (carryForward && hasNoteContent(finalizedNote)) {
      noteContent = finalizedNote;
      writeQueue.enqueue(() => saveNote(newSessionId, finalizedNote, Date.now())).catch((err) => {
        console.error('Failed to carry note into next session:', err);
        error = 'Failed to carry your note into the next session.';
      });
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

  function handlePromoteThought(id: string, minutes: number, carryNoteForward: boolean) {
    const thought = parkedThoughts.find((t) => t.id === id);
    if (!thought) return;
    const finalizedNote = noteContent; // the just-reviewed session's finalized note text
    const newSessionId = crypto.randomUUID();
    const result = startFocusWithDurationMinutes(session, thought.text, minutes, Date.now(), newSessionId);
    applyResult(result);
    if (!result.ok) return; // keep the thought — nothing succeeded, nothing should be lost
    durationMinutes = minutes;
    applyCarriedNote(newSessionId, finalizedNote, carryNoteForward);
    parkedThoughts = removeParkedThought(parkedThoughts, id);
    writeQueue.enqueue(() => deleteParkedThoughtRow(id)).catch((err) => {
      console.error('Failed to delete promoted parked thought:', err);
    });
  }

  function handleStartNext(task: string, minutes: number, carryNoteForward: boolean) {
    const finalizedNote = noteContent; // the just-reviewed session's finalized note text
    const newSessionId = crypto.randomUUID();
    const result = startFocusWithDurationMinutes(session, task, minutes, Date.now(), newSessionId);
    applyResult(result);
    if (result.ok) {
      durationMinutes = minutes;
      applyCarriedNote(newSessionId, finalizedNote, carryNoteForward);
    }
  }

  async function handleViewHistory() {
    try {
      const [rows, notes] = await Promise.all([loadCompletedSessions(), loadAllSessionNotes()]);
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
      // A save for this session already enqueued (in flight) is race-safe
      // by queue ordering alone — the delete just runs after it. A save
      // still waiting out its debounce timer isn't enqueued yet, though,
      // so it's canceled outright here rather than left to fire later.
      cancelPendingNoteSave(id);
      await writeQueue.enqueue(() => deleteSessionRow(id));
      historySummaries = historySummaries.filter((s) => s.id !== id);
      error = null;
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
      await writeQueue.enqueue(() => deleteAllData());
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
      error = null;
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
    <p class="error" role="alert">{error}</p>
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
    <SessionNotes content={noteContent} onChange={handleNoteChange} onBlur={flushPendingNoteSave} />
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
    <SessionNotes content={noteContent} onChange={handleNoteChange} onBlur={flushPendingNoteSave} />
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
