export type SoundscapeId =
  | 'deep-focus'
  | 'lofi-hip-hop'
  | 'quiet-piano'
  | 'organic-drift'
  | 'still-air'
  | 'rain-room'
  | 'slow-pulse';

export interface SoundscapeDefinition {
  id: SoundscapeId;
  name: string;
  description: string;
  assetPath: string;
  durationSeconds: number;
  loopStartSeconds: number;
  loopEndSeconds: number;
  creator: string;
  sourceUrl: string;
  licenseId: string;
  attribution: string;
}

export const SOUNDSCAPE_CATALOG: readonly SoundscapeDefinition[] = Object.freeze([
  {
    id: 'deep-focus',
    name: 'Deep Focus',
    description: 'Warm ambient electronics with restrained melodic movement.',
    assetPath: '/audio/soundscapes/deep-focus.wav',
    durationSeconds: 112.058776,
    loopStartSeconds: 0,
    loopEndSeconds: 112.058776,
    creator: 'Joth',
    sourceUrl: 'https://opengameart.org/content/contemplation-0',
    licenseId: 'CC0-1.0',
    attribution: 'Contemplation by Joth (CC0 1.0).',
  },
  {
    id: 'lofi-hip-hop',
    name: 'Lo-Fi Hip Hop',
    description: 'Mellow instrumental beats with warm keys and restrained bass.',
    assetPath: '/audio/soundscapes/lofi-hip-hop.wav',
    durationSeconds: 72,
    loopStartSeconds: 0,
    loopEndSeconds: 72,
    creator: 'omfgdude',
    sourceUrl: 'https://opengameart.org/content/lofi-again',
    licenseId: 'CC0-1.0',
    attribution: 'Lofi again by omfgdude (CC0 1.0).',
  },
  {
    id: 'quiet-piano',
    name: 'Quiet Piano',
    description: 'Soft piano phrases over a calm, spacious harmonic bed.',
    assetPath: '/audio/soundscapes/quiet-piano.wav',
    durationSeconds: 123.72,
    loopStartSeconds: 0,
    loopEndSeconds: 123.72,
    creator: 'Yoiyami',
    sourceUrl: 'https://opengameart.org/content/first-light-particles-%E2%80%93-cc0-atmospheric-pianoambient-track',
    licenseId: 'CC0-1.0',
    attribution: 'First Light Particles by Yoiyami (CC0 1.0).',
  },
  {
    id: 'organic-drift',
    name: 'Organic Drift',
    description: 'A gentle acoustic loop with natural warmth and patient movement.',
    assetPath: '/audio/soundscapes/organic-drift.wav',
    durationSeconds: 64,
    loopStartSeconds: 0,
    loopEndSeconds: 64,
    creator: 'Cal McEachern (Trex0n)',
    sourceUrl: 'https://opengameart.org/content/a-small-fire-will-do-calming-loop',
    licenseId: 'CC0-1.0',
    attribution: 'A Small Fire Will Do by Cal McEachern (Trex0n) (CC0 1.0).',
  },
  {
    id: 'still-air',
    name: 'Still Air',
    description: 'Slow pads and distant bells with subtle harmonic change.',
    assetPath: '/audio/soundscapes/still-air.wav',
    durationSeconds: 135.974331,
    loopStartSeconds: 0,
    loopEndSeconds: 135.974331,
    creator: 'congusbongus',
    sourceUrl: 'https://opengameart.org/content/cathedral-in-the-forest-ambient-loop',
    licenseId: 'CC0-1.0',
    attribution: 'Cathedral in the Forest by congusbongus (CC0 1.0).',
  },
  {
    id: 'rain-room',
    name: 'Rain Room',
    description: 'Soft shelter rain with a distant, understated piano texture.',
    assetPath: '/audio/soundscapes/rain-room.wav',
    durationSeconds: 90,
    loopStartSeconds: 0,
    loopEndSeconds: 90,
    creator: 'constantinov and Yoiyami',
    sourceUrl: 'https://freesound.org/people/constantinov/sounds/807703/',
    licenseId: 'CC0-1.0',
    attribution: 'Rain 7 by constantinov and First Light Particles by Yoiyami (CC0 1.0).',
  },
  {
    id: 'slow-pulse',
    name: 'Slow Pulse',
    description: 'A warm electronic bed with a clear, unhurried half-time groove.',
    assetPath: '/audio/soundscapes/slow-pulse.wav',
    durationSeconds: 142.702698,
    loopStartSeconds: 0,
    loopEndSeconds: 142.702698,
    creator: 'Tsorthan Grove',
    sourceUrl: 'https://opengameart.org/content/safe-space-0',
    licenseId: 'CC0-1.0',
    attribution: 'Safe Space by Tsorthan Grove (CC0 1.0), with an original rhythm treatment.',
  },
]);

