<script lang="ts">
  import X from 'lucide-svelte/icons/x';
  import { tick } from 'svelte';
  import {
    APPEARANCE_OPTIONS,
    FOCUS_WARNING_OPTIONS,
    THEME_OPTIONS,
    TIMER_ACCENT_OPTIONS,
    TIMER_PROGRESS_STYLE_OPTIONS,
    TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS,
    type AppearanceMode,
    type FocusWarningLeadMs,
    type ThemeFamily,
    type TimerAccent,
    type TimerProgressStyle,
    type TouchGrassReminderThresholdMs,
  } from './appearance';
  import type { SettingsController } from './settingsController.svelte';
  import type { UpdateController } from './updateController.svelte';
  import ToneSelector from './ToneSelector.svelte';
  import { DEFAULT_RETURN_TONE_ID, RETURN_TONE_CATALOG } from './sound';
  import { SOUNDSCAPE_CATALOG } from './soundscapeCatalog';
  // Read at build time, not via @tauri-apps/api/app's getVersion(): this
  // way works identically in `npm run dev` and the real Tauri build with
  // no new capability/permission, and release automation already keeps
  // package.json/Cargo.toml/tauri.conf.json in lockstep (see
  // scripts/releaseVersion.mjs), so it's always accurate.
  import { version as appVersion } from '../../package.json';
  import { verifyLicenseKey } from './license';

  let {
    controller,
    updateController,
    onClose,
    onPreviewTone,
    onOpenHelp,
    showUpdateCheck = true,
    isPaidUser,
  }: {
    controller: SettingsController;
    updateController: UpdateController;
    onClose: () => void;
    onPreviewTone: (id: string) => void;
    onOpenHelp?: () => void;
    /** False on iOS, where there's no update source to check against — Apple
     * disallows in-app binary updates entirely, so the row would just be
     * dead UI (see App.svelte's isIOSPlatform). */
    showUpdateCheck?: boolean;
    isPaidUser: boolean;
  } = $props();

  // svelte-ignore state_referenced_locally
  let licenseInput = $state(controller.current.licenseKey);
  let licenseValidationError = $state<string | null>(null);

  function submitLicenseKey() {
    const trimmed = licenseInput.trim();
    if (trimmed === '') {
      // Clicking Save with an empty field is the intended way to remove a
      // stored license key — it clears licenseKey back to '' (free tier),
      // same as clearing any other setting field. No confirmation prompt:
      // this mirrors every other setting in this drawer, which all save
      // immediately on change with no undo step.
      licenseValidationError = null;
      controller.set('licenseKey', '');
      return;
    }
    if (verifyLicenseKey(trimmed) === null) {
      licenseValidationError = "That license key isn't valid.";
      return;
    }
    licenseValidationError = null;
    controller.set('licenseKey', trimmed);
  }

  // Manual "Check for updates" feedback: the controller's own automatic
  // background check stays silent on failure by design (see the
  // auto-updater spec — checking is opportunistic, never worth alarming a
  // tester over), but a check the user explicitly asked for needs SOME
  // visible result, even a boring one. Purely local UI state — never
  // changes updateController's own silent-by-default semantics, only
  // watches its stage to decide what this one button should say.
  let manualCheckPending = $state(false);
  let manualCheckMessage = $state<string | null>(null);

  function handleCheckForUpdates() {
    manualCheckPending = true;
    manualCheckMessage = null;
    updateController.startCheck();
  }

  $effect(() => {
    if (!manualCheckPending) return;
    if (updateController.stage === 'idle') {
      manualCheckPending = false;
      manualCheckMessage = "You're up to date.";
    } else if (updateController.stage === 'available') {
      manualCheckPending = false;
      manualCheckMessage = null; // the update banner elsewhere already shows this
    }
  });

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
            <span
              class="swatch theme-swatch"
              data-theme={option.value}
              data-appearance={controller.resolvedAppearance}
              aria-hidden="true"
            ></span>
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
            <span
              class="swatch accent-swatch"
              data-timer-accent={option.value}
              data-appearance={controller.resolvedAppearance}
              aria-hidden="true"
            ></span>
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

      <fieldset>
        <legend>Timer progress</legend>
        {#each TIMER_PROGRESS_STYLE_OPTIONS as option (option.value)}
          <label class="option">
            <input
              type="radio"
              name="timerProgressStyle"
              value={option.value}
              checked={controller.current.timerProgressStyle === option.value}
              onchange={() => controller.set('timerProgressStyle', option.value as TimerProgressStyle)}
            />
            <span class="swatch progress-swatch" aria-hidden="true">
              {#if option.value === 'crown'}
                <svg viewBox="0 0 24 16"><path d="M2,15 A10,10 0 0 1 22,15" /></svg>
              {:else if option.value === 'ring'}
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /></svg>
              {:else}
                <svg viewBox="0 0 24 10"><path d="M2,9 A9,9 0 0 1 22,9" /></svg>
              {/if}
            </span>
            {option.label}
          </label>
        {/each}
      </fieldset>
      {#if controller.errors.timerProgressStyle}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('timerProgressStyle')}
            >Retry timer progress</button
          >
        </p>
      {/if}
    </section>

    <section class="settings-section">
      <h3>Timer</h3>
      <label class="option select-option">
        Focus warning before expiry
        <select
          value={controller.current.focusWarningLeadMs}
          onchange={(event) =>
            controller.set('focusWarningLeadMs', event.currentTarget.value as FocusWarningLeadMs)}
        >
          {#each FOCUS_WARNING_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
      {#if controller.errors.focusWarningLeadMs}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('focusWarningLeadMs')}
            >Retry focus warning</button
          >
        </p>
      {/if}
      <label class="option select-option">
        Touch Grass reminder
        <select
          value={controller.current.touchGrassReminderThresholdMs}
          onchange={(event) =>
            controller.set('touchGrassReminderThresholdMs', event.currentTarget.value as TouchGrassReminderThresholdMs)}
        >
          {#each TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
      {#if controller.errors.touchGrassReminderThresholdMs}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('touchGrassReminderThresholdMs')}
            >Retry Touch Grass reminder</button
          >
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
      <ToneSelector
        selectedToneId={controller.current.selectedReturnToneId}
        catalog={RETURN_TONE_CATALOG}
        fallbackToneId={DEFAULT_RETURN_TONE_ID}
        label="Return tone"
        controlId="return-tone"
        onSelect={(id) => controller.set('selectedReturnToneId', id)}
        onPreview={onPreviewTone}
      />
      {#if controller.errors.selectedReturnToneId}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('selectedReturnToneId')}
            >Retry return tone</button
          >
        </p>
      {/if}
      <details class="music-credits">
        <summary>Music credits</summary>
        <ul>
          {#each SOUNDSCAPE_CATALOG as soundscape (soundscape.id)}
            <li>{soundscape.attribution}</li>
          {/each}
        </ul>
      </details>
    </section>

    <section class="settings-section">
      <h3>License</h3>
      {#if isPaidUser}
        <p class="license-status">Full version unlocked.</p>
      {:else}
        <p class="license-status">Free tier. Enter a license key to unlock the full version.</p>
      {/if}
      <label class="field-label" for="license-key-input">License key</label>
      <input
        id="license-key-input"
        class="text-input"
        type="text"
        bind:value={licenseInput}
        oninput={() => (licenseValidationError = null)}
        placeholder="Paste your license key"
      />
      <button type="button" class="settings-button" onclick={submitLicenseKey}>Save license key</button>
      {#if licenseValidationError}
        <p class="setting-error">{licenseValidationError}</p>
      {/if}
      {#if controller.errors.licenseKey}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('licenseKey')}>Retry license key</button>
        </p>
      {/if}
    </section>

    {#if showUpdateCheck}
      <section class="settings-section">
        <h3>Updates</h3>
        <div class="option select-option">
          <span>Heartwood {appVersion}</span>
          <button
            type="button"
            class="link"
            disabled={manualCheckPending || updateController.stage === 'checking'}
            onclick={handleCheckForUpdates}
          >
            {manualCheckPending || updateController.stage === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
        {#if manualCheckMessage}
          <p class="update-check-message" role="status">{manualCheckMessage}</p>
        {/if}
      </section>
    {/if}

    {#if onOpenHelp}
      <section class="settings-section">
        <h3>Help</h3>
        <button type="button" class="link" onclick={onOpenHelp}>Help guide</button>
      </section>
    {/if}
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

  .swatch {
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
  }

  .theme-swatch {
    background: var(--app-background);
    border: 1px solid var(--border);
  }

  .accent-swatch {
    background: var(--timer-accent);
    border: 1px solid var(--border);
  }

  .progress-swatch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1rem;
    border-radius: 0;
    background: none;
  }

  .progress-swatch svg {
    width: 100%;
    height: 100%;
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 2;
    stroke-linecap: round;
  }

  .select-option {
    justify-content: space-between;
    cursor: default;
  }

  .select-option select {
    padding: 0.4rem 0.6rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
  }

  .setting-error {
    margin: -0.5rem 0 1rem;
    font-size: 0.8rem;
    color: var(--danger);
  }

  .license-status {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .field-label {
    display: block;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.4rem;
  }

  .text-input {
    box-sizing: border-box;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.6rem 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
  }

  .settings-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.75rem;
    margin-top: 0.6rem;
    padding: 0 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }

  .settings-button:hover {
    background: var(--surface);
  }

  .update-check-message {
    margin: -0.5rem 0 1rem;
    font-size: 0.8rem;
    color: var(--text-muted);
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

  .link:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .music-credits {
    margin-top: 1rem;
    color: var(--text-muted);
    font-size: 0.78rem;
  }

  .music-credits summary {
    display: flex;
    align-items: center;
    min-height: 44px;
    color: var(--text);
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .music-credits ul {
    margin: 0.65rem 0 0;
    padding-left: 1.1rem;
  }

  .music-credits li + li {
    margin-top: 0.35rem;
  }
</style>
