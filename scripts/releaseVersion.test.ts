import { describe, expect, it } from 'vitest';
import {
  assertVersionAgreement,
  normalizeAlphaTag,
  readRepositoryVersions,
} from './releaseVersion.mjs';

describe('release version contract', () => {
  it('normalizes only an alpha release tag', () => {
    expect(normalizeAlphaTag('v0.1.0-alpha.1')).toBe('0.1.0-alpha.1');
    expect(() => normalizeAlphaTag('0.1.0-alpha.1')).toThrow(/must start with v/i);
    expect(() => normalizeAlphaTag('v0.1.0')).toThrow(/alpha/i);
  });

  it('requires every version source and the tag to agree', () => {
    const versions = {
      packageVersion: '0.1.0-alpha.1',
      tauriVersion: '0.1.0-alpha.1',
      cargoVersion: '0.1.0-alpha.1',
    };
    expect(assertVersionAgreement(versions, 'v0.1.0-alpha.1')).toBe('0.1.0-alpha.1');
    expect(() =>
      assertVersionAgreement({ ...versions, packageVersion: '0.1.0' }, 'v0.1.0-alpha.1'),
    ).toThrow(/version mismatch/i);
  });

  it('keeps checked-in release metadata aligned', () => {
    expect(readRepositoryVersions(process.cwd())).toEqual({
      packageVersion: '0.1.0-alpha.1',
      tauriVersion: '0.1.0-alpha.1',
      cargoVersion: '0.1.0-alpha.1',
    });
  });
});
