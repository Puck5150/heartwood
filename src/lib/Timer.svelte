<script lang="ts">
  import { formatDuration } from './format';

  type Mode = 'focus' | 'flow' | 'break';

  let {
    task,
    mode,
    isPaused,
    displayMs,
    progress = null,
    onPause,
    onResume,
    onFinish,
  }: {
    task: string;
    mode: Mode;
    isPaused: boolean;
    displayMs: number;
    progress?: number | null;
    onPause: () => void;
    onResume: () => void;
    onFinish: () => void;
  } = $props();

  const modeLabel: Record<Mode, string> = {
    focus: 'Focusing',
    flow: 'Flow',
    break: 'Break',
  };

  const finishLabel: Record<Mode, string> = {
    focus: 'Finish early',
    flow: 'Finish session',
    break: 'End break',
  };
</script>

<section class="timer" class:flow={mode === 'flow'} class:break={mode === 'break'}>
  <p class="mode-label">{modeLabel[mode]}{isPaused ? ' · Paused' : ''}</p>
  <h1 class="task">{task}</h1>
  <p class="clock">{formatDuration(displayMs)}</p>

  {#if progress !== null}
    <div class="progress-track" role="presentation">
      <div class="progress-fill" style={`width: ${Math.min(100, progress * 100)}%`}></div>
    </div>
  {/if}

  <div class="controls">
    {#if mode !== 'break'}
      {#if isPaused}
        <button class="primary" onclick={onResume}>Resume</button>
      {:else}
        <button class="primary" onclick={onPause}>Pause</button>
      {/if}
    {/if}
    {#if mode !== 'focus'}
      <button class="secondary" onclick={onFinish}>{finishLabel[mode]}</button>
    {/if}
  </div>
</section>

<style>
  .timer {
    text-align: center;
    padding: 2.5rem 2rem;
    border-radius: 1.25rem;
    background: var(--surface);
    box-shadow: var(--shadow);
    transition: background 0.4s ease;
  }

  .timer.flow {
    background: var(--surface-flow);
  }

  .timer.break {
    background: var(--surface-break);
  }

  .mode-label {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .task {
    margin: 0 0 1.25rem;
    font-size: 1.4rem;
    font-weight: 600;
    color: var(--text);
  }

  .clock {
    margin: 0 0 1.5rem;
    font-size: 3.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    color: var(--text);
  }

  .progress-track {
    height: 6px;
    border-radius: 999px;
    background: var(--track);
    overflow: hidden;
    margin-bottom: 1.75rem;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.3s linear;
  }

  .controls {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
  }
</style>
