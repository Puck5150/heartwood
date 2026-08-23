// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import History from './History.svelte';
import type { SessionSummary } from './history';

afterEach(cleanup);

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    task: 'Write the report',
    completedAt: Date.now(),
    plannedFocusMs: 0,
    actualFocusMs: 0,
    flowMs: 0,
    tookBreak: false,
    breakMs: 0,
    breakIntermissionMs: 0,
    touchGrassMs: 0,
    totalElapsedMs: 0,
    parkedThoughtCount: 0,
    noteContent: 'original note',
    revisionCount: 0,
    projectId: null,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    summaries: [summary()],
    parkedThoughts: [],
    onBack: vi.fn(),
    onDeleteSession: vi.fn(),
    onDeleteAll: vi.fn(),
    onOpenNotesFolder: vi.fn(),
    onViewRevisions: vi.fn(),
    projects: [],
    onAssignProject: vi.fn(),
    onCreateProject: vi.fn(),
    onImport: vi.fn(),
    onEditNote: vi.fn(),
    tasks: [],
    ...overrides,
  };
}

describe('History note editing', () => {
  it('shows the note read-only until Edit is clicked', () => {
    render(History, baseProps());

    expect(screen.getByText('original note')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull();
  });

  it('opens an editable textarea prefilled with the current note', async () => {
    render(History, baseProps());

    await fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));

    expect((screen.getByRole('textbox', { name: 'Edit note' }) as HTMLTextAreaElement).value).toBe(
      'original note',
    );
  });

  it('calls onEditNote with the session id and new content on Save', async () => {
    const onEditNote = vi.fn();
    render(History, baseProps({ onEditNote }));

    await fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await fireEvent.input(screen.getByRole('textbox', { name: 'Edit note' }), {
      target: { value: 'updated note' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(onEditNote).toHaveBeenCalledWith('session-1', 'updated note');
  });

  it('discards edits without calling onEditNote on Cancel', async () => {
    const onEditNote = vi.fn();
    render(History, baseProps({ onEditNote }));

    await fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await fireEvent.input(screen.getByRole('textbox', { name: 'Edit note' }), {
      target: { value: 'discarded draft' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));

    expect(onEditNote).not.toHaveBeenCalled();
    expect(screen.getByText('original note')).toBeTruthy();
  });
});
