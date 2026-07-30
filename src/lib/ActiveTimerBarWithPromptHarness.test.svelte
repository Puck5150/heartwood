<script lang="ts">
  // A tiny test-only wrapper — see AppShellHarness.test.svelte's own doc
  // for why a Snippet prop needs a real .svelte template to construct.
  import ActiveTimerBar from './ActiveTimerBar.svelte';

  let {
    task,
    mode,
    displayMs,
    isPaused,
    displayLabel,
    onPause,
    onResume,
    onFinish,
  }: {
    task: string;
    mode: 'focus' | 'flow' | 'break';
    displayMs: number;
    isPaused: boolean;
    displayLabel?: string;
    onPause: () => void;
    onResume: () => void;
    onFinish: () => void;
  } = $props();
</script>

<ActiveTimerBar {task} {mode} {displayMs} {isPaused} {displayLabel} {onPause} {onResume} {onFinish}>
  {#snippet prompt()}
    <p data-testid="prompt-slot">Prompt content</p>
  {/snippet}
</ActiveTimerBar>
