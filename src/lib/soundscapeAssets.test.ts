import { lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOUNDSCAPE_CATALOG } from './soundscapeCatalog';

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
});
