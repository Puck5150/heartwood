// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionNotes from './SessionNotes.svelte';

afterEach(cleanup);

describe('SessionNotes', () => {
  it('switches between a stable editor and rendered preview', async () => {
    render(SessionNotes, {
      content: '# Session result',
      onChange: vi.fn(),
    });

    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByRole('heading', { name: 'Session result' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Notes' })).toBeNull();
  });

  it('disables editing when the file is unavailable', () => {
    render(SessionNotes, {
      content: 'preserved draft',
      onChange: vi.fn(),
      disabled: true,
    });
    expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('supports arrow-key movement between Edit and Preview tabs', async () => {
    render(SessionNotes, {
      content: '# Keyboard preview',
      onChange: vi.fn(),
    });
    const edit = screen.getByRole('tab', { name: 'Edit' });

    await fireEvent.keyDown(edit, { key: 'ArrowRight' });

    expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Keyboard preview' })).toBeTruthy();
  });

  it('defaults to the Edit tab', () => {
    render(SessionNotes, { content: 'draft', onChange: vi.fn() });
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('true');
  });

  it('calls onChange with the new textarea value', async () => {
    const onChange = vi.fn();
    render(SessionNotes, { content: '', onChange });

    await fireEvent.input(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'new text' } });

    expect(onChange).toHaveBeenCalledWith('new text');
  });
});
