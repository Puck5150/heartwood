<script lang="ts">
  import type { Snippet } from 'svelte';

  let { parking, notes }: { parking: Snippet; notes: Snippet } = $props();

  // Both panels are always rendered (see the template below) — this only
  // decides which one is *visible* on mobile, so Parking Lot's own local
  // draft state and Session Notes' autosave controller are never
  // interrupted by a tab switch. Desktop ignores this entirely (see
  // `mobile` below) and shows both regions side by side.
  let active = $state<'parking' | 'notes'>('parking');
  let mobile = $state(false);

  $effect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 639px)');
    mobile = media.matches;
    const handleChange = (event: MediaQueryListEvent) => {
      mobile = event.matches;
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  });

  function selectTab(tab: 'parking' | 'notes') {
    active = tab;
  }

  /** WAI-ARIA tabs pattern: ArrowLeft/ArrowRight move both the selection
   * and keyboard focus between the two tabs. */
  function handleTabKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = active === 'parking' ? 'notes' : 'parking';
    active = next;
    const currentTarget = event.currentTarget as HTMLElement;
    const sibling = (event.key === 'ArrowLeft' ? currentTarget.previousElementSibling : currentTarget.nextElementSibling) as HTMLElement | null;
    sibling?.focus();
  }
</script>

<div class="support-tabs" role="tablist" aria-label="Focus support">
  <button
    type="button"
    role="tab"
    id="support-tab-parking"
    aria-selected={active === 'parking'}
    aria-controls="support-panel-parking"
    tabindex={active === 'parking' ? 0 : -1}
    onclick={() => selectTab('parking')}
    onkeydown={handleTabKeydown}
  >
    Parking Lot
  </button>
  <button
    type="button"
    role="tab"
    id="support-tab-notes"
    aria-selected={active === 'notes'}
    aria-controls="support-panel-notes"
    tabindex={active === 'notes' ? 0 : -1}
    onclick={() => selectTab('notes')}
    onkeydown={handleTabKeydown}
  >
    Notes
  </button>
</div>
<div class="support-grid">
  <div
    id="support-panel-parking"
    role="tabpanel"
    tabindex="0"
    aria-labelledby="support-tab-parking"
    hidden={mobile && active !== 'parking'}
    aria-hidden={mobile && active !== 'parking'}
  >
    {@render parking()}
  </div>
  <div
    id="support-panel-notes"
    role="tabpanel"
    tabindex="0"
    aria-labelledby="support-tab-notes"
    hidden={mobile && active !== 'notes'}
    aria-hidden={mobile && active !== 'notes'}
  >
    {@render notes()}
  </div>
</div>

<style>
  .support-tabs {
    display: none;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .support-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    align-items: start;
  }

  @media (max-width: 639px) {
    .support-tabs {
      display: flex;
    }

    .support-grid {
      grid-template-columns: 1fr;
    }
  }

  .support-tabs button {
    flex: 1;
    min-height: 44px;
    padding: 0.5rem 0.75rem;
    border-radius: 0.6rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text-muted);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }

  .support-tabs button[aria-selected='true'] {
    background: var(--surface);
    color: var(--text);
    border-color: var(--focus-ring);
  }
</style>
