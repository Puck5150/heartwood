<script lang="ts">
  import type { ParkedThought } from './parkingLot';

  let {
    thoughts,
    onPark,
  }: {
    thoughts: ParkedThought[];
    onPark: (text: string) => void;
  } = $props();

  let draft = $state('');

  function submit(event: Event) {
    event.preventDefault();
    if (!draft.trim()) return;
    onPark(draft);
    draft = '';
  }
</script>

<section class="parking-lot">
  <form onsubmit={submit}>
    <input
      type="text"
      placeholder="Park a thought…"
      bind:value={draft}
      aria-label="Park a thought"
    />
    <button type="submit" disabled={!draft.trim()}>Park</button>
  </form>

  {#if thoughts.length > 0}
    <ul>
      {#each thoughts as thought (thought.id)}
        <li>{thought.text}</li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .parking-lot {
    margin-top: 1.5rem;
    padding: 1.25rem;
    border-radius: 1rem;
    background: var(--surface-secondary);
  }

  form {
    display: flex;
    gap: 0.5rem;
  }

  input {
    flex: 1;
    padding: 0.6rem 0.85rem;
    border-radius: 0.6rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.95rem;
  }

  input:focus {
    outline: 2px solid var(--timer-accent);
    outline-offset: 1px;
  }

  button {
    padding: 0.6rem 1rem;
    border-radius: 0.6rem;
    border: none;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-weight: 600;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  ul {
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 9rem;
    overflow-y: auto;
  }

  li {
    padding: 0.5rem 0.7rem;
    border-radius: 0.5rem;
    background: var(--surface);
    font-size: 0.9rem;
    color: var(--text-muted);
  }
</style>
