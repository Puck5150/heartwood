import { describe, expect, it } from 'vitest';
import { SOUNDSCAPE_CATALOG } from './soundscapeCatalog';
import {
  MAX_EVENTS_PER_WINDOW,
  createPresetProgram,
  createSeededRandom,
  getPresetSpec,
} from './soundscapePresets';

describe('createSeededRandom', () => {
  it('repeats the same sequence for the same seed', () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    expect(Array.from({ length: 8 }, first)).toEqual(Array.from({ length: 8 }, second));
  });
});

describe('procedural soundscape presets', () => {
  it('defines one shared-shape specification for every catalog preset', () => {
    for (const { id } of SOUNDSCAPE_CATALOG) {
      const spec = getPresetSpec(id);
      expect(spec.id).toBe(id);
      expect(spec.layers.length).toBeGreaterThan(0);
      expect(spec.layers.length).toBeLessThanOrEqual(4);
    }
  });

  it('schedules deterministic, bounded, valid events for a minute', () => {
    for (const { id } of SOUNDSCAPE_CATALOG) {
      const first = createPresetProgram(id, createSeededRandom(5150));
      const second = createPresetProgram(id, createSeededRandom(5150));
      const a = first.scheduleWindow(0, 60);
      const b = second.scheduleWindow(0, 60);

      expect(a).toEqual(b);
      expect(a.length).toBeLessThanOrEqual(MAX_EVENTS_PER_WINDOW);
      for (const event of a) {
        expect(event.startTime).toBeGreaterThanOrEqual(0);
        expect(event.startTime).toBeLessThan(60);
        expect(event.frequencyHz).toBeGreaterThanOrEqual(55);
        expect(event.frequencyHz).toBeLessThanOrEqual(2_000);
        expect(event.durationSeconds).toBeGreaterThan(0.1);
        expect(event.durationSeconds).toBeLessThanOrEqual(12);
        expect(event.gain).toBeGreaterThan(0);
        expect(event.gain).toBeLessThanOrEqual(0.25);
      }
    }
  });

  it('does not reschedule events from an earlier window', () => {
    const program = createPresetProgram('quiet-piano', createSeededRandom(3));
    const first = program.scheduleWindow(0, 10);
    const second = program.scheduleWindow(10, 20);
    expect(first.every(({ startTime }) => startTime < 10)).toBe(true);
    expect(second.every(({ startTime }) => startTime >= 10)).toBe(true);
  });
});
