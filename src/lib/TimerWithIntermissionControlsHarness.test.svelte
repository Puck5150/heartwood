<script lang="ts">
  import Timer from './Timer.svelte';

  let { task, mode, isPaused, displayMs, onPause, onResume, onFinish } = $props();
</script>

{#snippet intermissionControls()}
  <div data-testid="intermission-controls">Step away controls</div>
{/snippet}

<Timer
  {task}
  {mode}
  {isPaused}
  {displayMs}
  {onPause}
  {onResume}
  {onFinish}
  {intermissionControls}
/>
