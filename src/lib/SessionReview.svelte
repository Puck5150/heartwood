<script lang="ts">
  import type { ParkedThought } from './parkingLot';
  import { formatDuration } from './format';
  import { isValidDurationMinutes, MAX_DURATION_MINUTES, MIN_DURATION_MINUTES } from './duration';
  import { hasNoteContent } from './notes';
  import SessionNotes from './SessionNotes.svelte';

  let {
    task,
    plannedFocusMs,
    actualFocusMs,
    flowMs,
    tookBreak,
    breakMs,
    breakIntermissionMs = 0,
    touchGrassMs = 0,
    totalElapsedMs,
    thisSessionThoughts,
    carriedForwardThoughts,
    noteContent,
    onNoteChange,
    onNoteBlur,
    noteDisabled = false,
    noteWritesDisabled = false,
    onCheckpoint,
    checkpointStatus = null,
    onViewRevisions,
    defaultDurationMinutes,
    onDelete,
    onPromote,
    onStartNext,
    onViewHistory,
    onBackToStart,
    backToStartError = null,
  }: {
    task: string;
    plannedFocusMs: number;
    actualFocusMs: number;
    flowMs: number;
    tookBreak: boolean;
    breakMs: number;
    breakIntermissionMs?: number;
    touchGrassMs?: number;
    totalElapsedMs: number;
    thisSessionThoughts: ParkedThought[];
    carriedForwardThoughts: ParkedThought[];
    noteContent: string;
    onNoteChange: (content: string) => void;
    onNoteBlur: () => void;
    /** True when this session's note file is missing/unreadable — mirrors
     * the same disabled state the live editor shows, so review mode can't
     * silently recreate a note whose real content failed to load. */
    noteDisabled?: boolean;
    /** True when checkpoint's correctness currently depends on a note
     * flush that hasn't succeeded — see App.svelte's notesWritesDisabled. */
    noteWritesDisabled?: boolean;
    onCheckpoint?: () => void;
    checkpointStatus?: string | null;
    onViewRevisions?: () => void;
    defaultDurationMinutes: number;
    onDelete: (id: string) => void;
    /** Resolves to whether it actually happened — false means the just-
     * reviewed session's note couldn't be finalized (or promoting somehow
     * otherwise failed), so this screen should stay exactly as it is. */
    onPromote: (id: string, durationMinutes: number, carryNoteForward: boolean) => Promise<boolean>;
    onStartNext: (task: string, durationMinutes: number, carryNoteForward: boolean) => Promise<boolean>;
    onViewHistory: () => void;
    /** Returns to the idle front page without starting anything new — this
     * session is already saved (it's showing here because it's complete),
     * so there's nothing to lose by just leaving the review. */
    onBackToStart: () => void;
    /** Set only when a prior "Back to start" click failed to persist —
     * clicking the button again is the retry, so this is purely a visible
     * status, not a separate action. */
    backToStartError?: string | null;
  } = $props();

  // Guards against double-submission while a start/promote is awaiting the
  // old session's note flush — that's no longer instantaneous now that it
  // has to finish before the next session can begin.
  let starting = $state(false);

  // Always defaults to off for every review — this is a fresh $state each
  // time a new completed session mounts this component, never derived from
  // or persisted across sessions.
  let carryNoteForward = $state(false);

  // Finished early if actual focus time came up short of the plan. In the
  // common case (completed naturally) the two are equal, so we only show
  // "Planned" as a separate stat when it actually differs from what happened.
  const finishedEarly = $derived(actualFocusMs < plannedFocusMs);

  let nextTask = $state('');
  // Shared by both "start next" paths below (promoting a parked thought or
  // typing a new task) — starts pre-filled with whatever duration was last
  // used, but is adjustable here since the next session need not match it.
  // Reading defaultDurationMinutes once is intentional: this component
  // remounts fresh each time the review screen appears, so there's nothing
  // to keep in sync with later.
  // svelte-ignore state_referenced_locally
  let durationMinutes = $state(defaultDurationMinutes);

  const durationInvalid = $derived(!isValidDurationMinutes(durationMinutes));

  async function startNext(event: Event) {
    event.preventDefault();
    if (!nextTask.trim() || durationInvalid || starting) return;
    starting = true;
    const started = await onStartNext(nextTask, durationMinutes, carryNoteForward);
    starting = false;
    if (started) nextTask = ''; // only clear the draft once it actually started
  }

  async function promote(thought: ParkedThought) {
    if (durationInvalid || starting) return;
    starting = true;
    await onPromote(thought.id, durationMinutes, carryNoteForward);
    starting = false;
  }

  // Deleting a planted thought is permanent and has no undo, so it gets the
  // same inline confirm step History already uses for deleting a session —
  // never instant on a single click.
  let confirmingDeleteId = $state<string | null>(null);

  function confirmDeleteThought(id: string) {
    confirmingDeleteId = null;
    onDelete(id);
  }
