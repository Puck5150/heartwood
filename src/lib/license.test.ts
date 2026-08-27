import { describe, expect, it } from 'vitest';
import { verifyLicenseKey } from './license';
import { generateTestLicenseKeypair, signTestLicense } from './license.testHelpers';

describe('verifyLicenseKey', () => {
  it('verifies a correctly signed key', () => {
    const { secretKey, publicKeyHex } = generateTestLicenseKeypair();
    const key = signTestLicense(secretKey, { issuedAt: 1735689600, tier: 1 });

    const result = verifyLicenseKey(key, publicKeyHex);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(1);
    expect(result?.issuedAt).toBe(1735689600);
    expect(result?.licenseId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects a key signed with the wrong private key', () => {
    const { publicKeyHex } = generateTestLicenseKeypair();
    const wrongKeypair = generateTestLicenseKeypair();
    const key = signTestLicense(wrongKeypair.secretKey);

    expect(verifyLicenseKey(key, publicKeyHex)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const { secretKey, publicKeyHex } = generateTestLicenseKeypair();
    const key = signTestLicense(secretKey);
    const [payload, signature] = key.split('.');

    expect(verifyLicenseKey(`${payload}A.${signature}`, publicKeyHex)).toBeNull();
  });

  it('rejects a malformed string with no separator', () => {
    expect(verifyLicenseKey('not-a-license-key')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(verifyLicenseKey('')).toBeNull();
  });

  it('rejects an unrecognized tier byte', () => {
    const { secretKey, publicKeyHex } = generateTestLicenseKeypair();
    const key = signTestLicense(secretKey, { tier: 99 });

    expect(verifyLicenseKey(key, publicKeyHex)).toBeNull();
  });

  it('defaults to the placeholder public key and rejects a real-looking key against it', () => {
    const { secretKey } = generateTestLicenseKeypair();
    const key = signTestLicense(secretKey);

    expect(verifyLicenseKey(key)).toBeNull();
  });
});
