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

<!--
  One semantic navigation tree — never a separate desktop/mobile pair.
  Each item always renders both its icon and a real, always-present text
  label; only the label's *visual* presentation changes at the shell
  breakpoint (visually hidden on desktop, where it's still available as
  the button's accessible name and its `title` tooltip; visible on
  mobile, where hover tooltips aren't available). AppShell.svelte owns
  *where* this tree sits (a vertical rail vs. a bottom bar); this
  component owns its own item layout/label visibility at that same
  breakpoint.
-->
<nav class="workspace-nav" aria-label="Workspace">
  <button
    type="button"
    class="nav-item"
    aria-current={current === 'focus' ? 'page' : undefined}
    title="Focus"
    onclick={() => onNavigate('focus')}
  >
    <TimerIcon size={20} aria-hidden="true" />
    <span class="nav-label">Focus</span>
  </button>
  <button
    type="button"
    class="nav-item"
    aria-current={current === 'history' ? 'page' : undefined}
    title="History"
    onclick={() => onNavigate('history')}
  >
    <HistoryIcon size={20} aria-hidden="true" />
    <span class="nav-label">History</span>
  </button>
  {#if showRevisions}
    <button
      type="button"
      class="nav-item"
      aria-current={current === 'revisions' ? 'page' : undefined}
      title="Revisions"
      onclick={() => onNavigate('revisions')}
    >
      <FileClock size={20} aria-hidden="true" />
      <span class="nav-label">Revisions</span>
    </button>
  {/if}
</nav>

<style>
  .workspace-nav {
    display: flex;
    flex-direction: row;
    gap: 0.5rem;
  }

  .nav-item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-width: 44px;
    min-height: 44px;
    padding: 0.4rem 0.75rem;
    border-radius: 0.6rem;
    border: 1px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
  }

  .nav-item[aria-current='page'] {
    background: var(--surface-secondary);
    border-color: var(--border);
    color: var(--text);
  }

  /* Desktop: a narrow, icon-led vertical rail — labels stay in the
     accessible name and `title` tooltip rather than taking up visual
     space. */
  @media (min-width: 640px) {
    .workspace-nav {
      flex-direction: column;
    }

    .nav-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  }
</style>
