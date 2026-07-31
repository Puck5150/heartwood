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
}

export interface SoundscapeController {
  readonly snapshot: SoundscapePlaybackSnapshot;
  selectPreset(id: SoundscapeId): Promise<void>;
  setVolume(value: number): void;
  play(sessionId: string): Promise<void>;
  pause(): void;
  syncLifecycle(value: SoundscapeLifecycle): void;
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
  seed?: () => number;
}): SoundscapeController {
  const snapshot = $state<SoundscapePlaybackSnapshot>({ status: 'idle', error: null });
  let selectedPresetId = options.initialPresetId;
  let volume = Math.min(1, Math.max(0, options.initialVolume));
  let engine: SoundscapeEngine | null = null;
  let unsubscribeFromEngineState: (() => void) | null = null;
  let activePreset: SoundscapeEngineHandle | null = null;
  let lifecycle: SoundscapeLifecycle = { sessionId: null, phase: 'inactive', alarmActive: false };
  let playIntentSessionId: string | null = null;
  let disposed = false;
  let generation = 0;

  const nextSeed = options.seed ?? (() => Math.floor(Math.random() * 0xffff_ffff));

  function updateOutput(): void {
    if (!engine || !activePreset || playIntentSessionId === null) return;
    if (playIntentSessionId !== lifecycle.sessionId) {
      clearIntentAndPreset();
      return;
    }
    if (lifecycle.alarmActive || lifecycle.phase === 'intermission') {
      engine.setMasterGain(0, FADE_SECONDS);
      snapshot.status = 'suppressed';
      return;
    }
    if (PLAYABLE_PHASES.has(lifecycle.phase)) {
      engine.setMasterGain(volume, FADE_SECONDS);
      snapshot.status = engine.state === 'running' ? 'playing' : 'suspended';
    }
  }

  function clearIntentAndPreset(): void {
    generation += 1;
    playIntentSessionId = null;
    activePreset?.dispose();
    activePreset = null;
    snapshot.status = 'idle';
    snapshot.error = null;
  }

  async function play(sessionId: string): Promise<void> {
    if (disposed || lifecycle.sessionId !== sessionId) return;
    const request = ++generation;
    snapshot.error = null;
    try {
      if (!engine) {
        engine = options.createEngine();
        unsubscribeFromEngineState = engine.subscribeToStateChange(() => {
          if (!engine || playIntentSessionId === null) return;
          if (engine.state !== 'running') snapshot.status = 'suspended';
          else updateOutput();
        });
      }
      await engine.resume();
      if (disposed || request !== generation || lifecycle.sessionId !== sessionId) return;
      activePreset ??= engine.createPreset(selectedPresetId, nextSeed());
      activePreset.setGain(1, FADE_SECONDS);
      playIntentSessionId = sessionId;
      updateOutput();
    } catch {
      if (request !== generation || disposed) return;
      playIntentSessionId = null;
      snapshot.status = 'error';
      snapshot.error = 'Could not start flow-state music.';
    }
  }

  function pause(): void {
    if (!engine || playIntentSessionId === null) return;
    generation += 1;
    playIntentSessionId = null;
    engine.setMasterGain(0, FADE_SECONDS);
    snapshot.status = 'paused';
    snapshot.error = null;
  }

  async function selectPreset(id: SoundscapeId): Promise<void> {
    selectedPresetId = id;
    snapshot.error = null;
    if (!engine || !activePreset || playIntentSessionId === null) return;
    const request = ++generation;
    const previous = activePreset;
    try {
      const replacement = engine.createPreset(id, nextSeed());
      if (disposed || request !== generation) {
        replacement.dispose();
        return;
      }
      replacement.setGain(1, CROSSFADE_SECONDS);
      activePreset = replacement;
      void previous.stop(CROSSFADE_SECONDS);
      updateOutput();
    } catch {
      if (request !== generation || disposed) return;
      activePreset = previous;
      snapshot.error = 'Could not switch soundscapes. The previous sound is still playing.';
      updateOutput();
    }
  }

  function setVolume(value: number): void {
    volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : volume;
    if (engine && activePreset && playIntentSessionId !== null && snapshot.status === 'playing') {
      engine.setMasterGain(volume, 0.12);
    }
  }

  function syncLifecycle(value: SoundscapeLifecycle): void {
    if (disposed) return;
    const changedSession =
      lifecycle.sessionId !== null &&
      value.sessionId !== lifecycle.sessionId;
    lifecycle = value;
    if (changedSession || TERMINAL_PHASES.has(value.phase)) {
      clearIntentAndPreset();
      return;
    }
    updateOutput();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    clearIntentAndPreset();
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
    dispose,
  };
}
