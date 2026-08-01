import { lstatSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOUNDSCAPE_CATALOG } from './soundscapeCatalog';

interface WavInfo {
  audioFormat: number;
  bitsPerSample: number;
  sampleRate: number;
  channels: number;
  frames: number;
  firstRms: number;
  lastRms: number;
}

const EXPECTED_FRAMES = new Map([
  ['deep-focus', 4_941_792],
  ['lofi-hip-hop', 3_175_200],
  ['quiet-piano', 5_456_052],
  ['organic-drift', 2_822_400],
  ['still-air', 5_996_468],
  ['rain-room', 3_969_000],
  ['slow-pulse', 6_293_189],
]);

function rms16(buffer: Buffer, offset: number, sampleCount: number): number {
  let squareSum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = buffer.readInt16LE(offset + index * 2) / 32_768;
    squareSum += sample * sample;
  }
  return Math.sqrt(squareSum / sampleCount);
}

function readWavInfo(path: string): WavInfo {
  const buffer = readFileSync(path);
  expect(buffer.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buffer.toString('ascii', 8, 12)).toBe('WAVE');

  let offset = 12;
  let formatOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') formatOffset = offset + 8;
    if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }

  expect(formatOffset).toBeGreaterThanOrEqual(0);
  expect(dataOffset).toBeGreaterThanOrEqual(0);
  const audioFormat = buffer.readUInt16LE(formatOffset);
  const channels = buffer.readUInt16LE(formatOffset + 2);
  const sampleRate = buffer.readUInt32LE(formatOffset + 4);
  const blockAlign = buffer.readUInt16LE(formatOffset + 12);
  const bitsPerSample = buffer.readUInt16LE(formatOffset + 14);
  const frames = dataSize / blockAlign;
  const edgeSamples = Math.min(Math.round(sampleRate * 0.1) * channels, dataSize / 2);

  return {
    audioFormat,
    bitsPerSample,
    sampleRate,
    channels,
    frames,
    firstRms: rms16(buffer, dataOffset, edgeSamples),
    lastRms: rms16(buffer, dataOffset + dataSize - edgeSamples * 2, edgeSamples),
  };
}

describe('bundled soundscape assets', () => {
  it('keeps every non-empty catalog asset inside the canonical public directory', () => {
    const root = resolve(process.cwd(), 'public/audio/soundscapes');

    for (const definition of SOUNDSCAPE_CATALOG) {
      const asset = resolve(process.cwd(), 'public', definition.assetPath.slice(1));
      expect(asset.startsWith(`${root}${sep}`)).toBe(true);
      const stats = lstatSync(asset);
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBeGreaterThan(0);
    }
  });

  it('keeps every canonical asset on its approved pure-loop boundary', () => {
    for (const definition of SOUNDSCAPE_CATALOG) {
      const asset = resolve(process.cwd(), 'public', definition.assetPath.slice(1));
      const info = readWavInfo(asset);

      expect(info.audioFormat, definition.id).toBe(1);
      expect(info.bitsPerSample, definition.id).toBe(16);
      expect(info.sampleRate, definition.id).toBe(44_100);
      expect(info.channels, definition.id).toBeGreaterThanOrEqual(1);
      expect(info.frames, definition.id).toBe(EXPECTED_FRAMES.get(definition.id));
      expect(Math.abs(info.frames / info.sampleRate - definition.loopEndSeconds)).toBeLessThanOrEqual(
        1 / info.sampleRate,
      );
      expect(info.firstRms, definition.id).toBeGreaterThan(0.00001);
      expect(info.lastRms, definition.id).toBeGreaterThan(0.00001);
    }
  });
});
