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

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import type { ConflictResolutionResult, SaveNoteOptions, SaveNoteResult, SessionNoteRow } from './lib/notes';
import type { SessionRow } from './lib/persistence';
import { sha256Hex, type CreateRevisionRequest, type NoteRevision, type RestoreRevisionResult } from './lib/revisions';
import { DEFAULT_TONE_ID } from './lib/sound';

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
  getSetting: vi.fn(async (_key: string): Promise<string | null> => null),
  setSetting: vi.fn(async () => {}),
  loadCompletedSessions: vi.fn(async () => [] as unknown[]),
  loadAllSessionNotes: vi.fn(async () => [] as unknown[]),
  loadNoteRevisionCounts: vi.fn(async () => new Map<string, number>()),
  saveSession: vi.fn(async () => {}),
  deleteSessionRow: vi.fn(async () => ({ cleanupPending: false })),
  deleteAllData: vi.fn(async () => ({ cleanupPending: false })),
  deleteNoteRevisionHistory: vi.fn(async (_sessionId: string) => ({ cleanupPending: false })),
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
  keepAppNoteAfterConflict: vi.fn(
    async (_sessionId: string, _draft: string, _conflictHash: string, _now: number): Promise<ConflictResolutionResult> => {
      throw new Error('not implemented in this test');
    },
  ),
  reloadExternalNoteAfterConflict: vi.fn(
    async (_sessionId: string, _draft: string, _conflictHash: string, _now: number): Promise<ConflictResolutionResult> => {
      throw new Error('not implemented in this test');
    },
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
  restoreNoteRevision: vi.fn(
    async (_revisionId: string, _expectedCurrentHash: string | null, _now: number): Promise<RestoreRevisionResult> => {
      throw new Error('not implemented in this test');
    },
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

describe('App startup appearance hydration (Phase 5A Task 3)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('does not render the interactive shell until every appearance key has settled, alongside session/tone hydration', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    const themeGate = deferred<string | null>();
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === 'themeFamily') return themeGate.promise;
      return Promise.resolve(
        (
          {
            appearanceMode: 'dark',
            timerAccent: 'green',
            selectedToneId: 'soft-bell',
          } as Record<string, string>
        )[key] ?? null,
      );
    });

    render(App);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Focus task' })).toBeNull();

    themeGate.resolve('graphite');
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });

    // The resolved shell attributes and the Settings drawer's own tone
    // selection are the observable proof that all four keys were
    // requested in the same startup pass and applied before `ready`.
    const shell = taskInput.closest('[data-theme]')!;
    expect(shell.getAttribute('data-theme')).toBe('graphite');
    expect(shell.getAttribute('data-appearance')).toBe('dark');
    expect(shell.getAttribute('data-timer-accent')).toBe('green');

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect((screen.getByRole('combobox', { name: 'Alarm tone' }) as HTMLSelectElement).value).toBe('soft-bell');
  });

  it('defaults each malformed or missing appearance key independently, and never writes a fallback back during hydration', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === 'themeFamily') return Promise.resolve('not-a-real-theme');
      if (key === 'appearanceMode') return Promise.resolve(null);
      if (key === 'timerAccent') return Promise.resolve('purple');
      if (key === 'selectedToneId') return Promise.resolve('removed-tone');
      return Promise.resolve(null);
    });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });

    const shell = taskInput.closest('[data-theme]')!;
    expect(shell.getAttribute('data-theme')).toBe('sunlit');
    expect(shell.getAttribute('data-timer-accent')).toBe('blue');

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect((screen.getByRole('combobox', { name: 'Alarm tone' }) as HTMLSelectElement).value).toBe(DEFAULT_TONE_ID);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it('still creates the SettingsController and renders the shell with defaults when one getSetting call rejects', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === 'timerAccent') return Promise.reject(new Error('backend unavailable'));
      if (key === 'appearanceMode') return Promise.resolve('dark');
      return Promise.resolve(null);
    });

    render(App);
    // Previously this rejection propagated through the startup Promise.all
    // and skipped settingsController's creation entirely, leaving the app
    // stuck on "Loading…" forever — this proves the shell still renders,
    // with the failed key falling back to its own validated default
    // exactly like a malformed value already does, and every other key
    // (appearanceMode here) still hydrating normally.
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    const shell = taskInput.closest('[data-theme]')!;
    expect(shell.getAttribute('data-timer-accent')).toBe('blue');
    expect(shell.getAttribute('data-appearance')).toBe('dark');
  });

  it('resolves System appearance against the OS preference on the very first render, before any later effect fires', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === 'appearanceMode') return Promise.resolve('system');
      return Promise.resolve(null);
    });
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('dark'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );

    render(App);
    // No fireEvent/tick/effect-flush here on purpose — this must already
    // be correct on the shell's first paint, not just after the
    // subscribeToSystemAppearance component effect gets a chance to run.
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    const shell = taskInput.closest('[data-theme]')!;
    expect(shell.getAttribute('data-appearance')).toBe('dark');

    vi.unstubAllGlobals();
  });
});

