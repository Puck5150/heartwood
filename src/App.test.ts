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
import type { SessionState } from './lib/session';
import { sha256Hex, type CreateRevisionRequest, type NoteRevision, type RestoreRevisionResult } from './lib/revisions';
import { DEFAULT_TONE_ID } from './lib/sound';
import { APP_SETTING_KEYS } from './lib/appearance';

const soundMocks = vi.hoisted(() => ({ playTone: vi.fn() }));
vi.mock('./lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/sound')>();
  return { ...actual, playTone: soundMocks.playTone };
});

const soundscapeMocks = vi.hoisted(() => {
  const handle = {
    setGain: vi.fn(),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const engine = {
    state: 'running' as AudioContextState,
    resume: vi.fn(async () => {}),
    subscribeToStateChange: vi.fn(() => () => {}),
    setMasterGain: vi.fn(),
    createTrack: vi.fn(async () => handle),
    dispose: vi.fn(async () => {}),
  };
  return {
    handle,
    engine,
    createWebAudioSoundscapeEngine: vi.fn(() => engine),
  };
});
vi.mock('./lib/soundscapeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/soundscapeEngine')>();
  return {
    ...actual,
    createWebAudioSoundscapeEngine: soundscapeMocks.createWebAudioSoundscapeEngine,
  };
});

const notificationMocks = vi.hoisted(() => ({
  ensurePermission: vi.fn(async () => true),
  notifyWarning: vi.fn(async () => {}),
  notifyCompletion: vi.fn(async () => {}),
  notifyIntermissionReturn: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
}));
vi.mock('./lib/nativeNotifications', () => ({
  createNativeNotificationAdapter: () => notificationMocks,
}));

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
    focus_deadline_at: null,
    review_acknowledged_at: null,
    intermission_kind: null,
    intermission_started_at: null,
    intermission_deadline_at: null,
    intermission_return_status: null,
    break_intermission_ms: 0,
    touch_grass_ms: 0,
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
  saveSession: vi.fn(async (_state: SessionState, _updatedAt: number) => {}),
  acknowledgeSessionReview: vi.fn(async (_sessionId: string, _now: number) => {}),
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

