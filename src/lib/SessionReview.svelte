<script lang="ts">
  import type { ParkedThought } from './parkingLot';
  import { formatDuration } from './format';

  let {
    task,
    plannedFocusMs,
    flowMs,
    tookBreak,
    breakMs,
    totalElapsedMs,
    thisSessionThoughts,
    carriedForwardThoughts,
    onDelete,
    onPromote,
    onStartNext,
  }: {
    task: string;
    plannedFocusMs: number;
    flowMs: number;
    tookBreak: boolean;
    breakMs: number;
    totalElapsedMs: number;
    thisSessionThoughts: ParkedThought[];
    carriedForwardThoughts: ParkedThought[];
    onDelete: (id: string) => void;
    onPromote: (id: string) => void;
    onStartNext: (task: string) => void;
  } = $props();

  let nextTask = $state('');

  function startNext(event: Event) {
    event.preventDefault();
    if (!nextTask.trim()) return;
    onStartNext(nextTask);
    nextTask = '';
  }

  function promote(thought: ParkedThought) {
    onPromote(thought.id);
  }
</script>

<section class="review">
  <p class="eyebrow">Session review</p>
  <h1>{task}</h1>

  <dl class="stats">
    <div>
      <dt>Planned focus</dt>
      <dd>{formatDuration(plannedFocusMs)}</dd>
    </div>
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
    <div>
      <dt>Total elapsed</dt>
      <dd>{formatDuration(totalElapsedMs)}</dd>
    </div>
  </dl>

  <div class="parked">
    <h2>Parked thoughts</h2>
    {#if thisSessionThoughts.length === 0}
      <p class="empty">Nothing parked this session.</p>
    {:else}
      <ul>
        {#each thisSessionThoughts as thought (thought.id)}
          <li>
            <span>{thought.text}</span>
            <div class="actions">
              <button class="link" onclick={() => promote(thought)}>Start next from this</button>
              <button class="link danger" onclick={() => onDelete(thought.id)}>Delete</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if carriedForwardThoughts.length > 0}
    <div class="parked carried-forward">
      <h2>Still parked from earlier</h2>
      <ul>
        {#each carriedForwardThoughts as thought (thought.id)}
          <li>
            <span>{thought.text}</span>
            <div class="actions">
              <button class="link" onclick={() => promote(thought)}>Start next from this</button>
              <button class="link danger" onclick={() => onDelete(thought.id)}>Delete</button>
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <form class="next-session" onsubmit={startNext}>
    <label for="next-task">Or start a new focus task</label>
    <div class="row">
      <input id="next-task" type="text" placeholder="What's next?" bind:value={nextTask} />
      <button type="submit" disabled={!nextTask.trim()}>Start</button>
    </div>
  </form>
</section>

<style>
  .review {
    padding: 2.5rem 2rem;
    border-radius: 1.25rem;
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
    border-radius: 0.6rem;
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

  .link {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .link.danger {
    color: var(--text-muted);
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
    border-radius: 0.6rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.95rem;
  }

  .row button {
    padding: 0.6rem 1rem;
    border-radius: 0.6rem;
    border: none;
    background: var(--accent);
    color: var(--accent-contrast);
    font-weight: 600;
    cursor: pointer;
  }

  .row button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