export const DEFAULT_SOUNDSCAPE_ID: SoundscapeId = 'deep-focus';
export const DEFAULT_SOUNDSCAPE_VOLUME = '0.35';

const IDS = new Set(SOUNDSCAPE_CATALOG.map(({ id }) => id));

export function getSoundscapeDefinition(id: SoundscapeId): SoundscapeDefinition {
  const definition = SOUNDSCAPE_CATALOG.find((entry) => entry.id === id);
  if (!definition) throw new Error(`Unknown soundscape: ${id}`);
  return definition;
}

export function validateSoundscapeCatalog(
  catalog: readonly SoundscapeDefinition[],
): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const definition of catalog) {
    if (seen.has(definition.id)) errors.push(`Duplicate soundscape id: ${definition.id}.`);
    seen.add(definition.id);

    if (definition.assetPath !== `/audio/soundscapes/${definition.id}.wav`) {
      errors.push(`Invalid asset path for ${definition.id}.`);
    }
    if (
      !Number.isFinite(definition.durationSeconds) ||
      definition.durationSeconds < 60 ||
      definition.durationSeconds > 150
    ) {
      errors.push(`Invalid duration for ${definition.id}.`);
    }
    if (
      !Number.isFinite(definition.loopStartSeconds) ||
      !Number.isFinite(definition.loopEndSeconds) ||
      definition.loopStartSeconds < 0 ||
      definition.loopStartSeconds >= definition.loopEndSeconds ||
      definition.loopEndSeconds > definition.durationSeconds
    ) {
      errors.push(`Invalid loop range for ${definition.id}.`);
    }
    if (!definition.creator.trim() || !definition.sourceUrl.trim()) {
      errors.push(`Missing source metadata for ${definition.id}.`);
    }
    if (!definition.licenseId.trim() || !definition.attribution.trim()) {
      errors.push(`Missing license metadata for ${definition.id}.`);
    }
  }

  return errors;
}

// Runs at import time, not lazily — a malformed catalog entry (bad asset
// path, out-of-range loop points, missing attribution) should fail the
// whole app immediately on load rather than surface later as a silent
// playback bug once some specific soundscape is picked.
const CATALOG_ERRORS = validateSoundscapeCatalog(SOUNDSCAPE_CATALOG);
if (CATALOG_ERRORS.length > 0) throw new Error(CATALOG_ERRORS.join('\n'));

export function parseSoundscapeId(value: unknown): SoundscapeId {
  return typeof value === 'string' && IDS.has(value as SoundscapeId)
    ? (value as SoundscapeId)
    : DEFAULT_SOUNDSCAPE_ID;
}

export function parseSoundscapeVolume(value: unknown): string {
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_SOUNDSCAPE_VOLUME;
  const parsed =
    typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_SOUNDSCAPE_VOLUME;
  return String(Math.min(1, Math.max(0, parsed)));
}

export function soundscapeVolumeToNumber(value: string): number {
  return Number(parseSoundscapeVolume(value));
}
