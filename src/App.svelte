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
  import { createTaskQueue } from './lib/taskQueue';
  import {
    deleteAllData,
    deleteParkedThoughtRow,
    deleteSessionRow,
    insertParkedThought,
    loadAllParkedThoughts,
    loadCompletedSessions,
    loadLatestSessionRow,
    saveSession,
  } from './lib/repository';
  import Timer from './lib/Timer.svelte';
  import ParkingLot from './lib/ParkingLot.svelte';
  import DecisionScreen from './lib/DecisionScreen.svelte';
  import SessionReview from './lib/SessionReview.svelte';
  import History from './lib/History.svelte';

  const DEFAULT_DURATION_MINUTES = 25;

  let session = $state<SessionState>(createIdleState());
  let parkedThoughts = $state<ParkedThought[]>([]);
  let now = $state(Date.now());
  let taskDraft = $state('');
  let durationMinutes = $state(DEFAULT_DURATION_MINUTES);
  let error = $state<string | null>(null);
  let ready = $state(false);
  let view = $state<'main' | 'history'>('main');
  let historySummaries = $state<SessionSummary[]>([]);

  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 250);
    return () => clearInterval(id);
  });

  $effect(() => {
    if (session.status === 'focusing' && isFocusDue(session, now)) {
      applyResult(completeFocus(session, now));
    }
  });

  // Runs once on mount: recover the last active/incomplete session (if any)
  // and the full parked-thought pool, recomputed from stored timestamps.
  $effect(() => {
    let cancelled = false;
    (async () => {
      const [row, thoughts] = await Promise.all([loadLatestSessionRow(), loadAllParkedThoughts()]);
      if (cancelled) return;
      session = recoverSessionState(row, Date.now());
      parkedThoughts = thoughts;
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

  function applyResult(result: TransitionResult) {
    if (result.ok) {
      session = result.state;
      error = null;
      queueSaveSession(result.state, Date.now());
    } else {
      error = result.error;
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
    if (result.ok) taskDraft = '';
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

  function handlePromoteThought(id: string, minutes: number) {
    const thought = parkedThoughts.find((t) => t.id === id);
    if (!thought) return;
    const result = startFocusWithDurationMinutes(
      session,
      thought.text,
      minutes,
      Date.now(),
      crypto.randomUUID(),
    );
    applyResult(result);
    if (!result.ok) return; // keep the thought — nothing succeeded, nothing should be lost
    durationMinutes = minutes;
    parkedThoughts = removeParkedThought(parkedThoughts, id);
    writeQueue.enqueue(() => deleteParkedThoughtRow(id)).catch((err) => {
      console.error('Failed to delete promoted parked thought:', err);
    });
  }

  function handleStartNext(task: string, minutes: number) {
    const result = startFocusWithDurationMinutes(session, task, minutes, Date.now(), crypto.randomUUID());
    applyResult(result);
    if (result.ok) durationMinutes = minutes;
  }

  async function handleViewHistory() {
    try {
      const rows = await loadCompletedSessions();
      historySummaries = buildSessionHistory(rows, parkedThoughts);
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
      // Queued behind any already-pending save, so a save for this exact
      // session that's still in flight can't land after the delete and
      // resurrect the row.
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
      error = null;
    } catch (err) {
      console.error('Failed to delete all data:', err);
      error = 'Failed to delete all data.';
    }
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
