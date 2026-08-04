<script lang="ts">
  type Props =
    | {
        kind: 'warning';
        leadLabel: string;
        announcement: string | null;
        onPrimary: () => void; // Take break now
        onSecondary: () => void; // Continue focusing
      }
    | {
        kind: 'overtime';
        phase: 'initial' | 'warning' | 'due';
        leadLabel: string | null;
        announcement: string | null;
        onStay: () => void;
        onBreak: () => void;
        onEnd: () => void;
      };

  let props: Props = $props();
</script>

<!--
  Deliberately nonmodal: no dialog/alertdialog role, no aria-modal, no
  scrim, no focus movement. The countdown keeps advancing and every other
  control (timer, notes, Greenhouse, navigation, Settings) stays usable
  while this is visible — see focusWarning.ts's own doc for why. The
  aria-live region carries only the one-time announcement text the
  coordinator hands in; every later render with the same cycle still
  visible passes `announcement: null` here, so it never re-announces on
  its own. -->
<div class="completion-prompt">
  <p class="live" aria-live="polite">{props.announcement ?? ''}</p>
  {#if props.kind === 'warning'}
    <p class="headline">{props.leadLabel} left</p>
    <p class="subline">Ready for a break?</p>
    <p class="detail">The timer keeps moving. Ignore this and the alarm will sound at zero.</p>
    <div class="actions">
      <button type="button" onclick={props.onPrimary}>Take break now</button>
      <button type="button" class="primary" onclick={props.onSecondary}>Continue focusing</button>
    </div>
  {:else}
    <p class="headline">
      {#if props.phase === 'initial'}
        Planned focus complete
      {:else if props.phase === 'warning'}
        {props.leadLabel ?? ''} to next check-in
      {:else}
        Focus check-in
      {/if}
    </p>
    <p class="subline">Stay with it, or step away</p>
    <p class="detail">
      {props.phase === 'warning'
        ? 'Ignore this and the alarm will sound at the next check-in.'
        : 'Overtime stays quiet while you decide.'}
    </p>
    <div class="actions">
      <button type="button" class="primary" onclick={props.onStay}>Stay with it</button>
      <button type="button" onclick={props.onBreak}>Take a break</button>
      <button type="button" class="danger" onclick={props.onEnd}>End session</button>
    </div>
  {/if}
</div>

<style>
  .completion-prompt {
    margin: 1rem auto 0;
    max-width: 24rem;
    padding: 1rem 1.25rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    text-align: center;
  }

  @media (prefers-reduced-motion: no-preference) {
    .completion-prompt {
      animation: fade-in 0.15s ease-out;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .completion-prompt {
      animation: none;
    }
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .live {
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

  .headline {
    margin: 0 0 0.25rem;
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .subline {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .detail {
    margin: 0 0 1rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    justify-content: center;
    gap: 0.6rem;
  }

  .actions button {
    min-height: 44px;
    padding: 0.6rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }

  .actions button.primary {
    border-color: var(--timer-accent);
    background: var(--timer-accent);
    color: var(--on-timer-accent);
  }

  .actions button.danger {
    border-color: var(--danger);
    background: var(--surface);
    color: var(--danger);
  }

  @media (max-width: 639px) {
    .actions {
      flex-direction: column;
    }
  }
</style>
