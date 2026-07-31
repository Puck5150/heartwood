// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ToneSelector from './ToneSelector.svelte';
import {
  DEFAULT_RETURN_TONE_ID,
  DEFAULT_TONE_ID,
  RETURN_TONE_CATALOG,
  TONE_CATALOG,
} from './sound';

afterEach(cleanup);

describe('ToneSelector', () => {
  it('renders one labeled dropdown listing every tone by its stable id', () => {
    render(ToneSelector, { selectedToneId: TONE_CATALOG[0].id, onSelect: vi.fn(), onPreview: vi.fn() });

    const select = screen.getByRole('combobox', { name: 'Alarm tone' });
    expect(select).toBeTruthy();
    for (const tone of TONE_CATALOG) {
      expect(screen.getByRole('option', { name: tone.name }).getAttribute('value')).toBe(tone.id);
    }
  });

  it('selects the currently-selected tone in the dropdown', () => {
    render(ToneSelector, { selectedToneId: 'soft-bell', onSelect: vi.fn(), onPreview: vi.fn() });

    expect((screen.getByRole('combobox', { name: 'Alarm tone' }) as HTMLSelectElement).value).toBe('soft-bell');
  });

  it('emits the newly chosen tone id on change', async () => {
    const onSelect = vi.fn();
    render(ToneSelector, { selectedToneId: TONE_CATALOG[0].id, onSelect, onPreview: vi.fn() });

    await fireEvent.change(screen.getByRole('combobox', { name: 'Alarm tone' }), {
      target: { value: 'soft-bell' },
    });

    expect(onSelect).toHaveBeenCalledWith('soft-bell');
  });

  it('previews the currently-selected tone, not whatever is merely highlighted in the dropdown', async () => {
    const onPreview = vi.fn();
    render(ToneSelector, { selectedToneId: 'rising-arpeggio', onSelect: vi.fn(), onPreview });

    await fireEvent.click(screen.getByRole('button', { name: 'Preview alarm tone' }));

    expect(onPreview).toHaveBeenCalledWith('rising-arpeggio');
  });

  it('falls back to the existing default tone for an unknown persisted selection', () => {
    render(ToneSelector, { selectedToneId: 'not-a-real-tone-id', onSelect: vi.fn(), onPreview: vi.fn() });

    expect((screen.getByRole('combobox', { name: 'Alarm tone' }) as HTMLSelectElement).value).toBe(DEFAULT_TONE_ID);
  });

  it('supports a separately labeled return-tone catalog', async () => {
    const onPreview = vi.fn();
    render(ToneSelector, {
      selectedToneId: 'sad-trombone',
      catalog: RETURN_TONE_CATALOG,
      fallbackToneId: DEFAULT_RETURN_TONE_ID,
      label: 'Return tone',
      controlId: 'return-tone',
      onSelect: vi.fn(),
      onPreview,
    });

    const select = screen.getByRole('combobox', { name: 'Return tone' }) as HTMLSelectElement;
    expect(select.value).toBe('sad-trombone');
    expect(screen.getByRole('option', { name: 'Sad Trombone' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Preview return tone' }));
    expect(onPreview).toHaveBeenCalledWith('sad-trombone');
  });
});
