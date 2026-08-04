// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FocusSupportPanelsHarness from './FocusSupportPanelsHarness.test.svelte';

/** Stubs `window.matchMedia('(max-width: 639px)')` as matching (mobile) or
 * not (desktop) — jsdom never evaluates real CSS media queries, so the
 * component's own mobile/desktop behavior has to be driven explicitly. */
function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('max-width') ? initialMatches : false,
      media: query,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FocusSupportPanels', () => {
  beforeEach(() => {
    stubMatchMedia(true); // mobile by default — the interesting case for hiding/switching
  });

  it('keeps both rendered snippets mounted (same DOM node, same value) across a mobile tab switch', async () => {
    render(FocusSupportPanelsHarness);

    const parkingInput = screen.getByRole('textbox', { name: 'Plant a thought' });
    await fireEvent.input(parkingInput, { target: { value: 'Remember this' } });

    await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));

    // getByRole excludes hidden elements by default — pass hidden: true
    // since proving this exact node survives *while hidden* is the point.
    const sameParkingInput = screen.getByRole('textbox', { name: 'Plant a thought', hidden: true });
    expect(sameParkingInput).toBe(parkingInput); // never unmounted/remounted
    expect((sameParkingInput as HTMLInputElement).value).toBe('Remember this');
  });

  it('hides the inactive panel from layout and assistive technology on mobile', async () => {
    render(FocusSupportPanelsHarness);

    const parkingInput = screen.getByRole('textbox', { name: 'Plant a thought' });
    const parkingPanel = parkingInput.closest('[role="tabpanel"]')!;
    expect(parkingPanel.hasAttribute('hidden')).toBe(false); // starts active

    await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));

    expect(parkingPanel.hasAttribute('hidden')).toBe(true);
    expect(parkingPanel.getAttribute('aria-hidden')).toBe('true');

    const notesPanel = screen.getByRole('textbox', { name: 'Notes' }).closest('[role="tabpanel"]')!;
    expect(notesPanel.hasAttribute('hidden')).toBe(false);
  });

  it('never hides either panel on desktop, regardless of which tab was last clicked', async () => {
    stubMatchMedia(false); // desktop
    render(FocusSupportPanelsHarness);

    await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));

    const parkingPanel = screen.getByRole('textbox', { name: 'Plant a thought' }).closest('[role="tabpanel"]')!;
    const notesPanel = screen.getByRole('textbox', { name: 'Notes' }).closest('[role="tabpanel"]')!;
    expect(parkingPanel.hasAttribute('hidden')).toBe(false);
    expect(notesPanel.hasAttribute('hidden')).toBe(false);
  });

  it('moves the selected tab with ArrowRight/ArrowLeft', async () => {
    render(FocusSupportPanelsHarness);

    const parkingTab = screen.getByRole('tab', { name: 'Greenhouse' });
    const notesTab = screen.getByRole('tab', { name: 'Notes' });
    parkingTab.focus();

    await fireEvent.keyDown(parkingTab, { key: 'ArrowRight' });
    expect(notesTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(notesTab);

    await fireEvent.keyDown(notesTab, { key: 'ArrowLeft' });
    expect(parkingTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(parkingTab);
  });

  it('wraps ArrowLeft from the first tab to select and focus the last tab', async () => {
    render(FocusSupportPanelsHarness);

    const parkingTab = screen.getByRole('tab', { name: 'Greenhouse' });
    const notesTab = screen.getByRole('tab', { name: 'Notes' });
    parkingTab.focus();

    // Greenhouse is the first tab and has no previousElementSibling —
    // a naive sibling-based implementation drops focus here instead of
    // wrapping to the last tab.
    await fireEvent.keyDown(parkingTab, { key: 'ArrowLeft' });
    expect(notesTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(notesTab);
  });

  it('wraps ArrowRight from the last tab to select and focus the first tab', async () => {
    render(FocusSupportPanelsHarness);

    const parkingTab = screen.getByRole('tab', { name: 'Greenhouse' });
    const notesTab = screen.getByRole('tab', { name: 'Notes' });
    parkingTab.focus();
    await fireEvent.keyDown(parkingTab, { key: 'ArrowRight' }); // Notes becomes the active, focused tab
    expect(notesTab.getAttribute('aria-selected')).toBe('true');

    // Notes is now the last (active) tab and has no nextElementSibling —
    // same failure mode as the ArrowLeft case above, mirrored at the
    // other boundary.
    await fireEvent.keyDown(notesTab, { key: 'ArrowRight' });
    expect(parkingTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(parkingTab);
  });
});
