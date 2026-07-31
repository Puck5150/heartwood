<script lang="ts">
  import Volume2 from 'lucide-svelte/icons/volume-2';
  import {
    DEFAULT_TONE_ID,
    TONE_CATALOG,
    type ToneDefinition,
  } from './sound';

  let {
    selectedToneId,
    catalog = TONE_CATALOG,
    fallbackToneId = DEFAULT_TONE_ID,
    label = 'Alarm tone',
    controlId = 'alarm-tone',
    onSelect,
    onPreview,
  }: {
    selectedToneId: string;
    catalog?: ToneDefinition[];
    fallbackToneId?: string;
    label?: string;
    controlId?: string;
    onSelect: (id: string) => void;
    onPreview: (id: string) => void;
  } = $props();

  // Normalized through the existing catalog lookup, matching
  // getToneDefinition()'s own fallback for an unknown/removed id — a
  // persisted selection that no longer exists must never leave the
  // dropdown showing nothing selected.
  const normalizedToneId = $derived(
    catalog.some((tone) => tone.id === selectedToneId) ? selectedToneId : fallbackToneId,
  );
  const previewLabel = $derived(`Preview ${label.toLowerCase()}`);
</script>

<div class="tone-control">
  <label for={controlId}>{label}</label>
  <div class="tone-row">
    <select id={controlId} value={normalizedToneId} onchange={(event) => onSelect(event.currentTarget.value)}>
      {#each catalog as tone (tone.id)}
        <option value={tone.id}>{tone.name}</option>
      {/each}
    </select>
    <button
      type="button"
      class="icon-button"
      aria-label={previewLabel}
      title={previewLabel}
      onclick={() => onPreview(normalizedToneId)}
    >
      <Volume2 size={18} aria-hidden="true" />
    </button>
  </div>
</div>

<style>
  .tone-control {
    margin-top: 1.5rem;
    text-align: left;
  }

  label {
    display: block;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  .tone-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  select {
    flex: 1;
    padding: 0.5rem 0.7rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.75rem;
    min-height: 2.75rem;
    padding: 0;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--timer-accent);
    cursor: pointer;
  }
</style>
