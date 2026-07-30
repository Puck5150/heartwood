<script lang="ts">
  // A tiny test-only wrapper — see AppShellHarness.test.svelte's own doc
  // for why a Snippet prop needs a real .svelte template to construct.
  import Timer from './Timer.svelte';

  let {
    task,
    mode,
    isPaused,
    displayMs,
    displayLabel,
    onPause,
    onResume,
    onFinish,
  }: {
    task: string;
    mode: 'focus' | 'flow' | 'break';
    isPaused: boolean;
    displayMs: number;
    displayLabel?: string;
    onPause: () => void;
    onResume: () => void;
    onFinish: () => void;
  } = $props();
</script>

<Timer {task} {mode} {isPaused} {displayMs} {displayLabel} {onPause} {onResume} {onFinish}>
  {#snippet prompt()}
    <p data-testid="prompt-slot">Prompt content</p>
  {/snippet}
</Timer>
