import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOUNDSCAPE_ID,
  DEFAULT_SOUNDSCAPE_VOLUME,
  SOUNDSCAPE_CATALOG,
  parseSoundscapeId,
  parseSoundscapeVolume,
  soundscapeVolumeToNumber,
  validateSoundscapeCatalog,
} from './soundscapeCatalog';

describe('soundscape catalog', () => {
  it('lists the seven approved bundled tracks in display order', () => {
    expect(SOUNDSCAPE_CATALOG.map(({ id }) => id)).toEqual([
      'deep-focus',
      'lofi-hip-hop',
      'quiet-piano',
      'organic-drift',
      'still-air',
      'rain-room',
      'slow-pulse',
    ]);
  });

  it('describes a licensed local loop for every track', () => {
    for (const definition of SOUNDSCAPE_CATALOG) {
      expect(definition.assetPath).toBe(`/audio/soundscapes/${definition.id}.wav`);
      expect(definition.durationSeconds).toBeGreaterThanOrEqual(60);
      expect(definition.durationSeconds).toBeLessThanOrEqual(150);
      expect(definition.loopStartSeconds).toBeGreaterThanOrEqual(0);
      expect(definition.loopEndSeconds).toBeGreaterThan(definition.loopStartSeconds);
      expect(definition.loopEndSeconds).toBeLessThanOrEqual(definition.durationSeconds);
      expect(definition.name).not.toBe('');
      expect(definition.description).not.toBe('');
      expect(definition.creator).not.toBe('');
      expect(definition.sourceUrl).toMatch(/^https:\/\//);
      expect(definition.licenseId).not.toBe('');
      expect(definition.attribution).not.toBe('');
    }
  });

  it.each([
    [
      'duplicate id',
      [SOUNDSCAPE_CATALOG[0], SOUNDSCAPE_CATALOG[0]],
      /duplicate soundscape id/i,
    ],
    [
      'mismatched path',
      [{ ...SOUNDSCAPE_CATALOG[0], assetPath: '/audio/wrong.wav' }],
      /asset path/i,
    ],
    [
      'invalid loop range',
      [{ ...SOUNDSCAPE_CATALOG[0], loopStartSeconds: 30, loopEndSeconds: 20 }],
      /loop range/i,
    ],
    [
      'missing license',
      [{ ...SOUNDSCAPE_CATALOG[0], licenseId: '' }],
      /license/i,
    ],
  ])('reports %s', (_label, catalog, expected) => {
    expect(validateSoundscapeCatalog(catalog)).toEqual(
      expect.arrayContaining([expect.stringMatching(expected)]),
    );
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
