<script lang="ts">
  import X from 'lucide-svelte/icons/x';
  import { tick } from 'svelte';

  let { onClose }: { onClose: () => void } = $props();

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
    aria-labelledby="help-guide-title"
    tabindex="-1"
    bind:this={panel}
    onkeydown={handleKeydown}
  >
    <div class="panel-header">
      <h2 id="help-guide-title">Help</h2>
      <button type="button" class="icon-button" aria-label="Close help guide" bind:this={closeButton} onclick={onClose}>
        <X size={20} aria-hidden="true" />
      </button>
    </div>

    <section class="guide-section">
      <h3>The pomodoro basics</h3>
      <p>
        Type one task, pick a duration, and start focusing. When the timer ends, take a short
        Break before starting the next one — a steady rhythm of focus and rest is the whole
        idea. Every 4th fully-completed session, Heartwood suggests a longer Touch Grass
        instead of a quick Break.
      </p>
    </section>

    <section class="guide-section">
      <h3>Greenhouse</h3>
      <p>
        A distracting thought mid-focus doesn't have to break your concentration or get lost.
        Plant it in the Greenhouse and come back to it later, without leaving the task you're
        actually on.
      </p>
    </section>

    <section class="guide-section">
      <h3>Break and Touch Grass</h3>
      <p>
        Both pause the clock without ending your session — come back anytime and pick up
        exactly where you left off. Break is a quick pause; Touch Grass is a longer one, meant
        for actually standing up and stepping away from the screen.
      </p>
    </section>

    <section class="guide-section">
      <h3>Projects</h3>
      <p>
        Tag sessions with a project to track focus time and tasks together. Each project has
        its own task board — Backlog, To Do, In Progress, Done — and a history of every
        session logged against it.
      </p>
    </section>

    <section class="guide-section">
      <h3>Soundscapes</h3>
      <p>
        Local, offline ambient audio for focusing — pick a track and volume in the music
        control, independent of the timer itself.
      </p>
    </section>

    <section class="guide-section">
      <h3>Making it yours</h3>
      <p>
        Settings has theme, timer color, and progress-ring style options, plus how much
        warning you get before a session ends and how often Touch Grass gets suggested.
      </p>
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
    width: min(24rem, 100%);
    height: 100%;
    overflow-y: auto;
    background: var(--surface);
    box-shadow: var(--shadow);
    padding: 1.5rem;
    animation: slide-in 0.2s ease-out;
  }

  @keyframes slide-in {
    from {
      transform: translateX(1rem);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .panel {
      animation: none;
    }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
  }

  .panel-header h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.5rem;
    font-weight: 400;
    color: var(--text);
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 0;
    border-radius: 0.5rem;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  .icon-button:hover,
  .icon-button:focus-visible {
    background: var(--surface-secondary);
    color: var(--text);
  }

  .guide-section {
    margin-bottom: 1.25rem;
  }

  .guide-section h3 {
    margin: 0 0 0.35rem;
    font-size: 0.95rem;
    color: var(--text);
  }

  .guide-section p {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1.5;
  }
</style>
