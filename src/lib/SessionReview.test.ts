// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/svelte';
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
});
