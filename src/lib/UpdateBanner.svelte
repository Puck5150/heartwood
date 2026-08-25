<script lang="ts">
  let {
    stage,
    version,
    error,
    finalizeLabel = 'Restart now',
    onUpdate,
    onRestart,
    onDismiss,
  }: {
    stage: 'available' | 'downloading' | 'ready';
    version: string | null;
    error: string | null;
    /** Android hands off to the OS installer rather than restarting itself
     * in place — see androidUpdate.ts's own doc for why "relaunch" there
     * doesn't mean what it means on desktop. */
    finalizeLabel?: string;
    onUpdate: () => void;
    onRestart: () => void;
    onDismiss: () => void;
  } = $props();
</script>

<p class="update-banner" role="status">
  {#if stage === 'available'}
    {#if error}<span class="update-error">{error}</span>{/if}
    Heartwood {version} is available.
    <button type="button" class="action-link" onclick={onUpdate}>Update</button>
    <button type="button" class="dismiss-link" onclick={onDismiss}>Later</button>
  {:else if stage === 'downloading'}
    Downloading Heartwood {version}…
  {:else}
    Update ready.
    <button type="button" class="action-link" onclick={onRestart}>{finalizeLabel}</button>
    <button type="button" class="dismiss-link" onclick={onDismiss}>Later</button>
  {/if}
</p>

<style>
  .update-banner {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .update-error {
    color: var(--danger);
  }

  .action-link,
  .dismiss-link {
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
</style>
