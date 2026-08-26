import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Inlined rather than imported from releaseVersion.mjs: that module also
// imports @iarna/toml, and the release job (unlike build/validate) never
// runs npm install — pulling in an npm dependency here would break it.
const BETA_TAG = /^v(\d+\.\d+\.\d+-beta\.\d+)$/;

function normalizeBetaTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const match = BETA_TAG.exec(tag);
  if (!match) throw new Error('Release tag must use vX.Y.Z-beta.N.');
  return match[1];
}

const DARWIN_SUFFIXES = ['.app.tar.gz.sig', '.dmg.sig'];
const WINDOWS_SUFFIXES = ['.nsis.zip.sig', '.msi.sig', '.exe.sig'];
const LINUX_SUFFIXES = ['.AppImage.sig'];

export function classifyUpdaterSignature(filename) {
  if (DARWIN_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'darwin';
  if (WINDOWS_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'windows';
  if (LINUX_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'linux';
  throw new Error(`Unrecognized updater signature artifact: ${filename}`);
}

// darwin maps to two manifest keys sharing one signature/url: the bundler
// produces a single universal binary, so both arch entries point at the
// same artifact rather than needing separate per-arch builds like windows/linux.
const PLATFORM_KEYS = {
  darwin: ['darwin-x86_64', 'darwin-aarch64'],
  windows: ['windows-x86_64'],
  linux: ['linux-x86_64'],
};

// Recursive, because actions/download-artifact can preserve per-artifact
// subdirectories — prepareBetaAssets.mjs already walks recursively, and a
// flat scan here would report every platform missing for the same input.
// Entries are relative paths ('mac/Heartwood.app.tar.gz.sig'); suffix
// matching is unaffected, but URLs must use the basename only.
// .deb.sig is a real bundler output (Deb is on the updater-eligible list) that
// this project deliberately ignores: .deb installs can't self-update, and
// letting it through would collide with .AppImage.sig on the 'linux' key.
export function updaterSignatureFiles(artifactsDir) {
  return readdirSync(artifactsDir, { recursive: true }).filter(
    (name) => name.endsWith('.sig') && !name.endsWith('.deb.sig'),
  );
}

// Android has no updater signature at all — its own package installer
// already refuses to install an update APK signed with a different key
// than what's installed, so there's no minisign-equivalent check to add
// here. Found by filename instead of a .sig sibling, and — like the three
// desktop platforms — required, not optional: a build with signatures but
// no APK is exactly as broken as one missing a desktop installer (see
// beta-testing.md's severity rules, which already treat a missing Android
// build as a blocker).
//
// The entry still needs an (empty) `signature` key, though: desktop's
// updater plugin deserializes the whole `platforms` map with `signature`
// as a required (non-Option) field on every entry, not just its own OS's.
// Omitting it here doesn't just skip Android — it fails parsing for the
// *entire* manifest, silently breaking update checks on every desktop
// platform (see the regression this fixed).
function findAndroidApk(artifactsDir) {
  const matches = readdirSync(artifactsDir, { recursive: true }).filter((name) => name.endsWith('_arm64-v8a.apk'));
  if (matches.length > 1) {
    throw new Error(`Multiple Android APK artifacts found: ${matches.join(', ')}`);
  }
  return matches[0] ?? null;
}

export function buildUpdaterManifest({ version, notes, pubDate, artifactsDir, downloadBaseUrl }) {
  const sigFiles = updaterSignatureFiles(artifactsDir);

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

  const apkName = findAndroidApk(artifactsDir);
  if (apkName === null) {
    throw new Error('Missing Android APK artifact for the updater manifest');
  }

  const platforms = {};
  for (const [platform, sigName] of byPlatform) {
    const signature = readFileSync(path.join(artifactsDir, sigName), 'utf8').trim();
    const assetName = path.basename(sigName).slice(0, -'.sig'.length);
    const url = `${downloadBaseUrl}/${assetName}`;
    for (const key of PLATFORM_KEYS[platform]) {
      platforms[key] = { signature, url };
    }
  }
  platforms['android-aarch64'] = { signature: '', url: `${downloadBaseUrl}/${path.basename(apkName)}` };

  return { version, notes, pub_date: pubDate, platforms };
}

async function runCli() {
  const [artifactsDir, tag, downloadBaseUrl] = process.argv.slice(2);
  if (!artifactsDir || !tag || !downloadBaseUrl) {
    throw new Error('Usage: node scripts/buildUpdaterManifest.mjs <artifacts-dir> <tag> <download-base-url>');
  }
  const version = normalizeBetaTag(tag);
  // Zero signatures means signing simply isn't configured yet (the two
  // GitHub secrets are absent), which docs/beta-testing.md promises is a
  // no-op rather than a failure. A *partial* set is still a real
  // misconfiguration and still throws below.
  if (updaterSignatureFiles(artifactsDir).length === 0) {
    console.log('No updater signatures found — signing not configured yet, skipping manifest.');
    return;
  }
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
