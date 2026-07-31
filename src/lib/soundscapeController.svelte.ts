import type {
  SoundscapeEngine,
  SoundscapeEngineFactory,
  SoundscapeEngineHandle,
} from './soundscapeEngine';
import type { SoundscapeId } from './soundscapeCatalog';

export type SoundscapePhase =
  | 'inactive'
  | 'focus'
  | 'flow'
  | 'intermission'
  | 'postFocusBreak'
  | 'complete';

export interface SoundscapeLifecycle {
  sessionId: string | null;
  phase: SoundscapePhase;
  alarmActive: boolean;
}

export interface SoundscapePlaybackSnapshot {
  status: 'idle' | 'playing' | 'paused' | 'suppressed' | 'suspended' | 'error';
  error: string | null;
  temporarilySuppressed: boolean;
}

export interface SoundscapeController {
  readonly snapshot: SoundscapePlaybackSnapshot;
  selectPreset(id: SoundscapeId): Promise<void>;
  setVolume(value: number): void;
  play(sessionId: string): Promise<void>;
  pause(): void;
  syncLifecycle(value: SoundscapeLifecycle): void;
  setAlarmOutputSuppressed(suppressed: boolean): Promise<void>;
  dispose(): Promise<void>;
}

const FADE_SECONDS = 0.6;
const CROSSFADE_SECONDS = 1.2;
const PLAYABLE_PHASES = new Set<SoundscapePhase>(['focus', 'flow']);
const TERMINAL_PHASES = new Set<SoundscapePhase>(['inactive', 'postFocusBreak', 'complete']);