describe('App startup session/thought recovery resilience (PR #13 follow-up)', () => {
  it('still creates the SettingsController and renders idle (with starting disabled) when loadLatestSessionRow rejects, preserving successfully loaded parked thoughts', async () => {
    mocks.loadLatestSessionRow.mockRejectedValue(new Error('db unavailable'));
    mocks.loadAllParkedThoughts.mockResolvedValue([{ id: 't1', text: 'Still parked', sessionId: 's-old' }]);

    render(App);
    // Previously an unsettled Promise.all here skipped settingsController's
    // creation entirely, leaving the app on "Loading..." forever. Falls
    // back to idle (recoverSessionState(null, ...)) rather than that.
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    expect(taskInput.closest('[data-theme]')).toBeTruthy(); // shell rendered with a real (default) theme

    expect(screen.getByText('Failed to load your saved session.')).toBeTruthy();
    expect(screen.queryByText('Failed to load your parked thoughts.')).toBeNull(); // independent — thoughts succeeded

    // The persisted active session is still unknown, so starting a new one
    // (which would be built on top of an unverified idle placeholder) is
    // disabled until recovery actually succeeds.
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    expect((screen.getByRole('button', { name: 'Start focusing' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('still creates the SettingsController and renders the shell when loadAllParkedThoughts rejects, preserving the recovered session', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(completeSessionRow());
    mocks.loadAllParkedThoughts.mockRejectedValue(new Error('db unavailable'));

    render(App);
    // A completed session recovers straight to its review screen (Phase
    // 4C) — the observable proof the session half of the load succeeded
    // and wasn't discarded just because the thoughts half failed.
    const heading = await screen.findByRole('heading', { name: 'Write report' });
    expect(heading.closest('[data-theme]')).toBeTruthy();

    expect(screen.getByText('Failed to load your parked thoughts.')).toBeTruthy();
    expect(screen.queryByText('Failed to load your saved session.')).toBeNull(); // independent — session succeeded
  });

  it('a parked-thought Retry preserves the active session and an edited note draft, and never reloads the session', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // starts idle, succeeds
    mocks.loadAllParkedThoughts.mockRejectedValueOnce(new Error('db unavailable'));

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await screen.findByText('Failed to load your parked thoughts.');
    expect(mocks.loadLatestSessionRow).toHaveBeenCalledTimes(1);

    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '25' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    const noteInput = screen.getByRole('textbox', { name: 'Notes' });
    await fireEvent.input(noteInput, { target: { value: 'Unsaved draft' } });

    mocks.loadAllParkedThoughts.mockResolvedValue([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Failed to load your parked thoughts.')).toBeNull());

    // Retrying the thought pool must never touch the session it had
    // nothing to do with — proven by the mock call count, not just the
    // still-correct UI state.
    expect(mocks.loadLatestSessionRow).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Write launch brief' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe('Unsaved draft');
  });

  it('disables starting a new session until a session-recovery Retry succeeds, and clears only its own error', async () => {
    mocks.loadLatestSessionRow.mockRejectedValueOnce(new Error('db unavailable'));
    mocks.loadAllParkedThoughts.mockRejectedValueOnce(new Error('db unavailable'));

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    expect((screen.getByRole('button', { name: 'Start focusing' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Failed to load your parked thoughts.')).toBeTruthy();

    mocks.loadLatestSessionRow.mockResolvedValue(null);
    const sessionBanner = screen.getByText('Failed to load your saved session.').closest('p')!;
    await fireEvent.click(within(sessionBanner).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Failed to load your saved session.')).toBeNull());

    // Only the session-recovery error cleared — the still-unresolved
    // thoughts failure is a fully independent piece of state.
    expect(screen.getByText('Failed to load your parked thoughts.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start focusing' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('never applies a stale response when Retry is clicked again before the first attempt resolves', async () => {
    mocks.loadLatestSessionRow.mockRejectedValueOnce(new Error('db unavailable'));
    mocks.loadAllParkedThoughts.mockResolvedValue([]);

    render(App);
    await screen.findByText('Failed to load your saved session.');

    const slowRow = completeSessionRow({ task: 'Slow stale response' });
    const fastRow = completeSessionRow({ task: 'Fast current response' });
    let resolveSlow!: (value: SessionRow) => void;
    mocks.loadLatestSessionRow
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSlow = resolve)))
      .mockResolvedValueOnce(fastRow);

    // First click starts the slow attempt; second click (a newer
    // generation) starts and finishes first.
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('heading', { name: 'Fast current response' });

    // The slow attempt finally resolves — its result must be discarded
    // rather than clobbering what the newer attempt already applied.
    resolveSlow(slowRow);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByRole('heading', { name: 'Fast current response' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Slow stale response' })).toBeNull();
  });

  it('keeps the recovered session hidden (idle screen, starting disabled) until its note has also settled during a session Retry, then applies the real content with no intermediate blank draft', async () => {
    mocks.loadLatestSessionRow.mockRejectedValueOnce(new Error('db unavailable'));
    mocks.loadAllParkedThoughts.mockResolvedValue([]);
    const focusingRow = completeSessionRow({
      status: 'focusing',
      started_at: Date.now(),
      planned_duration_ms: 60 * 60_000,
      accumulated_pause_ms: 0,
      paused_at: null,
      focus_completed_at: null,
    });
    mocks.loadLatestSessionRow.mockResolvedValueOnce(focusingRow);

    let resolveNote!: (value: SessionNoteRow) => void;
    mocks.loadNoteRecordForSession.mockImplementationOnce(() => new Promise((resolve) => (resolveNote = resolve)));

    render(App);
    await screen.findByText('Failed to load your saved session.');

    mocks.loadLatestSessionRow.mockClear();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // The row loaded fine, but its note is still pending — the recovered
    // session must stay hidden and starting must stay disabled until the
    // whole thing settles together, not just the row.
    expect(screen.queryByRole('heading', { name: 'Write report' })).toBeNull();
    const taskInput = screen.getByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Something else' } });
    expect((screen.getByRole('button', { name: 'Start focusing' }) as HTMLButtonElement).disabled).toBe(true);

    resolveNote({
      id: 'note-1',
      session_id: 's1',
      content: 'Recovered note content',
      file_path: 's1.md',
      content_hash: 'hash-1',
      created_at: 1000,
      updated_at: 1000,
    });
    await screen.findByRole('heading', { name: 'Write report' });

    // The note's real content is already there the instant the recovered
    // session becomes visible at all — never a blank, editable draft
    // first, then the real content a moment later.
    expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe(
      'Recovered note content',
    );
    expect(mocks.loadLatestSessionRow).toHaveBeenCalledTimes(1); // one Retry, one row load
  });

  it('disables parking and preserves its draft while a parked-thought Retry is still pending, then re-enables it without discarding a new thought parked once it lands', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // idle recovers immediately, succeeds
    mocks.loadAllParkedThoughts.mockRejectedValueOnce(new Error('db unavailable'));

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await screen.findByText('Failed to load your parked thoughts.');
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '25' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const parkInput = screen.getByRole('textbox', { name: 'Park a thought' }) as HTMLInputElement;
    expect(parkInput.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Park' }) as HTMLButtonElement).toHaveProperty('disabled', true);

    let resolveThoughts!: (value: unknown[]) => void;
    mocks.loadAllParkedThoughts.mockImplementationOnce(() => new Promise((resolve) => (resolveThoughts = resolve)));
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // Still pending (the deferred load hasn't resolved yet) — parking
    // stays disabled and whatever the user already typed survives.
    await fireEvent.input(parkInput, { target: { value: 'Typed while disabled' } });
    expect(parkInput.disabled).toBe(true);
    expect(parkInput.value).toBe('Typed while disabled');

    resolveThoughts([]);
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Park a thought' }) as HTMLInputElement).disabled).toBe(false));
    expect(screen.queryByText('Failed to load your parked thoughts.')).toBeNull();

    // The preserved draft still submits cleanly now that parking is
    // enabled — recovery succeeding never silently drops it.
    await fireEvent.click(screen.getByRole('button', { name: 'Park' }));
    expect(screen.getByText('Typed while disabled')).toBeTruthy();
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

describe('Timer independence from Settings (Phase 5A Task 6)', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes focus, plays one alarm, and shows the decision UI while Settings is open — and Settings itself is unaffected', async () => {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await fireEvent.click(screen.getByRole('radio', { name: 'Graphite' }));

    await vi.advanceTimersByTimeAsync(61_000);

    expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Your planned session is complete.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take a break' })).toBeTruthy();
    // Settings stayed open and unaffected by the transition underneath it.
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Graphite' }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('Focus support panels (Phase 5A Task 7)', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // start idle so a fresh focus session can be created
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startOneMinuteFocus() {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
  }

  it('keeps an unsaved parked-thought draft mounted across the support-panel tab switch, and preserves note content and pause state across a History round-trip', async () => {
    await startOneMinuteFocus();

    // Parking Lot and Notes are both rendered through FocusSupportPanels —
    // switching the (mobile) tab must never unmount either one.
    const parkingInput = screen.getByRole('textbox', { name: 'Park a thought' });
    await fireEvent.input(parkingInput, { target: { value: 'Ping the design review' } });

    await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    await fireEvent.click(screen.getByRole('tab', { name: 'Parking Lot' }));
    expect((screen.getByRole('textbox', { name: 'Park a thought' }) as HTMLInputElement).value).toBe(
      'Ping the design review',
    );

    const noteInput = screen.getByRole('textbox', { name: 'Notes' });
    await fireEvent.input(noteInput, { target: { value: 'Draft outline' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    // App.svelte owns session and note-draft state independent of which
    // workspace is mounted (Phase 4C), so both survive a full History
    // round-trip even though the focus workspace itself unmounts.
    await fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByText('Session history')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe('Draft outline');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy(); // still running, not stuck paused
  });

  it('renders the same support panels once the session continues in flow', async () => {
    await startOneMinuteFocus();
    await vi.advanceTimersByTimeAsync(61_000); // focus expires naturally into the decision screen
    await fireEvent.click(screen.getByRole('button', { name: 'Continue in flow' }));

    expect(screen.getByRole('tablist', { name: 'Focus support' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Park a thought' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeTruthy();
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

  it('captures the exact content and hash committed at session completion, not a later edit made during review', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    // Only the completion-boundary save ("at completion") is gated. A
    // no-arg flush() re-reads pending/chains after every batch (see
    // noteSaveController.ts), so the review edit made below — scheduled
    // while this save is still in flight — is legitimately picked up as a
    // second, unrelated save before flush() returns; it must resolve on
    // its own so releasing the gated save is enough to let the whole
    // flush settle. That second save's mocked response deliberately
    // returns a content_hash that does *not* match "at completion" — the
    // submitted revision's contentHash must come from App.svelte's own
    // direct sha256Hex(content) computation, never from whatever the most
    // recent save happened to leave in noteHashBySession for this session.
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
            content_hash: 'mismatched-hash-from-a-later-save',
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
    expect(request.contentHash).toBe(await sha256Hex('at completion'));
    expect(request.reason).toBe('session_completed');
  });

  it('captures the exact content and hash committed at session start, not a later edit in the new session', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    // "carry me forward" gets saved twice — once into the original
    // session (via blur) and again into the carried-forward new session —
    // so the gate is keyed on call count (the second save) rather than
    // content, which is identical both times. Its mocked response
    // deliberately returns a mismatched content_hash: the submitted
    // revision's contentHash must be App.svelte's own sha256Hex(content) of
    // the exact carried text, never read back from noteHashBySession after
    // some other edit in the new session has landed.
    const release: { save: (() => void) | null } = { save: null };
    let saveCallCount = 0;
    mocks.saveNote.mockImplementation(
      async (sessionId: string, content: string, _now: number, _options?: SaveNoteOptions): Promise<SaveNoteResult> => {
        saveCallCount += 1;
        if (saveCallCount === 2) {
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
            content_hash: 'mismatched-hash-from-a-later-save',
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

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'carry me forward' } });
    await fireEvent.blur(textarea);
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));

    // Nothing is pending by the time Finish early's own flush runs (the
    // blur above already flushed it) — this transition's session_completed
    // snapshot fires from the already-committed content directly, without
    // needing a second saveNote call.
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await waitFor(() => expect(screen.getByText('Session review')).toBeTruthy());

    await fireEvent.click(screen.getByRole('checkbox', { name: 'Carry this note into the next session' }));
    const nextTaskInput = await screen.findByRole('textbox', { name: 'Or start a new focus task' });
    await fireEvent.input(nextTaskInput, { target: { value: 'Second task' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    // The carried note's own save into the new session is now gated
    // (saveCallCount === 2), simulating a completion-boundary-style race.
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(2));

    // Edit the new (now active) session's note before the carried save's
    // own flush resolves.
    const newSessionTextarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(newSessionTextarea, { target: { value: 'edited in the new session' } });

    release.save?.();
    await waitFor(() => {
      expect(mocks.createNoteRevision.mock.calls.some(([req]) => req.reason === 'session_started')).toBe(true);
    });

    const startedCall = mocks.createNoteRevision.mock.calls.find(
      ([req]) => (req as CreateRevisionRequest).reason === 'session_started',
    );
    const request = startedCall![0] as CreateRevisionRequest;
    expect(request.content).toBe('carry me forward');
    expect(request.contentHash).toBe(await sha256Hex('carry me forward'));
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

describe('External conflict resolution (Phase 4C Task 7)', () => {
  it('resolves Keep my version through the atomic conflict command and clears the banner', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.saveNote.mockRejectedValue({ code: 'conflict', diskContent: 'external edit', diskHash: 'ext-hash' });
    mocks.keepAppNoteAfterConflict.mockResolvedValue({
      note: { id: 'n1', session_id: 's1', content: 'my draft', file_path: 's1.md', content_hash: 'draft-hash', created_at: 0, updated_at: 0 },
      safetyRevision: {
        id: 'r1',
        sessionId: 's1',
        contentHash: 'ext-hash',
        kind: 'safety',
        reason: 'before_external_overwrite',
        label: null,
        createdAt: 2000,
      },
    });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'my draft' } });
    await fireEvent.blur(textarea);

    await waitFor(() => expect(screen.getByText('This note was changed outside the app. Keep your version, or reload the file\'s version?')).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Keep my version' }));

    await waitFor(() => expect(mocks.keepAppNoteAfterConflict).toHaveBeenCalledTimes(1));
    const [sessionId, draft, conflictHash] = mocks.keepAppNoteAfterConflict.mock.calls[0];
    expect(draft).toBe('my draft');
    expect(conflictHash).toBe('ext-hash');
    expect(typeof sessionId).toBe('string');

    await waitFor(() => {
      expect(screen.queryByText(/changed outside the app/)).toBeNull();
    });
  });

  it('shows a fresh conflict instead of overwriting when the disk changed again during Keep', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.saveNote.mockRejectedValue({ code: 'conflict', diskContent: 'external edit', diskHash: 'ext-hash' });
    mocks.keepAppNoteAfterConflict.mockRejectedValue({
      code: 'conflict',
      diskContent: 'second external edit',
      diskHash: 'second-hash',
    });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'my draft' } });
    await fireEvent.blur(textarea);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep my version' })).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Keep my version' }));

    await waitFor(() => expect(mocks.keepAppNoteAfterConflict).toHaveBeenCalledTimes(1));
    // The banner stays up — a fresh conflict, not a resolved one.
    await waitFor(() => {
      expect(screen.getByText('This note was changed outside the app. Keep your version, or reload the file\'s version?')).toBeTruthy();
    });
    const textareaAfter = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(textareaAfter.value).toBe('my draft');
  });

  it('resolves Reload file through the atomic conflict command and replaces the draft', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.saveNote.mockRejectedValue({ code: 'conflict', diskContent: 'external edit', diskHash: 'ext-hash' });
    mocks.reloadExternalNoteAfterConflict.mockResolvedValue({
      note: { id: 'n1', session_id: 's1', content: 'external edit', file_path: 's1.md', content_hash: 'ext-hash', created_at: 0, updated_at: 0 },
      safetyRevision: {
        id: 'r1',
        sessionId: 's1',
        contentHash: 'draft-hash',
        kind: 'safety',
        reason: 'before_external_reload',
        label: null,
        createdAt: 2000,
      },
    });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'my discarded draft' } });
    await fireEvent.blur(textarea);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload file' })).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Reload file' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm reload' }));

    await waitFor(() => expect(mocks.reloadExternalNoteAfterConflict).toHaveBeenCalledTimes(1));
    const [, draft, conflictHash] = mocks.reloadExternalNoteAfterConflict.mock.calls[0];
    expect(draft).toBe('my discarded draft');
    expect(conflictHash).toBe('ext-hash');

    await waitFor(() => {
      const reloadedTextarea = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
      expect(reloadedTextarea.value).toBe('external edit');
    });
  });
});

describe('Revision restore (Phase 4C Task 8)', () => {
  it('restores a revision and updates the live editor for the same session', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.listNoteRevisions.mockResolvedValue([
      {
        id: 'rev-1',
        sessionId: 's1',
        contentHash: 'target-hash',
        kind: 'checkpoint',
        reason: 'manual',
        label: null,
        createdAt: 1000,
      },
    ]);
    mocks.restoreNoteRevision.mockResolvedValue({
      note: {
        id: 'n1',
        session_id: 's1',
        content: 'restored content',
        file_path: 's1.md',
        content_hash: 'target-hash',
        created_at: 0,
        updated_at: 0,
      },
      safetyRevision: null,
    });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    await fireEvent.click(screen.getByRole('button', { name: 'View revisions' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore this revision' })).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Restore this revision' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));

    await waitFor(() => expect(mocks.restoreNoteRevision).toHaveBeenCalledTimes(1));
    expect(mocks.restoreNoteRevision.mock.calls[0][0]).toBe('rev-1');

    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const textarea = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('restored content');
  });
});

describe('Revision history deletion (Phase 4C Task 9)', () => {
  it('deletes only the revision history, leaving the note and workspace nav to Focus alone', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.listNoteRevisions.mockResolvedValue([
      {
        id: 'rev-1',
        sessionId: 's1',
        contentHash: 'target-hash',
        kind: 'checkpoint',
        reason: 'manual',
        label: null,
        createdAt: 1000,
      },
    ]);

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    await fireEvent.click(screen.getByRole('button', { name: 'View revisions' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete revision history' })).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Delete revision history' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(mocks.deleteNoteRevisionHistory).toHaveBeenCalledTimes(1));
    expect(typeof mocks.deleteNoteRevisionHistory.mock.calls[0][0]).toBe('string');

    await waitFor(() => {
      expect(screen.getByText(/no revisions yet/i)).toBeTruthy();
    });
  });
});

describe('Revisions view race safety (review follow-up)', () => {
  it('discards a stale revisions load when the same session view is reopened before it resolves', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    const release: { first: (() => void) | null } = { first: null };
    let callCount = 0;
    mocks.listNoteRevisions.mockImplementation(async (_sessionId: string): Promise<NoteRevision[]> => {
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          release.first = resolve;
        });
        return [
          {
            id: 'rev-stale',
            sessionId: 's1',
            contentHash: 'hash-stale',
            kind: 'checkpoint',
            reason: 'manual',
            label: null,
            createdAt: 1000,
          },
        ];
      }
      return [
        {
          id: 'rev-fresh',
          sessionId: 's1',
          contentHash: 'hash-fresh',
          kind: 'checkpoint',
          reason: 'manual',
          label: null,
          createdAt: 2000,
        },
      ];
    });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    await fireEvent.click(screen.getByRole('button', { name: 'View revisions' }));
    await waitFor(() => expect(mocks.listNoteRevisions).toHaveBeenCalledTimes(1));

    // Reopen the very same session's revisions before that first (now
    // in-flight) load resolves — simulates a fast re-navigation.
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.click(screen.getByRole('button', { name: 'View revisions' }));
    await waitFor(() => expect(mocks.listNoteRevisions).toHaveBeenCalledTimes(2));

    // The second (fresh) load resolves immediately; wait for its content
    // to show up before releasing the stale first one.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Checkpoint/ })).toHaveLength(1));

    // Now let the stale first response land — it must not clobber the
    // fresh one that already rendered.
    release.first?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const entries = screen.getAllByRole('button', { name: /Checkpoint/ });
    expect(entries).toHaveLength(1);
  });
});

describe('Revision failure handling (review follow-up)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // handleCheckpoint only submits once noteHashBySession actually has a
  // hash for the session — i.e. once saveNote has resolved with a real
  // note — so every test in this block needs saveNote to return one
  // (the shared beforeEach's default resolves `note: null`).
  function mockSaveNoteWithHash() {
    mocks.saveNote.mockImplementation(
      async (sessionId: string, content: string): Promise<SaveNoteResult> => ({
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
  }

  it('auto-retries a transient revision-save failure on a timer and clears the banner once it succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mockSaveNoteWithHash();
    let shouldFail = true;
    mocks.createNoteRevision.mockImplementation(async (request: CreateRevisionRequest) => {
      if (shouldFail) throw new Error('disk unavailable');
      return {
        id: `rev-${request.contentHash}`,
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
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'checkpoint me' } });
    await fireEvent.blur(textarea);
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));

    await fireEvent.click(screen.getByRole('button', { name: 'Save checkpoint' }));
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Failed to save a revision snapshot.*Retrying/)).toBeTruthy());
    // Not yet exhausted — no manual Retry button, and no integrity messaging.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText(/data-integrity problem/)).toBeNull();

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(3_000);

    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Failed to save a revision snapshot/)).toBeNull());
  });

  it('shows a manual-retry banner once automatic retries are exhausted, and Retry succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mockSaveNoteWithHash();
    let shouldFail = true;
    mocks.createNoteRevision.mockImplementation(async (request: CreateRevisionRequest) => {
      if (shouldFail) throw new Error('disk unavailable');
      return {
        id: `rev-${request.contentHash}`,
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
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'checkpoint me' } });
    await fireEvent.blur(textarea);
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));

    await fireEvent.click(screen.getByRole('button', { name: 'Save checkpoint' }));
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(1));

    // Default bound is 3 automatic retries — advance past every one of them.
    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(4));

    const retryButton = await screen.findByRole('button', { name: 'Retry' });
    await waitFor(() => expect(screen.getByText('Failed to save a revision snapshot.')).toBeTruthy());

    shouldFail = false;
    await fireEvent.click(retryButton);

    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(screen.queryByText('Failed to save a revision snapshot.')).toBeNull());
  });

  it('shows terminal data-integrity messaging (not a retry banner) and never auto-retries it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mockSaveNoteWithHash();
    mocks.createNoteRevision.mockRejectedValue({ code: 'unreadable' });

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

    await waitFor(() => expect(screen.getByText(/data-integrity problem/)).toBeTruthy());
    expect(screen.queryByText('Failed to save a revision snapshot.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    // Terminal failures are never auto-retried, even after the same delay
    // a transient failure would retry on.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.createNoteRevision).toHaveBeenCalledTimes(1);

    // Note editing itself is never affected by a revision-save failure.
    expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
  });
});

