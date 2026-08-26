import type { SoundscapeDefinition } from './soundscapeCatalog';

export type SoundscapeTrackLoader = (
  context: Pick<AudioContext, 'decodeAudioData'>,
  definition: SoundscapeDefinition,
) => Promise<AudioBuffer>;

export function createBundledTrackLoader(
  fetchAudio: typeof fetch = fetch,
): SoundscapeTrackLoader {
  return async (context, definition) => {
    const response = await fetchAudio(definition.assetPath);
    if (!response.ok) throw new Error(`Could not load ${definition.id}.`);

    const encoded = await response.arrayBuffer();
    // decodeAudioData detaches (neuters) the buffer it's given — .slice(0)
    // hands it a copy so `encoded` itself would still be usable if a future
    // caller needed it again.
    const decoded = await context.decodeAudioData(encoded.slice(0));
    if (decoded.duration + 0.01 < definition.loopEndSeconds) {
      throw new Error(`Decoded ${definition.id} is shorter than its loop range.`);
    }
    return decoded;
  };
}
