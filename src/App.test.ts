// @vitest-environment jsdom
//
// App.svelte itself has no prior dedicated test file — its pieces
// (noteSaveController.ts, noteStorage.ts, memoryRepository.ts, etc.) are
// unit-tested directly, and App.svelte's own wiring is normally exercised
// manually. These two tests cover App.svelte-only bugs from the PR #9
// review that no lower-level unit could reach: the startup recovery
// effect and the note-issue Retry handler are both plain closures inside
// the component, not exported functions. `./lib/repository` is mocked so
// each test can inject the exact load/save failure it needs.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import type { SaveNoteOptions, SaveNoteResult, SessionNoteRow } from './lib/notes';
import type { SessionRow } from './lib/persistence';

function completeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1',
    task: 'Write report',
    status: 'complete',
    started_at: 1000,
    planned_duration_ms: 60_000,
    accumulated_pause_ms: 0,
    paused_at: null,
    focus_completed_at: 61_000,
    flow_started_at: null,
    flow_accumulated_pause_ms: null,
    flow_paused_at: null,
    break_started_at: null,
    planned_focus_ms: 60_000,
    actual_focus_ms: 60_000,
    flow_ms: 0,
    took_break: 0,
    break_ms: 0,
    total_elapsed_ms: 61_000,
    completed_at: 61_000,
    updated_at: 61_000,
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  initializeNoteStorage: vi.fn(async () => {}),
  loadLatestSessionRow: vi.fn(async (): Promise<SessionRow | null> => null),
  loadAllParkedThoughts: vi.fn(async () => [] as unknown[]),
  getSetting: vi.fn(async (): Promise<string | null> => null),
  setSetting: vi.fn(async () => {}),
  loadCompletedSessions: vi.fn(async () => [] as unknown[]),
  loadAllSessionNotes: vi.fn(async () => [] as unknown[]),
  saveSession: vi.fn(async () => {}),
  deleteSessionRow: vi.fn(async () => ({ cleanupPending: false })),
  deleteAllData: vi.fn(async () => ({ cleanupPending: false })),
  deleteParkedThoughtRow: vi.fn(async () => {}),
  insertParkedThought: vi.fn(async () => {}),
  openNotesFolder: vi.fn(async () => {}),
  loadNoteRecordForSession: vi.fn(async (_sessionId: string): Promise<SessionNoteRow | null> => null),
  saveNote: vi.fn(
    async (
      _sessionId: string,
      _content: string,
      _now: number,
      _options?: SaveNoteOptions,
    ): Promise<SaveNoteResult> => ({ note: null, cleanupPending: false }),
  ),
}));

vi.mock('./lib/repository', () => mocks);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadLatestSessionRow.mockResolvedValue(completeSessionRow());
  mocks.loadAllParkedThoughts.mockResolvedValue([]);
  mocks.getSetting.mockResolvedValue(null);
  mocks.loadNoteRecordForSession.mockResolvedValue(null);
  mocks.saveNote.mockResolvedValue({ note: null, cleanupPending: false });
});
afterEach(cleanup);

describe('App startup note recovery (prior review round)', () => {
  it('disables the note editor instead of showing a blank draft when the recovered note fails to load', async () => {
    mocks.loadNoteRecordForSession.mockRejectedValue(new Error('disk read failed'));

    render(App);

    await waitFor(() => {
      expect(screen.getByText(/could not be (found|read)/)).toBeTruthy();
    });
    const textarea = (await screen.findByRole('textbox', { name: 'Notes' })) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe('');

    await fireEvent.click(screen.getByRole('button', { name: 'Open Notes Folder' }));
    expect(mocks.openNotesFolder).toHaveBeenCalledTimes(1);
  });
});

describe('App storage-init failure recovery (this review round)', () => {
  it('blocks on a recovery screen when initializeNoteStorage fails, and proceeds after Retry succeeds', async () => {
    mocks.initializeNoteStorage.mockRejectedValueOnce(new Error('disk unavailable'));

    render(App);

    await waitFor(() => {
      expect(screen.getByText(/failed to set up note storage/i)).toBeTruthy();
    });
    // Never falls through to the normal loading/ready screen while blocked.
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(mocks.loadLatestSessionRow).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Open Notes Folder' }));
    expect(mocks.openNotesFolder).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByText(/failed to set up note storage/i)).toBeNull();
    });
    // The rest of startup (session/thoughts/tone recovery) only ever runs
    // once initializeNoteStorage actually succeeds.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Write report' })).toBeTruthy());
    expect(mocks.initializeNoteStorage).toHaveBeenCalledTimes(2);
    expect(mocks.loadLatestSessionRow).toHaveBeenCalledTimes(1);
  });
});

describe('App note-issue Retry (prior review round)', () => {
  it('retries the preserved draft instead of discarding it for a reload', async () => {
    mocks.loadNoteRecordForSession.mockResolvedValue({
      id: 'note-1',
      session_id: 's1',
      content: 'original disk content',
      file_path: 's1.md',
      content_hash: 'hash-1',
      created_at: 1000,
      updated_at: 1000,
    });
    mocks.saveNote.mockRejectedValue({ code: 'missing', relativePath: 's1.md' });

    render(App);
    const textarea = (await screen.findByRole('textbox', { name: 'Notes' })) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('original disk content'));

    await fireEvent.input(textarea, { target: { value: 'a draft that must not be lost' } });
    await fireEvent.blur(textarea);

    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });
    expect(mocks.loadNoteRecordForSession).toHaveBeenCalledTimes(1); // only the initial load so far

    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(2));
    // Retry must re-attempt the save with the preserved draft, not fall
    // back to a disk reload that would discard it.
    expect(mocks.saveNote.mock.calls[1][1]).toBe('a draft that must not be lost');
    expect(mocks.loadNoteRecordForSession).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe(
      'a draft that must not be lost',
    );
  });
});
