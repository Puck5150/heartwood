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
import type { CreateRevisionRequest, NoteRevision } from './lib/revisions';

const soundMocks = vi.hoisted(() => ({ playTone: vi.fn() }));
vi.mock('./lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/sound')>();
  return { ...actual, playTone: soundMocks.playTone };
});

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
  loadNoteRevisionCounts: vi.fn(async () => new Map<string, number>()),
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
  createNoteRevision: vi.fn(async (request: CreateRevisionRequest) => ({
    id: `rev-${request.contentHash}`,
    sessionId: request.sessionId,
    contentHash: request.contentHash,
    kind: request.kind,
    reason: request.reason,
    label: null,
    createdAt: request.createdAt,
  })),
  listNoteRevisions: vi.fn(async (_sessionId: string): Promise<NoteRevision[]> => []),
  loadNoteRevision: vi.fn(async (_revisionId: string) => {
    throw new Error('not implemented in this test');
  }),
  renameNoteRevision: vi.fn(async (_revisionId: string, _label: string | null) => {
    throw new Error('not implemented in this test');
  }),
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

describe('Timer independence from workspace navigation (Phase 4C Task 1)', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // start idle so a fresh focus session can be created
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startOneMinuteFocusAndOpenHistory() {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    await fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByText('Session history')).toBeTruthy();
  }

  it('plays the completion alarm once and keeps History visible when focus expires while History is open', async () => {
    await startOneMinuteFocusAndOpenHistory();

    await vi.advanceTimersByTimeAsync(61_000);

    expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: 'Focus complete' })).toBeTruthy();
    expect(screen.getByText('Session history')).toBeTruthy();
  });

  it('does not replay the alarm on later ticks once focus has completed', async () => {
    await startOneMinuteFocusAndOpenHistory();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(soundMocks.playTone).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
  });
});

describe('Revision checkpoints and automatic snapshots (Phase 4C Task 6)', () => {
  it('keeps navigation immediate and disables checkpoint while a note save is failing', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.saveNote.mockRejectedValue({ code: 'missing', relativePath: 's1.md' });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'draft content' } });
    await fireEvent.blur(textarea);

    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalled());
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Save checkpoint' }) as HTMLButtonElement).disabled).toBe(true);
    });

    // Read-only navigation must still work immediately despite the failure.
    await fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByText('Session history')).toBeTruthy();
  });

  it('saves a checkpoint and reports non-blocking feedback without leaving the workspace', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.saveNote.mockImplementation(
      async (sessionId: string, content: string, _now: number, _options?: SaveNoteOptions): Promise<SaveNoteResult> => ({
        note: {
          id: 'n1',
          session_id: sessionId,
          content,
          file_path: `${sessionId}.md`,
          content_hash: `hash-${content}`,
          created_at: 0,
          updated_at: 0,
        },
        cleanupPending: false,
      }),
    );

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'checkpoint me' } });
    await fireEvent.blur(textarea);
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));

    await fireEvent.click(screen.getByRole('button', { name: 'Save checkpoint' }));

    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(1));
    const request = mocks.createNoteRevision.mock.calls[0][0] as CreateRevisionRequest;
    expect(request.kind).toBe('checkpoint');
    expect(request.reason).toBe('manual');
    expect(request.content).toBe('checkpoint me');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Checkpoint saved.'));
    // Still on the same workspace — no navigation happened.
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeTruthy();
  });

  it('plays the completion alarm once and keeps Revisions visible when focus expires while Revisions is open', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(App);
      const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
      await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
      await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

      await fireEvent.click(screen.getByRole('button', { name: 'View revisions' }));
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Write launch brief' })).toBeTruthy());

      await vi.advanceTimersByTimeAsync(61_000);

      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status', { name: 'Focus complete' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Write launch brief' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures the exact content committed at session completion, not a later edit made during review', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    // Only the completion-boundary save ("at completion") is gated. A
    // no-arg flush() re-reads pending/chains after every batch (see
    // noteSaveController.ts), so the review edit made below — scheduled
    // while this save is still in flight — is legitimately picked up as a
    // second, unrelated save before flush() returns; it must resolve on
    // its own so releasing the gated save is enough to let the whole
    // flush settle.
    // Boxed in an object: TypeScript's control-flow analysis doesn't track
    // a bare `let` reassigned only inside a nested closure, so a later
    // `releaseSave?.()` narrows to `null` and fails to type-check even
    // though the assignment does happen at runtime.
    const release: { save: (() => void) | null } = { save: null };
    mocks.saveNote.mockImplementation(
      async (sessionId: string, content: string, _now: number, _options?: SaveNoteOptions): Promise<SaveNoteResult> => {
        if (content === 'at completion') {
          await new Promise<void>((resolve) => {
            release.save = resolve;
          });
        }
        return {
          note: {
            id: 'n1',
            session_id: sessionId,
            content,
            file_path: `${sessionId}.md`,
            content_hash: `hash-${content}`,
            created_at: 0,
            updated_at: 0,
          },
          cleanupPending: false,
        };
      },
    );

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    // Deliberately no blur here: the edit stays pending in the note-save
    // controller so that clicking Finish early's own flush (via
    // applyResult) is what actually triggers the (gated) save below —
    // reproducing the completion transition's real save, not an unrelated
    // earlier one.
    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'at completion' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    // The completion transition's own flush is now gated, simulating an
    // edit landing before it actually resolves.
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));

    const reviewTextarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(reviewTextarea, { target: { value: 'edited during review' } });

    release.save?.();
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalled());

    const request = mocks.createNoteRevision.mock.calls[0][0] as CreateRevisionRequest;
    expect(request.content).toBe('at completion');
    expect(request.reason).toBe('session_completed');
  });

  it('starts the next session without waiting for the automatic snapshot to complete', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.saveNote.mockImplementation(
      async (sessionId: string, content: string, _now: number, _options?: SaveNoteOptions): Promise<SaveNoteResult> => ({
        note: {
          id: 'n1',
          session_id: sessionId,
          content,
          file_path: `${sessionId}.md`,
          content_hash: `hash-${content}`,
          created_at: 0,
          updated_at: 0,
        },
        cleanupPending: false,
      }),
    );
    const release: { create: (() => void) | null } = { create: null };
    mocks.createNoteRevision.mockImplementation(async (request: CreateRevisionRequest) => {
      await new Promise<void>((resolve) => {
        release.create = resolve;
      });
      return {
        id: 'r1',
        sessionId: request.sessionId,
        contentHash: request.contentHash,
        kind: request.kind,
        reason: request.reason,
        label: null,
        createdAt: request.createdAt,
      };
    });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'First task' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'finished note' } });
    await fireEvent.blur(textarea);
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));

    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(1)); // now gated, still pending

    const nextTaskInput = await screen.findByRole('textbox', { name: 'Or start a new focus task' });
    await fireEvent.input(nextTaskInput, { target: { value: 'Second task' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    // The new session starts immediately, without waiting for the gated
    // automatic snapshot to resolve.
    await waitFor(() => {
      expect(screen.getByText('Second task')).toBeTruthy();
    });
    expect(mocks.createNoteRevision).toHaveBeenCalledTimes(1); // still just the one, still pending

    release.create?.();
  });
});
