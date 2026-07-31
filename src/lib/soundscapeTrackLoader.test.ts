import { describe, expect, it, vi } from 'vitest';
import { getSoundscapeDefinition } from './soundscapeCatalog';
import { createBundledTrackLoader } from './soundscapeTrackLoader';

const definition = getSoundscapeDefinition('deep-focus');

describe('createBundledTrackLoader', () => {
  it('fetches the selected local asset once and decodes a copied buffer', async () => {
    const encoded = new ArrayBuffer(16);
    const decoded = { duration: definition.durationSeconds } as AudioBuffer;
    const fetchAudio = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => encoded,
    })) as unknown as typeof fetch;
    const decodeAudioData = vi.fn(async (_encoded: ArrayBuffer) => decoded);

    await expect(createBundledTrackLoader(fetchAudio)({ decodeAudioData }, definition)).resolves.toBe(
      decoded,
    );

    expect(fetchAudio).toHaveBeenCalledOnce();
    expect(fetchAudio).toHaveBeenCalledWith(definition.assetPath);
    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(decodeAudioData.mock.calls[0][0]).not.toBe(encoded);
    expect(decodeAudioData.mock.calls[0][0]).toEqual(encoded);
  });

  it('rejects an unavailable local asset before decoding', async () => {
    const fetchAudio = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    const decodeAudioData = vi.fn();

    await expect(
      createBundledTrackLoader(fetchAudio)({ decodeAudioData }, definition),
    ).rejects.toThrow('Could not load deep-focus.');
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('preserves decode failures for retry handling', async () => {
    const fetchAudio = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;
    const decodeAudioData = vi.fn(async () => {
      throw new Error('invalid audio');
    });

    await expect(
      createBundledTrackLoader(fetchAudio)({ decodeAudioData }, definition),
    ).rejects.toThrow('invalid audio');
  });

  it('rejects decoded audio shorter than the declared loop', async () => {
    const fetchAudio = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;
    const decodeAudioData = vi.fn(async () => ({
      duration: definition.loopEndSeconds - 0.02,
    })) as unknown as Pick<AudioContext, 'decodeAudioData'>['decodeAudioData'];

    await expect(
      createBundledTrackLoader(fetchAudio)({ decodeAudioData }, definition),
    ).rejects.toThrow('Decoded deep-focus is shorter than its loop range.');
  });
});
