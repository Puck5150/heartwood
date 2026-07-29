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
    <button class="secondary" onclick={onFinish}>{finishLabel[mode]}</button>
  </div>
</section>

<style>
  /* Unframed on the continuous app surface — the timer is the primary
     content, not a card. `container-type` lets a future container query
     react to the space AppShell actually gives it without needing to know
     the viewport width directly. */
  .timer {
    container-type: inline-size;
    min-inline-size: 0;
    text-align: center;
    padding: 1.5rem 1rem;
    background: transparent;
    box-shadow: none;
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
    overflow-wrap: anywhere;
  }

  .clock {
    inline-size: min(100%, 7ch);
    margin: 0 auto 1.5rem;
    font-size: 5.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    color: var(--timer-accent);
  }

  /* Flow/break read as visually distinct from countdown mode through
     color alone, matching the accent tokens Task 4 already defines for
     them — not a full-block background now that the timer is unframed. */
  .timer.flow .clock {
    color: var(--flow-accent);
  }

  .timer.break .clock {
    color: var(--break-accent);
  }

  @media (max-width: 639px) {
    .clock {
      font-size: 4rem;
    }
  }

  .progress-track {
    height: 6px;
    border-radius: 999px;
    background: var(--timer-track);
    overflow: hidden;
    margin-bottom: 1.75rem;
  }

  .progress-fill {
    height: 100%;
    background: var(--timer-accent);
    transition: width 0.3s linear;
  }

  .controls {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
  }

  .controls button {
    min-height: 44px;
    padding: 0.7rem 1.25rem;
    border-radius: 0.7rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
  }

  .controls .primary {
    border-color: var(--timer-accent);
    background: var(--timer-accent);
    color: var(--on-timer-accent);
  }
</style>
