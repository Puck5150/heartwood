<script lang="ts">
  import type { ParkedThought } from './parkingLot';

  let {
    thoughts,
    disabled = false,
    onStart,
  }: {
    thoughts: ParkedThought[];
    disabled?: boolean;
    onStart: (id: string) => void;
  } = $props();
</script>

{#if thoughts.length > 0}
  <section class="parked-thoughts" aria-labelledby="parked-thoughts-heading">
    <h2 id="parked-thoughts-heading">Planted thoughts</h2>
    <ul>
      {#each thoughts as thought (thought.id)}
        <li>
          <span>{thought.text}</span>
          <button
            type="button"
            aria-label={`Start focus: ${thought.text}`}
            {disabled}
            onclick={() => onStart(thought.id)}
          >
            Start
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .parked-thoughts {
    width: min(100%, 32rem);
    margin: 2rem auto 0;
    text-align: left;
  }

  h2 {
    margin: 0 0 0.65rem;
    color: var(--text-muted);
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  ul {
    display: grid;
    gap: 0.5rem;
    max-height: 13rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
    min-height: 3rem;
    padding: 0.6rem 0.65rem 0.6rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  span {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text);
    font-size: 0.95rem;
  }

  button {
    min-height: 44px;
    padding: 0.5rem 0.8rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
  }

  button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  @media (max-width: 639px) {
    .parked-thoughts {
      margin-top: 1.25rem;
    }

    li {
      gap: 0.65rem;
      padding-left: 0.75rem;
    }

    /* Narrower widths wrap thought text across more lines, so a couple of
       rows can already exceed the desktop cap — verified against a
       ~180-character thought, which clipped the row's own Start button at
       13rem. A taller cap here keeps that case fully visible without
       inflating the compact desktop list. */
    ul {
      max-height: 20rem;
    }
  }
</style>
