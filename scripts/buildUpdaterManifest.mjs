import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeAlphaTag } from './releaseVersion.mjs';

const DARWIN_SUFFIXES = ['.app.tar.gz.sig', '.dmg.sig'];
const WINDOWS_SUFFIXES = ['.nsis.zip.sig', '.msi.sig', '.exe.sig'];
const LINUX_SUFFIXES = ['.AppImage.sig'];

export function classifyUpdaterSignature(filename) {
  if (DARWIN_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'darwin';
  if (WINDOWS_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'windows';
  if (LINUX_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'linux';
  throw new Error(`Unrecognized updater signature artifact: ${filename}`);
}

const PLATFORM_KEYS = {
  darwin: ['darwin-x86_64', 'darwin-aarch64'],
  windows: ['windows-x86_64'],
  linux: ['linux-x86_64'],
};

export function buildUpdaterManifest({ version, notes, pubDate, artifactsDir, downloadBaseUrl }) {
  const sigFiles = readdirSync(artifactsDir).filter((name) => name.endsWith('.sig'));

  const byPlatform = new Map();
  for (const sigName of sigFiles) {
    const platform = classifyUpdaterSignature(sigName);
    if (byPlatform.has(platform)) {
      throw new Error(
        `Duplicate updater signature for platform ${platform}: ${byPlatform.get(platform)} and ${sigName}`,
      );
    }
    byPlatform.set(platform, sigName);
  }

  const missing = Object.keys(PLATFORM_KEYS).filter((platform) => !byPlatform.has(platform));
  if (missing.length > 0) {
    throw new Error(`Missing updater signature for platform(s): ${missing.join(', ')}`);
  }

  const platforms = {};
  for (const [platform, sigName] of byPlatform) {
    const signature = readFileSync(path.join(artifactsDir, sigName), 'utf8').trim();
    const assetName = sigName.slice(0, -'.sig'.length);
    const url = `${downloadBaseUrl}/${assetName}`;
    for (const key of PLATFORM_KEYS[platform]) {
      platforms[key] = { signature, url };
    }
  }

  return { version, notes, pub_date: pubDate, platforms };
}

async function runCli() {
  const [artifactsDir, tag, downloadBaseUrl] = process.argv.slice(2);
  if (!artifactsDir || !tag || !downloadBaseUrl) {
    throw new Error('Usage: node scripts/buildUpdaterManifest.mjs <artifacts-dir> <tag> <download-base-url>');
  }
  const version = normalizeAlphaTag(tag);
  const manifest = buildUpdaterManifest({
    version,
    notes: '',
    pubDate: new Date().toISOString(),
    artifactsDir,
    downloadBaseUrl,
  });
  writeFileSync(path.join(artifactsDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${path.join(artifactsDir, 'latest.json')}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
