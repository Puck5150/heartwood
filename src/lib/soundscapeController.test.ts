import { describe, expect, it, vi } from 'vitest';
import type { SoundscapeEngine, SoundscapeEngineHandle } from './soundscapeEngine';
import { createSoundscapeController } from './soundscapeController.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeHandle(): SoundscapeEngineHandle {
  return {
    setGain: vi.fn(),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function fakeEngine(overrides: Partial<SoundscapeEngine> = {}) {
  const handles: SoundscapeEngineHandle[] = [];
  const setMasterGain = vi.fn();
  const createTrack = vi.fn(async () => {
    const handle = fakeHandle();
    handles.push(handle);
    return handle;
  });
  const engine: SoundscapeEngine = {
    state: 'running',
    resume: vi.fn(async () => {}),
    subscribeToStateChange: vi.fn(() => () => {}),
    setMasterGain,
    createTrack,
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
  return { engine, handles, setMasterGain, createTrack };
}

const focus = (sessionId = 's1') => ({
  sessionId,
  phase: 'focus' as const,
  alarmActive: false,
});

describe('createSoundscapeController', () => {
  it('loads lazily and exposes playing only after the selected track is ready', async () => {
    const gate = deferred<SoundscapeEngineHandle>();
    const createTrack = vi.fn(() => gate.promise);
    const { engine } = fakeEngine({ createTrack });
    const createEngine = vi.fn(() => engine);
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine,
    });

    controller.syncLifecycle(focus());
    const play = controller.play('s1');
    expect(createEngine).toHaveBeenCalledOnce();
    expect(controller.snapshot.status).not.toBe('playing');

    const handle = fakeHandle();
    gate.resolve(handle);
    await play;

    expect(createTrack).toHaveBeenCalledWith('deep-focus');
    expect(handle.setGain).toHaveBeenCalledWith(1, expect.any(Number));
    expect(controller.snapshot.status).toBe('playing');
  });

  it('disposes a new track when its initial gain cannot be configured', async () => {
    const replacement = fakeHandle();
    vi.mocked(replacement.setGain).mockImplementationOnce(() => {
      throw new Error('gain unavailable');
    });
    const { engine } = fakeEngine({ createTrack: vi.fn(async () => replacement) });
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());

    await controller.play('s1');

    expect(replacement.dispose).toHaveBeenCalledOnce();
    expect(controller.snapshot.status).toBe('error');
  });

  it('keeps timer Pause independent while focus remains playable', async () => {
    const { engine, handles } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');

    controller.syncLifecycle(focus());

    expect(handles[0].suspend).not.toHaveBeenCalled();
    expect(handles[0].resume).not.toHaveBeenCalled();
    expect(controller.snapshot.status).toBe('playing');
  });

  it('suspends once for intermission or alarm and resumes for the same session', async () => {
    const { engine, handles, setMasterGain } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.5,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');
    const handle = handles[0];

    controller.syncLifecycle({ sessionId: 's1', phase: 'intermission', alarmActive: false });
    controller.syncLifecycle({ sessionId: 's1', phase: 'intermission', alarmActive: false });
    expect(handle.suspend).toHaveBeenCalledOnce();
    expect(setMasterGain).toHaveBeenLastCalledWith(0, expect.any(Number));
    expect(controller.snapshot.status).toBe('suppressed');

    controller.syncLifecycle({ sessionId: 's1', phase: 'flow', alarmActive: false });
    expect(handle.resume).toHaveBeenCalledOnce();
    expect(setMasterGain).toHaveBeenLastCalledWith(0.5, expect.any(Number));
    expect(controller.snapshot.status).toBe('playing');

    controller.syncLifecycle({ sessionId: 's1', phase: 'flow', alarmActive: true });
    expect(handle.suspend).toHaveBeenCalledTimes(2);
  });

  it('manual music Pause suspends and explicit Play resumes the same track', async () => {
    const { engine, handles, createTrack } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.4,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');
    const handle = handles[0];

    controller.pause();
    expect(handle.suspend).toHaveBeenCalledOnce();
    expect(controller.snapshot.status).toBe('paused');

    await controller.play('s1');
    expect(createTrack).toHaveBeenCalledOnce();
    expect(handle.resume).toHaveBeenCalledOnce();
    expect(controller.snapshot.status).toBe('playing');
  });

  it('loads a newly selected track on Play when music is manually paused', async () => {
    const { engine, handles, createTrack } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');
    controller.pause();

    await controller.selectPreset('slow-pulse');
    await controller.play('s1');

    expect(createTrack).toHaveBeenNthCalledWith(1, 'deep-focus');
    expect(createTrack).toHaveBeenNthCalledWith(2, 'slow-pulse');
    expect(handles[0].dispose).toHaveBeenCalledOnce();
  });

  it('keeps the old track audible until an asynchronous replacement is ready', async () => {
    const first = fakeHandle();
    const replacement = fakeHandle();
    const gate = deferred<SoundscapeEngineHandle>();
    const createTrack = vi
      .fn<SoundscapeEngine['createTrack']>()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(gate.promise);
    const { engine } = fakeEngine({ createTrack });
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');

    const switching = controller.selectPreset('lofi-hip-hop');
    expect(first.stop).not.toHaveBeenCalled();
    gate.resolve(replacement);
    await switching;

    expect(replacement.setGain).toHaveBeenCalledWith(1, expect.any(Number));
    expect(first.stop).toHaveBeenCalledWith(expect.any(Number));
  });

  it('releases an older crossfade before a rapid second track switch', async () => {
    const fading = fakeHandle();
    const fade = deferred<void>();
    fading.stop = vi.fn(() => fade.promise);
    const second = fakeHandle();
    const third = fakeHandle();
    const createTrack = vi
      .fn<SoundscapeEngine['createTrack']>()
      .mockResolvedValueOnce(fading)
      .mockResolvedValueOnce(second)
      .mockImplementationOnce(async () => {
        expect(fading.dispose).toHaveBeenCalledOnce();
        return third;
      });
    const { engine } = fakeEngine({ createTrack });
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');

    await controller.selectPreset('lofi-hip-hop');
    await controller.selectPreset('quiet-piano');

    expect(createTrack).toHaveBeenCalledTimes(3);
    expect(second.stop).toHaveBeenCalledOnce();
    fade.resolve();
  });

  it('keeps the prior track and reports a retryable error when switching fails', async () => {
    const first = fakeHandle();
    const createTrack = vi
      .fn<SoundscapeEngine['createTrack']>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('decode failed'));
    const { engine } = fakeEngine({ createTrack });
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');

    await controller.selectPreset('rain-room');

    expect(first.stop).not.toHaveBeenCalled();
    expect(controller.snapshot.status).toBe('playing');
    expect(controller.snapshot.error).toMatch(/previous sound is still playing/i);
  });

  it('disposes a stale track load that resolves after session termination', async () => {
    const gate = deferred<SoundscapeEngineHandle>();
    const { engine } = fakeEngine({ createTrack: vi.fn(() => gate.promise) });
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    const play = controller.play('s1');
    await Promise.resolve();
    controller.syncLifecycle({ sessionId: 's1', phase: 'complete', alarmActive: false });
    const stale = fakeHandle();
    gate.resolve(stale);
    await play;

    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(controller.snapshot.status).toBe('idle');
  });

  it('reports platform suspension and disposes all audio on terminal lifecycle', async () => {
    let state: AudioContextState = 'running';
    let emitStateChange = () => {};
    const { engine, handles } = fakeEngine();
    Object.defineProperty(engine, 'state', { get: () => state });
    engine.subscribeToStateChange = (listener) => {
      emitStateChange = listener;
      return () => {
        emitStateChange = () => {};
      };
    };
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');

    state = 'suspended';
    emitStateChange();
    expect(controller.snapshot.status).toBe('suspended');

    controller.syncLifecycle({ sessionId: 's1', phase: 'postFocusBreak', alarmActive: false });
    expect(handles[0].dispose).toHaveBeenCalledOnce();
    expect(controller.snapshot.status).toBe('idle');

    await controller.dispose();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });
});
