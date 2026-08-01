import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from '@iarna/toml';
import path from 'node:path';

const ALPHA_TAG = /^v(\d+\.\d+\.\d+-alpha\.\d+)$/;

export function normalizeAlphaTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const match = ALPHA_TAG.exec(tag);
  if (!match) throw new Error('Release tag must use vX.Y.Z-alpha.N.');
  return match[1];
}

export function assertVersionAgreement(versions, tag) {
  const values = [
    versions.packageVersion,
    versions.packageLockVersion,
    versions.packageLockRootVersion,
    versions.tauriVersion,
    versions.cargoVersion,
    versions.cargoLockVersion,
  ];
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
  const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const packageLockVersion = packageLock.version;
  const packageLockRootVersion = packageLock.packages?.['']?.version;
  if (!packageLockVersion || !packageLockRootVersion) {
    throw new Error('package-lock.json is missing a root version.');
  }
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
  const cargoLock = parseToml(readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'));
  const cargoLockVersion = cargoLock.package?.find((entry) => entry.name === 'app')?.version;
  if (!cargoLockVersion) throw new Error('Cargo.lock did not contain the app package.');
  return {
    packageVersion,
    packageLockVersion,
    packageLockRootVersion,
    tauriVersion,
    cargoVersion,
    cargoLockVersion,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const version = assertVersionAgreement(readRepositoryVersions(root), process.argv[2]);
  console.log(version);
}
