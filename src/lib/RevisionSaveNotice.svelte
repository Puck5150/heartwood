<script lang="ts">
  /** Renders the background revision-snapshot system's visible failure
   * state — entirely separate from the note's own save failure banner. A
   * revision failure never blocks editing or disables the note; it only
   * means the checkpoint/undo history has a gap until it resolves. Bound
   * directly to a revisionSaveCoordinator's reactive `status` plus its
   * `retry` action; App.svelte owns none of this state itself.
   *
   * `integrityIssue` and `failing`/`needsManualRetry` render as two
   * independent blocks, not an if/else-if — a terminal failure for one
   * session reads first, but must never hide a *different* session's
   * still-exposed manual-retry action. */
  const {
    integrityIssue,
    failing,
    needsManualRetry,
    onRetry,
  }: {
    integrityIssue: boolean;
    failing: boolean;
    needsManualRetry: boolean;
    onRetry: () => void;
  } = $props();
</script>

{#if integrityIssue}
  <div class="note-issue" role="alert">
    <p>
      A revision snapshot could not be saved because of a data-integrity problem. Your note itself is
      safe — only the checkpoint/undo history has a gap for this change.
    </p>
  </div>
{/if}
{#if failing}
  <p class="cleanup-warning" role="status">
    Failed to save a revision snapshot.{needsManualRetry ? '' : ' Retrying…'}
    {#if needsManualRetry}
      <button type="button" class="retry-link" onclick={onRetry}>Retry</button>
    {/if}
  </p>
{/if}

<style>
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
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--text);
    font-size: 0.85rem;
  }

  .note-issue p {
    margin: 0 0 0.5rem;
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
</style>