</script>

<section class="review">
  <p class="eyebrow">Session review</p>
  <h1>{task}</h1>

  <dl class="stats">
    <div>
      <dt>Focus</dt>
      <dd>{formatDuration(actualFocusMs)}</dd>
    </div>
    {#if finishedEarly}
      <div>
        <dt>Planned</dt>
        <dd>{formatDuration(plannedFocusMs)}</dd>
      </div>
    {/if}
    {#if flowMs > 0}
      <div>
        <dt>Flow</dt>
        <dd>{formatDuration(flowMs)}</dd>
      </div>
    {/if}
    {#if tookBreak}
      <div>
        <dt>Break</dt>
        <dd>{formatDuration(breakMs)}</dd>
      </div>
    {/if}
    {#if breakIntermissionMs > 0}
      <div>
        <dt>Breaks</dt>
        <dd>{formatDuration(breakIntermissionMs)}</dd>
      </div>
    {/if}
    {#if touchGrassMs > 0}
      <div>
        <dt>Touch Grass</dt>
        <dd>{formatDuration(touchGrassMs)}</dd>
      </div>
    {/if}
    <div>
      <dt>Total elapsed</dt>
      <dd>{formatDuration(totalElapsedMs)}</dd>
    </div>
  </dl>

  <SessionNotes
    content={noteContent}
    onChange={onNoteChange}
    onBlur={onNoteBlur}
    disabled={noteDisabled}
    writesDisabled={noteWritesDisabled}
    onCheckpoint={onCheckpoint}
    checkpointStatus={checkpointStatus}
    onViewRevisions={onViewRevisions}
  />
  {#if hasNoteContent(noteContent)}
    <label class="carry-note">
      <input type="checkbox" bind:checked={carryNoteForward} />
      <span>Carry this note into the next session</span>
    </label>
  {/if}

  <div class="next-duration">
    <label for="next-duration">Next session length</label>
    <div class="next-duration-input">
      <input
        id="next-duration"
        type="number"
        min={MIN_DURATION_MINUTES}
        max={MAX_DURATION_MINUTES}
        step="1"
        bind:value={durationMinutes}
        aria-invalid={durationInvalid}
      />
      <span>min</span>
    </div>
  </div>
  {#if durationInvalid}
    <p class="duration-error">
      Enter a whole number of minutes between {MIN_DURATION_MINUTES} and {MAX_DURATION_MINUTES}.
    </p>
  {/if}

  <div class="parked">
    <h2>Planted thoughts</h2>
    {#if thisSessionThoughts.length === 0}
      <p class="empty">Nothing planted this session.</p>
    {:else}
      <ul>
        {#each thisSessionThoughts as thought (thought.id)}
          <li>
            <span>{thought.text}</span>
            {#if confirmingDeleteId === thought.id}
              <div class="thought-confirm">
                <span class="thought-confirm-text">Delete this thought?</span>
                <button class="link" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
                <button class="link danger" onclick={() => confirmDeleteThought(thought.id)}>Confirm</button>
              </div>
            {:else}
              <div class="actions">
                <button class="link" onclick={() => promote(thought)} disabled={durationInvalid || starting}>
                  Start next from this
                </button>
                <button class="link danger" onclick={() => (confirmingDeleteId = thought.id)}>Delete</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if carriedForwardThoughts.length > 0}
    <div class="parked carried-forward">
      <h2>Still planted from earlier</h2>
      <ul>
        {#each carriedForwardThoughts as thought (thought.id)}
          <li>
            <span>{thought.text}</span>
            {#if confirmingDeleteId === thought.id}
              <div class="thought-confirm">
                <span class="thought-confirm-text">Delete this thought?</span>
                <button class="link" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
                <button class="link danger" onclick={() => confirmDeleteThought(thought.id)}>Confirm</button>
              </div>
            {:else}
              <div class="actions">
                <button class="link" onclick={() => promote(thought)} disabled={durationInvalid || starting}>
                  Start next from this
                </button>
                <button class="link danger" onclick={() => (confirmingDeleteId = thought.id)}>Delete</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <form class="next-session" onsubmit={startNext}>
    <label for="next-task">Or start a new focus task</label>
    <div class="row">
      <input id="next-task" type="text" placeholder="What's next?" bind:value={nextTask} />
      <button type="submit" disabled={!nextTask.trim() || durationInvalid || starting}>Start</button>
    </div>
  </form>

  {#if backToStartError}
    <p class="back-to-start-error" role="alert">{backToStartError}</p>
  {/if}
  <div class="footer-links">
    <button type="button" class="history-link" onclick={onBackToStart}>Back to start</button>
    <button type="button" class="history-link" onclick={onViewHistory}>View history</button>
  </div>
</section>

<style>
  .review {
    padding: 2.5rem 2rem;
    border-radius: 0.5rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .eyebrow {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    text-align: center;
  }

  h1 {
    margin: 0 0 1.5rem;
    font-size: 1.3rem;
    text-align: center;
    color: var(--text);
  }

  .stats {
    display: flex;
    justify-content: center;
    gap: 2rem;
    margin: 0 0 2rem;
    flex-wrap: wrap;
  }

  .stats div {
    text-align: center;
  }

  dt {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.2rem;
  }

  dd {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .next-duration {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    margin: 0 0 1.5rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .next-duration-input {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .next-duration input {
    width: 4rem;
    padding: 0.4rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    text-align: center;
  }

  .next-duration input[aria-invalid='true'] {
    border-color: var(--danger);
  }

  .duration-error {
    margin: -1rem 0 1.5rem;
    text-align: center;
    font-size: 0.8rem;
    color: var(--danger);
  }

  .carry-note {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    /* Left-aligned with the note box's own inner padding (1.25rem) so the
       checkbox lines up with the textarea's visible border above it,
       rather than sitting flush with the outer card edge. */
    margin: -0.75rem 0 1.5rem 1.25rem;
    font-size: 0.85rem;
    color: var(--text-muted);
    cursor: pointer;
  }

  .carry-note input {
    accent-color: var(--timer-accent);
  }

  .parked h2 {
    font-size: 0.95rem;
    margin: 0 0 0.75rem;
    color: var(--text);
  }

  .parked.carried-forward {
    margin-top: 1.25rem;
  }

  .parked.carried-forward h2 {
    color: var(--text-muted);
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 0.8rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  li span {
    font-size: 0.92rem;
    color: var(--text);
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .thought-confirm {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .thought-confirm-text {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .link {
    background: none;
    border: none;
    color: var(--timer-accent);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .link.danger {
    color: var(--danger);
  }

  .link:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .next-session {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
  }

  .next-session label {
    display: block;
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  .row {
    display: flex;
    gap: 0.5rem;
  }

  .row input {
    flex: 1;
    padding: 0.6rem 0.85rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.95rem;
  }

  .row button {
    padding: 0.6rem 1rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-weight: 600;
    cursor: pointer;
  }

  .row button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .back-to-start-error {
    margin: 1.5rem 0 0;
    text-align: center;
    font-size: 0.85rem;
    color: var(--danger);
  }

  .footer-links {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 1.25rem;
    margin: 1.5rem auto 0;
    flex-wrap: wrap;
  }

  .back-to-start-error + .footer-links {
    margin-top: 0.5rem;
  }

  .history-link {
    padding: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    cursor: pointer;
  }
</style>
