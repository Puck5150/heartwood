import type { SoundscapeId } from './soundscapeCatalog';

export type RandomSource = () => number;
export type SoundscapeWave = 'sine' | 'triangle';
export type SoundscapeLayerKind = 'drone' | 'notes' | 'noise-bed' | 'rain';

export interface SoundscapeLayer {
  kind: SoundscapeLayerKind;
  frequenciesHz: readonly number[];
  waveform: SoundscapeWave;
  gain: number;
  filterHz?: number;
  intervalSeconds?: readonly [number, number];
  durationSeconds?: readonly [number, number];
}

export interface SoundscapePresetSpec {
  id: SoundscapeId;
  layers: readonly SoundscapeLayer[];
}

export interface SoundscapeEvent {
  kind: 'tone' | 'noise';
  startTime: number;
  durationSeconds: number;
  frequencyHz: number;
  gain: number;
  waveform: SoundscapeWave;
  filterHz?: number;
}

export interface SoundscapePresetProgram {
  scheduleWindow(startTime: number, endTime: number): SoundscapeEvent[];
}

export const MAX_EVENTS_PER_WINDOW = 128;

const PRESETS: Record<SoundscapeId, SoundscapePresetSpec> = {
  'deep-focus': {
    id: 'deep-focus',
    layers: [
      { kind: 'drone', frequenciesHz: [110, 164.81, 220], waveform: 'sine', gain: 0.035, filterHz: 900 },
      {
        kind: 'notes',
        frequenciesHz: [110, 146.83, 164.81, 220],
        waveform: 'sine',
        gain: 0.055,
        intervalSeconds: [4.5, 7],
        durationSeconds: [1.8, 3.4],
      },
    ],
  },
  'quiet-piano': {
    id: 'quiet-piano',
    layers: [
      {
        kind: 'notes',
        frequenciesHz: [220, 261.63, 293.66, 329.63, 392, 440],
        waveform: 'triangle',
        gain: 0.07,
        filterHz: 1_600,
        intervalSeconds: [5, 10],
        durationSeconds: [2.5, 5],
      },
    ],
  },
  'organic-drift': {
    id: 'organic-drift',
    layers: [
      { kind: 'noise-bed', frequenciesHz: [420], waveform: 'sine', gain: 0.018, filterHz: 520 },
      {
        kind: 'notes',
        frequenciesHz: [174.61, 220, 261.63, 293.66, 349.23],
        waveform: 'sine',
        gain: 0.075,
        filterHz: 1_300,
        intervalSeconds: [3.5, 7.5],
        durationSeconds: [2, 4.5],
      },
    ],
  },
  'still-air': {
    id: 'still-air',
    layers: [
      { kind: 'drone', frequenciesHz: [98, 146.83, 196], waveform: 'sine', gain: 0.025, filterHz: 650 },
      { kind: 'drone', frequenciesHz: [110, 164.81], waveform: 'triangle', gain: 0.012, filterHz: 500 },
    ],
  },
  'rain-room': {
    id: 'rain-room',
    layers: [
      { kind: 'noise-bed', frequenciesHz: [900], waveform: 'sine', gain: 0.055, filterHz: 1_100 },
      {
        kind: 'rain',
        frequenciesHz: [650, 800, 950, 1_100, 1_350],
        waveform: 'sine',
        gain: 0.025,
        filterHz: 1_500,
        intervalSeconds: [0.8, 1.8],
        durationSeconds: [0.25, 0.8],
      },
    ],
  },
};

export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function getPresetSpec(id: SoundscapeId): SoundscapePresetSpec {
  return PRESETS[id];
}

function between([minimum, maximum]: readonly [number, number], random: RandomSource): number {
  return minimum + (maximum - minimum) * random();
}

export function createPresetProgram(id: SoundscapeId, random: RandomSource): SoundscapePresetProgram {
  const eventLayers = PRESETS[id].layers.filter(
    (layer): layer is SoundscapeLayer & {
      intervalSeconds: readonly [number, number];
      durationSeconds: readonly [number, number];
    } => layer.kind === 'notes' || layer.kind === 'rain',
  );
  const nextTimes = eventLayers.map(() => Number.NEGATIVE_INFINITY);

  return {
    scheduleWindow(startTime, endTime) {
      const events: SoundscapeEvent[] = [];
      for (let index = 0; index < eventLayers.length; index += 1) {
        const layer = eventLayers[index];
        if (nextTimes[index] < startTime) {
          nextTimes[index] = startTime + between(layer.intervalSeconds, random);
        }
        while (nextTimes[index] < endTime && events.length < MAX_EVENTS_PER_WINDOW) {
          const frequencyHz = layer.frequenciesHz[Math.floor(random() * layer.frequenciesHz.length)];
          events.push({
            kind: layer.kind === 'rain' ? 'noise' : 'tone',
            startTime: nextTimes[index],
            durationSeconds: between(layer.durationSeconds, random),
            frequencyHz,
            gain: layer.gain,
            waveform: layer.waveform,
            filterHz: layer.filterHz,
          });
          nextTimes[index] += between(layer.intervalSeconds, random);
        }
      }
      return events.sort((a, b) => a.startTime - b.startTime);
    },
  };
}