export function createSoundscapeController(options: {
  initialPresetId: SoundscapeId;
  initialVolume: number;
  createEngine: SoundscapeEngineFactory;
}): SoundscapeController {
  const snapshot = $state<SoundscapePlaybackSnapshot>({
    status: 'idle',
    error: null,
    temporarilySuppressed: false,
  });
  let selectedPresetId = options.initialPresetId;
  let volume = Math.min(1, Math.max(0, options.initialVolume));
  let engine: SoundscapeEngine | null = null;
  let unsubscribeFromEngineState: (() => void) | null = null;
  let activeTrack: SoundscapeEngineHandle | null = null;
  let activeTrackId: SoundscapeId | null = null;
  let retiringTrack: SoundscapeEngineHandle | null = null;
  let trackSuspended = false;
  let outputSuppressed = false;
  let alarmOutputSuppressed = false;
  let pendingSuppression: Promise<void> | null = null;
  let lifecycle: SoundscapeLifecycle = {
    sessionId: null,
    phase: 'inactive',
    alarmActive: false,
  };
  let playIntentSessionId: string | null = null;
  let disposed = false;
  let generation = 0;

  function clearIntentAndTrack(): void {
    generation += 1;
    playIntentSessionId = null;
    activeTrack?.dispose();
    retiringTrack?.dispose();
    activeTrack = null;
    activeTrackId = null;
    retiringTrack = null;
    trackSuspended = false;
    outputSuppressed = false;
    alarmOutputSuppressed = false;
    pendingSuppression = null;
    snapshot.status = 'idle';
    snapshot.error = null;
    snapshot.temporarilySuppressed = false;
  }

  function shouldSuppressOutput(): boolean {
    return alarmOutputSuppressed || lifecycle.alarmActive || lifecycle.phase === 'intermission';
  }

  function suppressOutput(): Promise<void> {
    if (!engine || !activeTrack || playIntentSessionId === null) return Promise.resolve();
    engine.setMasterGain(0, FADE_SECONDS);
    outputSuppressed = true;
    snapshot.status = 'suppressed';
    if (trackSuspended) return pendingSuppression ?? Promise.resolve();

    trackSuspended = true;
    const track = activeTrack;
    const pending = track.suspend(FADE_SECONDS).catch(() => {});
    pendingSuppression = pending;
    void pending.finally(() => {
      if (pendingSuppression === pending) pendingSuppression = null;
    });
    return pending;
  }

  function updateOutput(): void {
    snapshot.temporarilySuppressed = shouldSuppressOutput();
    if (!engine || !activeTrack || playIntentSessionId === null) return;
    if (playIntentSessionId !== lifecycle.sessionId) {
      clearIntentAndTrack();
      return;
    }

    if (shouldSuppressOutput()) {
      void suppressOutput();
      return;
    }

    if (PLAYABLE_PHASES.has(lifecycle.phase)) {
      if (outputSuppressed) {
        outputSuppressed = false;
        if (trackSuspended) {
          activeTrack.resume(FADE_SECONDS);
          trackSuspended = false;
        }
      }
      engine.setMasterGain(volume, FADE_SECONDS);
      snapshot.status = engine.state === 'running' ? 'playing' : 'suspended';
    }
  }

  function ensureEngine(): SoundscapeEngine {
    if (engine) return engine;
    engine = options.createEngine();
    unsubscribeFromEngineState = engine.subscribeToStateChange(() => {
      if (!engine || playIntentSessionId === null) return;
      if (engine.state !== 'running') snapshot.status = 'suspended';
      else updateOutput();
    });
    return engine;
  }

  async function play(sessionId: string): Promise<void> {
    if (disposed || lifecycle.sessionId !== sessionId || shouldSuppressOutput()) return;
    const request = ++generation;
    snapshot.error = null;
    let replacement: SoundscapeEngineHandle | null = null;

    try {
      const currentEngine = ensureEngine();
      await currentEngine.resume();
      if (
        disposed ||
        request !== generation ||
        lifecycle.sessionId !== sessionId ||
        shouldSuppressOutput()
      ) return;

      if (!activeTrack || activeTrackId !== selectedPresetId) {
        const requestedId = selectedPresetId;
        replacement = await currentEngine.createTrack(requestedId);
        if (
          disposed ||
          request !== generation ||
          lifecycle.sessionId !== sessionId ||
          selectedPresetId !== requestedId
        ) {
          replacement.dispose();
          replacement = null;
          return;
        }

        const previous = activeTrack;
        replacement.setGain(1, FADE_SECONDS);
        activeTrack = replacement;
        activeTrackId = requestedId;
        trackSuspended = false;
        outputSuppressed = false;
        replacement = null;
        previous?.dispose();
      } else if (trackSuspended) {
        activeTrack.resume(FADE_SECONDS);
        trackSuspended = false;
      }

      playIntentSessionId = sessionId;
      updateOutput();
    } catch {
      replacement?.dispose();
      if (request !== generation || disposed) return;
      playIntentSessionId = null;
      snapshot.status = 'error';
      snapshot.error = 'Could not start flow-state music.';
    }
  }

  function pause(): void {
    if (!engine || !activeTrack || playIntentSessionId === null) return;
    generation += 1;
    playIntentSessionId = null;
    engine.setMasterGain(0, FADE_SECONDS);
    if (!trackSuspended) {
      trackSuspended = true;
      void activeTrack.suspend(FADE_SECONDS);
    }
    outputSuppressed = false;
    snapshot.status = 'paused';
    snapshot.error = null;
  }

  async function selectPreset(id: SoundscapeId): Promise<void> {
    selectedPresetId = id;
    snapshot.error = null;
    if (!engine || !activeTrack || playIntentSessionId === null) return;

    const request = ++generation;
    const previous = activeTrack;
    const previousId = activeTrackId;
    retiringTrack?.dispose();
    retiringTrack = null;
    let replacement: SoundscapeEngineHandle | null = null;
    try {
      replacement = await engine.createTrack(id);
      if (disposed || request !== generation || selectedPresetId !== id) {
        replacement.dispose();
        return;
      }

      replacement.setGain(1, CROSSFADE_SECONDS);
      activeTrack = replacement;
      activeTrackId = id;
      trackSuspended = false;
      outputSuppressed = false;
      retiringTrack = previous;
      void previous
        .stop(CROSSFADE_SECONDS)
        .catch(() => previous.dispose())
        .finally(() => {
          if (retiringTrack === previous) retiringTrack = null;
        });
      updateOutput();
    } catch {
      if (request !== generation || disposed) {
        replacement?.dispose();
        return;
      }
      replacement?.dispose();
      activeTrack = previous;
      activeTrackId = previousId;
      snapshot.error = 'Could not switch soundscapes. The previous sound is still playing.';
      updateOutput();
    }
  }

  function setVolume(value: number): void {
    volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : volume;
    if (engine && activeTrack && playIntentSessionId !== null && snapshot.status === 'playing') {
      engine.setMasterGain(volume, 0.12);
    }
  }

  function syncLifecycle(value: SoundscapeLifecycle): void {
    if (disposed) return;
    const changedSession = lifecycle.sessionId !== null && value.sessionId !== lifecycle.sessionId;
    lifecycle = value;
    if (changedSession || TERMINAL_PHASES.has(value.phase)) {
      clearIntentAndTrack();
      return;
    }
    updateOutput();
  }

  async function setAlarmOutputSuppressed(suppressed: boolean): Promise<void> {
    if (disposed) return;
    alarmOutputSuppressed = suppressed;
    snapshot.temporarilySuppressed = shouldSuppressOutput();
    if (suppressed) {
      await suppressOutput();
      return;
    }
    updateOutput();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    clearIntentAndTrack();
    const currentEngine = engine;
    engine = null;
    unsubscribeFromEngineState?.();
    unsubscribeFromEngineState = null;
    await currentEngine?.dispose();
  }

  return {
    get snapshot() {
      return snapshot;
    },
    selectPreset,
    setVolume,
    play,
    pause,
    syncLifecycle,
    setAlarmOutputSuppressed,
    dispose,
  };
}
