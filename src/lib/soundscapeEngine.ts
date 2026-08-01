import {
  getSoundscapeDefinition,
  type SoundscapeDefinition,
  type SoundscapeId,
} from './soundscapeCatalog';
import type { SoundscapeTrackLoader } from './soundscapeTrackLoader';

export interface SoundscapeEngineHandle {
  setGain(value: number, rampSeconds: number): void;
  suspend(rampSeconds: number): Promise<void>;
  resume(rampSeconds: number): void;
  stop(rampSeconds: number): Promise<void>;
  dispose(): void;
}

export interface SoundscapeEngine {
  readonly state: AudioContextState;
  resume(): Promise<void>;
  subscribeToStateChange(listener: () => void): () => void;
  setMasterGain(value: number, rampSeconds: number): void;
  createTrack(id: SoundscapeId): Promise<SoundscapeEngineHandle>;
  dispose(): Promise<void>;
}

export type SoundscapeEngineFactory = () => SoundscapeEngine;

interface DisposableRegistry {
  add(dispose: () => void): () => void;
  dispose(): void;
}

export function createDisposableRegistry(): DisposableRegistry {
  const disposers = new Set<() => void>();
  let disposed = false;
  return {
    add(dispose) {
      if (disposed) {
        dispose();
        return () => {};
      }
      disposers.add(dispose);
      return () => disposers.delete(dispose);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // One faulty node must not prevent the rest of the graph closing.
        }
      }
      disposers.clear();
    },
  };
}

type GainParameter = Pick<
  AudioParam,
  'cancelScheduledValues' | 'setValueAtTime' | 'linearRampToValueAtTime'
> & { value: number };

export function smoothGain(
  parameter: GainParameter,
  value: number,
  now: number,
  rampSeconds: number,
): void {
  const target = Math.min(1, Math.max(0, value));
  try {
    parameter.cancelScheduledValues(now);
    parameter.setValueAtTime(parameter.value, now);
    parameter.linearRampToValueAtTime(target, now + Math.max(0.01, rampSeconds));
  } catch {
    parameter.value = target;
  }
}

interface CachedTrack {
  buffer: AudioBuffer;
  references: number;
  lastUsed: number;
}

function loopOffset(definition: SoundscapeDefinition, offset: number): number {
  const length = definition.loopEndSeconds - definition.loopStartSeconds;
  const relative = offset - definition.loopStartSeconds;
  return definition.loopStartSeconds + ((relative % length) + length) % length;
}

function stopSource(source: AudioBufferSourceNode | null): void {
  if (!source) return;
  try {
    source.stop();
  } catch {
    // An already-stopped source still needs to be disconnected by its owner.
  }
  source.disconnect();
}

const defaultWait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));

