<script lang="ts">
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import Coffee from 'lucide-svelte/icons/coffee';
  import Droplet from 'lucide-svelte/icons/droplet';
  import Footprints from 'lucide-svelte/icons/footprints';
  import { formatDuration } from './format';
  import type { IntermissionKind } from './session';

  let {
    task,
    kind,
    displayMs,
    isOvertime,
    onReturn,
    onViewHistory,
  }: {
    task: string;
    kind: IntermissionKind;
    displayMs: number;
    isOvertime: boolean;
    onReturn: () => void;
    onViewHistory?: () => void;
  } = $props();

  const title = $derived(kind === 'break' ? 'Break' : 'Touch Grass');
  const prompt = $derived(
    kind === 'break'
      ? 'Step away from the screen. Get water, stretch, or take care of what you need.'
      : "Go for a frickin' walk.",
  );
</script>

<section class="intermission" class:touch-grass={kind === 'touchGrass'}>
  <p class="mode-label">
    {#if kind === 'break'}
      <Coffee size={17} aria-hidden="true" />
    {:else}
      <Footprints size={17} aria-hidden="true" />
    {/if}
    {isOvertime ? 'Quiet overtime' : title}
  </p>
  <h1>{title}</h1>
  <p class="task">From: {task}</p>
  <p class="clock">{isOvertime ? '+' : ''}{formatDuration(displayMs)}</p>
  <p class="prompt">{prompt}</p>
  {#if kind === 'break'}
    <p class="hydrate-reminder">
      <Droplet size={16} aria-hidden="true" />
      Hydrate!
    </p>
  {/if}
  <button type="button" class="return" onclick={onReturn}>
    <ArrowLeft size={18} aria-hidden="true" />
    I'm back
  </button>
  {#if onViewHistory}
    <button type="button" class="history-link" onclick={onViewHistory}>View history</button>
  {/if}
</section>

<style>
  .intermission {
    min-inline-size: 0;
    max-width: 42rem;
    margin: 0 auto;
    padding: clamp(1rem, 4vh, 2.5rem) 1rem 1rem;
    text-align: center;
  }

  .touch-grass {
    color: var(--text);
  }

  .mode-label {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    color: var(--break-accent);
    font-size: 0.82rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  h1 {
    margin: 0.55rem 0 0;
    color: var(--text);
    font-size: clamp(1.75rem, 6vw, 2.75rem);
    letter-spacing: 0;
    overflow-wrap: anywhere;
  }

  .task {
    margin: 0.3rem auto 0;
    max-width: 34rem;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .clock {
    margin: clamp(1.25rem, 5vh, 2.75rem) 0 0;
    color: var(--text);
    font-size: clamp(3.25rem, 14vw, 6.25rem);
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }

  .prompt {
    max-width: 32rem;
    margin: 1rem auto 1.4rem;
    color: var(--text-muted);
    font-size: 1rem;
  }

  .hydrate-reminder {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    margin: -0.75rem 0 1.4rem;
    color: var(--break-accent);
    font-weight: 600;
    font-size: 0.95rem;
  }

  .return {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    min-height: 44px;
    padding: 0.65rem 1rem;
    border: 0;
    border-radius: 0.5rem;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .return:focus-visible {
    outline: 3px solid var(--focus-ring);
    outline-offset: 3px;
  }

  .history-link {
    display: block;
    margin: 1rem auto 0;
    min-height: 44px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    text-decoration: underline;
  }

  @media (prefers-reduced-motion: reduce) {
    .intermission,
    .return {
      transition: none;
      animation: none;
    }
  }
</style>
