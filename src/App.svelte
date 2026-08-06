<script lang="ts">
  import {
    completeFocusIntoFlow,
    createIdleState,
    endBreak,
    finishFlow,
    finishFocusEarly,
    getBreakElapsedMs,
    getFlowElapsedMs,
    getFocusRemainingMs,
    getIntermissionOvertimeMs,
    getIntermissionRemainingMs,
    isFocusDue,
    isIntermissionDue,
    pause,
    returnFromIntermission,
    restartFocusCycle,
    resume,
    startIntermission,
    takeBreakFromFlow,
    takeBreakFromFocus,
    type SessionState,
    type TransitionResult,
    type IntermissionKind,
  } from './lib/session';
  import {
    addParkedThought,
    removeParkedThought,
    setParkedThoughtNote,
    splitBySession,
    type ParkedThought,
  } from './lib/parkingLot';
  import { recoverSessionState, type SessionRow } from './lib/persistence';
  import {
    isValidDurationMinutes,
    MAX_DURATION_MINUTES,
    MIN_DURATION_MINUTES,
    reviewDefaultDurationMinutes,
    startFocusWithDurationMinutes,
  } from './lib/duration';
  import { buildSessionHistory, type SessionSummary } from './lib/history';
  import { hasNoteContent } from './lib/notes';
  import { createNoteSaveController } from './lib/noteSaveController';
  import { normalizeNoteStorageError, type NoteFailureKind } from './lib/noteStorage';
  import { createRevisionSaveCoordinator } from './lib/revisionSaveCoordinator.svelte';
  import {
    sha256Hex,
    type CurrentNoteSnapshot,
    type NoteRevision,
    type RestoreRevisionResult,
  } from './lib/revisions';
  import { createTaskQueue } from './lib/taskQueue';
  import {
    DEFAULT_RETURN_TONE_ID,
    DEFAULT_TONE_ID,
    getToneDurationMs,
    playTone,
  } from './lib/sound';
  import { createAlarmSequence } from './lib/alarmSequence';
  import { createWebAudioSoundscapeEngine } from './lib/soundscapeEngine';
  import { createBundledTrackLoader } from './lib/soundscapeTrackLoader';
  import {
    createSoundscapeController,
    type SoundscapeController,
  } from './lib/soundscapeController.svelte';
  import { soundscapeLifecycleFor } from './lib/soundscapeLifecycle';
  import {
    soundscapeVolumeToNumber,
    type SoundscapeId,
  } from './lib/soundscapeCatalog';
  import { createNativeNotificationAdapter } from './lib/nativeNotifications';
  import { createFocusWarningCoordinator, type FocusWarningView } from './lib/focusWarning';
  import {
    createOvertimeCadenceCoordinator,
    EMPTY_OVERTIME_CADENCE_VIEW,
    type OvertimeCadenceView,
  } from './lib/overtimeCadence';
  import FocusCompletionPrompt from './lib/FocusCompletionPrompt.svelte';
  import {
    APP_SETTING_KEYS,
    parseAppearanceMode,
    parseDismissedHints,
    parseFocusWarningLeadMs,
    parseReturnToneId,
    parseSoundscapeId,
    parseSoundscapeVolume,
    parseThemeFamily,
    parseTimerAccent,
    parseTimerProgressStyle,
    parseToneId,
    type AppSettings,
  } from './lib/appearance';
  import { createSettingsController, type SettingsController } from './lib/settingsController.svelte';
  import { HINT_TEXT, isHintDismissed, withHintDismissed, type HintId } from './lib/hints';
  import FirstTimeHint from './lib/FirstTimeHint.svelte';
  import { check } from '@tauri-apps/plugin-updater';
  import { relaunch } from '@tauri-apps/plugin-process';
  import UpdateBanner from './lib/UpdateBanner.svelte';
  import { createUpdateController } from './lib/updateController.svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import {
    acknowledgeSessionReview,
    createNoteRevision,
    deleteAllData,
    deleteNoteRevisionHistory,
    deleteParkedThoughtRow,
    deleteSessionRow,
    getSetting,
    initializeNoteStorage,
    insertParkedThought,
    keepAppNoteAfterConflict,
    listNoteRevisions,
    loadAllParkedThoughts,
    loadAllSessionNotes,
    loadCompletedSessions,
    loadLatestSessionRow,
    loadNoteRecordForSession,
    loadNoteRevision,
    loadNoteRevisionCounts,
    openNotesFolder,
    reloadExternalNoteAfterConflict,
    renameNoteRevision,
    restoreNoteRevision,
    saveNote,
    saveSession,
    setSetting,
    updateParkedThoughtNote,
  } from './lib/repository';
  import Timer from './lib/Timer.svelte';
  import ParkingLot from './lib/ParkingLot.svelte';
  import Greenhouse from './lib/Greenhouse.svelte';
  import FocusSupportPanels from './lib/FocusSupportPanels.svelte';
  import IdleParkedThoughts from './lib/IdleParkedThoughts.svelte';
  import SessionReview from './lib/SessionReview.svelte';
  import History from './lib/History.svelte';
  import SessionNotes from './lib/SessionNotes.svelte';
  import ActiveTimerBar from './lib/ActiveTimerBar.svelte';
  import IntermissionControls from './lib/IntermissionControls.svelte';
  import IntermissionTimer from './lib/IntermissionTimer.svelte';
  import { nextIntermissionDuration } from './lib/intermissionControls';
  import RevisionHistory from './lib/RevisionHistory.svelte';
  import RevisionSaveNotice from './lib/RevisionSaveNotice.svelte';
  import AppShell from './lib/AppShell.svelte';
  import SoundscapePopover from './lib/SoundscapePopover.svelte';
  import type { WorkspaceView } from './lib/workspace';

  const DEFAULT_DURATION_MINUTES = 25;
  const NOTE_AUTOSAVE_DEBOUNCE_MS = 600;
  const NOTE_SAVE_RETRY_DELAY_MS = 3000;

  let session = $state<SessionState>(createIdleState());
  let parkedThoughts = $state<ParkedThought[]>([]);
  let now = $state(Date.now());
  let taskDraft = $state('');
  let durationMinutes = $state(DEFAULT_DURATION_MINUTES);
  let breakIntermissionDurationMs = $state(5 * 60_000);
  let touchGrassDurationMs = $state(15 * 60_000);
  let error = $state<string | null>(null);
  let sessionPersistenceError = $state<string | null>(null);
  let intermissionAnnouncement = $state('');
  /** Announces a workspace switch (Focus/History/Revisions) for screen
   * reader users — the visible workspace doesn't otherwise get any
   * live-region confirmation that navigation actually happened. */
  let workspaceAnnouncement = $state('');
  let ready = $state(false);
  /** The visible workspace — independent of `session`/the timer, which
   * keep running (wall clock, deadline detection, alarm) regardless of
   * which workspace is showing. Never gate the timer effects below on
   * this value. */
  let workspaceView = $state<WorkspaceView>('focus');
  let historySummaries = $state<SessionSummary[]>([]);
  /** Created once, from validated startup results, inside runStartup() —
   * never re-created on a storage-init retry (see runStartup()'s own
   * doc). Nullable only for the brief window before that first successful
   * run; every template branch that reads it only renders once `ready` is
   * true, by which point it always exists. */
  let settingsController = $state<SettingsController | null>(null);
  let soundscapeController = $state<SoundscapeController | null>(null);
  let completionAlarmActive = $state(false);
  let noteContent = $state('');
  let noteSaveNeedsManualRetry = $state(false);
  /** Dedicated recovery-error state, deliberately never sharing the
   * generic `error` slot: an unrelated action's success (a note save, a
   * history delete, ...) resolving on its own timeline must not silently
   * clear a still-unresolved recovery failure, and vice versa. Session
   * and parked-thought recovery are tracked, retried, and cleared fully
   * independently of each other. */
  let sessionRecoveryError = $state<string | null>(null);
  let thoughtsRecoveryError = $state<string | null>(null);
  /** True only once the corresponding resource has been *fully and
   * safely* recovered — both the row/pool itself, and (for session) its
   * note. False for the entire duration a recovery attempt is in flight
   * or has failed, never flickering true partway through. Gates every
   * mutating action that would otherwise be built on top of an
   * unverified placeholder: starting a new focus session while
   * `!sessionRecovered`, and starting/parking/deleting/promoting a thought
   * while `!thoughtsRecovered`. Once true, stays true — a resource, once
   * safely known, is never re-guarded. */
  let sessionRecovered = $state(false);
  let thoughtsRecovered = $state(false);
  /** Bumped at the start of every loadLatestSessionRow()/
   * loadAllParkedThoughts() attempt (initial or Retry) — the same "only
   * the newest attempt may apply its result" discipline
   * noteSaveController.ts and settingsController.svelte.ts's
   * requestSequence already use, so two overlapping Retry clicks can
   * never let a slower, older response overwrite a newer one. */
  let sessionRecoveryAttempt = 0;
  let thoughtsRecoveryAttempt = 0;
  let sessionSaveSequence = 0;
  let failedSessionSave:
    | { state: SessionState; updatedAt: number; sequence: number }
    | null = null;
  /** Non-error, non-blocking status: a deletion/clear committed but a
   * secondary file-cleanup step failed and will retry at next startup.
   * Deliberately separate from `error` — a successful `flushPendingNoteSave`
   * clears `error`, which would otherwise silently erase this notice. */
  let cleanupWarning = $state<string | null>(null);

  /** Set only when "Back to start" fails to persist its acknowledgement —
   * the review screen stays showing (never presenting an idle state that
   * relaunch would just reverse) with this surfaced next to the button, so
   * clicking it again is the retry. Reset to null whenever a *new* session
   * reaches 'complete' (see applyResult), so a stale failure from a
   * previous review can never bleed into a later one. */
  let backToStartError = $state<string | null>(null);

  /** A non-transient note-save failure needing an explicit user decision:
   * an external edit conflict (offer Reload file / Keep my version), or a
   * missing/unreadable file (offer Retry — editing stays disabled until
   * it resolves). Never auto-retried, unlike a transient failure. */
  type NoteStorageIssue = {
    sessionId: string;
    kind: Exclude<NoteFailureKind, 'transient'>;
    diskContent: string | null;
    diskHash: string | null;
  };
  let noteStorageIssue = $state<NoteStorageIssue | null>(null);
  let confirmingConflictReload = $state(false);
  /** True when `initializeNoteStorage()` itself failed on startup (staged-
   * deletion recovery and/or the Phase 4A migration never ran) — a much
   * more fundamental failure than any single note's load, so this blocks
   * the whole app behind a dedicated recovery screen with Retry and Open
   * Notes Folder rather than silently falling through to the normal
   * idle/ready screen as though storage were fine. */
  let storageInitError = $state(false);

  // Composed once for the component's lifetime — see this file's own
  // teardown effect below for their matching disposal.
  const notificationAdapter = createNativeNotificationAdapter();
  const alarmSequence = createAlarmSequence({
    playOnce: playTone,
    durationMs: getToneDurationMs,
    beforeFirstPlay: () =>
      soundscapeController?.setAlarmOutputSuppressed(true) ?? Promise.resolve(),
    onActiveChange: (active) => {
      completionAlarmActive = active;
      if (!active) void soundscapeController?.setAlarmOutputSuppressed(false);
    },
  });
  const returnAlarmSequence = createAlarmSequence({
    playOnce: playTone,
    durationMs: getToneDurationMs,
  });
  let handledIntermissionDeadline = $state<string | null>(null);
  const warningCoordinator = createFocusWarningCoordinator({
    notifyWarning: (task, leadLabel) => notificationAdapter.notifyWarning(task, leadLabel),
  });
  const overtimeCadence = createOvertimeCadenceCoordinator({
    notifyWarning: (task, leadLabel) => notificationAdapter.notifyWarning(task, leadLabel),
  });

  /** Backgrounded vs foregrounded, for warning/completion notification
   * suppression — a minimized window counts as backgrounded. Independent
   * of `workspaceView`/Settings visibility, which never affect this. */
  let windowForeground = $state(document.visibilityState === 'visible');
  let warningView = $state<FocusWarningView>({
    visible: false,
    deadline: null,
    leadLabel: null,
    announcement: null,
  });
  let overtimeView = $state<OvertimeCadenceView>(EMPTY_OVERTIME_CADENCE_VIEW);

  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 250);
    return () => clearInterval(id);
  });

  $effect(() => {
    function updateForeground() {
      windowForeground = document.visibilityState === 'visible' && document.hasFocus();
    }
    document.addEventListener('visibilitychange', updateForeground);
    window.addEventListener('focus', updateForeground);
    window.addEventListener('blur', updateForeground);
    updateForeground();
    return () => {
      document.removeEventListener('visibilitychange', updateForeground);
      window.removeEventListener('focus', updateForeground);
      window.removeEventListener('blur', updateForeground);
    };
  });

  // Depends only on session, now, the validated warning setting, and
  // foreground state — never on workspaceView or drawer state, so
  // navigating or opening Settings never resets warning identity.
  $effect(() => {
    if (!settingsController) return;
    warningView = warningCoordinator.evaluate({
      session,
      now,
      lead: settingsController.current.focusWarningLeadMs,
      isForeground: windowForeground,
    });
  });

  // Runtime-only Flow cadence. Its marker identity is independent of
  // workspace navigation and Settings visibility; alarmDue is the single
  // gate for both live-expiry and recurring marker side effects.
  $effect(() => {
    if (!settingsController) return;
    const nextView = overtimeCadence.evaluate({
      session,
      now,
      lead: settingsController.current.focusWarningLeadMs,
      isForeground: windowForeground,
    });
    overtimeView = nextView;
    if (!nextView.alarmDue || session.status !== 'flow') return;

    alarmSequence.start(settingsController.current.selectedToneId ?? DEFAULT_TONE_ID);
    if (!windowForeground) {
      void notificationAdapter.notifyCompletion(session.task);
    }
  });

  // The live exact-deadline transition into Flow. Priming immediately
  // before the successful transition lets the cadence emit marker one;
  // recovered Flow is never primed, so its passed markers remain silent.
  $effect(() => {
    if (session.status !== 'focusing' || !isFocusDue(session, now)) return;
    const result = completeFocusIntoFlow(session, now);
    if (result.ok) overtimeCadence.activateLiveExpiry(session.sessionId);
    applyResult(result);
  });

  $effect(() => {
    if (session.status !== 'intermission' || !isIntermissionDue(session, now)) return;
    const deadlineKey = `${session.sessionId}:${session.intermissionDeadlineAt}`;
    if (handledIntermissionDeadline === deadlineKey) return;
    handledIntermissionDeadline = deadlineKey;
    returnAlarmSequence.start(
      settingsController?.current.selectedReturnToneId ?? DEFAULT_RETURN_TONE_ID,
    );
    if (!windowForeground) {
      void notificationAdapter.notifyIntermissionReturn(session.kind, session.task);
    }
  });

  $effect(() => {
    return () => {
      alarmSequence.cancel();
      returnAlarmSequence.cancel();
      warningCoordinator.dispose();
      overtimeCadence.dispose();
      void notificationAdapter.dispose();
    };
  });

  // Every repository write goes through this one queue — session saves,
  // parked-thought inserts/deletes, session deletes, and delete-all alike
  // — so a slow write that's already in flight (e.g. parking a thought)
  // can never land after a later delete and silently recreate the data
  // that delete just removed. The upsert's own updated_at guard is a
  // second line of defense on top of this ordering guarantee. A
  // file-backed note *load* that refreshes SQLite's content_hash counts as
  // a write for this ordering purpose too, so loadNoteRecordForSession and
  // loadAllSessionNotes are enqueued here rather than called directly.
  const writeQueue = createTaskQueue();

  /** The last content hash this session's note is known to have on disk,
   * used as the expected-hash for its next save's optimistic conflict
   * check. `null` means "no note exists yet" (or none has been loaded). */
  const noteHashBySession = new Map<string, string | null>();

  // Set by the mount effect's cleanup — shared with handleRetryStorageInit
  // so a retry triggered after the component unmounted (or a second mount
  // effect run) can't clobber state a later run already owns.
  let startupCancelled = false;

  /** Initializes native note storage (staged-deletion recovery, then
   * legacy Phase 4A migration), then recovers the last active/incomplete
   * session (if any), the full parked-thought pool, and every persisted
   * app setting in the same pass. Runs once on mount, and again from the
   * storage-init recovery screen's Retry button. An `initializeNoteStorage()`
   * failure blocks here — `storageInitError` stays true and `ready` is
   * never set — rather than falling through to a normal idle/ready screen
   * as though storage were fine. A failure loading the
   * session/thoughts/settings (rarer, and each individually recoverable in
   * place) is logged and still lets the app reach `ready`, matching this
   * function's original behavior. `settingsController` is created exactly
   * once, from this validated result — never re-created on a later
   * runStartup() call, and never given its own queue or hydration path
   * (see settingsController.svelte.ts's own doc). */
  async function runStartup(): Promise<void> {
    storageInitError = false;
    try {
      await initializeNoteStorage();
    } catch (err) {
      if (startupCancelled) return;
      console.error('Failed to initialize note storage:', err);
      storageInitError = true;
      return;
    }
    if (startupCancelled) return;

    // Settings load independently of session/thought recovery below, and
    // must always finish and create settingsController regardless of how
    // that recovery goes — `ready`'s own template gate also checks
    // settingsController, so leaving it unset here would strand the app
    // on "Loading..." forever. Each getSetting() is caught individually:
    // one key's read failing must not take down any other setting — it
    // just falls back to that key's own validated default, exactly like a
    // malformed persisted value already does via the parse* functions.
    const [
      themeFamily,
      appearanceMode,
      timerAccent,
      toneId,
      returnToneId,
      focusWarningLeadMs,
      selectedSoundscapeId,
      soundscapeVolume,
      dismissedHints,
      timerProgressStyle,
    ] = await Promise.all([
      getSetting(APP_SETTING_KEYS.themeFamily).catch(() => null),
      getSetting(APP_SETTING_KEYS.appearanceMode).catch(() => null),
      getSetting(APP_SETTING_KEYS.timerAccent).catch(() => null),
      getSetting(APP_SETTING_KEYS.selectedToneId).catch(() => null),
      getSetting(APP_SETTING_KEYS.selectedReturnToneId).catch(() => null),
      getSetting(APP_SETTING_KEYS.focusWarningLeadMs).catch(() => null),
      getSetting(APP_SETTING_KEYS.selectedSoundscapeId).catch(() => null),
      getSetting(APP_SETTING_KEYS.soundscapeVolume).catch(() => null),
      getSetting(APP_SETTING_KEYS.dismissedHints).catch(() => null),
      getSetting(APP_SETTING_KEYS.timerProgressStyle).catch(() => null),
    ]);
    if (startupCancelled) return;
    const initialSettings: AppSettings = {
      themeFamily: parseThemeFamily(themeFamily),
      appearanceMode: parseAppearanceMode(appearanceMode),
      timerAccent: parseTimerAccent(timerAccent),
      selectedToneId: parseToneId(toneId),
      selectedReturnToneId: parseReturnToneId(returnToneId),
      focusWarningLeadMs: parseFocusWarningLeadMs(focusWarningLeadMs),
      selectedSoundscapeId: parseSoundscapeId(selectedSoundscapeId),
      soundscapeVolume: parseSoundscapeVolume(soundscapeVolume),
      dismissedHints: parseDismissedHints(dismissedHints),
      timerProgressStyle: parseTimerProgressStyle(timerProgressStyle),
    };
    // Read synchronously so a `system` appearance mode already resolves
    // correctly on the very first render — the subscribeToSystemAppearance
    // effect below still attaches the live listener for later OS changes,
    // but the initial value can't wait for a post-mount effect to fire.
    const systemPrefersDark =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    settingsController ??= createSettingsController({
      initial: initialSettings,
      writeQueue,
      persist: setSetting,
      onPersistenceError: (key, err) => console.error(`Failed to persist setting ${key}:`, err),
      initialSystemPrefersDark: systemPrefersDark,
    });
    soundscapeController ??= createSoundscapeController({
      initialPresetId: initialSettings.selectedSoundscapeId,
      initialVolume: soundscapeVolumeToNumber(initialSettings.soundscapeVolume),
      createEngine: () =>
        createWebAudioSoundscapeEngine({
          loadTrack: createBundledTrackLoader(),
        }),
    });

    // Session and parked-thought recovery are two fully independent
    // resources, run concurrently but never coupled: a Retry for one must
    // never reload or reassign the other's state (see each function's own
    // doc). Neither ever rejects — each catches its own failure into its
    // own dedicated error state — so this can safely be a plain
    // Promise.all rather than allSettled.
    await Promise.all([recoverLatestSession(), recoverParkedThoughts()]);
    ready = true;
  }

  /** Loads the latest session row and, if it's active, that session's
   * note — then applies `session`/`noteContent`/`noteHashBySession`/
   * `noteStorageIssue`/`sessionRecoveryError`/`sessionRecovered` together,
   * in one synchronous block, only once *both* have fully settled. Called
   * once from runStartup() and again from Retry — each call is its own
   * generation (`sessionRecoveryAttempt`), checked after every await, so
   * an older, slower call can never overwrite what a newer one already
   * applied.
   *
   * The row and the note are held in local variables for the entire
   * duration: applying `session` before its note has resolved would let
   * the user start mutating a since-superseded placeholder out from under
   * a still-in-flight recovery, and would show the recovered timer next
   * to a blank *editable* note before its real content (or the disabled-
   * editor failure state standing in for it) actually exists. While
   * `!sessionRecovered`, `session` stays at its placeholder idle default
   * and starting a new focus session (the only session-mutating control
   * reachable from idle) is disabled in the template — the persisted
   * active session is still unknown, so nothing may be built on top of
   * the placeholder. That invariant is exactly what makes the final
   * unguarded assignment below safe: it only ever runs while mutation was
   * disabled, so there is never an in-progress, user-driven session to
   * clobber. */
  async function recoverLatestSession(): Promise<void> {
    const attempt = ++sessionRecoveryAttempt;
    let row: SessionRow | null;
    try {
      row = await loadLatestSessionRow();
    } catch (err) {
      if (startupCancelled || attempt !== sessionRecoveryAttempt) return;
      console.error('Failed to load the latest session:', err);
      sessionRecoveryError = 'Failed to load your saved session.';
      return;
    }
    if (startupCancelled || attempt !== sessionRecoveryAttempt) return;

    const recoveryNow = Date.now();
    let recoveredSession: SessionState;
    try {
      recoveredSession = recoverSessionState(row, recoveryNow);
    } catch (err) {
      if (startupCancelled || attempt !== sessionRecoveryAttempt) return;
      console.error('Failed to recover the latest session:', err);
      sessionRecoveryError = 'Failed to load your saved session.';
      return;
    }
    if (recoveredSession.status === 'intermission' && isIntermissionDue(recoveredSession, recoveryNow)) {
      handledIntermissionDeadline = `${recoveredSession.sessionId}:${recoveredSession.intermissionDeadlineAt}`;
    }

    // Covers 'complete' too, now that a recovered completed session
    // restores to its review screen instead of idle — see
    // recoverSessionState's own comment for why that changed. No note to
    // load for idle, so it applies immediately — same shape as the
    // non-idle path's final block below, just without the note fields.
    if (recoveredSession.status === 'idle') {
      sessionRecoveryError = null;
      sessionRecovered = true;
      session = recoveredSession;
      return;
    }

    const recoveredSessionId = recoveredSession.sessionId;
    let recoveredNoteContent: string;
    let recoveredNoteHash: string | null | undefined; // undefined = leave noteHashBySession untouched (failure path)
    let recoveredNoteIssue: NoteStorageIssue | null;
    try {
      const record = await writeQueue.enqueue(() => loadNoteRecordForSession(recoveredSessionId));
      if (startupCancelled || attempt !== sessionRecoveryAttempt) return;
      recoveredNoteContent = record?.content ?? '';
      recoveredNoteHash = record?.content_hash ?? null;
      recoveredNoteIssue = null;
    } catch (err) {
      if (startupCancelled || attempt !== sessionRecoveryAttempt) return;
      // Never fall through to a blank, *editable* draft here — that
      // would let the user silently recreate a note whose real content
      // we simply failed to read, discarding whatever was actually
      // there. Surface the same disabled-editor + Retry recovery UI a
      // later missing/unreadable save failure would, applied together
      // with the recovered session in the same update below rather than
      // exposed on its own first.
      console.error('Failed to load note for recovered session:', err);
      const normalized = normalizeNoteStorageError(err);
      recoveredNoteContent = '';
      recoveredNoteHash = undefined;
      recoveredNoteIssue = {
        sessionId: recoveredSessionId,
        kind: normalized.kind === 'transient' ? 'unreadable' : normalized.kind,
        diskContent: null,
        diskHash: null,
      };
    }

    // Everything applies together, synchronously — the recovered session
    // is never visible without its note editor's real state (content, or
    // the disabled-editor recovery state) already in place alongside it.
    sessionRecoveryError = null;
    sessionRecovered = true;
    session = recoveredSession;
    noteContent = recoveredNoteContent;
    if (recoveredNoteHash !== undefined) noteHashBySession.set(recoveredSessionId, recoveredNoteHash);
    noteStorageIssue = recoveredNoteIssue;
  }

  /** Loads the parked-thought pool — entirely independent of
   * recoverLatestSession() above: never touches `session` or `noteContent`,
   * so retrying a failed thought load can't disturb a session the user is
   * already actively working in (recovered or freshly started). Same
   * generation guard as recoverLatestSession(). While `!thoughtsRecovered`,
   * parking/deleting/promoting a thought is disabled (ParkingLot's own
   * `disabled` prop, plus a guard in each handler as defense in depth) —
   * the pool isn't yet safely known, so a mutation now would either act on
   * an incomplete pool or risk being silently overwritten once recovery
   * actually resolves. */
  async function recoverParkedThoughts(): Promise<void> {
    const attempt = ++thoughtsRecoveryAttempt;
    let thoughts: ParkedThought[];
    try {
      thoughts = await loadAllParkedThoughts();
    } catch (err) {
      if (startupCancelled || attempt !== thoughtsRecoveryAttempt) return;
      console.error('Failed to load parked thoughts:', err);
      thoughtsRecoveryError = 'Failed to load your parked thoughts.';
      return;
    }
    if (startupCancelled || attempt !== thoughtsRecoveryAttempt) return;
    thoughtsRecoveryError = null;
    thoughtsRecovered = true;
    parkedThoughts = thoughts;
  }

  function handleRetrySessionRecovery() {
    void recoverLatestSession();
  }

  function handleRetryThoughtsRecovery() {
    void recoverParkedThoughts();
  }

  $effect(() => {
    void runStartup();
    return () => {
      startupCancelled = true;
    };
  });

  $effect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => updateController.startCheck(), 5000);
    return () => window.clearTimeout(timer);
  });

  // The system-appearance observer is attached from a component effect,
  // not at module load or hidden inside settingsController's own factory
  // — this is the only place its subscription's cleanup can run (see
  // settingsController.svelte.ts's own doc for why). Re-runs only when
  // `settingsController` itself changes identity (created once, per its
  // own doc), so this effect fires at most twice: once as a no-op before
  // startup settles, once for real after.
  $effect(() => {
    const controller = settingsController;
    if (!controller || typeof window.matchMedia !== 'function') return;
    return controller.subscribeToSystemAppearance(window.matchMedia.bind(window));
  });

  $effect(() => {
    soundscapeController?.syncLifecycle(soundscapeLifecycleFor(session, completionAlarmActive));
  });

  $effect(() => {
    const controller = soundscapeController;
    if (!controller) return;
    return () => {
      void controller.dispose();
    };
  });

  function handleRetryStorageInit() {
    void runStartup();
  }

  function queueSaveSession(state: SessionState, updatedAt: number) {
    const sequence = ++sessionSaveSequence;
    writeQueue.enqueue(() => saveSession(state, updatedAt)).then(
      () => {
        if (sequence === sessionSaveSequence && failedSessionSave) {
          failedSessionSave = null;
          sessionPersistenceError = null;
        }
      },
      (err) => {
        console.error('Failed to persist session:', err);
        if (sequence === sessionSaveSequence) {
          failedSessionSave = { state, updatedAt, sequence };
          sessionPersistenceError = 'Failed to save session changes.';
        }
      },
    );
  }

  function handleRetrySessionSave() {
    if (!failedSessionSave) return;
    queueSaveSession(failedSessionSave.state, failedSessionSave.updatedAt);
  }

  function invalidateFailedSessionSave() {
    sessionSaveSequence += 1;
    failedSessionSave = null;
    sessionPersistenceError = null;
  }

  // Debounced note autosave, built on noteSaveController.ts (see that
  // module for the full race it closes: a save already enqueued when its
  // session is deleted must never repopulate itself and resurrect the note
  // once it fails). This file only owns the actual saveNote() call, the
  // debounce/auto-retry *timers*, and turning the controller's result into
  // UI state (the error banner, the manual-retry affordance).
  const noteSaveController = createNoteSaveController(
    async (sessionId, content) => {
      const result = await writeQueue.enqueue(() =>
        saveNote(sessionId, content, Date.now(), {
          expectedHash: noteHashBySession.get(sessionId) ?? null,
        }),
      );
      if (result.note) noteHashBySession.set(sessionId, result.note.content_hash);
      else noteHashBySession.delete(sessionId);
      if (result.cleanupPending) {
        cleanupWarning = 'Note cleared, but file cleanup will retry when the app restarts.';
      }
    },
    undefined,
    (error) => normalizeNoteStorageError(error).kind,
  );
  let noteSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let noteRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  // Automatic/checkpoint revision requests. Creation always goes through
  // the shared write queue, matching every other repository mutation. A
  // corruption/integrity failure (surfaced as 'unreadable' by the same
  // normalizer note storage errors use) is terminal — retrying the same
  // bytes could never fix it — everything else is treated as transient and
  // eligible for bounded auto-retry. See revisionSaveCoordinator.svelte.ts
  // for the producer-tracking, retry-timer, status-aggregation,
  // invalidation, and close-flush behavior this owns on App.svelte's
  // behalf.
  const revisionCoordinator = createRevisionSaveCoordinator({
    writeQueue,
    createRevision: (request) => createNoteRevision(request),
    deleteRevisionHistory: (sessionId) => deleteNoteRevisionHistory(sessionId),
    classifyFailure: (error) => (normalizeNoteStorageError(error).kind === 'unreadable' ? 'terminal' : 'transient'),
  });

  const updateController = createUpdateController({
    checkForUpdate: () =>
      check().then((update) =>
        update ? { version: update.version, downloadAndInstall: () => update.downloadAndInstall() } : null,
      ),
    relaunch,
  });

  /** The session whose revision history is loaded in the Revisions
   * workspace, or null when nothing has been opened yet. */
  let revisionsSessionId = $state<string | null>(null);
  let revisionsTask = $state('');
  let revisionsSessionDate = $state(0);
  let revisionsCurrentContent = $state('');
  let revisionsCurrentHash = $state<string | null>(null);
  let revisionsList = $state<NoteRevision[]>([]);
  /** True from the moment `openRevisionsView` starts until its load
   * settles — RevisionHistory.svelte disables Rename/Restore/Delete
   * history for the duration, since acting on `revisionsList`/
   * `revisionsCurrentContent` before they've actually been loaded for
   * *this* session would act on stale (or just-cleared) data. */
  let revisionsLoading = $state(false);
  /** Bumped by every `openRevisionsView` call (a new navigation *or* a
   * re-open of the same session) — never by rename/restore/delete/refresh
   * themselves. Every async completion that would otherwise write into
   * `revisionsCurrentContent`/`revisionsCurrentHash`/`revisionsList`
   * captures this at its own start and checks it's unchanged before
   * applying its result, so a response that lands after the view has
   * since moved on (to a different session, or a fresh re-open of the
   * same one) is discarded rather than clobbering newer state. Plain
   * (non-`$state`) since nothing ever reads it for rendering — it only
   * exists to be compared inside these guards. */
  let revisionsRequestId = 0;
  /** Brief, non-blocking feedback after a checkpoint attempt — cleared on
   * the next edit or checkpoint attempt. */
  let checkpointStatus = $state<string | null>(null);

  function clearNoteTimers() {
    if (noteSaveTimeout !== null) {
      clearTimeout(noteSaveTimeout);
      noteSaveTimeout = null;
    }
    if (noteRetryTimeout !== null) {
      clearTimeout(noteRetryTimeout);
      noteRetryTimeout = null;
    }
  }

  function handleRetryRevisionSave() {
    void revisionCoordinator.retry();
  }

  /** Flushes any pending note edit. Resolves `true` once it's safe to move
   * on — the save succeeded, there was nothing pending, or the pending save
   * had been invalidated by a deletion — and `false` only for a real,
   * still-relevant failure. Never rejects, so callers (including the
   * window-close handler) can always await it safely. A real failure
   * schedules a bounded number of automatic retries; once those are
   * exhausted, the error message switches to prompt a manual retry instead
   * of continuing to claim it'll retry itself. */
  /** The session the currently-visible note editor belongs to, or null
   * when there's no note editor on screen at all (idle). Used to attach a
   * non-transient failure to the right session — App.svelte only ever
   * shows one note editor at a time. */
  function currentNoteSessionId(): string | null {
    return session.status === 'idle' ? null : session.sessionId;
  }

  async function flushPendingNoteSave(): Promise<boolean> {
    clearNoteTimers();
    const result = await noteSaveController.flush();
    if (result.ok) {
      error = null;
      noteSaveNeedsManualRetry = false;
      noteStorageIssue = null;
      return true;
    }
    const kind = result.failure?.kind ?? 'transient';
    if (kind !== 'transient') {
      // Non-transient: stop auto-retrying outright and surface a specific
      // recovery choice instead of the generic retry banner — retrying a
      // conflict automatically would silently overwrite an external edit,
      // and retrying a missing/unreadable file automatically would just
      // paper over a problem the user needs to actually see.
      console.error('Note save requires a decision:', kind);
      noteSaveNeedsManualRetry = false;
      const sessionId = currentNoteSessionId();
      const normalized = result.failure ? normalizeNoteStorageError(result.failure.error) : null;
      if (sessionId) {
        noteStorageIssue = {
          sessionId,
          kind,
          diskContent: normalized?.diskContent ?? null,
          diskHash: normalized?.diskHash ?? null,
        };
      }
      error =
        kind === 'conflict'
          ? 'This note was changed outside the app.'
          : "This note's file could not be found or read.";
      return false;
    }
    console.error('Failed to save note');
    if (!result.exhausted) {
      error = 'Failed to save your note. Retrying…';
      noteSaveNeedsManualRetry = false;
      noteRetryTimeout = setTimeout(() => {
        noteRetryTimeout = null;
        void flushPendingNoteSave();
      }, NOTE_SAVE_RETRY_DELAY_MS);
    } else {
      error = 'Failed to save your note.';
      noteSaveNeedsManualRetry = true;
    }
    return false;
  }

  function handleRetryNoteSave() {
    noteSaveNeedsManualRetry = false;
    void flushPendingNoteSave();
  }

  /** Discards whatever unsaved draft was pending for the affected session
   * in favor of the external version, snapshotting that draft first (if
   * non-blank) as a `before_external_reload` safety revision — one atomic
   * native operation, so the snapshot and the discard can't come apart.
   * Only ever reached via the conflict banner's explicit Cancel/Confirm
   * step. Requires the disk hash to still equal what the conflict
   * reported; a second external edit since then comes back as a fresh
   * conflict instead of discarding the draft against stale information —
   * the banner stays up with the newer disk content. If the file is
   * missing/unreadable instead, the issue is re-shown with that kind. */
  async function handleReloadExternalNote() {
    if (!noteStorageIssue?.diskHash) return;
    const sessionId = noteStorageIssue.sessionId;
    const draft = noteContent;
    try {
      const result = await writeQueue.enqueue(() =>
        reloadExternalNoteAfterConflict(sessionId, draft, noteStorageIssue!.diskHash!, Date.now()),
      );
      noteSaveController.discard(sessionId);
      noteContent = result.note?.content ?? '';
      noteHashBySession.set(sessionId, result.note?.content_hash ?? null);
      noteStorageIssue = null;
      confirmingConflictReload = false;
      error = null;
      if (revisionsSessionId === sessionId) void refreshRevisionsList(sessionId);
    } catch (err) {
      confirmingConflictReload = false;
      const normalized = normalizeNoteStorageError(err);
      if (normalized.kind === 'conflict') {
        noteStorageIssue = {
          sessionId,
          kind: 'conflict',
          diskContent: normalized.diskContent,
          diskHash: normalized.diskHash,
        };
      } else if (normalized.kind === 'missing' || normalized.kind === 'unreadable') {
        noteStorageIssue = { sessionId, kind: normalized.kind, diskContent: null, diskHash: null };
      } else {
        console.error('Failed to reload note over external conflict:', err);
      }
    }
  }

  /** "Retry" for a missing/unreadable file. Unlike handleReloadExternalNote,
   * this never discards a preserved pending draft: if the note storage
   * controller still has unflushed content for this session — the edit
   * that failed to save in the first place, kept pending per its non-
   * transient-failures-stay-pending contract — retry the *save*, so that
   * draft is what actually lands once the file is readable again (and a
   * fresh conflict/missing/unreadable outcome is reported the same way any
   * other save failure would be). Only falls back to a plain re-read from
   * disk when nothing is pending for this session, e.g. after a startup
   * recovery load failure, where there was never a draft to retry. */
  async function handleRetryMissingNote() {
    if (!noteStorageIssue) return;
    const sessionId = noteStorageIssue.sessionId;
    if (noteSaveController.hasPending(sessionId)) {
      void flushPendingNoteSave();
      return;
    }
    try {
      const record = await writeQueue.enqueue(() => loadNoteRecordForSession(sessionId));
      noteContent = record?.content ?? '';
      noteHashBySession.set(sessionId, record?.content_hash ?? null);
      noteStorageIssue = null;
      error = null;
    } catch (err) {
      const normalized = normalizeNoteStorageError(err);
      noteStorageIssue = {
        sessionId,
        kind: normalized.kind === 'transient' ? 'unreadable' : normalized.kind,
        diskContent: null,
        diskHash: null,
      };
    }
  }

  /** Keeps the in-memory draft over the external version — the opposite
   * choice from Reload. One atomic native operation: it re-verifies the
   * disk hash still matches what the conflict reported, snapshots those
   * verified external bytes as a `before_external_overwrite` safety
   * revision, and only then writes the draft (or, for a blank draft,
   * clears the note the same safe way a whitespace clear would) — the
   * write never happens unless the safety snapshot actually committed.
   * The pending draft in noteSaveController is left untouched until this
   * succeeds, so a failure here leaves it available for a later retry
   * rather than losing it. A second external edit since the conflict was
   * reported comes back as a fresh conflict instead of silently
   * overwriting it — the banner stays up with the newer disk content. */
  async function handleKeepAppNote() {
    if (!noteStorageIssue?.diskHash) return;
    const sessionId = noteStorageIssue.sessionId;
    const draft = noteContent;
    try {
      const result = await writeQueue.enqueue(() =>
        keepAppNoteAfterConflict(sessionId, draft, noteStorageIssue!.diskHash!, Date.now()),
      );
      noteSaveController.discard(sessionId);
      noteHashBySession.set(sessionId, result.note?.content_hash ?? null);
      noteStorageIssue = null;
      error = null;
      if (revisionsSessionId === sessionId) void refreshRevisionsList(sessionId);
    } catch (err) {
      const normalized = normalizeNoteStorageError(err);
      if (normalized.kind === 'conflict') {
        noteStorageIssue = {
          sessionId,
          kind: 'conflict',
          diskContent: normalized.diskContent,
          diskHash: normalized.diskHash,
        };
      } else {
        console.error('Failed to keep note over external conflict:', err);
      }
    }
  }

  /** True only when the *current* note editor's file is missing/unreadable
   * — a conflict deliberately keeps editing enabled (the user's draft is
   * exactly what "Keep my version" would submit), but there's nowhere safe
   * for new keystrokes to land when the file itself can't be read. */
  const noteEditingDisabled = $derived.by(() => {
    if (!noteStorageIssue) return false;
    if (noteStorageIssue.kind === 'conflict') return false;
    return noteStorageIssue.sessionId === currentNoteSessionId();
  });

  /** True when checkpoint's correctness currently depends on a note flush
   * that hasn't succeeded — a manual-retry-eligible failure or an
   * unresolved conflict/missing-file issue. A merely-pending edit still
   * inside its debounce window is not a failure and doesn't disable
   * anything. Revisions viewing itself never depends on this — read-only
   * navigation must never wait for a save. */
  const notesWritesDisabled = $derived(noteSaveNeedsManualRetry || noteStorageIssue !== null);

  /** Gates the ready-to-restart stage behind an idle session — restarting
   * would discard an in-progress focus/flow/break/intermission, so that
   * stage never renders while one is active. The other stages (available,
   * downloading) are harmless to show regardless of session status. */
  const visibleUpdateStage = $derived.by(() => {
    if (updateController.stage === 'ready' && session.status !== 'idle') return null;
    if (updateController.stage === 'available') return 'available' as const;
    if (updateController.stage === 'downloading') return 'downloading' as const;
    if (updateController.stage === 'ready') return 'ready' as const;
    return null;
  });

  // The compact timer strip shown above History/Revisions while a focus,
  // pause, flow, or break session is active. Purely presentational
  // derivations — none of this owns or resets `session`; they just read
  // it the same way the full Timer views do.

  const compactMode = $derived.by((): 'focus' | 'flow' | 'break' | 'intermission' => {
    if (session.status === 'intermission') return 'intermission';
    if (session.status === 'flow' || session.status === 'flowPaused') return 'flow';
    if (session.status === 'break') return 'break';
    return 'focus';
  });

  // Where the Step Away controls (Break/Touch Grass) are actually
  // rendered — deliberately narrower than compactMode, which defaults to
  // 'focus' for idle/complete/awaitingDecision too and isn't safe to read
  // outside a branch that's already gated on an active session.
  const showsStepAway = $derived(
    session.status === 'focusing' ||
      session.status === 'paused' ||
      session.status === 'flow' ||
      session.status === 'flowPaused',
  );
  // Greenhouse is additionally visible during an intermission itself
  // (planting/reading thoughts doesn't require leaving Break/Touch Grass).
  const showsGreenhouse = $derived(showsStepAway || session.status === 'intermission');

  /** True for Flow entered by deadline expiry (live or recovered) — never
   * set by explicitly restarting/continuing, which always begins a new
   * focus cycle, not Flow directly. Drives both the "Quiet overtime"
   * display label and which completion prompt variant renders. */
  const isQuietOvertime = $derived(
    (session.status === 'flow' || session.status === 'flowPaused') &&
      session.flowStartedAt === session.focusCompletedAt,
  );

  const compactIsPaused = $derived.by(() => session.status === 'paused' || session.status === 'flowPaused');

  const compactDisplayMs = $derived.by(() => {
    if (session.status === 'focusing' || session.status === 'paused') return getFocusRemainingMs(session, now) ?? 0;
    if (session.status === 'flow' || session.status === 'flowPaused') return getFlowElapsedMs(session, now) ?? 0;
    if (session.status === 'break') return getBreakElapsedMs(session, now) ?? 0;
    if (session.status === 'intermission') {
      return isIntermissionDue(session, now)
        ? getIntermissionOvertimeMs(session, now) ?? 0
        : getIntermissionRemainingMs(session, now) ?? 0;
    }
    return 0;
  });

  function compactFinish() {
    if (session.status === 'focusing' || session.status === 'paused') {
      handleFinishFocusEarly();
    } else if (session.status === 'flow' || session.status === 'flowPaused') {
      handleFinishFlow();
    } else if (session.status === 'break') {
      handleEndBreak();
    }
  }

  function scheduleNoteSave(sessionId: string, content: string) {
    noteSaveController.schedule(sessionId, content);
    noteSaveNeedsManualRetry = false;
    clearNoteTimers();
    noteSaveTimeout = setTimeout(() => {
      noteSaveTimeout = null;
      void flushPendingNoteSave();
    }, NOTE_AUTOSAVE_DEBOUNCE_MS);
  }

  /** Invalidates a note edit that's pending or waiting on a retry, so it can
   * never fire later and write a note back for a session that's about to be
   * (or already was) deleted. Pass no id to invalidate everything
   * (delete-all). Deliberately called *twice* around a delete: once before
   * enqueuing it (covers a save still sitting in a debounce/retry timer,
   * not yet enqueued at all) and once after it commits (covers a save that
   * was already enqueued — in flight — when the delete started, and only
   * repopulates itself for retry *after* failing, possibly while the
   * delete was still waiting its turn in the queue). */
  function cancelPendingNoteSave(sessionId?: string) {
    noteSaveController.invalidate(sessionId);
    revisionCoordinator.invalidate(sessionId);
    if (!noteSaveController.hasPending()) {
      clearNoteTimers();
      noteSaveNeedsManualRetry = false;
    }
    // A conflict/missing-file issue for a session that's being (or was
    // just) deleted has nothing left to reload or keep — drop it rather
    // than leaving a dangling recovery prompt for data that's gone.
    if (noteStorageIssue && (sessionId === undefined || noteStorageIssue.sessionId === sessionId)) {
      noteStorageIssue = null;
      confirmingConflictReload = false;
    }
  }

  // Tauri only: hold the window open long enough to flush every pending
  // note edit and drain the rest of the write queue before actually
  // closing, so a note typed right before quitting can't be dropped
  // mid-save. If the note flush reports a real failure, the close is
  // aborted entirely — the window stays open, the edit stays pending, and
  // the error (with a retry action once auto-retries are exhausted) stays
  // visible. destroy() (unlike close()) doesn't re-emit close-requested, so
  // there's no risk of looping back into this same handler.
  $effect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        const noteFlushOk = await flushPendingNoteSave();
        // flushForClose() itself drains the shared write queue as part of
        // its sealed producers→controller→queue loop — no separate drain
        // call here, so nothing can slip in between its own last check and
        // this handler deciding whether to actually destroy the window.
        const revisionFlushOk = await revisionCoordinator.flushForClose();
        if (!noteFlushOk || !revisionFlushOk) return; // keep the window open; the error is already showing
        await win.destroy();
      });
    })();
    return () => unlisten?.();
  });

  /** Submits an automatic `session_completed` snapshot once the flush this
   * transition kicked off actually lands, using the exact content this
   * transition committed — never the (possibly further-edited) live
   * `noteContent`. The hash is derived directly from that same immutable
   * `content` string (`sha256Hex`), not read back from
   * `noteHashBySession` afterward: that map is shared/mutable per session,
   * and a review edit typed during this same flush can — via the no-arg
   * `flushPendingNoteSave()`'s own re-scan-and-pick-up-new-work loop — have
   * its *own* save land as part of the very `flushPromise` this function is
   * awaiting, overwriting the map with a hash that no longer corresponds to
   * `content`. Computing the hash directly makes {content, contentHash} one
   * atomic, self-consistent pair regardless of anything else that raced in.
   * A failed flush keeps the completed session state and preserves the
   * pending edit for retry; no snapshot is promised for it (see the
   * design's automatic-snapshot failure handling). Blank content creates no
   * snapshot either. */
  async function snapshotSessionCompleted(
    sessionId: string,
    completedAt: number,
    content: string,
    flushPromise: Promise<boolean>,
  ) {
    // Captured *before* awaiting the flush — this function's true intent
    // boundary — so an invalidate() that happens while this is still
    // waiting on flushPromise is correctly observed once submit() runs.
    const token = revisionCoordinator.beginIntent(sessionId);
    const flushed = await flushPromise;
    if (!flushed || !hasNoteContent(content)) return;
    const contentHash = await sha256Hex(content);
    await revisionCoordinator.submit(token, {
      sessionId,
      content,
      contentHash,
      kind: 'automatic',
      reason: 'session_completed',
      createdAt: completedAt,
    });
  }

  function applyResult(result: TransitionResult) {
    // Flush first: any transition (pause, finish, finish-early, etc.)
    // should never leave an un-persisted, debounce-pending note edit
    // behind. Captured before the flush starts, not read again afterward —
    // see snapshotSessionCompleted's doc.
    const previous = session;
    const contentBeingFlushed = noteContent;
    const flushPromise = flushPendingNoteSave();
    void flushPromise;
    if (result.ok) {
      session = result.state;
      error = null;
      if (session.status !== 'intermission') intermissionAnnouncement = '';
      queueSaveSession(result.state, Date.now());
      // Every path into 'complete' — decision-screen Finish, finish early,
      // finish flow, and end break — is covered here in one place, since
      // it's the transition's *destination* that matters, not which
      // button triggered it. Recovering an already-complete session on
      // startup never passes through here, so it never synthesizes one.
      if (previous.status !== 'complete' && session.status === 'complete') {
        // A fresh review screen — any stale acknowledgement-write failure
        // from a previous session's review must never bleed into this one.
        backToStartError = null;
        // Tracked from this exact call — its intent boundary — not from
        // whenever it first happens to call submit(): it awaits
        // `flushPromise` before that, and a window close in the meantime
        // must still wait for it (see revisionSaveCoordinator.svelte.ts).
        revisionCoordinator.trackProducer(
          snapshotSessionCompleted(session.sessionId, session.completedAt, contentBeingFlushed, flushPromise),
        );
      }
    } else {
      error = result.error;
    }
  }

  function handleNoteChange(content: string) {
    noteContent = content;
    checkpointStatus = null;
    // 'complete' is included deliberately: the review screen's note is
    // editable, not read-only, so edits made there need to autosave too.
    if (session.status === 'idle') return;
    scheduleNoteSave(session.sessionId, content);
  }

  /** Applied after starting the next session from the review screen (either
   * path). If the user opted to carry the just-reviewed note forward, it's
   * scheduled and flushed through the exact same noteSaveController as any
   * other note edit — not a bespoke one-off write — so a failure here gets
   * the same bounded auto-retry, manual-retry action, and close-blocking
   * behavior as normal autosave, rather than leaving the carried text
   * visible only in this component's in-memory state if the write fails.
   * Flushed immediately rather than going through the debounce timer, since
   * there's nothing left to batch — this *is* the final content. The
   * original session's note row is never touched either way; this only
   * ever writes to `newSessionId`. */
  function applyCarriedNote(newSessionId: string, finalizedNote: string, carryForward: boolean) {
    if (carryForward && hasNoteContent(finalizedNote)) {
      noteContent = finalizedNote;
      noteSaveController.schedule(newSessionId, finalizedNote);
      clearNoteTimers();
      const flushPromise = flushPendingNoteSave();
      // Tracked from this exact call — see snapshotSessionCompleted's call
      // site for why.
      revisionCoordinator.trackProducer(snapshotSessionStarted(newSessionId, finalizedNote, flushPromise));
    } else {
      noteContent = ''; // fresh session, blank notes editor — no start snapshot
    }
  }

  /** Submits an automatic `session_started` snapshot once the carried
   * note's flush lands, using the exact carried content and its own
   * directly-derived hash (`sha256Hex`) as one immutable pair — not
   * `noteHashBySession`, for the same reason `snapshotSessionCompleted`
   * doesn't: an edit made in the *new* session before this flush settles
   * shares the same session id, and could otherwise overwrite the map with
   * a hash that no longer matches `content`. The new timer/workspace never
   * waits on this — it's fired in the background from applyCarriedNote,
   * which itself isn't awaited by its callers. */
  async function snapshotSessionStarted(sessionId: string, content: string, flushPromise: Promise<boolean>) {
    // Captured before awaiting the flush — see snapshotSessionCompleted's
    // token comment for why.
    const token = revisionCoordinator.beginIntent(sessionId);
    const flushed = await flushPromise;
    if (!flushed) return;
    const contentHash = await sha256Hex(content);
    await revisionCoordinator.submit(token, {
      sessionId,
      content,
      contentHash,
      kind: 'automatic',
      reason: 'session_started',
      createdAt: Date.now(),
    });
  }

  /** Submits an automatic `review_finalized` snapshot for the
   * just-reviewed session, using its already-flushed content and a hash
   * derived directly from that same immutable string (`sha256Hex`) — not
   * `noteHashBySession`, matching `snapshotSessionCompleted`'s reasoning:
   * the map is shared/mutable per session, and reading it after an
   * `await` boundary risks pairing this content with some other save's
   * hash. Deduplicates naturally (native dedup by content hash) into a
   * no-op when review made no changes since the session-complete
   * snapshot. */
  async function submitReviewFinalized(sessionId: string, content: string) {
    // Captured as this function's first statement — its intent boundary —
    // see snapshotSessionCompleted's token comment for why.
    const token = revisionCoordinator.beginIntent(sessionId);
    if (!hasNoteContent(content)) return;
    const contentHash = await sha256Hex(content);
    await revisionCoordinator.submit(token, {
      sessionId,
      content,
      contentHash,
      kind: 'automatic',
      reason: 'review_finalized',
      createdAt: Date.now(),
    });
  }

  /** Checks/requests native notification permission on the first focus
   * start, from every entry point that starts a fresh focusing session.
   * Completion notifications remain available even when advance warnings
   * are Off. Never awaited — permission handling
   * must never delay or block the focus-start transition. A no-op in the
   * browser and once a decision (granted or denied) is already known. */
  function maybeEnsureNotificationPermission() {
    void notificationAdapter.ensurePermission();
  }

  function startFreshFocus(task: string): boolean {
    const result = startFocusWithDurationMinutes(
      session,
      task,
      durationMinutes,
      Date.now(),
      crypto.randomUUID(),
    );
    applyResult(result);
    if (result.ok) {
      taskDraft = '';
      noteContent = ''; // fresh session, blank notes editor
      maybeEnsureNotificationPermission();
    }
    return result.ok;
  }

  function handleStart(event: Event) {
    event.preventDefault();
    startFreshFocus(taskDraft);
  }

  function handleStartParkedThought(id: string) {
    if (!sessionRecovered || !thoughtsRecovered || session.status !== 'idle') return;
    const thought = parkedThoughts.find((candidate) => candidate.id === id);
    // Only consume the thought once its own fresh-focus transition actually
    // succeeded — an invalid duration or a rejected transition must leave
    // it exactly as it was (see duration.ts's own doc for why "not ok"
    // means nothing changed).
    if (!thought || !startFreshFocus(thought.text)) return;
    handleDeleteThought(id);
  }

  function handlePause() {
    alarmSequence.cancel();
    applyResult(pause(session, Date.now()));
  }

  function handleResume() {
    applyResult(resume(session, Date.now()));
  }

  function handleStartIntermission(kind: IntermissionKind) {
    const durationMs =
      kind === 'break' ? breakIntermissionDurationMs : touchGrassDurationMs;
    alarmSequence.cancel();
    returnAlarmSequence.cancel();
    const result = startIntermission(session, kind, durationMs, Date.now());
    applyResult(result);
    if (result.ok) {
      intermissionAnnouncement = `${kind === 'break' ? 'Break' : 'Touch Grass'} started.`;
      void notificationAdapter.ensurePermission();
    }
  }

  function handleReturnFromIntermission() {
    returnAlarmSequence.cancel();
    applyResult(returnFromIntermission(session, Date.now()));
  }

  function handleCycleIntermissionDuration(kind: IntermissionKind) {
    if (kind === 'break') {
      breakIntermissionDurationMs = nextIntermissionDuration(
        kind,
        breakIntermissionDurationMs,
      );
    } else {
      touchGrassDurationMs = nextIntermissionDuration(kind, touchGrassDurationMs);
    }
  }

  /** "Continue focusing" from the warning prompt: restarts the full
   * planned duration, unlimited times, keeping the same session ID, task,
   * note, and parked thoughts. */
  function handleContinueFocusing() {
    alarmSequence.cancel();
    applyResult(restartFocusCycle(session, Date.now()));
  }

  /** "Take a break now" from the warning prompt while still focusing —
   * counts as a successful completion, recording actual focus time. */
  function handleTakeBreakNow() {
    alarmSequence.cancel();
    applyResult(takeBreakFromFocus(session, Date.now()));
  }

  function handleStayWithIt() {
    alarmSequence.cancel();
    overtimeView = overtimeCadence.acknowledge();
  }

  /** "Take a break" from the quiet-overtime prompt — same as above, but
   * from Flow, folding in whatever flow time already elapsed. */
  function handleTakeBreakFromOvertime() {
    alarmSequence.cancel();
    applyResult(takeBreakFromFlow(session, Date.now()));
  }

  /** "End session" from the quiet-overtime prompt. */
  function handleEndOvertime() {
    alarmSequence.cancel();
    applyResult(finishFlow(session, Date.now()));
  }

  function handleFinishFlow() {
    alarmSequence.cancel();
    applyResult(finishFlow(session, Date.now()));
  }

  function handleEndBreak() {
    applyResult(endBreak(session, Date.now()));
  }

  function handleFinishFocusEarly() {
    alarmSequence.cancel();
    applyResult(finishFocusEarly(session, Date.now()));
  }

  function handlePark(text: string) {
    if (!thoughtsRecovered) return; // defense in depth — ParkingLot's own disabled prop is the primary guard
    if (session.status === 'idle' || session.status === 'complete') return;
    const next = addParkedThought(parkedThoughts, crypto.randomUUID(), text, Date.now(), session.sessionId);
    if (next === parkedThoughts) return; // blank/whitespace text; addParkedThought no-opped
    parkedThoughts = next;
    const added = next[next.length - 1];
    writeQueue.enqueue(() => insertParkedThought(added)).catch((err) => {
      console.error('Failed to persist parked thought:', err);
    });
  }

  function handleDeleteThought(id: string) {
    if (!thoughtsRecovered) return; // defense in depth — the pool isn't safely known yet
    parkedThoughts = removeParkedThought(parkedThoughts, id);
    writeQueue.enqueue(() => deleteParkedThoughtRow(id)).catch((err) => {
      console.error('Failed to delete parked thought:', err);
    });
  }

  /** Unlike handlePark, never gated on an active session — planting from
   * the Greenhouse view works whether or not a session is running. A
   * thought planted while idle gets no sessionId at all (see
   * ParkedThought's own doc for why that's meaningful, not just absent
   * data). */
  function handlePlantFromGreenhouse(text: string) {
    if (!thoughtsRecovered) return; // defense in depth — Greenhouse's own disabled prop is the primary guard
    const sessionId = session.status === 'idle' ? undefined : session.sessionId;
    const next = addParkedThought(parkedThoughts, crypto.randomUUID(), text, Date.now(), sessionId);
    if (next === parkedThoughts) return; // blank/whitespace text; addParkedThought no-opped
    parkedThoughts = next;
    const added = next[next.length - 1];
    writeQueue.enqueue(() => insertParkedThought(added)).catch((err) => {
      console.error('Failed to persist parked thought:', err);
    });
  }

  function handleUpdateThoughtNote(id: string, note: string) {
    if (!thoughtsRecovered) return; // defense in depth — the pool isn't safely known yet
    parkedThoughts = setParkedThoughtNote(parkedThoughts, id, note);
    writeQueue.enqueue(() => updateParkedThoughtNote(id, note)).catch((err) => {
      console.error('Failed to persist parked thought note:', err);
    });
  }

  /** Promotes a parked thought into the next session. Returns whether it
   * actually happened, so SessionReview.svelte only clears/advances its own
   * local UI state on success. Deliberately awaits the just-reviewed
   * session's own note flush *before* creating the new session or
   * scheduling its carried note: this serializes the two sessions' saves
   * rather than letting them run concurrently, and if the old note can't
   * be finalized, the review screen stays exactly as it was — no next
   * session starts — until the user retries it successfully (the existing
   * error banner and retry action already surface that). */
  async function handlePromoteThought(id: string, minutes: number, carryNoteForward: boolean): Promise<boolean> {
    if (!thoughtsRecovered) return false; // defense in depth — the pool isn't safely known yet
    const thought = parkedThoughts.find((t) => t.id === id);
    if (!thought) return false;
    if (session.status === 'idle') return false; // only ever called from review; narrows session.sessionId below
    const oldSessionId = session.sessionId;
    const finalizedNote = noteContent; // the just-reviewed session's finalized note text
    const oldNoteFlushedOk = await flushPendingNoteSave();
    if (!oldNoteFlushedOk) return false; // stay on review; error + retry UI already surfaced
    // Tracked from this exact call — see snapshotSessionCompleted's call
    // site for why.
    revisionCoordinator.trackProducer(submitReviewFinalized(oldSessionId, finalizedNote));
    const newSessionId = crypto.randomUUID();
    const result = startFocusWithDurationMinutes(session, thought.text, minutes, Date.now(), newSessionId);
    applyResult(result);
    if (!result.ok) return false; // keep the thought — nothing succeeded, nothing should be lost
    durationMinutes = minutes;
    maybeEnsureNotificationPermission();
    applyCarriedNote(newSessionId, finalizedNote, carryNoteForward);
    parkedThoughts = removeParkedThought(parkedThoughts, id);
    writeQueue.enqueue(() => deleteParkedThoughtRow(id)).catch((err) => {
      console.error('Failed to delete promoted parked thought:', err);
    });
    return true;
  }

  /** Starts the next session from a typed task. See handlePromoteThought's
   * doc for why the old session's note is flushed and awaited first. */
  async function handleStartNext(task: string, minutes: number, carryNoteForward: boolean): Promise<boolean> {
    if (session.status === 'idle') return false; // only ever called from review; narrows session.sessionId below
    const oldSessionId = session.sessionId;
    const finalizedNote = noteContent; // the just-reviewed session's finalized note text
    const oldNoteFlushedOk = await flushPendingNoteSave();
    if (!oldNoteFlushedOk) return false; // stay on review; error + retry UI already surfaced
    // Tracked from this exact call — see snapshotSessionCompleted's call
    // site for why.
    revisionCoordinator.trackProducer(submitReviewFinalized(oldSessionId, finalizedNote));
    const newSessionId = crypto.randomUUID();
    const result = startFocusWithDurationMinutes(session, task, minutes, Date.now(), newSessionId);
    applyResult(result);
    if (!result.ok) return false;
    durationMinutes = minutes;
    maybeEnsureNotificationPermission();
    applyCarriedNote(newSessionId, finalizedNote, carryNoteForward);
    return true;
  }

  /** "Back to start": returns to the idle front page from review without
   * starting anything new. The just-reviewed session's history, note, and
   * revisions are all already saved and untouched by this — the only new
   * write is a narrow acknowledgement flag (see acknowledgeSessionReview),
   * so a later launch's recovery knows to open idle instead of reopening
   * this same review (see recoverSessionState). That write is awaited and
   * checked *before* leaving the in-memory `session` state: presenting an
   * idle screen the user could keep using, only to have relaunch silently
   * reopen the old review because the acknowledgement never actually
   * persisted, would be worse than just staying on review with a visible
   * retry — clicking the button again is that retry. */
  async function handleBackToStart(): Promise<void> {
    if (session.status !== 'complete') return;
    const sessionId = session.sessionId;
    const finalizedNote = noteContent;
    const flushedOk = await flushPendingNoteSave();
    if (!flushedOk) return; // stay on review; error + retry UI already surfaced

    try {
      await writeQueue.enqueue(() => acknowledgeSessionReview(sessionId, Date.now()));
    } catch (err) {
      console.error('Failed to acknowledge the reviewed session:', err);
      backToStartError = 'Failed to save. Please try again.';
      return; // stay on review — never present an idle state relaunch would reverse
    }
    backToStartError = null;

    revisionCoordinator.trackProducer(submitReviewFinalized(sessionId, finalizedNote));
    session = createIdleState();
    intermissionAnnouncement = '';
    workspaceView = 'focus';
    taskDraft = '';
    durationMinutes = DEFAULT_DURATION_MINUTES;
    noteContent = '';
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }

  /** Read-only workspace navigation: switches immediately and never waits
   * for note persistence, so History/Revisions stay reachable even while a
   * save is stuck retrying. A background flush is still kicked off (best
   * effort) so the workspace's own view of committed content catches up
   * once it lands; the global error banner stays visible throughout. */
  const WORKSPACE_LABELS: Record<WorkspaceView, string> = {
    focus: 'Focus',
    history: 'History',
    revisions: 'Revisions',
    greenhouse: 'Greenhouse',
  };

  function handleNavigate(next: WorkspaceView) {
    workspaceView = next;
    workspaceAnnouncement = WORKSPACE_LABELS[next];
    if (noteSaveController.hasPending()) void flushPendingNoteSave();
    if (next === 'history') void refreshHistorySummaries();
  }

  async function refreshHistorySummaries() {
    try {
      const [rows, notes, revisionCounts] = await Promise.all([
        loadCompletedSessions(),
        writeQueue.enqueue(() => loadAllSessionNotes()),
        loadNoteRevisionCounts(),
      ]);
      historySummaries = buildSessionHistory(rows, parkedThoughts, notes, revisionCounts);
      error = null;
    } catch (err) {
      console.error('Failed to load session history:', err);
      error = 'Failed to load session history.';
    }
  }

  /** Opens Revisions for `sessionId`. Navigates immediately (read-only,
   * never waits for persistence); if the loaded editor belongs to this
   * exact session, starts a background flush so the loaded "current" note
   * catches up to the latest draft once it lands. Clears the prior
   * session's content/list *synchronously*, before the new session's
   * header even renders, so a freshly-mounted RevisionHistory never shows
   * a stale revision/current-note pairing under the new session's title —
   * `revisionsLoading` disables Rename/Restore/Delete history for the same
   * window. Loads the session's last committed note/hash and revision
   * metadata through the shared queue; a stale in-flight open (superseded
   * by navigating elsewhere, or by re-opening the very same session again,
   * before it resolves) is discarded via the request token rather than
   * clobbering newer state. */
  async function openRevisionsView(sessionId: string, task: string, sessionDate: number) {
    const requestId = ++revisionsRequestId;
    revisionsSessionId = sessionId;
    revisionsTask = task;
    revisionsSessionDate = sessionDate;
    revisionsCurrentContent = '';
    revisionsCurrentHash = null;
    revisionsList = [];
    revisionsLoading = true;
    handleNavigate('revisions');
    if (sessionId === currentNoteSessionId() && noteSaveController.hasPending(sessionId)) {
      void flushPendingNoteSave();
    }
    try {
      const [record, list] = await Promise.all([
        writeQueue.enqueue(() => loadNoteRecordForSession(sessionId)),
        listNoteRevisions(sessionId),
      ]);
      if (requestId !== revisionsRequestId) return; // superseded before this landed
      revisionsCurrentContent = record?.content ?? '';
      revisionsCurrentHash = record?.content_hash ?? null;
      revisionsList = list;
      revisionsLoading = false;
    } catch (err) {
      if (requestId !== revisionsRequestId) return;
      console.error('Failed to load note revisions:', err);
      error = 'Failed to load note revisions.';
      revisionsLoading = false;
    }
  }

  function handleViewRevisions(sessionId: string, task: string, sessionDate: number) {
    void openRevisionsView(sessionId, task, sessionDate);
  }

  /** Opens Revisions for the currently active/loaded session — the
   * SessionNotes toolbar's own history action, which always means "this
   * session", unlike History's per-row action which names its target
   * explicitly. */
  function handleViewCurrentRevisions() {
    if (session.status === 'idle') return;
    const sessionDate =
      session.status === 'complete'
        ? session.completedAt
        : session.status === 'intermission'
          ? session.returnState.startedAt
          : session.startedAt;
    void openRevisionsView(session.sessionId, session.task, sessionDate);
  }

  async function handleRenameRevision(id: string, label: string | null): Promise<NoteRevision> {
    const requestId = revisionsRequestId;
    const renamed = await writeQueue.enqueue(() => renameNoteRevision(id, label));
    if (requestId === revisionsRequestId) {
      revisionsList = revisionsList.map((revision) => (revision.id === id ? renamed : revision));
    }
    return renamed;
  }

  /** Guarded by the request token: a refresh triggered by some other
   * success handler (checkpoint, Keep/Reload, restore) may still be in
   * flight when the view moves on to a different session (or re-opens the
   * same one) — applying its result at that point would clobber newer
   * state with a stale list. */
  async function refreshRevisionsList(sessionId: string) {
    const requestId = revisionsRequestId;
    try {
      const list = await listNoteRevisions(sessionId);
      if (requestId !== revisionsRequestId) return;
      revisionsList = list;
    } catch (err) {
      console.error('Failed to refresh note revisions:', err);
    }
  }

  /** Restores a revision as the current note for whichever session
   * Revisions is open on. Never touches `workspaceView` or session/timer
   * state — restore is purely a note-content operation. On success,
   * refreshes the Revisions view's own comparison and timeline (a
   * `before_restore` safety revision may have just been created) *only if*
   * the view hasn't since moved on to a different session or re-opened
   * this same one (guarded by the request token — a restore can take a
   * moment, and applying a stale result on top of a fresh navigation would
   * clobber it). The active-editor and History-summary updates below are
   * unaffected by that guard: they apply to whichever session was
   * actually restored, regardless of what the Revisions view happens to
   * be showing right now. A stale-conflict throw is left for
   * RevisionHistory.svelte itself to handle (it never reuses the active
   * editor's Keep/Reload prompt). */
  async function handleRestoreRevision(
    revisionId: string,
    expectedCurrentHash: string | null,
  ): Promise<RestoreRevisionResult> {
    const sessionId = revisionsSessionId;
    const requestId = revisionsRequestId;
    const result = await writeQueue.enqueue(() => restoreNoteRevision(revisionId, expectedCurrentHash, Date.now()));
    if (sessionId) {
      if (requestId === revisionsRequestId) {
        revisionsCurrentContent = result.note.content;
        revisionsCurrentHash = result.note.content_hash;
        void refreshRevisionsList(sessionId);
      }
      historySummaries = historySummaries.map((summary) =>
        summary.id === sessionId
          ? { ...summary, noteContent: hasNoteContent(result.note.content) ? result.note.content : null }
          : summary,
      );
      if (sessionId === currentNoteSessionId()) {
        noteSaveController.discard(sessionId);
        noteContent = result.note.content;
        noteHashBySession.set(sessionId, result.note.content_hash);
        checkpointStatus = null;
      }
    }
    return result;
  }

  /** Non-destructive: re-reads the current note fresh (never the target
   * revision) and reports it back to RevisionHistory.svelte so it can
   * require a brand-new confirmation against what's actually on disk now,
   * without discarding the selected revision or touching anything else.
   * The returned snapshot always reflects what was actually read; the
   * app-level `revisionsCurrentContent`/`revisionsCurrentHash` are only
   * updated if the view hasn't since moved on (request-token guarded). */
  async function handleReloadRevisionComparison(): Promise<CurrentNoteSnapshot> {
    const sessionId = revisionsSessionId;
    if (!sessionId) throw new Error('no revisions session is open');
    const requestId = revisionsRequestId;
    const record = await writeQueue.enqueue(() => loadNoteRecordForSession(sessionId));
    const content = record?.content ?? '';
    const contentHash = record?.content_hash ?? null;
    if (requestId === revisionsRequestId) {
      revisionsCurrentContent = content;
      revisionsCurrentHash = contentHash;
    }
    return { sessionId, content, contentHash };
  }

  /** Deletes only the currently-open session's revision history — its
   * current note and the session itself are left completely untouched.
   * The exclusion-with-creation behavior (nothing scheduled before or
   * during this delete ever executes afterward, while a genuinely new
   * request submitted once it settles works normally, even on a *failed*
   * delete attempt) lives entirely in revisionCoordinator.deleteHistory()
   * — see that module's doc. Clearing `revisionsList` is request-token
   * guarded — the History-summary update isn't, since it applies to
   * whichever session was actually deleted regardless of what Revisions is
   * currently showing. */
  async function handleDeleteRevisionHistory(): Promise<void> {
    const sessionId = revisionsSessionId;
    if (!sessionId) return;
    const requestId = revisionsRequestId;
    try {
      const outcome = await revisionCoordinator.deleteHistory(sessionId);
      if (requestId === revisionsRequestId) {
        revisionsList = [];
      }
      historySummaries = historySummaries.map((summary) =>
        summary.id === sessionId ? { ...summary, revisionCount: 0 } : summary,
      );
      cleanupWarning = outcome.cleanupPending
        ? 'Revision history deleted, but file cleanup will retry when the app restarts.'
        : null;
    } catch (err) {
      console.error('Failed to delete revision history:', err);
      error = 'Failed to delete revision history.';
    }
  }

  /** Manual checkpoint: flush, capture the exact committed content
   * immutably, submit through the revision coordinator, and report brief
   * non-blocking feedback without leaving the current workspace. Disabled
   * upstream (SessionNotes) for blank content; still guarded here since
   * this is also reachable while a flush is in flight. `content` is
   * captured right after the flush lands and never re-read afterward —
   * immune to an edit made during the `listNoteRevisions` dedup lookup
   * below — and `contentHash` is computed directly from that exact value
   * (`sha256Hex`), never from `noteHashBySession`, so the dedup check and
   * the submission both use the *same* {content, contentHash} pair. */
  async function performCheckpoint() {
    checkpointStatus = null;
    const sessionId = currentNoteSessionId();
    if (!sessionId) return;
    // Captured before the flush even starts — this function's true intent
    // boundary — see snapshotSessionCompleted's token comment for why.
    const token = revisionCoordinator.beginIntent(sessionId);
    const flushed = await flushPendingNoteSave();
    if (!flushed) return;
    const content = noteContent;
    if (!hasNoteContent(content)) return;
    const contentHash = await sha256Hex(content);
    let alreadyExists = false;
    try {
      const existing = await listNoteRevisions(sessionId);
      alreadyExists = existing.some((revision) => revision.contentHash === contentHash);
    } catch (err) {
      console.error('Failed to check existing revisions before checkpoint:', err);
    }
    const ok = await revisionCoordinator.submit(token, {
      sessionId,
      content,
      contentHash,
      kind: 'checkpoint',
      reason: 'manual',
      createdAt: Date.now(),
    });
    if (ok) {
      checkpointStatus = alreadyExists ? 'No changes since the last revision.' : 'Checkpoint saved.';
      if (revisionsSessionId === sessionId) void refreshRevisionsList(sessionId);
    } else {
      checkpointStatus = 'Failed to save checkpoint.';
    }
  }

  /** Tracked from this exact call — its intent boundary, before even the
   * note flush starts — so a window close can't proceed until a
   * still-in-progress checkpoint has at least reached submit() (see
   * revisionSaveCoordinator.svelte.ts). */
  function handleCheckpoint(): Promise<void> {
    return revisionCoordinator.trackProducer(performCheckpoint());
  }

  function handleViewHistory() {
    handleNavigate('history');
  }

  function handleBackFromHistory() {
    handleNavigate('focus');
  }

  /** Returns to Focus if Revisions was showing the currently active/loaded
   * session, or back to History if it was showing a different (past)
   * session — matching whichever entry point actually makes sense for
   * what's being viewed. */
  function handleBackFromRevisions() {
    const backTo = revisionsSessionId !== null && revisionsSessionId === currentNoteSessionId() ? 'focus' : 'history';
    handleNavigate(backTo);
  }

  async function handleDeleteSessionFromHistory(id: string) {
    alarmSequence.cancel();
    try {
      // Invalidated twice, deliberately: once now (covers a save still
      // waiting out its debounce/retry timer, not yet enqueued at all —
      // this cancels it outright), and once again after the delete
      // actually commits below (covers a save that was already enqueued
      // — in flight — when this ran, which only repopulates itself for
      // retry *after* failing, possibly while this delete was still
      // waiting its turn in the queue; without the second call that
      // repopulated retry would survive to resurrect the note later).
      cancelPendingNoteSave(id);
      const outcome = await writeQueue.enqueue(() => deleteSessionRow(id));
      cancelPendingNoteSave(id);
      historySummaries = historySummaries.filter((s) => s.id !== id);
      error = null;
      cleanupWarning = outcome.cleanupPending
        ? 'Session deleted, but note file cleanup will retry when the app restarts.'
        : null;
    } catch (err) {
      // Don't remove it from view until the delete is confirmed — leaving
      // it visible on failure is safer than pretending it's gone.
      console.error('Failed to delete session:', err);
      error = 'Failed to delete session.';
    }
  }

  async function handleDeleteAllData() {
    // Confirmation happens in History.svelte's own UI before this is ever
    // called — window.confirm() isn't reliably supported across Tauri's
    // WebView backends, so we don't rely on it here.
    alarmSequence.cancel();
    returnAlarmSequence.cancel();
    try {
      cancelPendingNoteSave(); // every note is about to be wiped; nothing to save
      const outcome = await writeQueue.enqueue(() => deleteAllData());
      cancelPendingNoteSave(); // recheck: a racing failed save may have repopulated one while we waited
      invalidateFailedSessionSave();
      historySummaries = [];
      parkedThoughts = [];
      // Return to a clean idle state — whatever session/review was showing
      // referenced data that no longer exists, and there's no "current
      // session" left to be in.
      session = createIdleState();
      intermissionAnnouncement = '';
      workspaceView = 'focus';
      taskDraft = '';
      durationMinutes = DEFAULT_DURATION_MINUTES;
      noteContent = '';
      noteHashBySession.clear();
      error = null;
      cleanupWarning = outcome.cleanupPending
        ? 'Data deleted, but note file cleanup will retry when the app restarts.'
        : null;
    } catch (err) {
      console.error('Failed to delete all data:', err);
      error = 'Failed to delete all data.';
    }
  }

  function handlePreviewTone(id: string) {
    alarmSequence.cancel();
    returnAlarmSequence.cancel();
    playTone(id);
  }

  function handleSelectSoundscape(id: SoundscapeId) {
    if (!settingsController || !soundscapeController) return;
    settingsController.set('selectedSoundscapeId', id);
    void soundscapeController.selectPreset(id);
  }

  function handleSoundscapeVolume(value: string) {
    if (!settingsController || !soundscapeController) return;
    const normalized = parseSoundscapeVolume(value);
    settingsController.set('soundscapeVolume', normalized);
    soundscapeController.setVolume(soundscapeVolumeToNumber(normalized));
  }

  // First-occurrence explanations for Flow, Greenhouse, and Touch Grass —
  // shown once each, right where the concept first appears, never again
  // once dismissed. Deliberately inline banners, not a modal/tour: this
  // app never interrupts a running timer for anything (see
  // FocusCompletionPrompt's own nonmodal design), and onboarding
  // shouldn't be the exception.
  function handleDismissHint(id: HintId) {
    if (!settingsController) return;
    settingsController.set('dismissedHints', withHintDismissed(settingsController.current.dismissedHints, id));
  }
