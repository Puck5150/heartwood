import { describe, expect, it, vi } from 'vitest';
import { getSoundscapeDefinition, type SoundscapeId } from './soundscapeCatalog';
import {
  createDisposableRegistry,
  createWebAudioSoundscapeEngine,
  smoothGain,
} from './soundscapeEngine';
import type { SoundscapeTrackLoader } from './soundscapeTrackLoader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeContext() {
  const sources: Array<{
    buffer: AudioBuffer | null;
    loop: boolean;
    loopStart: number;
    loopEnd: number;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const gains: Array<{
    gain: {
      value: number;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const listeners = new Set<() => void>();
  const context = {
    currentTime: 0,
    state: 'running' as AudioContextState,
    destination: {},
    decodeAudioData: vi.fn(),
    createGain: vi.fn(() => {
      const gain = {
        gain: {
          value: 0,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as AudioBuffer | null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source;
    }),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
  };
  return { context, sources, gains };
}

function fakeLoader() {
  const buffers = new Map<SoundscapeId, AudioBuffer>();
  const loadTrack = vi.fn<SoundscapeTrackLoader>(async (_context, definition) => {
    const buffer = { duration: definition.durationSeconds } as AudioBuffer;
    buffers.set(definition.id, buffer);
    return buffer;
  });
  return { loadTrack, buffers };
}

describe('soundscape engine helpers', () => {
  it('disposes every registered resource once and rejects late additions', () => {
    const registry = createDisposableRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.add(first);
    registry.add(second);

    registry.dispose();
    registry.dispose();
    const late = vi.fn();
    registry.add(late);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('allows a completed resource to unregister before disposal', () => {
    const registry = createDisposableRegistry();
    const disposeResource = vi.fn();
    const unregister = registry.add(disposeResource);

    unregister();
    registry.dispose();

    expect(disposeResource).not.toHaveBeenCalled();
  });

  it('uses a short ramp and falls back to an immediate value when ramping fails', () => {
    const parameter = {
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(() => {
        throw new Error('ramp unavailable');
      }),
      value: 0,
    };

    smoothGain(parameter, 0.6, 10, 0.25);

    expect(parameter.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(parameter.value).toBe(0.6);
  });
});

describe('createWebAudioSoundscapeEngine', () => {
  it('loads lazily and starts one source at the authored loop boundary', async () => {
    const { context, sources } = fakeContext();
    const { loadTrack, buffers } = fakeLoader();
    const engine = createWebAudioSoundscapeEngine({
      loadTrack,
      createContext: () => context as unknown as AudioContext,
      wait: async () => {},
    });
    const definition = getSoundscapeDefinition('deep-focus');

    expect(loadTrack).not.toHaveBeenCalled();
    await engine.createTrack('deep-focus');

    expect(loadTrack).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(1);
    expect(sources[0].buffer).toBe(buffers.get('deep-focus'));
    expect(sources[0].loop).toBe(true);
    expect(sources[0].loopStart).toBe(definition.loopStartSeconds);
    expect(sources[0].loopEnd).toBe(definition.loopEndSeconds);
    expect(sources[0].start).toHaveBeenCalledWith(0, definition.loopStartSeconds);
  });

  it('captures elapsed loop offset on suspend and resumes from it once', async () => {
    const { context, sources } = fakeContext();
    const { loadTrack } = fakeLoader();
    const engine = createWebAudioSoundscapeEngine({
      loadTrack,
      createContext: () => context as unknown as AudioContext,
      wait: async () => {},
    });
    const handle = await engine.createTrack('deep-focus');

    context.currentTime = 17.25;
    await handle.suspend(0.6);
    await handle.suspend(0.6);
    handle.resume(0.6);
    handle.resume(0.6);

    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(2);
    expect(sources[1].start).toHaveBeenCalledWith(0, 17.25);
  });

  it('keeps one source when resume interrupts a pending suspend fade', async () => {
    const { context, sources } = fakeContext();
    const { loadTrack } = fakeLoader();
    const fade = deferred<void>();
    const engine = createWebAudioSoundscapeEngine({
      loadTrack,
      createContext: () => context as unknown as AudioContext,
      wait: () => fade.promise,
    });
    const handle = await engine.createTrack('deep-focus');

    const suspending = handle.suspend(0.6);
    handle.resume(0.6);
    fade.resolve();
    await suspending;

    expect(sources).toHaveLength(1);
    expect(sources[0].stop).not.toHaveBeenCalled();
  });

  it('retains at most two referenced decoded tracks and evicts a released one', async () => {
    const { context } = fakeContext();
    const { loadTrack } = fakeLoader();
    const engine = createWebAudioSoundscapeEngine({
      loadTrack,
      createContext: () => context as unknown as AudioContext,
      wait: async () => {},
    });
    const deep = await engine.createTrack('deep-focus');
    const lofi = await engine.createTrack('lofi-hip-hop');

    await expect(engine.createTrack('quiet-piano')).rejects.toThrow(/two tracks/i);
    expect(loadTrack).toHaveBeenCalledTimes(2);

    deep.dispose();
    await expect(engine.createTrack('quiet-piano')).resolves.toBeTruthy();
    expect(loadTrack).toHaveBeenCalledTimes(3);
    lofi.dispose();
  });

  it('releases handle nodes and cache references only once', async () => {
    const { context, sources, gains } = fakeContext();
    const { loadTrack } = fakeLoader();
    const engine = createWebAudioSoundscapeEngine({
      loadTrack,
      createContext: () => context as unknown as AudioContext,
      wait: async () => {},
    });
    const handle = await engine.createTrack('deep-focus');

    handle.dispose();
    handle.dispose();

    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(sources[0].disconnect).toHaveBeenCalledOnce();
    expect(gains[1].disconnect).toHaveBeenCalledOnce();
  });

  it('prevents a stale load from creating nodes after engine disposal', async () => {
    const { context, sources } = fakeContext();
    const gate = deferred<AudioBuffer>();
    const loadTrack = vi.fn<SoundscapeTrackLoader>(() => gate.promise);
    const engine = createWebAudioSoundscapeEngine({
      loadTrack,
      createContext: () => context as unknown as AudioContext,
      wait: async () => {},
    });

    const pending = engine.createTrack('deep-focus');
    await engine.dispose();
    gate.resolve({ duration: 120.058776 } as AudioBuffer);

    await expect(pending).rejects.toThrow(/disposed/i);
    expect(sources).toHaveLength(0);
    expect(context.close).toHaveBeenCalledOnce();
  });
});
