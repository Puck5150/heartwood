<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import SettingsIcon from 'lucide-svelte/icons/settings';
  import SettingsDrawer from './SettingsDrawer.svelte';
  import WorkspaceNav from './WorkspaceNav.svelte';
  import type { SettingsController } from './settingsController.svelte';
  import type { WorkspaceView } from './workspace';

  let {
    currentWorkspace,
    showRevisions,
    onNavigate,
    settings,
    onPreviewTone,
    children,
  }: {
    currentWorkspace: WorkspaceView;
    showRevisions: boolean;
    onNavigate: (view: WorkspaceView) => void;
    settings: SettingsController;
    onPreviewTone: (id: string) => void;
    children: Snippet;
  } = $props();

  // Owned here, not in App.svelte: this is transient shell UI (which
  // workspace/session state to show is App.svelte's concern; whether the
  // drawer happens to be open right now is this component's own).
  let settingsOpen = $state(false);
  let settingsTrigger = $state<HTMLButtonElement | undefined>();

  async function closeSettings() {
    settingsOpen = false;
    await tick();
    settingsTrigger?.focus();
  }
</script>

<!--
  One shell tree: a single WorkspaceNav instance that AppShell only
  *places* (aside rail on desktop, fixed bottom bar on mobile) — it never
  renders a second, separate mobile nav tree. Root data attributes here are
  the sole source of the resolved theme/appearance/accent for every
  descendant's CSS custom properties. -->
<div
  class="app-shell"
  data-theme={settings.current.themeFamily}
  data-appearance={settings.resolvedAppearance}
  data-timer-accent={settings.current.timerAccent}
>
  <aside class="workspace-rail">
    <WorkspaceNav current={currentWorkspace} {showRevisions} {onNavigate} />
    <button
      type="button"
      class="settings-trigger"
      aria-label="Open settings"
      title="Settings"
      bind:this={settingsTrigger}
      onclick={() => (settingsOpen = true)}
    >
      <SettingsIcon size={20} aria-hidden="true" />
      <span class="settings-trigger-label">Settings</span>
    </button>
  </aside>
  <main class="workspace-content">
    {@render children()}
  </main>
  {#if settingsOpen}
    <SettingsDrawer controller={settings} onClose={closeSettings} {onPreviewTone} />
  {/if}
</div>

<style>
  .app-shell {
    display: flex;
    min-height: 100vh;
    /* The data-theme/data-appearance/data-timer-accent attributes live
       here, not on <html>/<body> — :root's own background never sees
       them, so without repainting here the page canvas would stay stuck
       on :root's Sunlit/Light fallback no matter which theme is active. */
    background: var(--app-background);
    color: var(--text);
  }

  .workspace-rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem 0.5rem;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .settings-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-width: 44px;
    min-height: 44px;
    padding: 0.4rem 0.75rem;
    border-radius: 0.6rem;
    border: 1px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
  }

  .workspace-content {
    flex: 1;
    min-width: 0;
    padding: 1.5rem;
  }

  /* Mobile: the same rail becomes a fixed bottom bar; content gets bottom
     padding so the bar never overlays its own inputs. */
  @media (max-width: 639px) {
    .app-shell {
      flex-direction: column;
    }

    .workspace-rail {
      position: fixed;
      inset-inline: 0;
      bottom: 0;
      flex-direction: row;
      justify-content: center;
      border-right: none;
      border-top: 1px solid var(--border);
      padding: 0.4rem;
      z-index: 50;
    }

    .settings-trigger-label {
      font-size: 0.7rem;
    }

    .workspace-content {
      padding-bottom: calc(1.5rem + 64px);
    }
  }

  @media (min-width: 640px) {
    .settings-trigger-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  }
</style>
