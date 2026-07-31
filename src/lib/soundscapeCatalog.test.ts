import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOUNDSCAPE_ID,
  DEFAULT_SOUNDSCAPE_VOLUME,
  SOUNDSCAPE_CATALOG,
  parseSoundscapeId,
  parseSoundscapeVolume,
  soundscapeVolumeToNumber,
} from './soundscapeCatalog';

describe('soundscape catalog', () => {
  it('lists the five approved local presets in display order', () => {
    expect(SOUNDSCAPE_CATALOG.map(({ id }) => id)).toEqual([
      'deep-focus',
      'quiet-piano',
      'organic-drift',
      'still-air',
      'rain-room',
    ]);
    expect(SOUNDSCAPE_CATALOG.every(({ name, description }) => name.length > 0 && description.length > 0)).toBe(true);
  });

  it('accepts catalog ids and defaults unknown persisted values', () => {
    expect(parseSoundscapeId('rain-room')).toBe('rain-room');
    expect(parseSoundscapeId('missing')).toBe(DEFAULT_SOUNDSCAPE_ID);
    expect(parseSoundscapeId(null)).toBe(DEFAULT_SOUNDSCAPE_ID);
  });

  it.each([
    ['0.7', '0.7'],
    [0.25, '0.25'],
    ['1.5', '1'],
    ['-0.1', '0'],
    ['bad', DEFAULT_SOUNDSCAPE_VOLUME],
    [Infinity, DEFAULT_SOUNDSCAPE_VOLUME],
    [null, DEFAULT_SOUNDSCAPE_VOLUME],
  ])('normalizes volume %p to %s', (input, expected) => {
    expect(parseSoundscapeVolume(input)).toBe(expected);
  });

  it('converts a validated stored volume for the audio controller', () => {
    expect(soundscapeVolumeToNumber('0.35')).toBe(0.35);
  });
});
