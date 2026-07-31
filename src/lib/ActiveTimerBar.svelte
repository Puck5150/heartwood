<script lang="ts">
  import type { Snippet } from 'svelte';
  import Pause from 'lucide-svelte/icons/pause';
  import Play from 'lucide-svelte/icons/play';
  import Square from 'lucide-svelte/icons/square';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import { formatDuration } from './format';

  type CompactMode = 'focus' | 'flow' | 'break' | 'intermission';

  let {
    task,
    mode,
    displayMs,
    isPaused,
    displayLabel,
    prompt,
    intermissionControls,
    onReturn,
    onPause,
    onResume,
    onFinish,
  }: {
    task: string;
    mode: CompactMode;
    displayMs: number;
    isPaused: boolean;
    /** Overrides the mode label text (e.g. "Quiet overtime"), matching
     * Timer.svelte's own contract — the compact bar and full timer show
     * the exact same warning/overtime state, never a separate decision UI. */
    displayLabel?: string;
    prompt?: Snippet;
    intermissionControls?: Snippet;
    onPause: () => void;
    onResume: () => void;
    onFinish: () => void;
    onReturn?: () => void;
  } = $props();

  const modeLabel: Record<CompactMode, string> = {
    focus: 'Focusing',
    flow: 'Flow',
    break: 'Break',
    intermission: 'Intermission',
  };

  const finishLabel: Record<Exclude<CompactMode, 'intermission'>, string> = {
    focus: 'Finish early',
    flow: 'Finish session',
    break: 'End break',
  };
</script>

<div
  class="active-timer-bar"
  class:flow={mode === 'flow'}
  class:break={mode === 'break'}
  class:intermission={mode === 'intermission'}
>
  <div class="info">
    <p class="mode-label">{displayLabel ?? modeLabel[mode]}{isPaused ? ' · Paused' : ''}</p>
    <p class="task">{task}</p>
  </div>
  <p class="clock">{formatDuration(displayMs)}</p>
  <div class="controls">
    {#if mode === 'intermission'}
      <button type="button" class="icon-button" onclick={onReturn} title="I'm back">
        <ArrowLeft size={16} aria-hidden="true" />
        I'm back
      </button>
    {:else}
      {#if mode !== 'break'}
        {#if isPaused}
          <button type="button" class="icon-button" onclick={onResume} title="Resume">
            <Play size={16} aria-hidden="true" />
            Resume
          </button>
        {:else}
          <button type="button" class="icon-button" onclick={onPause} title="Pause">
            <Pause size={16} aria-hidden="true" />
            Pause
          </button>
        {/if}
      {/if}
      <button type="button" class="icon-button" onclick={onFinish} title={finishLabel[mode]}>
        <Square size={16} aria-hidden="true" />
        {finishLabel[mode]}
      </button>
    {/if}
  </div>
  {#if prompt}
    <div class="prompt-slot">
      {@render prompt()}
    </div>
  {/if}
  {#if intermissionControls}
    <div class="intermission-slot">
      {@render intermissionControls()}
    </div>
  {/if}
</div>

<style>
  /* A restrained full-width band, not a floating card — no shadow, a
     hairline border for definition instead. */
  .active-timer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    box-shadow: none;
  }

  .active-timer-bar.flow {
    background: var(--flow-surface);
  }

  .active-timer-bar.break {
    background: var(--break-surface);
  }

  .active-timer-bar.intermission {
    border-color: var(--break-accent);
    background: var(--break-surface);
  }

  .info {
    min-width: 0;
  }

  .mode-label {
    margin: 0;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .task {
    margin: 0.1rem 0 0;
    font-weight: 600;
    color: var(--text);
    font-size: 0.95rem;
    overflow-wrap: anywhere;
  }

  .clock {
    margin: 0;
    flex-shrink: 0;
    font-size: 1.4rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .controls button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 44px;
    padding: 0.45rem 0.7rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  /* Forces the prompt onto its own full-width row within the flex-wrap
     bar, below the info/clock/controls row, rather than squeezing beside
     them. */
  .prompt-slot {
    flex-basis: 100%;
  }

  .intermission-slot {
    flex-basis: 100%;
  }
</style>
