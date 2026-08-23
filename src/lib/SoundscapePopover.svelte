<script lang="ts">
  import { tick } from 'svelte';
  import MusicIcon from 'lucide-svelte/icons/music-2';
  import PauseIcon from 'lucide-svelte/icons/pause';
  import PlayIcon from 'lucide-svelte/icons/play';
  import RetryIcon from 'lucide-svelte/icons/rotate-ccw';
  import { SOUNDSCAPE_CATALOG, type SoundscapeId } from './soundscapeCatalog';
  import type { SoundscapeController } from './soundscapeController.svelte';

  let {
    controller,
    selectedPresetId,
    volume,
    disabledReason,
    selectionError,
    volumeError,
    onSelect,
    onVolume,
    onRetrySelection,
    onRetryVolume,
  }: {
    controller: SoundscapeController;
    selectedPresetId: SoundscapeId;
    volume: string;
    disabledReason: 'intermission' | 'alarm' | null;
    selectionError: string | null;
    volumeError: string | null;
    onSelect: (id: SoundscapeId) => void;
    onVolume: (value: string) => void;
    onRetrySelection: () => void;
    onRetryVolume: () => void;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | undefined>();
  let trigger = $state<HTMLButtonElement | undefined>();

  const actionLabel = $derived(
    disabledReason === 'intermission'
      ? 'Soundscape paused during intermission'
      : disabledReason === 'alarm'
        ? 'Soundscape paused during alarm'
      : controller.snapshot.status === 'playing'
        ? 'Pause soundscape'
        : controller.snapshot.status === 'suspended'
          ? 'Resume audio'
          : controller.snapshot.status === 'error'
            ? 'Retry music'
            : 'Play soundscape',
  );

  async function close(restoreFocus: boolean) {
    open = false;
    if (!restoreFocus) return;
    await tick();
    trigger?.focus();
  }

  function handleAction() {
    if (disabledReason) return;
    if (controller.snapshot.status === 'playing') controller.pause();
    else void controller.play();
  }

  function handleWindowClick(event: MouseEvent) {
    if (open && event.target instanceof Node && !root?.contains(event.target)) void close(false);
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') void close(true);
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div class="soundscape-control" bind:this={root}>
  <button
    type="button"
    class:active={controller.snapshot.status === 'playing'}
    class="music-trigger"
    aria-label="Soundscapes"
    aria-expanded={open}
    aria-controls="soundscape-popover"
    title="Soundscapes"
    bind:this={trigger}
    onclick={() => (open = !open)}
  >
    <MusicIcon size={20} aria-hidden="true" />
    <span class="trigger-label">Soundscapes</span>
  </button>

  {#if open}
    <section
      id="soundscape-popover"
      class="popover"
      aria-labelledby="soundscape-popover-title"
    >
      <header>
        <div>
          <h2 id="soundscape-popover-title">Flow-state music</h2>
          <p>Local and offline</p>
        </div>
        <button type="button" class="playback-action" disabled={disabledReason !== null} onclick={handleAction}>
          {#if controller.snapshot.status === 'playing'}
            <PauseIcon size={17} aria-hidden="true" />
          {:else if controller.snapshot.status === 'suspended' || controller.snapshot.status === 'error'}
            <RetryIcon size={17} aria-hidden="true" />
          {:else}
            <PlayIcon size={17} aria-hidden="true" />
          {/if}
          <span>{actionLabel}</span>
        </button>
      </header>

      {#if controller.snapshot.error}
        <p class="audio-error" role="alert">{controller.snapshot.error}</p>
      {/if}

      <fieldset role="radiogroup" aria-label="Soundscape">
        <legend>Soundscape</legend>
        <div class="preset-list">
          {#each SOUNDSCAPE_CATALOG as preset (preset.id)}
            <label class:selected={selectedPresetId === preset.id}>
              <input
                type="radio"
                name="soundscape"
                value={preset.id}
                checked={selectedPresetId === preset.id}
                onchange={() => onSelect(preset.id)}
              />
              <span>
                <strong>{preset.name}</strong>
                <small>{preset.description}</small>
              </span>
            </label>
          {/each}
        </div>
      </fieldset>

      {#if selectionError}
        <div class="save-error" role="status">
          Soundscape not saved.
          <button type="button" onclick={onRetrySelection}>Retry soundscape selection</button>
        </div>
      {/if}

      <label class="volume-control">
        <span>Soundscape volume <output>{Math.round(Number(volume) * 100)}%</output></span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          aria-label="Soundscape volume"
          oninput={(event) => onVolume(event.currentTarget.value)}
        />
      </label>

      {#if volumeError}
        <div class="save-error" role="status">
          Volume not saved.
          <button type="button" onclick={onRetryVolume}>Retry soundscape volume</button>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .soundscape-control {
    position: relative;
  }

  .music-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-width: 44px;
    min-height: 44px;
    padding: 0.4rem 0.75rem;
    border: 1px solid transparent;
    border-radius: 0.5rem;
    background: none;
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
  }

  .music-trigger:hover,
  .music-trigger:focus-visible,
  .music-trigger.active {
    border-color: var(--border);
    background: var(--surface-secondary);
    color: var(--text);
  }

  .popover {
    position: fixed;
    z-index: 80;
    top: 0.5rem;
    left: 4.4rem;
    width: min(22rem, calc(100vw - 1rem));
    max-height: min(38rem, calc(100vh - 1rem));
    overflow-y: auto;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.9rem;
  }

  h2 {
    margin: 0;
    font-size: 1rem;
  }

  header p {
    margin: 0.15rem 0 0;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .playback-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    min-height: 44px;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: var(--surface-secondary);
    color: var(--text);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .playback-action:disabled {
    cursor: default;
    opacity: 0.6;
  }

  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend,
  .volume-control > span {
    margin-bottom: 0.4rem;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 700;
  }

  .preset-list {
    display: grid;
    gap: 0.25rem;
  }

  .preset-list label {
    display: grid;
    grid-template-columns: 1rem minmax(0, 1fr);
    gap: 0.6rem;
    align-items: start;
    min-height: 44px;
    padding: 0.55rem;
    border: 1px solid transparent;
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .preset-list label:hover,
  .preset-list label.selected {
    border-color: var(--border);
    background: var(--surface-secondary);
  }

  .preset-list input {
    margin: 0.2rem 0 0;
    accent-color: var(--timer-accent);
  }

  .preset-list span {
    min-width: 0;
  }

  .preset-list strong,
  .preset-list small {
    display: block;
  }

  .preset-list strong {
    font-size: 0.82rem;
  }

  .preset-list small {
    margin-top: 0.12rem;
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.35;
  }

  .volume-control {
    display: grid;
    margin-top: 0.9rem;
  }

  .volume-control > span {
    display: flex;
    justify-content: space-between;
  }

  .volume-control input {
    width: 100%;
    min-height: 44px;
    accent-color: var(--timer-accent);
  }

  output {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .audio-error,
  .save-error {
    margin: 0.55rem 0;
    color: var(--danger);
    font-size: 0.75rem;
  }

  .save-error button {
    min-height: 44px;
    padding: 0 0.35rem;
    border: 0;
    background: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }

  @media (max-width: 639px) {
    .popover {
      top: auto;
      right: 0.5rem;
      bottom: 4.5rem;
      left: auto;
      max-height: calc(100vh - 5rem);
    }
  }

  /* Same reasoning as WorkspaceNav's own <420px rule: stack instead of
     dropping the label, so a narrow phone still shows it. */
  @media (max-width: 420px) {
    .music-trigger {
      flex-direction: column;
      gap: 0.1rem;
      padding-inline: 0;
    }

    .trigger-label {
      /* >=11px: the project's own documented legibility floor (see
         History.svelte's `dt` rule) — 0.6rem (9.6px) fell under it. */
      font-size: 0.7rem;
    }
  }

  /* Matches WorkspaceNav/AppShell's own desktop rail treatment: icon-led
     but never unlabeled — a small caption stays visible under the icon
     instead of collapsing to tooltip-only. */
  @media (min-width: 640px) {
    .music-trigger {
      flex-direction: column;
      gap: 0.15rem;
      min-width: 3.25rem;
      padding: 0.5rem 0.4rem;
    }

    .trigger-label {
      /* >=11px: see the <420px rule's own note above. */
      font-size: 0.7rem;
    }
  }
</style>