const scrollToMock = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadLatestSessionRow.mockResolvedValue(completeSessionRow());
  mocks.loadAllParkedThoughts.mockResolvedValue([]);
  mocks.getSetting.mockResolvedValue(null);
  mocks.loadNoteRecordForSession.mockResolvedValue(null);
  mocks.saveSession.mockResolvedValue(undefined);
  mocks.saveNote.mockResolvedValue({ note: null, cleanupPending: false });
  notificationMocks.ensurePermission.mockResolvedValue(true);
  notificationMocks.notifyWarning.mockResolvedValue(undefined);
  notificationMocks.notifyCompletion.mockResolvedValue(undefined);
  notificationMocks.notifyIntermissionReturn.mockResolvedValue(undefined);
  notificationMocks.dispose.mockResolvedValue(undefined);
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

    // The resolved shell attributes and Settings drawer selection are
    // observable proof that the persisted settings were requested in the
    // same startup pass and applied before `ready`.
    const shell = taskInput.closest('[data-theme]')!;
    expect(shell.getAttribute('data-theme')).toBe('graphite');
    expect(shell.getAttribute('data-appearance')).toBe('dark');
    expect(shell.getAttribute('data-timer-accent')).toBe('green');

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect((screen.getByRole('combobox', { name: 'Alarm tone' }) as HTMLSelectElement).value).toBe('soft-bell');
  });

  it('hydrates both local soundscape settings before rendering without writing defaults back', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    const volumeGate = deferred<string | null>();
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === APP_SETTING_KEYS.soundscapeVolume) return volumeGate.promise;
      if (key === APP_SETTING_KEYS.selectedSoundscapeId) return Promise.resolve('rain-room');
      return Promise.resolve(null);
    });

    render(App);
    expect(screen.getByText('Loading…')).toBeTruthy();
    await waitFor(() => {
      expect(mocks.getSetting).toHaveBeenCalledWith(APP_SETTING_KEYS.selectedSoundscapeId);
      expect(mocks.getSetting).toHaveBeenCalledWith(APP_SETTING_KEYS.soundscapeVolume);
    });

    volumeGate.resolve('0.7');
    expect(await screen.findByRole('textbox', { name: 'Focus task' })).toBeTruthy();
    expect(mocks.setSetting).not.toHaveBeenCalled();
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
    mocks.loadAllParkedThoughts.mockResolvedValue([
      { id: 't1', text: 'Still parked', createdAt: 1_000, sessionId: 's-old' },
    ]);

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
    expect(
      (screen.getByRole('button', { name: 'Start focus: Still parked' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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

describe('Idle parked-thought starts (PR #14 follow-up)', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
    mocks.loadAllParkedThoughts.mockResolvedValue([
      {
        id: 'thought-1',
        text: 'Outline the launch post',
        createdAt: 1_000,
        sessionId: 'deleted-session',
      },
    ]);
  });

  it('starts an unresolved parked thought with the selected idle duration, then consumes it', async () => {
    render(App);

    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    expect(taskInput).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Parked thoughts' })).toBeTruthy();

    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), {
      target: { value: '40' },
    });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Start focus: Outline the launch post' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Outline the launch post' })).toBeTruthy(),
    );
    await waitFor(() => expect(mocks.deleteParkedThoughtRow).toHaveBeenCalledWith('thought-1'));
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'focusing',
        task: 'Outline the launch post',
        plannedDurationMs: 40 * 60_000,
      }),
      expect.any(Number),
    );
    expect(
      screen.queryByRole('button', { name: 'Start focus: Outline the launch post' }),
    ).toBeNull();
  });

  it('keeps the parked thought when the selected idle duration is invalid', async () => {
    render(App);
    await screen.findByRole('heading', { name: 'Parked thoughts' });

    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), {
      target: { value: '0' },
    });

    const parkedStart = screen.getByRole('button', {
      name: 'Start focus: Outline the launch post',
    }) as HTMLButtonElement;
    expect(parkedStart.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Start focusing' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('Outline the launch post')).toBeTruthy();
    expect(mocks.deleteParkedThoughtRow).not.toHaveBeenCalled();
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });

  it('shows unresolved thoughts again after returning from Review to the start page', async () => {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await screen.findByText('Session review');

    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Start focus: Outline the launch post' }),
      ).toBeTruthy(),
    );
    expect(mocks.deleteParkedThoughtRow).not.toHaveBeenCalled();
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

  it('plays the completion alarm and keeps History visible when focus expires while History is open', async () => {
    await startOneMinuteFocusAndOpenHistory();

    // Past the deadline plus enough time for all three alarm repetitions
    // (gentle-chime's own 750ms schedule plus the 500ms gap between
    // repetitions) to finish.
    await vi.advanceTimersByTimeAsync(63_000);

    expect(soundMocks.playTone).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Planned focus complete')).toBeTruthy();
    expect(screen.getByText('Session history')).toBeTruthy();
  });

  it('does not replay the alarm on later ticks once the three-tone sequence has finished', async () => {
    await startOneMinuteFocusAndOpenHistory();

    await vi.advanceTimersByTimeAsync(63_000);
    expect(soundMocks.playTone).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(soundMocks.playTone).toHaveBeenCalledTimes(3);
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

  it('completes focus, plays the three-tone alarm, and shows quiet overtime while Settings is open — and Settings itself is unaffected', async () => {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await fireEvent.click(screen.getByRole('radio', { name: 'Graphite' }));

    // Past the deadline plus enough time for all three alarm repetitions
    // (gentle-chime's own 750ms schedule plus the 500ms gap between
    // repetitions) to finish.
    await vi.advanceTimersByTimeAsync(63_000);

    expect(soundMocks.playTone).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Planned focus complete')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take a break' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End session' })).toBeTruthy();
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

  it('renders the same support panels once the session continues into quiet overtime', async () => {
    await startOneMinuteFocus();
    await vi.advanceTimersByTimeAsync(61_000); // focus expires naturally straight into quiet overtime (Flow)

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

  it('plays the completion alarm and keeps Revisions visible when focus expires while Revisions is open', async () => {
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

      // Past the deadline plus enough time for all three alarm repetitions
      // (gentle-chime's own 750ms schedule plus the 500ms gap between
      // repetitions) to finish.
      await vi.advanceTimersByTimeAsync(63_000);

      expect(soundMocks.playTone).toHaveBeenCalledTimes(3);
      expect(screen.getByText('Planned focus complete')).toBeTruthy();
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
    // Wait for that gate directly rather than an exact transient mock call
    // count; later autosave scheduling is unrelated to the race under test.
    await waitFor(() => expect(release.save).toEqual(expect.any(Function)));

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

describe('Gentle focus completion integration (Phase 5B Task 8)', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // start idle so a fresh focus session can be created
  });

  async function startOneMinuteFocus(task = 'Deep work') {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: task } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '1' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
  }

  it('invokes ensurePermission once on the first focus start when warnings are enabled, without delaying the transition', async () => {
    await startOneMinuteFocus('Task');

    expect(notificationMocks.ensurePermission).toHaveBeenCalledTimes(1);
    // The transition already applied synchronously — never blocked on permission.
    expect(screen.getByRole('heading', { name: 'Task' })).toBeTruthy();
  });

  it('still initializes completion-notification permission when the warning preset is Off', async () => {
    mocks.getSetting.mockImplementation(async (key: string) =>
      key === APP_SETTING_KEYS.focusWarningLeadMs ? 'off' : null,
    );
    await startOneMinuteFocus('Task');

    expect(notificationMocks.ensurePermission).toHaveBeenCalledTimes(1);
  });

  it('shows the warning prompt consistently in the focus workspace and other workspaces', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(30_250); // into the default 30s warning window
      expect(screen.getByText('30 seconds left')).toBeTruthy();

      await fireEvent.click(screen.getByRole('button', { name: 'History' }));
      expect(screen.getByText('30 seconds left')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Continue focusing restarts the full duration, keeping the same session, task, note, and parked thoughts, and cancels any pending alarm', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();

      const parkingInput = screen.getByRole('textbox', { name: 'Park a thought' });
      await fireEvent.input(parkingInput, { target: { value: 'Ping the design review' } });
      const noteInput = screen.getByRole('textbox', { name: 'Notes' });
      await fireEvent.input(noteInput, { target: { value: 'Draft outline' } });

      await vi.advanceTimersByTimeAsync(30_250);
      expect(screen.getByText('30 seconds left')).toBeTruthy();

      await fireEvent.click(screen.getByRole('button', { name: 'Continue focusing' }));

      expect(screen.queryByText('30 seconds left')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Deep work' })).toBeTruthy(); // still focusing, same task
      expect((screen.getByRole('textbox', { name: 'Park a thought' }) as HTMLInputElement).value).toBe(
        'Ping the design review',
      );
      expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe('Draft outline');

      // A full new minute remains — no expiry when only the old remaining time passes.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(soundMocks.playTone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Take break now ends focus successfully into Break without playing the completion alarm', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(30_250);
      await fireEvent.click(screen.getByRole('button', { name: 'Take break now' }));

      expect(soundMocks.playTone).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Deep work' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'End break' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends exactly one background completion notification for a live expiry while unfocused', async () => {
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(62_000);

      expect(notificationMocks.notifyCompletion).toHaveBeenCalledTimes(1);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledWith('Deep work');
    } finally {
      document.hasFocus = originalHasFocus;
      vi.useRealTimers();
    }
  });

  it('sends no completion notification for a live expiry while foregrounded', async () => {
    // jsdom's document.hasFocus() defaults to false (nothing has real OS
    // focus in a headless test), so this must be stubbed true explicitly
    // to exercise the foregrounded branch.
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(62_000);

      expect(notificationMocks.notifyCompletion).not.toHaveBeenCalled();
    } finally {
      document.hasFocus = originalHasFocus;
      vi.useRealTimers();
    }
  });

  it('never plays audio or sends a notification when recovery lands directly in quiet overtime', async () => {
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const recoveredAt = Date.now();
    const focusDeadlineAt = recoveredAt - 1_000;
    mocks.loadLatestSessionRow.mockResolvedValue({
      id: 'recovered-1',
      task: 'Recovered task',
      status: 'focusing',
      started_at: focusDeadlineAt - 60_000,
      planned_duration_ms: 60_000,
      accumulated_pause_ms: 0,
      paused_at: null,
      focus_completed_at: null,
      flow_started_at: null,
      flow_accumulated_pause_ms: null,
      flow_paused_at: null,
      break_started_at: null,
      planned_focus_ms: null,
      actual_focus_ms: null,
      flow_ms: null,
      took_break: null,
      break_ms: null,
      total_elapsed_ms: null,
      completed_at: null,
      focus_deadline_at: focusDeadlineAt,
      review_acknowledged_at: null,
      intermission_kind: null,
      intermission_started_at: null,
      intermission_deadline_at: null,
      intermission_return_status: null,
      break_intermission_ms: 0,
      touch_grass_ms: 0,
      updated_at: focusDeadlineAt,
    });

    try {
      render(App);

      await screen.findByRole('heading', { name: 'Recovered task' });
      expect(screen.queryByText('Planned focus complete')).toBeNull();
      expect(soundMocks.playTone).not.toHaveBeenCalled();
      expect(notificationMocks.notifyCompletion).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(28_000);
      expect(screen.queryByText('30 seconds to next check-in')).toBeNull();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(screen.getByText('30 seconds to next check-in')).toBeTruthy();
      expect(soundMocks.playTone).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(screen.getByText('Focus check-in')).toBeTruthy();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledTimes(1);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledWith('Recovered task');
    } finally {
      document.hasFocus = originalHasFocus;
      vi.useRealTimers();
    }
  });

  it('Stay with it acknowledges only the initial marker and cancels its remaining alarm repetitions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(screen.getByText('Planned focus complete', { selector: '.headline' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stay with it' })).toBeTruthy();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);

      await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));

      expect(screen.queryByText('Planned focus complete')).toBeNull();
      expect(screen.getByText('Quiet overtime')).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Deep work' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
      expect(screen.getByText('00:05')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns at the next marker warning and acknowledgement suppresses that marker alarm', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(60_000);
      await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));

      await vi.advanceTimersByTimeAsync(29_750);
      expect(screen.queryByText('30 seconds to next check-in')).toBeNull();

      await vi.advanceTimersByTimeAsync(250);
      expect(screen.getByText('30 seconds to next check-in')).toBeTruthy();

      await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(screen.queryByText('Focus check-in')).toBeNull();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Quiet overtime')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps marker alarms and due prompts enabled when advance warnings are Off', async () => {
    mocks.getSetting.mockImplementation(async (key: string) =>
      key === APP_SETTING_KEYS.focusWarningLeadMs ? 'off' : null,
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(screen.getByText('Planned focus complete', { selector: '.headline' })).toBeTruthy();
      await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));

      await vi.advanceTimersByTimeAsync(59_750);
      expect(screen.queryByText('30 seconds to next check-in')).toBeNull();
      expect(screen.queryByText('Focus check-in')).toBeNull();

      await vi.advanceTimersByTimeAsync(250);
      expect(screen.getByText('Focus check-in', { selector: '.headline' })).toBeTruthy();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts one three-play alarm and one background notification for each ignored marker', async () => {
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(63_000);

      expect(screen.getByText('Planned focus complete')).toBeTruthy();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(3);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(screen.getByText('Focus check-in')).toBeTruthy();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(6);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(soundMocks.playTone).toHaveBeenCalledTimes(6);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledTimes(2);
    } finally {
      document.hasFocus = originalHasFocus;
      vi.useRealTimers();
    }
  });

  it('keeps acknowledgement and marker timing across focus surfaces, History, and Settings', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(60_000);
      await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));

      await fireEvent.click(screen.getByRole('button', { name: 'History' }));
      expect(screen.getByText('Session history')).toBeTruthy();
      expect(screen.queryByText('Planned focus complete')).toBeNull();

      await fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
      await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
      await fireEvent.click(screen.getByRole('tab', { name: 'Parking Lot' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();

      await vi.advanceTimersByTimeAsync(30_000);
      await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
      expect(screen.getByText('30 seconds to next check-in')).toBeTruthy();

      await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));
      await fireEvent.click(screen.getByRole('button', { name: 'History' }));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(screen.queryByText('Focus check-in')).toBeNull();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Quiet overtime')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('consumes a marker crossed in the heartbeat gap without alarming while paused or on resume', async () => {
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(60_000);
      await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));

      // Stop one heartbeat before marker two, then cross its deadline by
      // moving wall time without running the pending 250 ms interval.
      await vi.advanceTimersByTimeAsync(59_750);
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 251);

      await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

      expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledTimes(1);

      await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
      expect(notificationMocks.notifyCompletion).toHaveBeenCalledTimes(1);
    } finally {
      document.hasFocus = originalHasFocus;
      vi.useRealTimers();
    }
  });

  it('freezes the next marker countdown while quiet overtime is paused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(60_000);
      await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));

      await vi.advanceTimersByTimeAsync(20_000);
      await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(screen.queryByText('30 seconds to next check-in')).toBeNull();
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);

      await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await vi.advanceTimersByTimeAsync(9_750);
      expect(screen.queryByText('30 seconds to next check-in')).toBeNull();

      await vi.advanceTimersByTimeAsync(500);
      expect(screen.getByText('30 seconds to next check-in')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('overtime Take a break moves the session into Break', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(90_000); // past the deadline, into overtime
      await fireEvent.click(screen.getByRole('button', { name: 'Take a break' }));

      expect(screen.getByRole('button', { name: 'End break' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('overtime End session finishes straight to review', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(62_000);
      await fireEvent.click(screen.getByRole('button', { name: 'End session' }));

      expect(screen.getByText('Session review')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pausing during quiet overtime cancels the remaining alarm repetitions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(60_000); // exactly at the deadline — first tone plays
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);

      await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      await vi.advanceTimersByTimeAsync(5_000); // well past when repetitions 2 and 3 would have fired
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('previewing a tone in Settings cancels an in-progress completion sequence and plays the tone exactly once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startOneMinuteFocus();
      await vi.advanceTimersByTimeAsync(60_000); // first tone of the completion sequence plays
      expect(soundMocks.playTone).toHaveBeenCalledTimes(1);

      await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Preview alarm tone' }));
      expect(soundMocks.playTone).toHaveBeenCalledTimes(2); // exactly one more, for the preview itself

      await vi.advanceTimersByTimeAsync(5_000); // the cancelled sequence's remaining reps never fire
      expect(soundMocks.playTone).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Resumable intermission integration (Phase 5C)', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
  });

  async function startFocus(task = 'Deep work') {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: task } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Minutes' }), {
      target: { value: '1' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
  }

  it('starts a Break, keeps the same session content, and returns to active focus', async () => {
    await startFocus();
    const sessionId = (
      mocks.saveSession.mock.calls.at(-1)?.[0] as Exclude<SessionState, { status: 'idle' }>
    ).sessionId;

    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    expect(screen.getByRole('heading', { name: 'Break' })).toBeTruthy();
    expect(screen.getByText('From: Deep work')).toBeTruthy();
    expect(mocks.saveSession.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'intermission',
      sessionId,
      kind: 'break',
    });

    await fireEvent.click(screen.getByRole('button', { name: "I'm back" }));
    expect(screen.getByRole('heading', { name: 'Deep work' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(mocks.saveSession.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'focusing',
      sessionId,
    });
  });

  it('keeps Parking Lot, Notes, and revision access available during an intermission', async () => {
    await startFocus();
    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));

    expect(screen.getByRole('tab', { name: 'Parking Lot' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View revisions' })).toBeTruthy();
  });

  it('announces an intermission once even when it starts from History', async () => {
    await startFocus();
    await fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));

    const announcement = screen.getByRole('status');
    expect(announcement.textContent).toBe('Break started.');

    await fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Break started.');
  });

  it('surfaces a failed intermission save and retries it through the shared queue', async () => {
    await startFocus();
    mocks.saveSession.mockRejectedValueOnce(new Error('database busy'));

    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    expect(await screen.findByText('Failed to save session changes.')).toBeTruthy();

    mocks.saveSession.mockResolvedValue(undefined);
    await fireEvent.click(screen.getByRole('button', { name: 'Retry session save' }));

    await waitFor(() => {
      expect(screen.queryByText('Failed to save session changes.')).toBeNull();
    });
    expect(mocks.saveSession.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'intermission',
      kind: 'break',
    });
  });

  it('invalidates a failed session-save retry when Delete All removes its session', async () => {
    await startFocus();
    mocks.saveSession.mockRejectedValueOnce(new Error('database busy'));

    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    const staleRetry = await screen.findByRole('button', { name: 'Retry session save' });

    mocks.loadCompletedSessions.mockResolvedValue([completeSessionRow()]);
    await fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await screen.findByText('Write report');
    await fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Yes, delete everything' }));
    await waitFor(() => expect(mocks.deleteAllData).toHaveBeenCalledOnce());

    expect(screen.queryByText('Failed to save session changes.')).toBeNull();
    const saveCallsAfterDelete = mocks.saveSession.mock.calls.length;
    await fireEvent.click(staleRetry);
    await Promise.resolve();
    expect(mocks.saveSession).toHaveBeenCalledTimes(saveCallsAfterDelete);
  });

  it('cycles durations in place without a dropdown or starting an intermission', async () => {
    await startFocus();

    const breakDuration = screen.getByRole('button', {
      name: 'Break duration: 5 minutes. Change duration',
    });
    await fireEvent.click(breakDuration);
    expect(
      screen.getByRole('button', { name: 'Break duration: 10 minutes. Change duration' }),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Break' })).toBeNull();

    const touchDuration = screen.getByRole('button', {
      name: 'Touch Grass duration: 15 minutes. Change duration',
    });
    await fireEvent.click(touchDuration);
    expect(
      screen.getByRole('button', { name: 'Touch Grass duration: 30 minutes. Change duration' }),
    ).toBeTruthy();
  });

  it('returns an already-paused focus session to paused', async () => {
    await startFocus();
    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    await fireEvent.click(screen.getByRole('button', { name: "I'm back" }));

    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(mocks.saveSession.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'paused' });
  });

  it('returns Touch Grass to quiet Flow overtime without resetting it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startFocus();
      await vi.advanceTimersByTimeAsync(61_000);
      soundMocks.playTone.mockClear();

      await fireEvent.click(screen.getByRole('button', { name: 'Touch grass' }));
      expect(screen.getByRole('heading', { name: 'Touch Grass' })).toBeTruthy();
      expect(screen.getByText("Go for a frickin' walk.")).toBeTruthy();
      await fireEvent.click(screen.getByRole('button', { name: "I'm back" }));

      expect(screen.getByText('Quiet overtime')).toBeTruthy();
      expect(mocks.saveSession.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'flow' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays the return tone three times at zero, stays away, then enters quiet overtime', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startFocus();
      await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
      soundMocks.playTone.mockClear();

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);

      expect(soundMocks.playTone).toHaveBeenCalledTimes(3);
      expect(soundMocks.playTone).toHaveBeenCalledWith('calm-return');
      expect(screen.getByText('Quiet overtime')).toBeTruthy();
      expect(screen.getByRole('button', { name: "I'm back" })).toBeTruthy();
      expect(mocks.saveSession.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'intermission' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends one silent-return notification only while backgrounded', async () => {
    const originalHasFocus = document.hasFocus;
    document.hasFocus = () => false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startFocus();
      await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);

      expect(notificationMocks.notifyIntermissionReturn).toHaveBeenCalledTimes(1);
      expect(notificationMocks.notifyIntermissionReturn).toHaveBeenCalledWith('break', 'Deep work');
    } finally {
      document.hasFocus = originalHasFocus;
      vi.useRealTimers();
    }
  });

  it('recovers an overdue intermission silently and waits for explicit return', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue({
      id: 'recovered-intermission',
      task: 'Recovered break',
      status: 'intermission',
      started_at: 1_000,
      planned_duration_ms: 60_000,
      accumulated_pause_ms: 0,
      paused_at: 10_000,
      focus_completed_at: null,
      flow_started_at: null,
      flow_accumulated_pause_ms: null,
      flow_paused_at: null,
      break_started_at: null,
      planned_focus_ms: null,
      actual_focus_ms: null,
      flow_ms: null,
      took_break: null,
      break_ms: null,
      total_elapsed_ms: null,
      completed_at: null,
      focus_deadline_at: 61_000,
      review_acknowledged_at: null,
      intermission_kind: 'break',
      intermission_started_at: 10_000,
      intermission_deadline_at: 310_000,
      intermission_return_status: 'focusing',
      break_intermission_ms: 0,
      touch_grass_ms: 0,
      updated_at: 10_000,
    });

    render(App);

    expect(await screen.findByText('Quiet overtime')).toBeTruthy();
    expect(screen.getByRole('button', { name: "I'm back" })).toBeTruthy();
    expect(soundMocks.playTone).not.toHaveBeenCalled();
    expect(notificationMocks.notifyIntermissionReturn).not.toHaveBeenCalled();
  });

  it('keeps intermission controls available in the compact timer over History', async () => {
    await startFocus();
    await fireEvent.click(screen.getByRole('button', { name: 'History' }));

    expect(screen.getByRole('button', { name: 'Break' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    expect(screen.getByText('Break', { selector: '.mode-label' })).toBeTruthy();
    expect(screen.getByRole('button', { name: "I'm back" })).toBeTruthy();
  });

  it('surfaces malformed recovered intermissions instead of remaining on Loading', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue({
      id: 'malformed-intermission',
      task: 'Malformed break',
      status: 'intermission',
      started_at: 1_000,
      planned_duration_ms: 60_000,
      accumulated_pause_ms: 0,
      paused_at: 10_000,
      focus_completed_at: null,
      flow_started_at: null,
      flow_accumulated_pause_ms: null,
      flow_paused_at: null,
      break_started_at: null,
      planned_focus_ms: null,
      actual_focus_ms: null,
      flow_ms: null,
      took_break: null,
      break_ms: null,
      total_elapsed_ms: null,
      completed_at: null,
      focus_deadline_at: 61_000,
      review_acknowledged_at: null,
      intermission_kind: 'break',
      intermission_started_at: 10_000,
      intermission_deadline_at: 20_000,
      intermission_return_status: 'focusing',
      break_intermission_ms: 0,
      touch_grass_ms: 0,
      updated_at: 10_000,
    });

    render(App);

    expect(await screen.findByText('Failed to load your saved session.')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('Back to start from review', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // start idle so a fresh focus session can be created
  });

  it('returns to the idle front page from the review screen without starting a new session', async () => {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await waitFor(() => expect(screen.getByText('Session review')).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Heartwood' })).toBeTruthy());
    expect(screen.queryByText('Session review')).toBeNull();
    // A blank draft, not the just-finished task carried over.
    expect((screen.getByRole('textbox', { name: 'Focus task' }) as HTMLInputElement).value).toBe('');
  });

  it('resets the document scroll position after returning to the idle front page', async () => {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await screen.findByText('Session review');

    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));

    await waitFor(() =>
      expect(scrollToMock).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' }),
    );
  });

  it('flushes a pending note edit before leaving review, and stays on review if the flush fails', async () => {
    mocks.saveNote.mockRejectedValueOnce(new Error('disk full'));
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await waitFor(() => expect(screen.getByText('Session review')).toBeTruthy());

    const textarea = await screen.findByRole('textbox', { name: 'Notes' });
    await fireEvent.input(textarea, { target: { value: 'one more thought' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));

    // The flush failed — still on review, with the retry banner surfaced,
    // and the draft is preserved rather than discarded.
    await waitFor(() => expect(screen.getByText('Session review')).toBeTruthy());
    expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe('one more thought');
  });

  it('persists the acknowledgement — a simulated relaunch afterward opens idle, not Review', async () => {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await waitFor(() => expect(screen.getByText('Session review')).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Heartwood' })).toBeTruthy());

    expect(mocks.acknowledgeSessionReview).toHaveBeenCalledTimes(1);
    const [acknowledgedSessionId, acknowledgedAt] = mocks.acknowledgeSessionReview.mock.calls[0] as [string, number];

    // Simulate relaunch: a fresh mount recovering the same row, now
    // reflecting exactly the acknowledgement that was actually persisted
    // above (not a hand-picked value) — the row shape is otherwise
    // whatever completeSessionRow's own default already covers.
    mocks.loadLatestSessionRow.mockResolvedValue(
      completeSessionRow({ id: acknowledgedSessionId, review_acknowledged_at: acknowledgedAt }),
    );
    cleanup();
    render(App);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Heartwood' })).toBeTruthy());
    expect(screen.queryByText('Session review')).toBeNull();
  });

  it('an unacknowledged completed session still recovers straight to Review on launch', async () => {
    mocks.loadLatestSessionRow.mockResolvedValue(completeSessionRow({ review_acknowledged_at: null }));
    render(App);

    await waitFor(() => expect(screen.getByText('Session review')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Heartwood' })).toBeNull();
  });

  it('a failed acknowledgement write keeps the user on Review with a visible retry path', async () => {
    mocks.acknowledgeSessionReview.mockRejectedValueOnce(new Error('disk full'));
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await waitFor(() => expect(screen.getByText('Session review')).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));

    // Never present an idle state that relaunch would just reverse — stays
    // on review, with the failure visible next to the button.
    await waitFor(() => expect(screen.getByText('Failed to save. Please try again.')).toBeTruthy());
    expect(screen.getByText('Session review')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Heartwood' })).toBeNull();

    // Clicking the same button again is the retry, and this time it succeeds.
    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Heartwood' })).toBeTruthy());
  });

  it('never deletes anything — history stays reachable and intact after acknowledgement', async () => {
    mocks.loadCompletedSessions.mockResolvedValue([completeSessionRow({ id: 's1', task: 'Write launch brief' })]);
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    await waitFor(() => expect(screen.getByText('Session review')).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Back to start' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Heartwood' })).toBeTruthy());

    expect(mocks.deleteSessionRow).not.toHaveBeenCalled();
    expect(mocks.deleteAllData).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await waitFor(() => expect(screen.getByText('Session history')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Write launch brief')).toBeTruthy());
  });
});

describe('View history from the timer screen', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // start idle so a fresh focus session can be created
  });

  it('offers a View history link directly on the timer while focusing, without disturbing the running session', async () => {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Write launch brief' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));

    await fireEvent.click(screen.getByRole('button', { name: 'View history' }));

    expect(screen.getByText('Session history')).toBeTruthy();

    // Back on Focus, the same session is still running, untouched.
    await fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(screen.getByRole('heading', { name: 'Write launch brief' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });
});

describe('Local soundscape integration (Phase 5D)', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null);
  });

  async function startFocus() {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    await fireEvent.input(taskInput, { target: { value: 'Deep work' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
  }

  it('offers explicit soundscape playback before a timer starts', async () => {
    render(App);
    await screen.findByRole('textbox', { name: 'Focus task' });

    expect(soundscapeMocks.createWebAudioSoundscapeEngine).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));
    expect(soundscapeMocks.createWebAudioSoundscapeEngine).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Play soundscape' }));

    expect(soundscapeMocks.createWebAudioSoundscapeEngine).toHaveBeenCalledTimes(1);
    expect(soundscapeMocks.engine.createTrack).toHaveBeenCalledWith('deep-focus');
  });

  it('keeps an active soundscape playing from the first focus session through review and the next session', async () => {
    render(App);
    const taskInput = await screen.findByRole('textbox', { name: 'Focus task' });
    const trigger = screen.getByRole('button', { name: 'Flow-state music' });
    await fireEvent.click(trigger);
    await fireEvent.click(screen.getByRole('button', { name: 'Play soundscape' }));
    await waitFor(() => expect(soundscapeMocks.engine.createTrack).toHaveBeenCalledTimes(1));

    await fireEvent.input(taskInput, { target: { value: 'Deep work' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start focusing' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));

    expect(screen.getByText('Session review')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Flow-state music' })).toBe(trigger);

    const nextTaskInput = screen.getByRole('textbox', { name: 'Or start a new focus task' });
    await fireEvent.input(nextTaskInput, { target: { value: 'Second deep work' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Second deep work' })).toBeTruthy());
    expect(soundscapeMocks.engine.createTrack).toHaveBeenCalledTimes(1);
    expect(soundscapeMocks.handle.dispose).not.toHaveBeenCalled();
  });

  it('keeps the one music control mounted across navigation and timer pause', async () => {
    await startFocus();
    const trigger = screen.getByRole('button', { name: 'Flow-state music' });
    await fireEvent.click(trigger);
    await fireEvent.click(screen.getByRole('button', { name: 'Play soundscape' }));
    await fireEvent.click(trigger);

    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(soundscapeMocks.engine.setMasterGain).toHaveBeenLastCalledWith(0.35, expect.any(Number));

    await fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('button', { name: 'Flow-state music' })).toBe(trigger);
  });

  it("suppresses a Break and resumes after I'm back, then preserves music when focus ends", async () => {
    await startFocus();
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Play soundscape' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));

    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    expect(soundscapeMocks.engine.setMasterGain).toHaveBeenLastCalledWith(0, expect.any(Number));
    expect(soundscapeMocks.handle.suspend).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));
    expect(screen.getByRole('button', { name: 'Soundscape paused during intermission' })).toHaveProperty(
      'disabled',
      true,
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));

    await fireEvent.click(screen.getByRole('button', { name: "I'm back" }));
    expect(soundscapeMocks.engine.setMasterGain).toHaveBeenLastCalledWith(0.35, expect.any(Number));
    expect(soundscapeMocks.handle.resume).toHaveBeenCalledOnce();

    await fireEvent.click(screen.getByRole('button', { name: 'Finish early' }));
    expect(soundscapeMocks.handle.dispose).not.toHaveBeenCalled();
  });

  it('loads Lo-Fi Hip Hop and Slow Pulse from the seven-track popover', async () => {
    await startFocus();
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Play soundscape' }));

    await fireEvent.click(screen.getByRole('radio', { name: /Lo-Fi Hip Hop/ }));
    await waitFor(() =>
      expect(soundscapeMocks.engine.createTrack).toHaveBeenCalledWith('lofi-hip-hop'),
    );
    await fireEvent.click(screen.getByRole('radio', { name: /Slow Pulse/ }));
    await waitFor(() =>
      expect(soundscapeMocks.engine.createTrack).toHaveBeenCalledWith('slow-pulse'),
    );
  });
});

describe('Notification adapter lifecycle', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // start idle so a fresh focus session can be created
  });

  it('disposes the notification adapter on teardown', () => {
    const { unmount } = render(App);
    unmount();
    expect(notificationMocks.dispose).toHaveBeenCalled();
  });
});