</script>

<div class="app-root">
  {#if storageInitError}
    <section class="storage-init-error" role="alert">
      <p>Failed to set up note storage. Your sessions and notes can't load until this is resolved.</p>
      <div class="storage-init-error-actions">
        <button type="button" onclick={handleRetryStorageInit}>Retry</button>
        <button type="button" onclick={() => void openNotesFolder()}>Open Notes Folder</button>
      </div>
    </section>
  {:else if !ready || !settingsController}
    <p class="loading">Loading…</p>
  {:else}
    <!--
      AppShell owns presentation/navigation only — never session behavior.
      The wall-clock effect, focus-deadline/alarm effect, and window-close
      handler above are all unconditional and independent of workspaceView
      or whether Settings is open; changing either here never mounts,
      unmounts, resets, or pauses the session state machine.
    -->
    {#snippet completionPrompt()}
      {#if warningView.visible}
        <FocusCompletionPrompt
          kind="warning"
          leadLabel={warningView.leadLabel ?? ''}
          announcement={warningView.announcement}
          onPrimary={handleTakeBreakNow}
          onSecondary={handleContinueFocusing}
        />
      {:else if overtimeView.visible && overtimeView.phase}
        <FocusCompletionPrompt
          kind="overtime"
          phase={overtimeView.phase}
          leadLabel={overtimeView.leadLabel}
          announcement={overtimeView.announcement}
          onStay={handleStayWithIt}
          onBreak={handleTakeBreakFromOvertime}
          onEnd={handleEndOvertime}
        />
      {/if}
    {/snippet}
    {#snippet intermissionActions()}
      <IntermissionControls
        breakDurationMs={breakIntermissionDurationMs}
        touchGrassDurationMs={touchGrassDurationMs}
        onStartBreak={() => handleStartIntermission('break')}
        onStartTouchGrass={() => handleStartIntermission('touchGrass')}
        onCycleBreak={() => handleCycleIntermissionDuration('break')}
        onCycleTouchGrass={() => handleCycleIntermissionDuration('touchGrass')}
      />
    {/snippet}
    {#snippet railActions()}
      {#if settingsController && soundscapeController}
        <SoundscapePopover
          controller={soundscapeController}
          selectedPresetId={settingsController.current.selectedSoundscapeId}
          volume={settingsController.current.soundscapeVolume}
          disabledReason={session.status === 'intermission'
            ? 'intermission'
            : soundscapeController.snapshot.temporarilySuppressed
              ? 'alarm'
              : null}
          selectionError={settingsController.errors.selectedSoundscapeId ?? null}
          volumeError={settingsController.errors.soundscapeVolume ?? null}
          onSelect={handleSelectSoundscape}
          onVolume={handleSoundscapeVolume}
          onRetrySelection={() => settingsController?.retry('selectedSoundscapeId')}
          onRetryVolume={() => settingsController?.retry('soundscapeVolume')}
        />
      {/if}
    {/snippet}
    <AppShell
      currentWorkspace={workspaceView}
      showRevisions={workspaceView === 'revisions'}
      onNavigate={handleNavigate}
      settings={settingsController}
      onPreviewTone={handlePreviewTone}
      {railActions}
    >
      {#if error}
        <p class="error" role="alert">
          {error}
          {#if noteSaveNeedsManualRetry}
            <button type="button" class="retry-link" onclick={handleRetryNoteSave}>Retry</button>
          {/if}
        </p>
      {/if}
      {#if sessionPersistenceError}
        <p class="error" role="alert">
          {sessionPersistenceError}
          <button type="button" class="retry-link" onclick={handleRetrySessionSave}
            >Retry session save</button
          >
        </p>
      {/if}
      {#if sessionRecoveryError}
        <p class="error" role="alert">
          {sessionRecoveryError}
          <button type="button" class="retry-link" onclick={handleRetrySessionRecovery}>Retry</button>
        </p>
      {/if}
      {#if thoughtsRecoveryError}
        <p class="error" role="alert">
          {thoughtsRecoveryError}
          <button type="button" class="retry-link" onclick={handleRetryThoughtsRecovery}>Retry</button>
        </p>
      {/if}
      {#if cleanupWarning}
        <p class="cleanup-warning" role="status">{cleanupWarning}</p>
      {/if}
      {#if visibleUpdateStage}
        <UpdateBanner
          stage={visibleUpdateStage}
          version={updateController.version}
          error={updateController.error}
          onUpdate={() => updateController.startDownload()}
          onRestart={() => updateController.restart()}
          onDismiss={() => updateController.dismiss()}
        />
      {/if}
      {#if settingsController && session.status === 'flow' && !isHintDismissed(settingsController.current.dismissedHints, 'flow')}
        <FirstTimeHint text={HINT_TEXT.flow} onDismiss={() => handleDismissHint('flow')} />
      {/if}
      {#if settingsController && showsGreenhouse && !isHintDismissed(settingsController.current.dismissedHints, 'greenhouse')}
        <FirstTimeHint text={HINT_TEXT.greenhouse} onDismiss={() => handleDismissHint('greenhouse')} />
      {/if}
      {#if settingsController && showsStepAway && !isHintDismissed(settingsController.current.dismissedHints, 'touchGrass')}
        <FirstTimeHint text={HINT_TEXT.touchGrass} onDismiss={() => handleDismissHint('touchGrass')} />
      {/if}
      <RevisionSaveNotice
        integrityIssue={revisionCoordinator.status.integrityIssue}
        failing={revisionCoordinator.status.failing}
        needsManualRetry={revisionCoordinator.status.needsManualRetry}
        onRetry={handleRetryRevisionSave}
      />
      {#if intermissionAnnouncement}
        <div class="sr-only" role="status" aria-live="polite">
          {intermissionAnnouncement}
        </div>
      {/if}
      {#if workspaceAnnouncement}
        <div class="sr-only" role="status" aria-live="polite">
          {workspaceAnnouncement}
        </div>
      {/if}
      {#if noteStorageIssue?.kind === 'conflict'}
        <div class="note-issue" role="alert">
          {#if confirmingConflictReload}
            <p>Reload the file and discard your unsaved changes here?</p>
            <div class="note-issue-actions">
              <button type="button" class="note-issue-link" onclick={() => (confirmingConflictReload = false)}>Cancel</button>
              <button type="button" class="note-issue-link danger" onclick={handleReloadExternalNote}>Confirm reload</button>
            </div>
          {:else}
            <p>This note was changed outside the app. Keep your version, or reload the file's version?</p>
            <div class="note-issue-actions">
              <button type="button" class="note-issue-link" onclick={() => (confirmingConflictReload = true)}>Reload file</button>
              <button type="button" class="note-issue-link" onclick={handleKeepAppNote}>Keep my version</button>
            </div>
          {/if}
        </div>
      {:else if noteStorageIssue}
        <div class="note-issue" role="alert">
          <p>
            This note's file could not be {noteStorageIssue.kind === 'missing' ? 'found' : 'read'}. Editing is
            disabled until it's resolved.
          </p>
          <div class="note-issue-actions">
            <button type="button" class="note-issue-link" onclick={handleRetryMissingNote}>Retry</button>
            <button type="button" class="note-issue-link" onclick={() => void openNotesFolder()}>Open Notes Folder</button>
          </div>
        </div>
      {/if}

    {#if workspaceView !== 'focus' && session.status !== 'idle' && session.status !== 'complete'}
      <ActiveTimerBar
        task={session.task}
        mode={compactMode}
        displayMs={compactDisplayMs}
        isPaused={compactIsPaused}
        displayLabel={session.status === 'intermission'
          ? `${session.kind === 'break' ? 'Break' : 'Touch Grass'}${isIntermissionDue(session, now) ? ' · Quiet overtime' : ''}`
          : isQuietOvertime
            ? 'Quiet overtime'
            : undefined}
        prompt={completionPrompt}
        intermissionControls={compactMode === 'focus' || compactMode === 'flow'
          ? intermissionActions
          : undefined}
        onPause={handlePause}
        onResume={handleResume}
        onFinish={compactFinish}
        onReturn={handleReturnFromIntermission}
      />
    {/if}

    {#if workspaceView === 'history'}
      <History
        summaries={historySummaries}
        parkedThoughts={parkedThoughts}
        onBack={handleBackFromHistory}
        onDeleteSession={handleDeleteSessionFromHistory}
        onDeleteAll={handleDeleteAllData}
        onOpenNotesFolder={openNotesFolder}
        onViewRevisions={handleViewRevisions}
      />
    {:else if workspaceView === 'greenhouse'}
      <Greenhouse
        thoughts={parkedThoughts}
        disabled={!thoughtsRecovered}
        onPlant={handlePlantFromGreenhouse}
        onStart={handleStartParkedThought}
        onDelete={handleDeleteThought}
        onUpdateNote={handleUpdateThoughtNote}
      />
    {:else if workspaceView === 'revisions' && revisionsSessionId}
      <RevisionHistory
        sessionId={revisionsSessionId}
        task={revisionsTask}
        sessionDate={revisionsSessionDate}
        currentContent={revisionsCurrentContent}
        currentHash={revisionsCurrentHash}
        revisions={revisionsList}
        loadRevision={loadNoteRevision}
        onRename={handleRenameRevision}
        onRestore={handleRestoreRevision}
        onReloadComparison={handleReloadRevisionComparison}
        onDeleteHistory={handleDeleteRevisionHistory}
        writesDisabled={notesWritesDisabled}
        loading={revisionsLoading}
        onBack={handleBackFromRevisions}
      />
    {:else if workspaceView === 'focus'}
      {#snippet notesPanel()}
        <SessionNotes
          content={noteContent}
          onChange={handleNoteChange}
          onBlur={flushPendingNoteSave}
          disabled={noteEditingDisabled}
          writesDisabled={notesWritesDisabled}
          onCheckpoint={handleCheckpoint}
          checkpointStatus={checkpointStatus}
          onViewRevisions={handleViewCurrentRevisions}
        />
      {/snippet}
      {#if session.status === 'idle'}
        <section class="setup">
          <h1>Heartwood</h1>
          <p class="subtitle">Choose one focus task and start the timer.</p>
          <form onsubmit={handleStart}>
            <!-- svelte-ignore a11y_autofocus -->
            <input
              type="text"
              placeholder="What are you focusing on?"
              bind:value={taskDraft}
              aria-label="Focus task"
              autofocus
            />
            <label class="duration">
              <span>Minutes</span>
              <input
                type="number"
                min={MIN_DURATION_MINUTES}
                max={MAX_DURATION_MINUTES}
                bind:value={durationMinutes}
                aria-invalid={!isValidDurationMinutes(durationMinutes)}
              />
            </label>
            <button
              type="submit"
              disabled={!taskDraft.trim() || !sessionRecovered || !isValidDurationMinutes(durationMinutes)}
            >
              Start focusing
            </button>
          </form>
          {#if !isValidDurationMinutes(durationMinutes)}
            <p class="duration-error">
              Enter a whole number of minutes between {MIN_DURATION_MINUTES} and {MAX_DURATION_MINUTES}.
            </p>
          {/if}
          <IdleParkedThoughts
            thoughts={parkedThoughts}
            disabled={!sessionRecovered || !thoughtsRecovered || !isValidDurationMinutes(durationMinutes)}
            onStart={handleStartParkedThought}
          />
          <button type="button" class="history-link" onclick={handleViewHistory}>View history</button>
        </section>
      {:else if session.status === 'focusing' || session.status === 'paused'}
        {@const remaining = getFocusRemainingMs(session, now) ?? 0}
        {@const sessionId = session.sessionId}
        <Timer
          task={session.task}
          mode="focus"
          isPaused={session.status === 'paused'}
          displayMs={remaining}
          progress={1 - remaining / session.plannedDurationMs}
          progressStyle={settingsController?.current.timerProgressStyle ?? 'crown'}
          prompt={completionPrompt}
          intermissionControls={intermissionActions}
          onPause={handlePause}
          onResume={handleResume}
          onFinish={handleFinishFocusEarly}
          onViewHistory={handleViewHistory}
        />
        {#snippet parkingPanel()}
          <ParkingLot
            thoughts={parkedThoughts.filter((t) => t.sessionId === sessionId)}
            onPark={handlePark}
            disabled={!thoughtsRecovered}
          />
        {/snippet}
        <FocusSupportPanels parking={parkingPanel} notes={notesPanel} />
      {:else if session.status === 'flow' || session.status === 'flowPaused'}
        {@const sessionId = session.sessionId}
        <Timer
          task={session.task}
          mode="flow"
          isPaused={session.status === 'flowPaused'}
          displayMs={getFlowElapsedMs(session, now) ?? 0}
          displayLabel={isQuietOvertime ? 'Quiet overtime' : undefined}
          prompt={completionPrompt}
          intermissionControls={intermissionActions}
          onPause={handlePause}
          onResume={handleResume}
          onFinish={handleFinishFlow}
          onViewHistory={handleViewHistory}
        />
        {#snippet parkingPanel()}
          <ParkingLot
            thoughts={parkedThoughts.filter((t) => t.sessionId === sessionId)}
            onPark={handlePark}
            disabled={!thoughtsRecovered}
          />
        {/snippet}
        <FocusSupportPanels parking={parkingPanel} notes={notesPanel} />
      {:else if session.status === 'intermission'}
        {@const intermissionOvertime = isIntermissionDue(session, now)}
        {@const sessionId = session.sessionId}
        <IntermissionTimer
          task={session.task}
          kind={session.kind}
          displayMs={intermissionOvertime
            ? getIntermissionOvertimeMs(session, now) ?? 0
            : getIntermissionRemainingMs(session, now) ?? 0}
          isOvertime={intermissionOvertime}
          onReturn={handleReturnFromIntermission}
          onViewHistory={handleViewHistory}
        />
        {#snippet parkingPanel()}
          <ParkingLot
            thoughts={parkedThoughts.filter((t) => t.sessionId === sessionId)}
            onPark={handlePark}
            disabled={!thoughtsRecovered}
          />
        {/snippet}
        <FocusSupportPanels parking={parkingPanel} notes={notesPanel} />
      {:else if session.status === 'break'}
        <Timer
          task={session.task}
          mode="break"
          isPaused={false}
          displayMs={getBreakElapsedMs(session, now) ?? 0}
          onPause={() => {}}
          onResume={() => {}}
          onFinish={handleEndBreak}
          onViewHistory={handleViewHistory}
        />
      {:else if session.status === 'complete'}
        {@const split = splitBySession(parkedThoughts, session.sessionId)}
        <SessionReview
          task={session.task}
          plannedFocusMs={session.plannedFocusMs}
          actualFocusMs={session.actualFocusMs}
          flowMs={session.flowMs}
          tookBreak={session.tookBreak}
          breakMs={session.breakMs}
          breakIntermissionMs={session.breakIntermissionMs}
          touchGrassMs={session.touchGrassMs}
          totalElapsedMs={session.totalElapsedMs}
          thisSessionThoughts={split.current}
          carriedForwardThoughts={split.carriedForward}
          noteContent={noteContent}
          onNoteChange={handleNoteChange}
          onNoteBlur={flushPendingNoteSave}
          noteDisabled={noteEditingDisabled}
          noteWritesDisabled={notesWritesDisabled}
          onCheckpoint={handleCheckpoint}
          checkpointStatus={checkpointStatus}
          onViewRevisions={handleViewCurrentRevisions}
          defaultDurationMinutes={reviewDefaultDurationMinutes(session.plannedFocusMs)}
          onDelete={handleDeleteThought}
          onPromote={handlePromoteThought}
          onStartNext={handleStartNext}
          onViewHistory={handleViewHistory}
          onBackToStart={handleBackToStart}
          backToStartError={backToStartError}
        />
      {/if}
    {/if}
    </AppShell>
  {/if}
</div>

<style>
  /* Plain wrapper, not <main> — AppShell renders the page's one <main>
     landmark internally; a second one here would confuse assistive
     technology about which is the actual main content region. */
  .app-root {
    min-height: 100vh;
  }

  .error {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
    font-size: 0.85rem;
  }

  .cleanup-warning {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .note-issue {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--text);
    font-size: 0.85rem;
  }

  .note-issue p {
    margin: 0 0 0.5rem;
  }

  .note-issue-actions {
    display: flex;
    gap: 1rem;
  }

  .note-issue-link {
    padding: 0;
    background: none;
    border: none;
    color: var(--timer-accent);
    font-weight: 700;
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    cursor: pointer;
  }

  .note-issue-link.danger {
    color: var(--text-muted);
  }

  .retry-link {
    margin-left: 0.5rem;
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font-weight: 700;
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    cursor: pointer;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .loading {
    max-width: 32rem;
    margin: 3rem auto;
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
  }

  /* Unframed, matching Timer's own continuous-surface treatment — idle is
     just another state of the same focus workspace, not a separate card. */
  .setup {
    text-align: center;
    padding: 3rem 2rem;
    background: transparent;
    box-shadow: none;
  }

  .setup h1 {
    margin: 0 0 0.4rem;
    font-size: 1.6rem;
    color: var(--text);
  }

  .subtitle {
    margin: 0 0 2rem;
    color: var(--text-muted);
  }

  .setup form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 22rem;
    margin: 0 auto;
  }

  .setup input[type='text'] {
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 1rem;
  }

  .duration {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    font-size: 0.9rem;
    color: var(--text-muted);
  }

  .duration input {
    width: 4.5rem;
    padding: 0.5rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    text-align: center;
  }

  .duration-error {
    margin: 0.6rem 0 0;
    text-align: center;
    font-size: 0.8rem;
    color: var(--danger);
  }

  .setup button {
    padding: 0.8rem 1rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
  }

  .setup button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .setup .history-link {
    margin-top: 1.25rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }

  @media (max-width: 639px) {
    .setup {
      padding: 1.5rem 1rem 2rem;
    }

    .subtitle {
      margin-bottom: 1.25rem;
    }

    .setup .history-link {
      margin-top: 1rem;
    }
  }

  .storage-init-error {
    max-width: 32rem;
    margin: 3rem auto;
    text-align: center;
    padding: 3rem 2rem;
    border-radius: 0.5rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .storage-init-error p {
    margin: 0 0 1.5rem;
    color: var(--text);
  }

  .storage-init-error-actions {
    display: flex;
    justify-content: center;
    gap: 1rem;
  }

  .storage-init-error-actions button {
    padding: 0.8rem 1rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
  }
</style>
