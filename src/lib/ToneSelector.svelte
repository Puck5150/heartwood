<script lang="ts">
  import { TONE_CATALOG } from './sound';

  let {
    selectedToneId,
    onSelect,
    onPreview,
  }: {
    selectedToneId: string;
    onSelect: (id: string) => void;
    onPreview: (id: string) => void;
  } = $props();
</script>

<div class="tone-selector">
  <span class="tone-label">Alarm tone</span>
  <ul>
    {#each TONE_CATALOG as tone (tone.id)}
      <li>
        <button
          type="button"
          class="tone-option"
          class:selected={tone.id === selectedToneId}
          onclick={() => onSelect(tone.id)}
          aria-pressed={tone.id === selectedToneId}
        >
          {tone.name}
        </button>
        <button type="button" class="link preview" onclick={() => onPreview(tone.id)}>
          Preview
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .tone-selector {
    margin-top: 1.5rem;
    text-align: left;
  }

  .tone-label {
    display: block;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.7rem;
    border-radius: 0.6rem;
    background: var(--surface-secondary);
  }

  .tone-option {
    flex: 1;
    text-align: left;
    padding: 0;
    background: none;
    border: none;
    font-size: 0.88rem;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
  }

  .tone-option.selected {
    color: var(--timer-accent);
    font-weight: 700;
  }

  .link {
    background: none;
    border: none;
    color: var(--timer-accent);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
  }
</style>
