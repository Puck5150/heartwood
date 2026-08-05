import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildUpdaterManifest, classifyUpdaterSignature } from './buildUpdaterManifest.mjs';

const execFileAsync = promisify(execFile);
const script = path.join(process.cwd(), 'scripts/buildUpdaterManifest.mjs');

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

  it('finds signatures nested in per-artifact subdirectories and keeps the URL flat', async () => {
    const dir = await fixture();
    await mkdir(path.join(dir, 'mac', 'deep'), { recursive: true });
    await writeFile(path.join(dir, 'mac/deep/Heartwood.app.tar.gz.sig'), 'darwin-signature');
    await writeFile(path.join(dir, 'b.exe.sig'), 'windows-signature');
    await writeFile(path.join(dir, 'c.AppImage.sig'), 'linux-signature');

    const manifest = buildUpdaterManifest({
      version: '0.1.0-alpha.4',
      notes: '',
      pubDate: '2026-08-05T00:00:00.000Z',
      artifactsDir: dir,
      downloadBaseUrl: 'https://example.test',
    });

    // The release uploads a flat set of assets, so the subdirectory must
    // not leak into the download URL.
    expect(manifest.platforms['darwin-x86_64']).toEqual({
      signature: 'darwin-signature',
      url: 'https://example.test/Heartwood.app.tar.gz',
    });
  });

  it('ignores the .deb.sig the bundler also emits on Linux', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'darwin-signature');
    await writeFile(path.join(dir, 'b.exe.sig'), 'windows-signature');
    await writeFile(path.join(dir, 'c.AppImage.sig'), 'linux-signature');
    await writeFile(path.join(dir, 'd.deb.sig'), 'deb-signature');

    const manifest = buildUpdaterManifest({
      version: '0.1.0-alpha.4',
      notes: '',
      pubDate: '2026-08-05T00:00:00.000Z',
      artifactsDir: dir,
      downloadBaseUrl: 'https://example.test',
    });

    // .deb can't self-update, so its signature must neither win the 'linux'
    // slot nor trip the duplicate-platform guard.
    expect(manifest.platforms['linux-x86_64']).toEqual({
      signature: 'linux-signature',
      url: 'https://example.test/c.AppImage',
    });
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

describe('buildUpdaterManifest CLI', () => {
  it('succeeds without writing a manifest when no signatures exist at all', async () => {
    const dir = await fixture();
    // An unsigned build: installers, but no .sig files, because the signing
    // secrets aren't configured. Documented as a no-op, not a failure.
    await writeFile(path.join(dir, 'Heartwood_universal.dmg'), 'dmg bytes');
    await writeFile(path.join(dir, 'heartwood_amd64.deb'), 'deb bytes');

    const { stdout } = await execFileAsync(process.execPath, [
      script,
      dir,
      'v0.1.0-alpha.4',
      'https://example.test',
    ]);

    expect(stdout).toMatch(/no updater signatures found/i);
    expect((await readdir(dir)).sort()).toEqual(['Heartwood_universal.dmg', 'heartwood_amd64.deb']);
  });

  it('still fails loudly when only some platform signatures exist', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'darwin-signature');

    await expect(
      execFileAsync(process.execPath, [script, dir, 'v0.1.0-alpha.4', 'https://example.test']),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/missing updater signature.*windows, linux/i),
    });
  });

  it('writes latest.json when every platform signature is present', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'darwin-signature');
    await writeFile(path.join(dir, 'b.exe.sig'), 'windows-signature');
    await writeFile(path.join(dir, 'c.AppImage.sig'), 'linux-signature');

    await execFileAsync(process.execPath, [script, dir, 'v0.1.0-alpha.4', 'https://example.test']);

    expect(await readdir(dir)).toContain('latest.json');
  });
});
