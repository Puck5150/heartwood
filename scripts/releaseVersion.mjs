import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ALPHA_TAG = /^v(\d+\.\d+\.\d+-alpha\.\d+)$/;

export function normalizeAlphaTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const match = ALPHA_TAG.exec(tag);
  if (!match) throw new Error('Release tag must use vX.Y.Z-alpha.N.');
  return match[1];
}

export function assertVersionAgreement(versions, tag) {
  const values = [versions.packageVersion, versions.tauriVersion, versions.cargoVersion];
  if (new Set(values).size !== 1) {
    throw new Error(`Version mismatch: ${values.join(', ')}`);
  }
  if (tag && normalizeAlphaTag(tag) !== values[0]) {
    throw new Error(`Version mismatch: tag ${tag} does not match ${values[0]}.`);
  }
  return values[0];
}

export function readRepositoryVersions(root) {
  const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tauriVersion = JSON.parse(
    readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
  ).version;
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  const cargoVersion = metadata.packages.find((entry) => entry.name === 'app')?.version;
  if (!cargoVersion) throw new Error('Cargo metadata did not contain the app package.');
  return { packageVersion, tauriVersion, cargoVersion };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const version = assertVersionAgreement(readRepositoryVersions(root), process.argv[2]);
  console.log(version);
}
