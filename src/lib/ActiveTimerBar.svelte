<script lang="ts">
  import Pause from 'lucide-svelte/icons/pause';
  import Play from 'lucide-svelte/icons/play';
  import Square from 'lucide-svelte/icons/square';
  import { formatDuration } from './format';

  type CompactMode = 'focus' | 'flow' | 'break';

  type Props =
    | {
        task: string;
        mode: CompactMode;
        displayMs: number;
        isPaused: boolean;
        onPause: () => void;
        onResume: () => void;
        onFinish: () => void;
      }
    | {
        task: string;
        mode: 'awaitingDecision';
        onBreak: () => void;
        onFlow: () => void;
        onFinish: () => void;
      };

  let props: Props = $props();

  const modeLabel: Record<CompactMode, string> = {
    focus: 'Focusing',
    flow: 'Flow',
    break: 'Break',
  };

  const finishLabel: Record<CompactMode, string> = {
    focus: 'Finish early',
    flow: 'Finish session',
    break: 'End break',
  };
</script>

{#if props.mode === 'awaitingDecision'}
  <div class="active-timer-bar notice" role="status" aria-label="Focus complete">
    <div class="notice-text">
      <p class="eyebrow">Focus complete</p>
      <p class="task">{props.task}</p>
    </div>
    <div class="controls">
      <button type="button" onclick={props.onBreak}>Take a break</button>
      <button type="button" onclick={props.onFlow}>Continue in flow</button>
      <button type="button" class="primary" onclick={props.onFinish}>Finish session</button>
    </div>
  </div>
{:else}
  <div class="active-timer-bar" class:flow={props.mode === 'flow'} class:break={props.mode === 'break'}>
    <div class="info">
      <p class="mode-label">{modeLabel[props.mode]}{props.isPaused ? ' · Paused' : ''}</p>
      <p class="task">{props.task}</p>
    </div>
    <p class="clock">{formatDuration(props.displayMs)}</p>
    <div class="controls">
      {#if props.mode !== 'break'}
        {#if props.isPaused}
          <button type="button" class="icon-button" onclick={props.onResume} title="Resume">
            <Play size={16} aria-hidden="true" />
            Resume
          </button>
        {:else}
          <button type="button" class="icon-button" onclick={props.onPause} title="Pause">
            <Pause size={16} aria-hidden="true" />
            Pause
          </button>
        {/if}
      {/if}
      <button type="button" class="icon-button" onclick={props.onFinish} title={finishLabel[props.mode]}>
        <Square size={16} aria-hidden="true" />
        {finishLabel[props.mode]}
      </button>
    </div>
  </div>
{/if}

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

  .info,
  .notice-text {
    min-width: 0;
  }

  .mode-label,
  .eyebrow {
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

  .controls button.primary {
    background: var(--timer-accent);
    border-color: var(--timer-accent);
    color: var(--on-timer-accent);
  }
</style>
