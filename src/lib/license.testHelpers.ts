//
// Test-only fixtures. NEVER imported by production code — this module
// generates and exposes a private key on purpose, because it is
// deliberately never the real one (see license.ts's own key-custody
// comment).

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

ed.hashes.sha512 = sha512;

export function generateTestLicenseKeypair(): { secretKey: Uint8Array; publicKeyHex: string } {
  const { secretKey, publicKey } = ed.keygen();
  return { secretKey, publicKeyHex: bytesToHex(publicKey) };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signTestLicense(
  secretKey: Uint8Array,
  overrides: { licenseId?: Uint8Array; issuedAt?: number; tier?: number } = {}
): string {
  const licenseId = overrides.licenseId ?? crypto.getRandomValues(new Uint8Array(8));
  const issuedAt = overrides.issuedAt ?? Math.floor(Date.now() / 1000);
  const tier = overrides.tier ?? 1;

  const payload = new Uint8Array(13);
  payload.set(licenseId, 0);
  new DataView(payload.buffer).setUint32(8, issuedAt, false);
  payload[12] = tier;

  const signature = ed.sign(payload, secretKey);

  return `${toBase64Url(payload)}.${toBase64Url(signature)}`;
}
