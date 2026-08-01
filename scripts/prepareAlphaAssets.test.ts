import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { collectAlphaArtifacts, prepareAlphaAssets } from './prepareAlphaAssets.mjs';

const execFileAsync = promisify(execFile);
const names = [
  'Pomodoro.Parking.Lot_0.1.0-alpha.1_universal.dmg',
  'Pomodoro.Parking.Lot_0.1.0-alpha.1_x64-setup.exe',
  'pomodoro-parking-lot_0.1.0-alpha.1_amd64.AppImage',
  'pomodoro-parking-lot_0.1.0-alpha.1_amd64.deb',
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'alpha-assets-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await mkdir(input);
  return { root, input, output };
}

async function writeCompleteSet(input: string) {
  const locations = ['mac/deep', 'windows', 'linux/appimage', 'linux/deb'];
  for (const [index, name] of names.entries()) {
    const directory = path.join(input, locations[index]);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), `contents:${name}`);
  }
}

describe('alpha release assets', () => {
  it('recursively collects exactly one artifact of each required kind', async () => {
    const { input } = await fixture();
    await writeCompleteSet(input);

    const artifacts = await collectAlphaArtifacts(input);

    expect(artifacts.map(({ filename, kind }) => ({ filename, kind }))).toEqual([
      { filename: names[0], kind: 'macos' },
      { filename: names[1], kind: 'windows' },
      { filename: names[2], kind: 'linux-appimage' },
      { filename: names[3], kind: 'linux-deb' },
    ]);
  });

  it('flattens the complete set, replaces stale output, and writes sorted checksums', async () => {
    const { input, output } = await fixture();
    await writeCompleteSet(input);
    await mkdir(path.join(output, 'stale'), { recursive: true });
    await writeFile(path.join(output, 'stale', 'old.txt'), 'old');

    expect(await prepareAlphaAssets(input, output)).toEqual([...names].sort());
    expect((await readdir(output)).sort()).toEqual([...names, 'SHA256SUMS.txt'].sort());

    const checksums = await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
    const expected = [...names]
      .sort()
      .map((name) => {
        const digest = createHash('sha256').update(`contents:${name}`).digest('hex');
        return `${digest}  ${name}`;
      });
    expect(checksums).toBe(`${expected.join('\n')}\n`);
  });

  it('reports every missing required kind in one error', async () => {
    const { input, output } = await fixture();
    await writeFile(path.join(input, names[0]), 'dmg');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(
      /missing required artifact kinds: windows, linux-appimage, linux-deb/i,
    );
  });

  it('rejects two differently named installers of the same kind', async () => {
    const { input, output } = await fixture();
    await writeCompleteSet(input);
    await writeFile(path.join(input, 'another-installer.dmg'), 'duplicate kind');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(
      /duplicate artifact kind macos/i,
    );
  });

  it('rejects the same installer filename found in different directories', async () => {
    const { input, output } = await fixture();
    await writeCompleteSet(input);
    await mkdir(path.join(input, 'duplicate'));
    await writeFile(path.join(input, 'duplicate', names[0]), 'duplicate filename');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(
      /duplicate artifact filename.*universal\.dmg/i,
    );
  });

  it('rejects unsupported regular files', async () => {
    const { input, output } = await fixture();
    await writeCompleteSet(input);
    await writeFile(path.join(input, 'notes.txt'), 'not an installer');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(
      /unsupported artifact.*notes\.txt/i,
    );
  });

  it('classifies suffixes case-sensitively', async () => {
    const { input, output } = await fixture();
    await writeCompleteSet(input);
    await writeFile(path.join(input, 'wrong-case.appimage'), 'wrong case');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(
      /unsupported artifact.*wrong-case\.appimage/i,
    );
  });

  it('requires exactly two CLI arguments', async () => {
    const script = path.join(process.cwd(), 'scripts/prepareAlphaAssets.mjs');

    await expect(execFileAsync(process.execPath, [script])).rejects.toMatchObject({
      stderr: expect.stringMatching(/usage:.*<download-dir> <release-dir>/i),
    });
    await expect(execFileAsync(process.execPath, [script, 'one', 'two', 'three'])).rejects.toMatchObject(
      {
        stderr: expect.stringMatching(/usage:.*<download-dir> <release-dir>/i),
      },
    );
  });

  it('prepares assets through the CLI', async () => {
    const { input, output } = await fixture();
    await writeCompleteSet(input);
    const script = path.join(process.cwd(), 'scripts/prepareAlphaAssets.mjs');

    const { stdout, stderr } = await execFileAsync(process.execPath, [script, input, output]);

    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toEqual([...names].sort());
    expect(await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8')).toMatch(
      /^[0-9a-f]{64}  .+$/m,
    );
  });
});
