<script lang="ts">
  let { text, onDismiss }: { text: string; onDismiss: () => void } = $props();
</script>

<p class="first-time-hint" role="status">
  {text}
  <button type="button" class="dismiss-link" onclick={onDismiss}>Got it</button>
</p>

<style>
  .first-time-hint {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .dismiss-link {
    margin-left: 0.5rem;
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font-weight: 700;
    font-size: 0.85rem;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
