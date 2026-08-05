import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildUpdaterManifest, classifyUpdaterSignature } from './buildUpdaterManifest.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'updater-manifest-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('classifyUpdaterSignature', () => {
  it('classifies known macOS, Windows, and Linux signature suffixes', () => {
    expect(classifyUpdaterSignature('Heartwood.app.tar.gz.sig')).toBe('darwin');
    expect(classifyUpdaterSignature('Heartwood_universal.dmg.sig')).toBe('darwin');
    expect(classifyUpdaterSignature('Heartwood.nsis.zip.sig')).toBe('windows');
    expect(classifyUpdaterSignature('Heartwood_x64-setup.exe.sig')).toBe('windows');
    expect(classifyUpdaterSignature('Heartwood_amd64.AppImage.sig')).toBe('linux');
  });

  it('rejects an unrecognized signature suffix', () => {
    expect(() => classifyUpdaterSignature('Heartwood_amd64.deb.sig')).toThrow(
      /unrecognized updater signature/i,
    );
  });
});

describe('buildUpdaterManifest', () => {
  it('builds a manifest with darwin, windows, and linux platform entries', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'Heartwood_universal.dmg'), 'dmg bytes');
    await writeFile(path.join(dir, 'Heartwood_universal.dmg.sig'), 'darwin-signature');
    await writeFile(path.join(dir, 'Heartwood_x64-setup.exe'), 'exe bytes');
    await writeFile(path.join(dir, 'Heartwood_x64-setup.exe.sig'), 'windows-signature');
    await writeFile(path.join(dir, 'Heartwood_amd64.AppImage'), 'appimage bytes');
    await writeFile(path.join(dir, 'Heartwood_amd64.AppImage.sig'), 'linux-signature');

    const manifest = buildUpdaterManifest({
      version: '0.1.0-alpha.4',
      notes: 'Alpha release',
      pubDate: '2026-08-05T00:00:00.000Z',
      artifactsDir: dir,
      downloadBaseUrl: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4',
    });

    expect(manifest).toEqual({
      version: '0.1.0-alpha.4',
      notes: 'Alpha release',
      pub_date: '2026-08-05T00:00:00.000Z',
      platforms: {
        'darwin-x86_64': {
          signature: 'darwin-signature',
          url: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4/Heartwood_universal.dmg',
        },
        'darwin-aarch64': {
          signature: 'darwin-signature',
          url: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4/Heartwood_universal.dmg',
        },
        'windows-x86_64': {
          signature: 'windows-signature',
          url: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4/Heartwood_x64-setup.exe',
        },
        'linux-x86_64': {
          signature: 'linux-signature',
          url: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4/Heartwood_amd64.AppImage',
        },
      },
    });
  });

  it('trims trailing whitespace from signature file contents', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'darwin-signature\n');
    await writeFile(path.join(dir, 'b.exe.sig'), 'windows-signature\n');
    await writeFile(path.join(dir, 'c.AppImage.sig'), 'linux-signature\n');

    const manifest = buildUpdaterManifest({
      version: '0.1.0-alpha.4',
      notes: '',
      pubDate: '2026-08-05T00:00:00.000Z',
      artifactsDir: dir,
      downloadBaseUrl: 'https://example.test',
    });

    expect(manifest.platforms['darwin-x86_64'].signature).toBe('darwin-signature');
  });

  it('throws when a platform signature is missing', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'darwin-signature');
    await writeFile(path.join(dir, 'b.exe.sig'), 'windows-signature');

    expect(() =>
      buildUpdaterManifest({
        version: '0.1.0-alpha.4',
        notes: '',
        pubDate: '2026-08-05T00:00:00.000Z',
        artifactsDir: dir,
        downloadBaseUrl: 'https://example.test',
      }),
    ).toThrow(/missing updater signature.*linux/i);
  });

  it('throws on two signature files for the same platform', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'one');
    await writeFile(path.join(dir, 'b.dmg.sig'), 'two');
    await writeFile(path.join(dir, 'c.exe.sig'), 'windows-signature');
    await writeFile(path.join(dir, 'd.AppImage.sig'), 'linux-signature');

    expect(() =>
      buildUpdaterManifest({
        version: '0.1.0-alpha.4',
        notes: '',
        pubDate: '2026-08-05T00:00:00.000Z',
        artifactsDir: dir,
        downloadBaseUrl: 'https://example.test',
      }),
    ).toThrow(/duplicate updater signature.*darwin/i);
  });
});
