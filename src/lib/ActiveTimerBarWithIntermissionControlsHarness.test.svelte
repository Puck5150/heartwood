<script lang="ts">
  import ActiveTimerBar from './ActiveTimerBar.svelte';

  let { task, mode, isPaused, displayMs, onPause, onResume, onFinish } = $props();
</script>

{#snippet intermissionControls()}
  <div data-testid="intermission-controls">Step away controls</div>
{/snippet}

<ActiveTimerBar
  {task}
  {mode}
  {isPaused}
  {displayMs}
  {onPause}
  {onResume}
  {onFinish}
  {intermissionControls}
/>
