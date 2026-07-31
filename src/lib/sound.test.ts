import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildToneSchedule,
  DEFAULT_RETURN_TONE_ID,
  DEFAULT_TONE_ID,
  getReturnToneDefinition,
  getToneDefinition,
  getToneDurationMs,
  isToneId,
  isReturnToneId,
  playTone,
  RETURN_TONE_CATALOG,
  TONE_CATALOG,
} from './sound';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TONE_CATALOG', () => {
  it('is a small, non-empty catalog', () => {
    expect(TONE_CATALOG.length).toBeGreaterThan(0);
    expect(TONE_CATALOG.length).toBeLessThanOrEqual(6);
  });

  it('gives every tone a non-empty stable id and display name', () => {
    for (const tone of TONE_CATALOG) {
      expect(tone.id.length).toBeGreaterThan(0);
      expect(tone.name.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = TONE_CATALOG.map((tone) => tone.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every tone at least one note with a positive duration', () => {
    for (const tone of TONE_CATALOG) {
      expect(tone.notesHz.length).toBeGreaterThan(0);
      expect(tone.noteDurationS).toBeGreaterThan(0);
    }
  });
});

describe('return tone catalog', () => {
  it('has a calm default and lists Sad Trombone plainly', () => {
    expect(getReturnToneDefinition(DEFAULT_RETURN_TONE_ID).name).toBe('Calm Return');
    expect(RETURN_TONE_CATALOG.some((tone) => tone.name === 'Sad Trombone')).toBe(true);
  });

  it('validates return ids independently from focus alarm ids', () => {
    expect(isReturnToneId('calm-return')).toBe(true);
    expect(isReturnToneId('sad-trombone')).toBe(true);
    expect(isReturnToneId(DEFAULT_TONE_ID)).toBe(false);
    expect(isToneId(DEFAULT_RETURN_TONE_ID)).toBe(false);
  });

  it('falls back to the calm return tone for an unknown return id', () => {
    expect(getReturnToneDefinition('missing').id).toBe(DEFAULT_RETURN_TONE_ID);
  });

  it('derives playback duration for return tones through the shared scheduler', () => {
    for (const tone of RETURN_TONE_CATALOG) {
      const schedule = buildToneSchedule(tone);
      const last = schedule.at(-1)!;
      expect(getToneDurationMs(tone.id)).toBe(
        Math.ceil((last.startOffsetS + last.durationS) * 1000),
      );
    }
  });
});

describe('DEFAULT_TONE_ID', () => {
  it('refers to a tone that actually exists in the catalog', () => {
    expect(TONE_CATALOG.some((tone) => tone.id === DEFAULT_TONE_ID)).toBe(true);
  });
});

describe('isToneId', () => {
  it('accepts every id actually in the catalog', () => {
    for (const tone of TONE_CATALOG) {
      expect(isToneId(tone.id)).toBe(true);
    }
  });

  it('rejects an unknown, non-string, or empty value', () => {
    expect(isToneId('not-a-real-tone-id')).toBe(false);
    expect(isToneId('')).toBe(false);
    expect(isToneId(null)).toBe(false);
    expect(isToneId(undefined)).toBe(false);
    expect(isToneId(42)).toBe(false);
  });
});

describe('getToneDefinition', () => {
  it('returns the matching tone for a known id', () => {
    const tone = TONE_CATALOG[0];
    expect(getToneDefinition(tone.id)).toEqual(tone);
  });

  it('falls back to the default tone for an unknown id', () => {
    expect(getToneDefinition('not-a-real-tone-id').id).toBe(DEFAULT_TONE_ID);
  });
});

describe('buildToneSchedule', () => {
  it('produces one step per note, in the same order as notesHz', () => {
    for (const tone of TONE_CATALOG) {
      const schedule = buildToneSchedule(tone);
      expect(schedule.map((step) => step.frequencyHz)).toEqual(tone.notesHz);
    }
  });

  it('starts the first note immediately for every tone in the catalog', () => {
    for (const tone of TONE_CATALOG) {
      expect(buildToneSchedule(tone)[0].startOffsetS).toBe(0);
    }
  });

  it('schedules notes back-to-back without overlapping, for every tone in the catalog', () => {
    for (const tone of TONE_CATALOG) {
      const schedule = buildToneSchedule(tone);
      for (let i = 1; i < schedule.length; i++) {
        const previousEnd = schedule[i - 1].startOffsetS + schedule[i - 1].durationS;
        expect(schedule[i].startOffsetS).toBeGreaterThanOrEqual(previousEnd);
      }
    }
  });

  it('gives every step a positive duration, for every tone in the catalog', () => {
    for (const tone of TONE_CATALOG) {
      for (const step of buildToneSchedule(tone)) {
        expect(step.durationS).toBeGreaterThan(0);
      }
    }
  });
});

describe('getToneDurationMs (Phase 5B)', () => {
  it('derives duration from the end of the final scheduled note, for every tone in the catalog', () => {
    for (const tone of TONE_CATALOG) {
      const schedule = buildToneSchedule(tone);
      const last = schedule.at(-1)!;
      expect(getToneDurationMs(tone.id)).toBe(Math.ceil((last.startOffsetS + last.durationS) * 1000));
    }
  });

  it('falls back to the default tone duration for an unknown id', () => {
    expect(getToneDurationMs('not-a-real-tone-id')).toBe(getToneDurationMs(DEFAULT_TONE_ID));
  });
});

describe('playTone failure isolation', () => {
  it('does not throw when constructing AudioContext fails', () => {
    const failure = new Error('audio unavailable');
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw failure;
        }
      },
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => playTone(DEFAULT_RETURN_TONE_ID)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('Failed to play tone:', failure);
  });
});
