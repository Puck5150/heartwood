<script lang="ts">
  // A tiny test-only wrapper: @testing-library/svelte's render() can't pass
  // a Snippet prop as a plain value, since a snippet can only be created by
  // an actual `{#snippet}` block in a .svelte template. This harness exists
  // solely so AppShell.test.ts can exercise the real `children` prop (and
  // prove content stays mounted across Settings opening/closing) without
  // AppShell.svelte itself needing any test-only affordance.
  import AppShell from './AppShell.svelte';
  import type { SettingsController } from './settingsController.svelte';
  import type { WorkspaceView } from './workspace';

  let {
    currentWorkspace,
    showRevisions,
    onNavigate,
    settings,
    onPreviewTone,
  }: {
    currentWorkspace: WorkspaceView;
    showRevisions: boolean;
    onNavigate: (view: WorkspaceView) => void;
    settings: SettingsController;
    onPreviewTone: (id: string) => void;
  } = $props();
</script>

<AppShell {currentWorkspace} {showRevisions} {onNavigate} {settings} {onPreviewTone}>
  <input aria-label="Harness input" />
</AppShell>
