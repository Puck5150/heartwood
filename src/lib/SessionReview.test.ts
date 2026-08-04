// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionReview from './SessionReview.svelte';

afterEach(cleanup);

function baseProps() {
  return {
    task: 'Write report',
    plannedFocusMs: 60_000,
    actualFocusMs: 60_000,
    flowMs: 0,
    tookBreak: false,
    breakMs: 0,
    totalElapsedMs: 60_000,
    thisSessionThoughts: [],
    carriedForwardThoughts: [],
    noteContent: 'preserved draft',
    onNoteChange: vi.fn(),
    onNoteBlur: vi.fn(),
    defaultDurationMinutes: 25,
    onDelete: vi.fn(),
    onPromote: vi.fn(),
    onStartNext: vi.fn(),
    onViewHistory: vi.fn(),
    onBackToStart: vi.fn(),
  };
}

describe('SessionReview', () => {
  it('leaves the note editor enabled by default', () => {
    render(SessionReview, baseProps());
    expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('disables the note editor when noteDisabled is set, without losing the draft', () => {
    render(SessionReview, { ...baseProps(), noteDisabled: true });
    const textarea = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe('preserved draft');
  });

  it('offers a way back to the front page, calling onBackToStart', async () => {
    const onBackToStart = vi.fn();
    render(SessionReview, { ...baseProps(), onBackToStart });

    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));
    expect(onBackToStart).toHaveBeenCalledOnce();
  });

  it('requires an inline confirm before deleting a planted thought, and Cancel leaves it in place', async () => {
    const onDelete = vi.fn();
    render(SessionReview, {
      ...baseProps(),
      thisSessionThoughts: [{ id: 't1', text: 'Call the vet', createdAt: 0, sessionId: 's1' }],
      onDelete,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this thought?')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('t1');
  });

  it('shows nonzero intermission totals separately and omits zero values', () => {
    const { rerender } = render(SessionReview, {
      ...baseProps(),
      breakIntermissionMs: 60_000,
      touchGrassMs: 120_000,
    });
    expect(screen.getByText('Breaks')).toBeTruthy();
    expect(screen.getByText('Touch Grass')).toBeTruthy();

    rerender({ ...baseProps(), breakIntermissionMs: 0, touchGrassMs: 0 });
    expect(screen.queryByText('Breaks')).toBeNull();
    expect(screen.queryByText('Touch Grass')).toBeNull();
  });
});
