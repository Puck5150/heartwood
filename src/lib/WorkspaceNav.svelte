<script lang="ts">
  import HistoryIcon from 'lucide-svelte/icons/history';
  import TimerIcon from 'lucide-svelte/icons/timer';
  import FileClock from 'lucide-svelte/icons/file-clock';
  import type { WorkspaceView } from './workspace';

  let {
    current,
    showRevisions,
    onNavigate,
  }: {
    current: WorkspaceView;
    /** Revisions has no generic entry point of its own — it's only reached
     * by opening a specific session's history from SessionNotes or
     * History.svelte. This nav only ever offers it as a destination once
     * that view is already active, so the user can see where they are and
     * step back to Focus/History from it. */
    showRevisions: boolean;
    onNavigate: (view: WorkspaceView) => void;
  } = $props();
</script>

<nav class="workspace-nav" aria-label="Workspace">
  <button
    type="button"
    class="nav-item"
    aria-current={current === 'focus' ? 'page' : undefined}
    onclick={() => onNavigate('focus')}
  >
    <TimerIcon size={16} aria-hidden="true" />
    Focus
  </button>
  <button
    type="button"
    class="nav-item"
    aria-current={current === 'history' ? 'page' : undefined}
    onclick={() => onNavigate('history')}
  >
    <HistoryIcon size={16} aria-hidden="true" />
    History
  </button>
  {#if showRevisions}
    <button
      type="button"
      class="nav-item"
      aria-current={current === 'revisions' ? 'page' : undefined}
      onclick={() => onNavigate('revisions')}
    >
      <FileClock size={16} aria-hidden="true" />
      Revisions
    </button>
  {/if}
</nav>

<style>
  .workspace-nav {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }

  .nav-item {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.75rem;
    border-radius: 0.6rem;
    border: 1px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }

  .nav-item[aria-current='page'] {
    background: var(--surface-secondary);
    border-color: var(--border);
    color: var(--text);
  }
</style>