export function createWebAudioSoundscapeEngine(options: {
  loadTrack: SoundscapeTrackLoader;
  createContext?: () => AudioContext;
  wait?: (milliseconds: number) => Promise<void>;
}): SoundscapeEngine {
  const context = (options.createContext ?? (() => new AudioContext()))();
  const wait = options.wait ?? defaultWait;
  const master = context.createGain();
  master.gain.value = 0;
  master.connect(context.destination);

  const cache = new Map<SoundscapeId, CachedTrack>();
  const pendingLoads = new Map<SoundscapeId, Promise<CachedTrack>>();
  const handles = new Set<SoundscapeEngineHandle>();
  let useCounter = 0;
  let disposed = false;

  function evictOneReleasedTrack(): boolean {
    const candidate = [...cache.entries()]
      .filter(([, entry]) => entry.references === 0)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
    if (!candidate) return false;
    cache.delete(candidate[0]);
    return true;
  }

  async function getTrack(id: SoundscapeId): Promise<CachedTrack> {
    if (disposed) throw new Error('Soundscape engine is disposed.');

    const cached = cache.get(id);
    if (cached) {
      cached.lastUsed = ++useCounter;
      return cached;
    }

    const pending = pendingLoads.get(id);
    if (pending) return pending;

    while (cache.size + pendingLoads.size >= 2) {
      if (!evictOneReleasedTrack()) {
        throw new Error('Soundscape engine can retain only two tracks at a time.');
      }
    }

    const definition = getSoundscapeDefinition(id);
    const loading = options
      .loadTrack(context, definition)
      .then((buffer) => {
        if (disposed) throw new Error('Soundscape engine is disposed.');
        const entry = { buffer, references: 0, lastUsed: ++useCounter };
        cache.set(id, entry);
        return entry;
      })
      .finally(() => pendingLoads.delete(id));
    pendingLoads.set(id, loading);
    return loading;
  }

  async function createTrack(id: SoundscapeId): Promise<SoundscapeEngineHandle> {
    const definition = getSoundscapeDefinition(id);
    const cached = await getTrack(id);
    if (disposed) throw new Error('Soundscape engine is disposed.');

    const bus = context.createGain();
    bus.gain.value = 0;
    bus.connect(master);
    cached.references += 1;
    cached.lastUsed = ++useCounter;

    let source: AudioBufferSourceNode | null = null;
    let savedOffset = definition.loopStartSeconds;
    let startedAt = context.currentTime;
    let targetGain = 0;
    let suspended = false;
    let handleDisposed = false;
    let operation = 0;

    function startSource(offset: number): void {
      const next = context.createBufferSource();
      next.buffer = cached.buffer;
      next.loop = true;
      next.loopStart = definition.loopStartSeconds;
      next.loopEnd = definition.loopEndSeconds;
      next.connect(bus);
      savedOffset = loopOffset(definition, offset);
      startedAt = context.currentTime;
      next.start(0, savedOffset);
      source = next;
    }

    const handle: SoundscapeEngineHandle = {
      setGain(value, rampSeconds) {
        if (handleDisposed) return;
        targetGain = Math.min(1, Math.max(0, value));
        if (!suspended) smoothGain(bus.gain, targetGain, context.currentTime, rampSeconds);
      },
      async suspend(rampSeconds) {
        if (handleDisposed || suspended) return;
        suspended = true;
        const request = ++operation;
        smoothGain(bus.gain, 0, context.currentTime, rampSeconds);
        await wait(Math.max(0, rampSeconds) * 1_000);
        if (handleDisposed || request !== operation || !source) return;
        savedOffset = loopOffset(
          definition,
          savedOffset + Math.max(0, context.currentTime - startedAt),
        );
        stopSource(source);
        source = null;
      },
      resume(rampSeconds) {
        if (handleDisposed || !suspended) return;
        operation += 1;
        suspended = false;
        if (!source) startSource(savedOffset);
        smoothGain(bus.gain, targetGain, context.currentTime, rampSeconds);
      },
      async stop(rampSeconds) {
        if (handleDisposed) return;
        smoothGain(bus.gain, 0, context.currentTime, rampSeconds);
        await wait(Math.max(0, rampSeconds) * 1_000);
        handle.dispose();
      },
      dispose() {
        if (handleDisposed) return;
        handleDisposed = true;
        operation += 1;
        stopSource(source);
        source = null;
        bus.disconnect();
        cached.references = Math.max(0, cached.references - 1);
        cached.lastUsed = ++useCounter;
        handles.delete(handle);
      },
    };

    try {
      startSource(savedOffset);
      handles.add(handle);
      return handle;
    } catch (error) {
      handle.dispose();
      throw error;
    }
  }

  return {
    get state() {
      return context.state;
    },
    resume: () => context.resume(),
    subscribeToStateChange(listener) {
      context.addEventListener('statechange', listener);
      return () => context.removeEventListener('statechange', listener);
    },
    setMasterGain(value, rampSeconds) {
      if (!disposed) smoothGain(master.gain, value, context.currentTime, rampSeconds);
    },
    createTrack,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of [...handles]) handle.dispose();
      cache.clear();
      master.disconnect();
      await context.close();
    },
  };
}
