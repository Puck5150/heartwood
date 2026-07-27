<script lang="ts">
  import type { SessionSummary } from './history';
  import { formatDateTime, formatDuration } from './format';

  let {
    summaries,
    onBack,
  }: {
    summaries: SessionSummary[];
    onBack: () => void;
  } = $props();
</script>

<section class="history">
  <div class="header">
    <p class="eyebrow">Session history</p>
    <button class="link" onclick={onBack}>Back</button>
  </div>

  {#if summaries.length === 0}
    <p class="empty">No completed sessions yet.</p>
  {:else}
    <ul>
      {#each summaries as summary (summary.id)}
        <li>
          <div class="row-top">
            <span class="task">{summary.task}</span>
            <span class="when">{formatDateTime(summary.completedAt)}</span>
          </div>
          <dl class="stats">
            <div>
              <dt>Focus</dt>
              <dd>{formatDuration(summary.actualFocusMs)}</dd>
            </div>
            {#if summary.actualFocusMs < summary.plannedFocusMs}
              <div>
                <dt>Planned</dt>
                <dd>{formatDuration(summary.plannedFocusMs)}</dd>
              </div>
            {/if}
            {#if summary.flowMs > 0}
              <div>
                <dt>Flow</dt>
                <dd>{formatDuration(summary.flowMs)}</dd>
              </div>
            {/if}
            {#if summary.tookBreak}
              <div>
                <dt>Break</dt>
                <dd>{formatDuration(summary.breakMs)}</dd>
              </div>
            {/if}
            <div>
              <dt>Total</dt>
              <dd>{formatDuration(summary.totalElapsedMs)}</dd>
            </div>
            {#if summary.parkedThoughtCount > 0}
              <div>
                <dt>Parked</dt>
                <dd>{summary.parkedThoughtCount}</dd>
              </div>
            {/if}
          </dl>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .history {
    padding: 2.5rem 2rem;
    border-radius: 1.25rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }

  .eyebrow {
    margin: 0;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .link {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
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
    gap: 0.75rem;
    max-height: 24rem;
    overflow-y: auto;
  }

  li {
    padding: 0.9rem 1rem;
    border-radius: 0.7rem;
    background: var(--surface-secondary);
  }

  .row-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }

  .task {
    font-weight: 600;
    color: var(--text);
    font-size: 0.95rem;
  }

  .when {
    font-size: 0.78rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin: 0;
  }

  dt {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.1rem;
  }

  dd {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
</style>
