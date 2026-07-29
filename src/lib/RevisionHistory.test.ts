// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RevisionHistory from './RevisionHistory.svelte';
import type { LoadedNoteRevision, NoteRevision } from './revisions';

afterEach(cleanup);

function revision(overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    id: 'r1',
    sessionId: 's1',
    contentHash: 'hash-1',
    kind: 'automatic',
    reason: 'session_completed',
    label: null,
    createdAt: 1000,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof RevisionHistory>[1]> = {}) {
  return {
    sessionId: 's1',
    task: 'Write launch brief',
    sessionDate: 1000,
    currentContent: 'current content\n',
    currentHash: 'current-hash',
    revisions: [revision()],
    loadRevision: vi.fn(async (id: string): Promise<LoadedNoteRevision> => ({ ...revision({ id }), content: 'revision content\n' })),
    onRename: vi.fn(async (id: string, label: string | null) => ({ ...revision({ id, label }) })),
    writesDisabled: false,
    onBack: vi.fn(),
    ...overrides,
  };
}

describe('RevisionHistory', () => {
  it('selects the newest revision by default and shows its metadata', async () => {
    const revisions = [
      revision({ id: 'r2', createdAt: 2000, kind: 'checkpoint', reason: 'manual' }),
      revision({ id: 'r1', createdAt: 1000 }),
    ];
    render(RevisionHistory, baseProps({ revisions }));

    const entries = screen.getAllByRole('button', { name: /Checkpoint|Session complete/ });
    expect(entries[0].getAttribute('aria-pressed')).toBe('true');
    expect(entries[1].getAttribute('aria-pressed')).toBe('false');
  });

  it('loads and displays a diff between the selected revision and current content', async () => {
    const loadRevision = vi.fn(async (): Promise<LoadedNoteRevision> => ({
      ...revision(),
      content: 'old line\n',
    }));
    render(RevisionHistory, baseProps({ loadRevision, currentContent: 'new line\n' }));

    await waitFor(() => {
      expect(screen.getByText('old line')).toBeTruthy();
      expect(screen.getByText('new line')).toBeTruthy();
    });
  });

  it('shows +/- markers distinguishable in text, not just color', async () => {
    const loadRevision = vi.fn(async (): Promise<LoadedNoteRevision> => ({ ...revision(), content: 'old\n' }));
    render(RevisionHistory, baseProps({ loadRevision, currentContent: 'new\n' }));

    await waitFor(() => {
      const rows = screen.getAllByRole('row');
      expect(rows.some((row) => row.textContent?.includes('-') && row.textContent?.includes('old'))).toBe(true);
      expect(rows.some((row) => row.textContent?.includes('+') && row.textContent?.includes('new'))).toBe(true);
    });
  });

  it('switches to Preview and renders the selected revision as sanitized Markdown', async () => {
    const loadRevision = vi.fn(async (): Promise<LoadedNoteRevision> => ({
      ...revision(),
      content: '# Revision heading',
    }));
    render(RevisionHistory, baseProps({ loadRevision }));

    await fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Revision heading' })).toBeTruthy();
    });
  });

  it('falls back to a bounded excerpt for oversized revision content', async () => {
    const huge = 'x'.repeat(600_000);
    const loadRevision = vi.fn(async (): Promise<LoadedNoteRevision> => ({ ...revision(), content: huge }));
    render(RevisionHistory, baseProps({ loadRevision, currentContent: 'small' }));

    await waitFor(() => {
      expect(screen.getByText(/too large/i)).toBeTruthy();
    });
  });

  it('reports unavailable content as an alert rather than an empty diff', async () => {
    const loadRevision = vi.fn(async (): Promise<LoadedNoteRevision> => {
      throw new Error('missing snapshot object');
    });
    render(RevisionHistory, baseProps({ loadRevision }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
  });

  it('renames on Enter and reflects the new label', async () => {
    const onRename = vi.fn(async (id: string, label: string | null) => ({ ...revision({ id, label }) }));
    render(RevisionHistory, baseProps({ onRename }));

    await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Revision label' });
    await fireEvent.input(input, { target: { value: 'Launch draft' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith('r1', 'Launch draft');
    });
  });

  it('cancels rename on Escape without calling onRename', async () => {
    const onRename = vi.fn();
    render(RevisionHistory, baseProps({ onRename }));

    await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Revision label' });
    await fireEvent.input(input, { target: { value: 'Should not save' } });
    await fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Revision label' })).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('saves on blur', async () => {
    const onRename = vi.fn(async (id: string, label: string | null) => ({ ...revision({ id, label }) }));
    render(RevisionHistory, baseProps({ onRename }));

    await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Revision label' });
    await fireEvent.input(input, { target: { value: 'Saved on blur' } });
    await fireEvent.blur(input);

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith('r1', 'Saved on blur');
    });
  });

  it('normalizes a blank rename to null', async () => {
    const onRename = vi.fn(async (id: string, label: string | null) => ({ ...revision({ id, label }) }));
    render(RevisionHistory, baseProps({ onRename, revisions: [revision({ label: 'Old label' })] }));

    await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Revision label' });
    await fireEvent.input(input, { target: { value: '   ' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith('r1', null);
    });
  });

  it('calls onBack when the back control is used', async () => {
    const onBack = vi.fn();
    render(RevisionHistory, baseProps({ onBack }));

    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('shows a message when there are no revisions yet', () => {
    render(RevisionHistory, baseProps({ revisions: [] }));
    expect(screen.getByText(/no revisions/i)).toBeTruthy();
  });
});
