import { describe, expect, it, vi } from 'vitest';
import type {
  SoundscapeEngine,
  SoundscapeEngineHandle,
} from './soundscapeEngine';
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

function fakeHandle() {
  return {
    setGain: vi.fn(),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(),
  } satisfies SoundscapeEngineHandle;
}

function fakeEngine(overrides: Partial<SoundscapeEngine> = {}) {
  const handles: ReturnType<typeof fakeHandle>[] = [];
  const setMasterGain = vi.fn();
  const createPreset = vi.fn(() => {
    const handle = fakeHandle();
    handles.push(handle);
    return handle;
  });
  const engine: SoundscapeEngine = {
    state: 'running' as AudioContextState,
    resume: vi.fn(async () => {}),
    subscribeToStateChange: vi.fn(() => () => {}),
    setMasterGain,
    createPreset,
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
  return { engine, handles, setMasterGain, createPreset };
}

const focus = (sessionId = 's1') => ({
  sessionId,
  phase: 'focus' as const,
  alarmActive: false,
});

describe('createSoundscapeController', () => {
  it('is lazy and requires explicit Play for every new session', async () => {
    const { engine } = fakeEngine();
    const createEngine = vi.fn(() => engine);
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine,
    });

    controller.syncLifecycle(focus());
    expect(createEngine).not.toHaveBeenCalled();
    expect(controller.snapshot.status).toBe('idle');

    await controller.play('s1');
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(engine.createPreset).toHaveBeenCalledWith('deep-focus', expect.any(Number));
    expect(controller.snapshot.status).toBe('playing');

    controller.syncLifecycle(focus('s2'));
    expect(controller.snapshot.status).toBe('idle');
    expect(engine.createPreset).toHaveBeenCalledTimes(1);

    await controller.play('s2');
    expect(engine.createPreset).toHaveBeenCalledTimes(2);
  });

  it('keeps timer pause independent because focus lifecycle remains playable', async () => {
    const { engine, setMasterGain } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');
    setMasterGain.mockClear();

    controller.syncLifecycle(focus());

    expect(controller.snapshot.status).toBe('playing');
    expect(setMasterGain).toHaveBeenLastCalledWith(0.35, expect.any(Number));
  });

  it('suppresses intermission and alarm audio, then resumes only for the same session', async () => {
    const { engine, setMasterGain } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.5,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');

    controller.syncLifecycle({ sessionId: 's1', phase: 'intermission', alarmActive: false });
    expect(controller.snapshot.status).toBe('suppressed');
    expect(setMasterGain).toHaveBeenLastCalledWith(0, expect.any(Number));

    controller.syncLifecycle({ sessionId: 's1', phase: 'flow', alarmActive: true });
    expect(controller.snapshot.status).toBe('suppressed');
    controller.syncLifecycle({ sessionId: 's1', phase: 'flow', alarmActive: false });
    expect(controller.snapshot.status).toBe('playing');
    expect(setMasterGain).toHaveBeenLastCalledWith(0.5, expect.any(Number));

    controller.syncLifecycle(focus('s2'));
    controller.syncLifecycle({ sessionId: 's1', phase: 'flow', alarmActive: false });
    expect(controller.snapshot.status).toBe('idle');
  });

  it('crossfades preset switches and retains the previous preset if creation fails', async () => {
    const { engine, handles, createPreset } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');
    const first = handles[0];

    await controller.selectPreset('rain-room');
    expect(handles[1].setGain).toHaveBeenCalledWith(1, expect.any(Number));
    expect(first.stop).toHaveBeenCalledWith(expect.any(Number));

    createPreset.mockImplementationOnce(() => {
      throw new Error('preset failed');
    });
    await controller.selectPreset('quiet-piano');
    expect(controller.snapshot.status).toBe('playing');
    expect(controller.snapshot.error).toMatch(/could not switch/i);
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it('disposes a replacement whose gain initialization fails', async () => {
    const { engine, handles } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');
    const previous = handles[0];
    const replacement = fakeHandle();
    replacement.setGain.mockImplementationOnce(() => {
      throw new Error('gain failed');
    });
    vi.mocked(engine.createPreset).mockReturnValueOnce(replacement);

    await controller.selectPreset('rain-room');

    expect(replacement.dispose).toHaveBeenCalledTimes(1);
    expect(previous.stop).not.toHaveBeenCalled();
    expect(controller.snapshot.status).toBe('playing');
    expect(controller.snapshot.error).toMatch(/could not switch/i);
  });

  it('manual Pause fades out without changing timer lifecycle and Play resumes', async () => {
    const { engine, setMasterGain } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.4,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');

    controller.pause();
    expect(controller.snapshot.status).toBe('paused');
    expect(setMasterGain).toHaveBeenLastCalledWith(0, expect.any(Number));

    await controller.play('s1');
    expect(controller.snapshot.status).toBe('playing');
    expect(setMasterGain).toHaveBeenLastCalledWith(0.4, expect.any(Number));
  });

  it('reports suspended and failed audio without affecting lifecycle state', async () => {
    const suspended = fakeEngine({ state: 'suspended' });
    const suspendedController = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => suspended.engine,
    });
    suspendedController.syncLifecycle(focus());
    await suspendedController.play('s1');
    expect(suspendedController.snapshot.status).toBe('suspended');

    const failed = fakeEngine({
      resume: vi.fn(async () => {
        throw new Error('blocked');
      }),
    });
    const failedController = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => failed.engine,
    });
    failedController.syncLifecycle(focus());
    await failedController.play('s1');
    expect(failedController.snapshot.status).toBe('error');
    expect(failedController.snapshot.error).toMatch(/could not start/i);
  });

  it('observes a later platform suspension and waits for an explicit Resume audio gesture', async () => {
    let state: AudioContextState = 'running';
    let emitStateChange = () => {};
    const { engine } = fakeEngine();
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
    expect(engine.resume).toHaveBeenCalledTimes(1);

    await controller.play('s1');
    expect(engine.resume).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale Play completion after the session ends', async () => {
    const gate = deferred<void>();
    const { engine } = fakeEngine({ resume: vi.fn(() => gate.promise) });
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    const play = controller.play('s1');
    controller.syncLifecycle({ sessionId: 's1', phase: 'complete', alarmActive: false });
    gate.resolve();
    await play;

    expect(controller.snapshot.status).toBe('idle');
    expect(engine.createPreset).not.toHaveBeenCalled();
  });

  it('disposes all audio on terminal lifecycle and controller disposal', async () => {
    const { engine, handles } = fakeEngine();
    const controller = createSoundscapeController({
      initialPresetId: 'deep-focus',
      initialVolume: 0.35,
      createEngine: () => engine,
    });
    controller.syncLifecycle(focus());
    await controller.play('s1');

    controller.syncLifecycle({ sessionId: 's1', phase: 'postFocusBreak', alarmActive: false });
    expect(handles[0].dispose).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.status).toBe('idle');

    await controller.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });
});
