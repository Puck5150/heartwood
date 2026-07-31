<script lang="ts">
  import Coffee from 'lucide-svelte/icons/coffee';
  import Footprints from 'lucide-svelte/icons/footprints';

  let {
    breakDurationMs,
    touchGrassDurationMs,
    onStartBreak,
    onStartTouchGrass,
    onCycleBreak,
    onCycleTouchGrass,
  }: {
    breakDurationMs: number;
    touchGrassDurationMs: number;
    onStartBreak: () => void;
    onStartTouchGrass: () => void;
    onCycleBreak: () => void;
    onCycleTouchGrass: () => void;
  } = $props();

  const minutes = (durationMs: number) => durationMs / 60_000;
</script>

<section class="step-away" aria-label="Step away">
  <p>Step away</p>
  <div class="actions">
    <div class="action-group">
      <button type="button" class="action" onclick={onStartBreak}>
        <Coffee size={17} aria-hidden="true" />
        Break
      </button>
      <button
        type="button"
        class="duration"
        onclick={onCycleBreak}
        aria-label={`Break duration: ${minutes(breakDurationMs)} minutes. Change duration`}
      >
        {minutes(breakDurationMs)} min
      </button>
    </div>
    <div class="action-group">
      <button type="button" class="action touch-grass" onclick={onStartTouchGrass}>
        <Footprints size={17} aria-hidden="true" />
        Touch grass
      </button>
      <button
        type="button"
        class="duration"
        onclick={onCycleTouchGrass}
        aria-label={`Touch Grass duration: ${minutes(touchGrassDurationMs)} minutes. Change duration`}
      >
        {minutes(touchGrassDurationMs)} min
      </button>
    </div>
  </div>
</section>

<style>
  .step-away {
    max-width: 38rem;
    margin: 1rem auto 0;
    padding-top: 0.9rem;
    border-top: 1px solid var(--border);
  }

  .step-away > p {
    margin: 0 0 0.55rem;
    color: var(--text-muted);
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .actions {
    display: flex;
    justify-content: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }

  .action-group {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    min-width: 0;
  }

  button {
    min-height: 44px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-width: 8.5rem;
    padding: 0.5rem 0.8rem;
    border-radius: 0.5rem 0 0 0.5rem;
  }

  .touch-grass {
    color: var(--break-accent);
  }

  .duration {
    min-width: 4.25rem;
    padding: 0.5rem 0.55rem;
    border-left: 0;
    border-radius: 0 0.5rem 0.5rem 0;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  button:hover {
    background: var(--surface-secondary);
  }

  button:focus-visible {
    outline: 3px solid var(--focus-ring);
    outline-offset: 2px;
  }

  @media (max-width: 479px) {
    .actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
    }

    .action-group {
      width: 100%;
    }
  }
</style>
