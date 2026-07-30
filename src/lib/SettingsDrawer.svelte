<script lang="ts">
  import X from 'lucide-svelte/icons/x';
  import { tick } from 'svelte';
  import {
    APPEARANCE_OPTIONS,
    THEME_OPTIONS,
    TIMER_ACCENT_OPTIONS,
    type AppearanceMode,
    type ThemeFamily,
    type TimerAccent,
  } from './appearance';
  import type { SettingsController } from './settingsController.svelte';
  import ToneSelector from './ToneSelector.svelte';

  let {
    controller,
    onClose,
    onPreviewTone,
  }: {
    controller: SettingsController;
    onClose: () => void;
    onPreviewTone: (id: string) => void;
  } = $props();

  let panel = $state<HTMLDivElement | undefined>();
  let closeButton = $state<HTMLButtonElement | undefined>();

  $effect(() => {
    void tick().then(() => closeButton?.focus());
  });

  const FOCUSABLE =
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel) return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0];
    const last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleScrimClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onClose();
  }
</script>

<div class="scrim" role="presentation" onclick={handleScrimClick}>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-drawer-title"
    tabindex="-1"
    bind:this={panel}
    onkeydown={handleKeydown}
  >
    <div class="panel-header">
      <h2 id="settings-drawer-title">Settings</h2>
      <button type="button" class="icon-button" aria-label="Close settings" bind:this={closeButton} onclick={onClose}>
        <X size={20} aria-hidden="true" />
      </button>
    </div>

    <section class="settings-section">
      <h3>Appearance</h3>

      <fieldset>
        <legend>Theme</legend>
        {#each THEME_OPTIONS as option (option.value)}
          <label class="option">
            <input
              type="radio"
              name="themeFamily"
              value={option.value}
              checked={controller.current.themeFamily === option.value}
              onchange={() => controller.set('themeFamily', option.value as ThemeFamily)}
            />
            {option.label}
          </label>
        {/each}
      </fieldset>
      {#if controller.errors.themeFamily}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('themeFamily')}>Retry theme</button>
        </p>
      {/if}

      <fieldset>
        <legend>Mode</legend>
        {#each APPEARANCE_OPTIONS as option (option.value)}
          <label class="option">
            <input
              type="radio"
              name="appearanceMode"
              value={option.value}
              checked={controller.current.appearanceMode === option.value}
              onchange={() => controller.set('appearanceMode', option.value as AppearanceMode)}
            />
            {option.label}
          </label>
        {/each}
      </fieldset>
      {#if controller.errors.appearanceMode}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('appearanceMode')}>Retry mode</button>
        </p>
      {/if}

      <fieldset>
        <legend>Timer accent</legend>
        {#each TIMER_ACCENT_OPTIONS as option (option.value)}
          <label class="option">
            <input
              type="radio"
              name="timerAccent"
              value={option.value}
              checked={controller.current.timerAccent === option.value}
              onchange={() => controller.set('timerAccent', option.value as TimerAccent)}
            />
            {option.label}
          </label>
        {/each}
      </fieldset>
      {#if controller.errors.timerAccent}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('timerAccent')}>Retry timer accent</button>
        </p>
      {/if}
    </section>

    <section class="settings-section">
      <h3>Audio</h3>
      <ToneSelector
        selectedToneId={controller.current.selectedToneId}
        onSelect={(id) => controller.set('selectedToneId', id)}
        onPreview={onPreviewTone}
      />
      {#if controller.errors.selectedToneId}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('selectedToneId')}>Retry tone</button>
        </p>
      {/if}
    </section>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--text) 35%, transparent);
    display: flex;
    justify-content: flex-end;
    z-index: 100;
  }

  .panel {
    width: min(22rem, 100%);
    height: 100%;
    overflow-y: auto;
    background: var(--surface);
    box-shadow: var(--shadow);
    padding: 1.5rem;
    animation: slide-in 0.2s ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    .panel {
      animation: none;
    }
  }

  @keyframes slide-in {
    from {
      transform: translateX(100%);
    }
    to {
      transform: translateX(0);
    }
  }

  @media (max-width: 639px) {
    .panel {
      width: 100%;
    }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }

  .panel-header h2 {
    margin: 0;
    font-size: 1.2rem;
    color: var(--text);
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.75rem;
    min-height: 2.75rem;
    padding: 0;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  .settings-section {
    padding: 1rem 0;
    border-top: 1px solid var(--border);
  }

  .settings-section:first-of-type {
    border-top: none;
    padding-top: 0;
  }

  .settings-section h3 {
    margin: 0 0 0.75rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  fieldset {
    border: none;
    margin: 0 0 1rem;
    padding: 0;
  }

  legend {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.5rem;
    padding: 0;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
    font-size: 0.88rem;
    color: var(--text);
    cursor: pointer;
  }

  .setting-error {
    margin: -0.5rem 0 1rem;
    font-size: 0.8rem;
    color: var(--danger);
  }

  .link {
    background: none;
    border: none;
    color: inherit;
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    cursor: pointer;
    padding: 0;
    margin-left: 0.4rem;
  }
</style>