describe('Revision invalidation generation tokens (review follow-up)', () => {
  it('retries a request scheduled before Delete revision history is invalidated, while a fresh request for the same still-open session afterward retries normally', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.listNoteRevisions.mockResolvedValue([
      {
        id: 'rev-1',
        sessionId: 's1',
        contentHash: 'existing-hash',
        kind: 'checkpoint',
        reason: 'manual',
        label: null,
        createdAt: 500,
      },
    ]);
    mocks.saveNote.mockImplementation(
      async (sessionId: string, content: string): Promise<SaveNoteResult> => ({
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
    // A checkpoint for "stale checkpoint" always fails transiently (still
    // pending, scheduled for a future auto-retry, when deletion runs) — a
    // checkpoint submitted *after* deletion (same session, same still-open
    // note) must behave completely normally instead of being permanently
    // blocked by the earlier invalidate().
    mocks.createNoteRevision.mockImplementation(async (request: CreateRevisionRequest) => {
      if (request.content === 'stale checkpoint') throw new Error('disk unavailable');
      return {
        id: `rev-${request.contentHash}`,
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
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'stale checkpoint' } });
    await fireEvent.blur(textarea);
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(1));

    await fireEvent.click(screen.getByRole('button', { name: 'Save checkpoint' }));
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(1));
    // Failed but not yet exhausted — pending, scheduled for auto-retry.
    await waitFor(() => expect(screen.getByText(/Failed to save a revision snapshot/)).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'View revisions' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete revision history' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Delete revision history' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(mocks.deleteNoteRevisionHistory).toHaveBeenCalledTimes(1));

    // The stale pending checkpoint is discarded by the delete's
    // invalidate() calls — the banner clears immediately rather than
    // resurrecting on some later auto-retry tick.
    await waitFor(() => expect(screen.queryByText(/Failed to save a revision snapshot/)).toBeNull());

    // Back to Focus, and submit a brand-new checkpoint for the exact same
    // (still-open) session — this must succeed normally, proving the
    // session id wasn't permanently blocked by the earlier invalidate().
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const freshTextarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(freshTextarea, { target: { value: 'fresh checkpoint' } });
    await fireEvent.blur(freshTextarea);
    await waitFor(() => expect(mocks.saveNote).toHaveBeenCalledTimes(2));

    await fireEvent.click(screen.getByRole('button', { name: 'Save checkpoint' }));
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Checkpoint saved.')).toBeTruthy());
    expect(screen.queryByText(/Failed to save a revision snapshot/)).toBeNull();
  });

  it('still invalidates the pre-deletion request and surfaces an error when the delete command itself fails', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.listNoteRevisions.mockResolvedValue([
      {
        id: 'rev-1',
        sessionId: 's1',
        contentHash: 'existing-hash',
        kind: 'checkpoint',
        reason: 'manual',
        label: null,
        createdAt: 500,
      },
    ]);
    mocks.deleteNoteRevisionHistory.mockRejectedValue(new Error('disk unavailable'));

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    await fireEvent.click(screen.getByRole('button', { name: 'View revisions' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete revision history' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Delete revision history' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(mocks.deleteNoteRevisionHistory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Failed to delete revision history.')).toBeTruthy());
  });
});

describe('Checkpoint content immutability (review follow-up)', () => {
  it('captures checkpoint content immutably and uses the exact same content/hash pair for the dedup lookup and the submission, even if the note is edited during the lookup', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    const release: { list: (() => void) | null } = { list: null };
    mocks.listNoteRevisions.mockImplementation(async (_sessionId: string) => {
      await new Promise<void>((resolve) => {
        release.list = resolve;
      });
      return [];
    });

    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'checkpoint me' } });

    // No blur — the checkpoint action's own flush is what commits this,
    // exercising the same path a debounced-but-not-yet-flushed edit would.
    await fireEvent.click(screen.getByRole('button', { name: 'Save checkpoint' }));
    await waitFor(() => expect(mocks.listNoteRevisions).toHaveBeenCalledTimes(1));

    // Edit the note *during* the dedup lookup, before the checkpoint's own
    // submission has been built — this must never leak into the request.
    await fireEvent.input(textarea, { target: { value: 'edited during lookup' } });

    release.list?.();
    await waitFor(() => expect(mocks.createNoteRevision).toHaveBeenCalled());

    const request = mocks.createNoteRevision.mock.calls[0][0] as CreateRevisionRequest;
    expect(request.content).toBe('checkpoint me');
    expect(request.contentHash).toBe(await sha256Hex('checkpoint me'));
  });
});
