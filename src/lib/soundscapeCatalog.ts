export type SoundscapeId =
  | 'deep-focus'
  | 'quiet-piano'
  | 'organic-drift'
  | 'still-air'
  | 'rain-room';

export interface SoundscapeDefinition {
  id: SoundscapeId;
  name: string;
  description: string;
}

export const SOUNDSCAPE_CATALOG: readonly SoundscapeDefinition[] = Object.freeze([
  { id: 'deep-focus', name: 'Deep Focus', description: 'Warm layers with a subtle pulse.' },
  { id: 'quiet-piano', name: 'Quiet Piano', description: 'Sparse, soft notes with generous space.' },
  { id: 'organic-drift', name: 'Organic Drift', description: 'Rounded tones and restrained natural texture.' },
  { id: 'still-air', name: 'Still Air', description: 'Slowly evolving pads and near-musical atmosphere.' },
  { id: 'rain-room', name: 'Rain Room', description: 'Rain and room tone with minimal tonal content.' },
]);

export const DEFAULT_SOUNDSCAPE_ID: SoundscapeId = 'deep-focus';
export const DEFAULT_SOUNDSCAPE_VOLUME = '0.35';

const IDS = new Set(SOUNDSCAPE_CATALOG.map(({ id }) => id));

export function parseSoundscapeId(value: unknown): SoundscapeId {
  return typeof value === 'string' && IDS.has(value as SoundscapeId)
    ? (value as SoundscapeId)
    : DEFAULT_SOUNDSCAPE_ID;
}

export function parseSoundscapeVolume(value: unknown): string {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_SOUNDSCAPE_VOLUME;
  return String(Math.min(1, Math.max(0, parsed)));
}

export function soundscapeVolumeToNumber(value: string): number {
  return Number(parseSoundscapeVolume(value));
}
