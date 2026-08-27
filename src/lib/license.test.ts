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

  it('rejects a degenerate all-zero signature (torsion-subgroup forgery)', () => {
    // An attacker-constructed key with an all-zero signature and tier=1 payload
    // must return null, both against the placeholder and against a real test key.
    const payload = new Uint8Array(13);
    payload.set(crypto.getRandomValues(new Uint8Array(8)), 0); // random licenseId
    new DataView(payload.buffer).setUint32(8, Math.floor(Date.now() / 1000), false); // issuedAt
    payload[12] = 1; // tier

    function toBase64Url(bytes: Uint8Array): string {
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    const degenerateKey = `${toBase64Url(payload)}.${toBase64Url(new Uint8Array(64))}`;

    // Must reject against placeholder (default)
    expect(verifyLicenseKey(degenerateKey)).toBeNull();

    // Must also reject against a real test public key
    const { publicKeyHex } = generateTestLicenseKeypair();
    expect(verifyLicenseKey(degenerateKey, publicKeyHex)).toBeNull();
  });
});
