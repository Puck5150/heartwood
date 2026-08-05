import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  assertVersionAgreement,
  normalizeAlphaTag,
  readRepositoryVersions,
} from './releaseVersion.mjs';

function copyVersionFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'release-version-'));
  onTestFinished(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) {
    cpSync(path.join(process.cwd(), file), path.join(root, file));
  }
  for (const file of ['Cargo.toml', 'Cargo.lock', 'tauri.conf.json']) {
    cpSync(path.join(process.cwd(), 'src-tauri', file), path.join(root, 'src-tauri', file));
  }
  cpSync(path.join(process.cwd(), 'src-tauri', 'src'), path.join(root, 'src-tauri', 'src'), {
    recursive: true,
  });
  cpSync(path.join(process.cwd(), 'src-tauri', 'build.rs'), path.join(root, 'src-tauri', 'build.rs'));
  return root;
}

describe('release version contract', () => {
  it('normalizes only an alpha release tag', () => {
    expect(normalizeAlphaTag('v0.1.0-alpha.1')).toBe('0.1.0-alpha.1');
    expect(() => normalizeAlphaTag('0.1.0-alpha.1')).toThrow(/must start with v/i);
    expect(() => normalizeAlphaTag('v0.1.0')).toThrow(/alpha/i);
  });

  it('requires every version source and the tag to agree', () => {
    const versions = {
      packageVersion: '0.1.0-alpha.1',
      packageLockVersion: '0.1.0-alpha.1',
      packageLockRootVersion: '0.1.0-alpha.1',
      tauriVersion: '0.1.0-alpha.1',
      cargoVersion: '0.1.0-alpha.1',
      cargoLockVersion: '0.1.0-alpha.1',
    };
    expect(assertVersionAgreement(versions, 'v0.1.0-alpha.1')).toBe('0.1.0-alpha.1');
    expect(() =>
      assertVersionAgreement({ ...versions, packageVersion: '0.1.0' }, 'v0.1.0-alpha.1'),
    ).toThrow(/version mismatch/i);
  });

  it('keeps checked-in release metadata aligned', () => {
    expect(readRepositoryVersions(process.cwd())).toEqual({
      packageVersion: '0.1.0-alpha.3',
      packageLockVersion: '0.1.0-alpha.3',
      packageLockRootVersion: '0.1.0-alpha.3',
      tauriVersion: '0.1.0-alpha.3',
      cargoVersion: '0.1.0-alpha.3',
      cargoLockVersion: '0.1.0-alpha.3',
    });
  });

  it('rejects an npm lockfile top-level version mismatch', () => {
    const root = copyVersionFixture();
    const lockfilePath = path.join(root, 'package-lock.json');
    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    lockfile.version = '9.9.9';
    writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    expect(() => assertVersionAgreement(readRepositoryVersions(root))).toThrow(/version mismatch/i);
  });

  it('rejects an npm lockfile root package version mismatch', () => {
    const root = copyVersionFixture();
    const lockfilePath = path.join(root, 'package-lock.json');
    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    lockfile.packages[''].version = '9.9.9';
    writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    expect(() => assertVersionAgreement(readRepositoryVersions(root))).toThrow(/version mismatch/i);
  });

  it('rejects a Cargo.lock root app package version mismatch', () => {
    const root = copyVersionFixture();
    const lockfilePath = path.join(root, 'src-tauri/Cargo.lock');
    const lockfile = readFileSync(lockfilePath, 'utf8');
    const appPackage = 'name = "app"\nversion = "0.1.0-alpha.3"';
    expect(lockfile.match(new RegExp(appPackage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    writeFileSync(lockfilePath, lockfile.replace(appPackage, 'name = "app"\nversion = "9.9.9"'));

    expect(() => assertVersionAgreement(readRepositoryVersions(root))).toThrow(/version mismatch/i);
  });
});
