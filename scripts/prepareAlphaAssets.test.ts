import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';
import { collectAlphaArtifacts, prepareAlphaAssets } from './prepareAlphaAssets.mjs';

const execFileAsync = promisify(execFile);
const names = [
  'Heartwood_0.1.0-alpha.1_universal.dmg',
  'Heartwood_0.1.0-alpha.1_x64-setup.exe',
  'heartwood_0.1.0-alpha.1_amd64.AppImage',
  'heartwood_0.1.0-alpha.1_amd64.deb',
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'alpha-assets-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
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

const updaterFiles = {
  'Heartwood_universal.dmg.sig': 'darwin-signature',
  'Heartwood_x64-setup.exe.sig': 'windows-signature',
  'heartwood_amd64.AppImage.sig': 'linux-signature',
  'latest.json': '{"version":"0.1.0-alpha.4","platforms":{}}',
};

async function writeCompleteSetWithUpdater(input: string) {
  await writeCompleteSet(input);
  for (const [name, contents] of Object.entries(updaterFiles)) {
    await writeFile(path.join(input, name), contents);
  }
}

describe('alpha release assets', () => {
  it('recursively collects exactly one artifact of each required kind', async () => {
    const { input } = await fixture();
    await writeCompleteSet(input);

    const artifacts = await collectAlphaArtifacts(input);

    expect(
      artifacts.map(({ filename, kind }) => ({ filename, kind })).sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual(
      [
        { filename: names[0], kind: 'macos' },
        { filename: names[1], kind: 'windows' },
        { filename: names[2], kind: 'linux-appimage' },
        { filename: names[3], kind: 'linux-deb' },
      ].sort((a, b) => a.kind.localeCompare(b.kind)),
    );
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

  it('rejects equal input and output paths without deleting source installers', async () => {
    const { input } = await fixture();
    await writeCompleteSet(input);

    await expect(prepareAlphaAssets(input, path.join(input, 'nested', '..'))).rejects.toThrow(
      /input and output directories must not overlap/i,
    );
    expect(await readFile(path.join(input, 'mac/deep', names[0]), 'utf8')).toBe(
      `contents:${names[0]}`,
    );
  });

  it('rejects an output directory above the input without deleting source installers', async () => {
    const { root, input } = await fixture();
    await writeCompleteSet(input);

    await expect(prepareAlphaAssets(input, root)).rejects.toThrow(
      /input and output directories must not overlap/i,
    );
    expect(await readFile(path.join(input, 'mac/deep', names[0]), 'utf8')).toBe(
      `contents:${names[0]}`,
    );
  });

  it('rejects an output directory below the input for repeatable collection', async () => {
    const { input } = await fixture();
    await writeCompleteSet(input);

    await expect(prepareAlphaAssets(input, path.join(input, 'release'))).rejects.toThrow(
      /input and output directories must not overlap/i,
    );
    expect(await readFile(path.join(input, 'mac/deep', names[0]), 'utf8')).toBe(
      `contents:${names[0]}`,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink alias that resolves to the input directory',
    async () => {
      const { root, input } = await fixture();
      await writeCompleteSet(input);
      const outputAlias = path.join(root, 'output-alias');
      await symlink(input, outputAlias, 'dir');

      await expect(prepareAlphaAssets(input, outputAlias)).rejects.toThrow(
        /input and output directories must not overlap/i,
      );
      expect(await readFile(path.join(input, 'mac/deep', names[0]), 'utf8')).toBe(
        `contents:${names[0]}`,
      );
    },
  );

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

  it('accepts exactly one latest.json plus its platform signature files', async () => {
    const { input, output } = await fixture();
    await writeCompleteSetWithUpdater(input);

    const filenames = await prepareAlphaAssets(input, output);

    expect(filenames).toEqual([...names, ...Object.keys(updaterFiles)].sort());
    expect((await readdir(output)).sort()).toEqual(
      [...names, ...Object.keys(updaterFiles), 'SHA256SUMS.txt'].sort(),
    );
    expect(await readFile(path.join(output, 'latest.json'), 'utf8')).toBe(updaterFiles['latest.json']);
  });

  it('rejects a second latest.json', async () => {
    const { input, output } = await fixture();
    await writeCompleteSetWithUpdater(input);
    await mkdir(path.join(input, 'nested'), { recursive: true });
    await writeFile(path.join(input, 'nested', 'latest.json'), '{}');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(/duplicate artifact filename.*latest\.json/i);
  });

  it('rejects an unrecognized signature suffix', async () => {
    const { input, output } = await fixture();
    await writeCompleteSetWithUpdater(input);
    await writeFile(path.join(input, 'Heartwood_amd64.deb.sig'), 'not a real updater target');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(/unrecognized updater signature/i);
  });

  it('still requires the four installer kinds even when updater files are present', async () => {
    const { input, output } = await fixture();
    await mkdir(input, { recursive: true });
    for (const [name, contents] of Object.entries(updaterFiles)) {
      await writeFile(path.join(input, name), contents);
    }

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(/missing required artifact kinds/i);
  });
});
