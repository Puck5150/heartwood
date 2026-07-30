<script lang="ts">
  // A tiny test-only wrapper — see AppShellHarness.test.svelte's own doc
  // for why a Snippet prop needs a real .svelte template to construct.
  import FocusSupportPanels from './FocusSupportPanels.svelte';
</script>

<FocusSupportPanels>
  {#snippet parking()}
    <input aria-label="Park a thought" />
  {/snippet}
  {#snippet notes()}
    <textarea aria-label="Notes"></textarea>
  {/snippet}
</FocusSupportPanels>
