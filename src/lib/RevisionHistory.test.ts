// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RevisionHistory from './RevisionHistory.svelte';
import type { CurrentNoteSnapshot, LoadedNoteRevision, NoteRevision, RestoreRevisionResult } from './revisions';

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
    onRestore: vi.fn(
      async (revisionId: string, _expectedCurrentHash: string | null): Promise<RestoreRevisionResult> => ({
        note: {
          id: 'n1',
          session_id: 's1',
          content: 'revision content\n',
          file_path: 's1.md',
          content_hash: `restored-${revisionId}`,
          created_at: 0,
          updated_at: 0,
        },
        safetyRevision: null,
      }),
    ),
    onReloadComparison: vi.fn(
      async (): Promise<CurrentNoteSnapshot> => ({ sessionId: 's1', content: 'current content\n', contentHash: 'current-hash' }),
    ),
    onDeleteHistory: vi.fn(async () => {}),
    writesDisabled: false,
    loading: false,
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

  describe('restore', () => {
    it('shows confirmation copy mentioning a safety snapshot when current content is non-blank', async () => {
      render(RevisionHistory, baseProps({ currentContent: 'current content\n' }));

      await fireEvent.click(screen.getByRole('button', { name: 'Restore this revision' }));

      expect(screen.getByText(/saved as a new revision first/)).toBeTruthy();
    });

    it('shows simpler confirmation copy when there is no current content to displace', async () => {
      render(RevisionHistory, baseProps({ currentContent: '   ' }));

      await fireEvent.click(screen.getByRole('button', { name: 'Restore this revision' }));

      expect(screen.getByText('Restore "Session complete" as the current note?')).toBeTruthy();
    });

    it('cancels without calling onRestore', async () => {
      const onRestore = vi.fn();
      render(RevisionHistory, baseProps({ onRestore }));

      await fireEvent.click(screen.getByRole('button', { name: 'Restore this revision' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onRestore).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Restore this revision' })).toBeTruthy();
    });

    it('disables restore when the selected revision already matches current content', () => {
      render(
        RevisionHistory,
        baseProps({ revisions: [revision({ contentHash: 'current-hash' })], currentHash: 'current-hash' }),
      );

      const button = screen.getByRole('button', { name: 'Restore this revision' }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it('restores successfully and shows a status message', async () => {
      const onRestore = vi.fn(
        async (): Promise<RestoreRevisionResult> => ({
          note: {
            id: 'n1',
            session_id: 's1',
            content: 'revision content\n',
            file_path: 's1.md',
            content_hash: 'restored-hash',
            created_at: 0,
            updated_at: 0,
          },
          safetyRevision: null,
        }),
      );
      render(RevisionHistory, baseProps({ onRestore }));

      await fireEvent.click(screen.getByRole('button', { name: 'Restore this revision' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));

      expect(onRestore).toHaveBeenCalledWith('r1', 'current-hash');
      await waitFor(() => {
        expect(screen.getByRole('status').textContent).toBe('Restored.');
      });
    });

    it('shows Reload comparison on a stale conflict and requires a fresh confirmation afterward', async () => {
      const onRestore = vi.fn(async () => {
        throw { code: 'conflict', diskContent: 'newer content', diskHash: 'newer-hash' };
      });
      const onReloadComparison = vi.fn(
        async (): Promise<CurrentNoteSnapshot> => ({ sessionId: 's1', content: 'newer content', contentHash: 'newer-hash' }),
      );
      render(RevisionHistory, baseProps({ onRestore, onReloadComparison }));

      await fireEvent.click(screen.getByRole('button', { name: 'Restore this revision' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('changed since');
      });
      expect(screen.queryByRole('button', { name: 'Confirm restore' })).toBeNull();

      await fireEvent.click(screen.getByRole('button', { name: 'Reload comparison' }));

      expect(onReloadComparison).toHaveBeenCalledOnce();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Restore this revision' })).toBeTruthy();
      });
      expect(screen.queryByText(/changed since/)).toBeNull();
    });
  });

  describe('delete revision history', () => {
    it('shows an inline confirmation stating the note and session will remain', async () => {
      render(RevisionHistory, baseProps());

      await fireEvent.click(screen.getByRole('button', { name: 'Delete revision history' }));

      expect(screen.getByText(/current note and session will remain/)).toBeTruthy();
    });

    it('cancels without calling onDeleteHistory', async () => {
      const onDeleteHistory = vi.fn();
      render(RevisionHistory, baseProps({ onDeleteHistory }));

      await fireEvent.click(screen.getByRole('button', { name: 'Delete revision history' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onDeleteHistory).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Delete revision history' })).toBeTruthy();
    });

    it('calls onDeleteHistory on confirm', async () => {
      const onDeleteHistory = vi.fn(async () => {});
      render(RevisionHistory, baseProps({ onDeleteHistory }));

      await fireEvent.click(screen.getByRole('button', { name: 'Delete revision history' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

      expect(onDeleteHistory).toHaveBeenCalledOnce();
    });

    it('shows an error when onDeleteHistory fails', async () => {
      const onDeleteHistory = vi.fn(async () => {
        throw new Error('boom');
      });
      render(RevisionHistory, baseProps({ onDeleteHistory }));

      await fireEvent.click(screen.getByRole('button', { name: 'Delete revision history' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toBe('Failed to delete revision history.');
      });
    });

    it('is not shown when there are no revisions yet', () => {
      render(RevisionHistory, baseProps({ revisions: [] }));
      expect(screen.queryByRole('button', { name: 'Delete revision history' })).toBeNull();
    });
  });

  describe('loading state', () => {
    it('shows a loading message instead of the empty-state message', () => {
      render(RevisionHistory, baseProps({ loading: true, revisions: [] }));
      expect(screen.getByText('Loading revisions…')).toBeTruthy();
      expect(screen.queryByText(/no revisions yet/i)).toBeNull();
    });

    it('disables Restore, Rename, and Delete revision history while loading', () => {
      render(RevisionHistory, baseProps({ loading: true }));

      const restoreButton = screen.getByRole('button', { name: 'Restore this revision' }) as HTMLButtonElement;
      const renameButton = screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement;
      const deleteButton = screen.getByRole('button', { name: 'Delete revision history' }) as HTMLButtonElement;

      expect(restoreButton.disabled).toBe(true);
      expect(renameButton.disabled).toBe(true);
      expect(deleteButton.disabled).toBe(true);
    });

    it('does not open rename/restore/delete confirmation when clicked while loading', async () => {
      render(RevisionHistory, baseProps({ loading: true }));

      await fireEvent.click(screen.getByRole('button', { name: 'Restore this revision' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Delete revision history' }));

      expect(screen.queryByRole('button', { name: 'Confirm restore' })).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Revision label' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Confirm delete' })).toBeNull();
    });

    it('re-enables all three once loading finishes', () => {
      const { rerender } = render(RevisionHistory, baseProps({ loading: true }));
      rerender(baseProps({ loading: false }));

      const restoreButton = screen.getByRole('button', { name: 'Restore this revision' }) as HTMLButtonElement;
      const renameButton = screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement;
      const deleteButton = screen.getByRole('button', { name: 'Delete revision history' }) as HTMLButtonElement;

      expect(restoreButton.disabled).toBe(false);
      expect(renameButton.disabled).toBe(false);
      expect(deleteButton.disabled).toBe(false);
    });
  });
});
