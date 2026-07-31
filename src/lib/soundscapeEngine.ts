import type { SoundscapeId } from './soundscapeCatalog';
import {
  createPresetProgram,
  createSeededRandom,
  getPresetSpec,
  type SoundscapeEvent,
} from './soundscapePresets';

export interface SoundscapeEngineHandle {
  setGain(value: number, rampSeconds: number): void;
  stop(rampSeconds: number): Promise<void>;
  dispose(): void;
}

export interface SoundscapeEngine {
  readonly state: AudioContextState;
  resume(): Promise<void>;
  setMasterGain(value: number, rampSeconds: number): void;
  createPreset(id: SoundscapeId, seed: number): SoundscapeEngineHandle;
  dispose(): Promise<void>;
}

export type SoundscapeEngineFactory = () => SoundscapeEngine;

interface DisposableRegistry {
  add(dispose: () => void): void;
  dispose(): void;
}

export function createDisposableRegistry(): DisposableRegistry {
  const disposers = new Set<() => void>();
  let disposed = false;
  return {
    add(dispose) {
      if (disposed) {
        dispose();
        return;
      }
      disposers.add(dispose);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers) dispose();
      disposers.clear();
    },
  };
}

type GainParameter = Pick<AudioParam, 'cancelScheduledValues' | 'setValueAtTime' | 'linearRampToValueAtTime'> & {
  value: number;
};

export function smoothGain(parameter: GainParameter, value: number, now: number, rampSeconds: number): void {
  const target = Math.min(1, Math.max(0, value));
  try {
    parameter.cancelScheduledValues(now);
    parameter.setValueAtTime(parameter.value, now);
    parameter.linearRampToValueAtTime(target, now + Math.max(0.01, rampSeconds));
  } catch {
    parameter.value = target;
  }
}

function safeStop(node: AudioScheduledSourceNode): void {
  try {
    node.stop();
  } catch {
    // The source may already have ended; its owner still disconnects it.
  }
}

function createNoiseBuffer(context: AudioContext, random: () => number, seconds = 2): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = random() * 2 - 1;
  return buffer;
}

function connectFiltered(
  context: AudioContext,
  source: AudioNode,
  destination: AudioNode,
  filterHz?: number,
): () => void {
  if (!filterHz) {
    source.connect(destination);
    return () => source.disconnect();
  }
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterHz;
  source.connect(filter);
  filter.connect(destination);
  return () => {
    source.disconnect();
    filter.disconnect();
  };
}

function scheduleTone(context: AudioContext, destination: AudioNode, event: SoundscapeEvent): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = event.waveform;
  oscillator.frequency.value = event.frequencyHz;
  const disconnect = connectFiltered(context, oscillator, gain, event.filterHz);
  gain.connect(destination);

  const start = Math.max(context.currentTime, event.startTime);
  const end = start + event.durationSeconds;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(event.gain, start + 0.08);
  gain.gain.linearRampToValueAtTime(0, end);
  oscillator.onended = () => {
    disconnect();
    gain.disconnect();
  };
  oscillator.start(start);
  oscillator.stop(end);
}

function scheduleNoise(
  context: AudioContext,
  destination: AudioNode,
  event: SoundscapeEvent,
  random: () => number,
): void {
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = createNoiseBuffer(context, random, Math.max(0.25, event.durationSeconds));
  const disconnect = connectFiltered(context, source, gain, event.filterHz ?? event.frequencyHz);
  gain.connect(destination);

  const start = Math.max(context.currentTime, event.startTime);
  const end = start + event.durationSeconds;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(event.gain, start + 0.03);
  gain.gain.linearRampToValueAtTime(0, end);
  source.onended = () => {
    disconnect();
    gain.disconnect();
  };
  source.start(start);
  source.stop(end);
}

export function createWebAudioSoundscapeEngine(
  createContext: () => AudioContext = () => new AudioContext(),
): SoundscapeEngine {
  const context = createContext();
  const master = context.createGain();
  master.gain.value = 0;
  master.connect(context.destination);
  const handles = new Set<SoundscapeEngineHandle>();
  let disposed = false;

  function createPreset(id: SoundscapeId, seed: number): SoundscapeEngineHandle {
    if (disposed) throw new Error('Soundscape engine is disposed.');
    const bus = context.createGain();
    bus.gain.value = 0;
    bus.connect(master);
    const registry = createDisposableRegistry();
    const random = createSeededRandom(seed);
    const spec = getPresetSpec(id);

    for (const layer of spec.layers) {
      if (layer.kind === 'drone') {
        for (const frequency of layer.frequenciesHz) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = layer.waveform;
          oscillator.frequency.value = frequency;
          gain.gain.value = layer.gain / layer.frequenciesHz.length;
          const disconnect = connectFiltered(context, oscillator, gain, layer.filterHz);
          gain.connect(bus);
          oscillator.start();
          registry.add(() => {
            safeStop(oscillator);
            disconnect();
            gain.disconnect();
          });
        }
      } else if (layer.kind === 'noise-bed') {
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = createNoiseBuffer(context, random);
        source.loop = true;
        gain.gain.value = layer.gain;
        const disconnect = connectFiltered(context, source, gain, layer.filterHz);
        gain.connect(bus);
        source.start();
        registry.add(() => {
          safeStop(source);
          disconnect();
          gain.disconnect();
        });
      }
    }

    const program = createPresetProgram(id, random);
    let scheduledThrough = context.currentTime;
    const schedule = () => {
      if (disposed) return;
      const horizon = context.currentTime + 4;
      const events = program.scheduleWindow(scheduledThrough, horizon);
      scheduledThrough = horizon;
      for (const event of events) {
        if (event.kind === 'noise') scheduleNoise(context, bus, event, random);
        else scheduleTone(context, bus, event);
      }
    };
    schedule();
    const interval = setInterval(schedule, 1_000);
    registry.add(() => clearInterval(interval));

    let stopped = false;
    const handle: SoundscapeEngineHandle = {
      setGain(value, rampSeconds) {
        if (!stopped) smoothGain(bus.gain, value, context.currentTime, rampSeconds);
      },
      async stop(rampSeconds) {
        if (stopped) return;
        smoothGain(bus.gain, 0, context.currentTime, rampSeconds);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, rampSeconds) * 1_000));
        handle.dispose();
      },
      dispose() {
        if (stopped) return;
        stopped = true;
        registry.dispose();
        bus.disconnect();
        handles.delete(handle);
      },
    };
    handles.add(handle);
    return handle;
  }

  return {
    get state() {
      return context.state;
    },
    resume: () => context.resume(),
    setMasterGain(value, rampSeconds) {
      if (!disposed) smoothGain(master.gain, value, context.currentTime, rampSeconds);
    },
    createPreset,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of [...handles]) handle.dispose();
      master.disconnect();
      await context.close();
    },
  };
}
