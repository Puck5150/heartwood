//
// Offline license-key verification. Every check here is pure signature
// math against bytes already on disk — no network call anywhere in this
// module, ever. See docs/superpowers/specs/2026-08-27-offline-license-
// verification-design.md for the format and the reasoning.
//
// HEARTWOOD_LICENSE_PUBLIC_KEY_HEX below is a placeholder and must be
// replaced with the real public key before any paid build ships. This
// placeholder is a well-formed Ed25519 public key (from a discarded
// keypair) to ensure the verification logic is inert and cannot be
// trivially forged. The private key that signs real licenses is generated
// and held by the maintainer outside this repository — the same custody
// discipline as the auto-updater's signing key (see the 2026-08-05
// auto-updater spec's "Signing key custody"). It must never be
// generated or stored here, and never appears in this codebase, in CI,
// or in any assistant-authored file.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';

ed.hashes.sha512 = sha512;

// TODO(license): replace with the real production public key before any paid build ships
export const HEARTWOOD_LICENSE_PUBLIC_KEY_HEX = 'e72e778f94069f577fe12bdef84e76344a4e51abf8072ea58bd4121fa8bf8987';

export interface LicenseInfo {
  licenseId: string;
  issuedAt: number;
  tier: 1;
}

const PAYLOAD_BYTES = 13; // 8-byte licenseId + 4-byte issuedAt (u32 BE) + 1-byte tier
const SIGNATURE_BYTES = 64;
const TIER_FULL = 1;

// Note: this is not a canonical encoding. The 13-byte payload (104 bits)
// and 64-byte signature both encode to base64url with unused trailing
// bits in their final character, so multiple distinct strings can decode
// to the identical byte sequence. That's harmless here — `ed.verify`
// operates on the decoded bytes, never the string — but don't compare or
// dedupe raw license-key strings assuming this string form is canonical.
function base64UrlToBytes(input: string): Uint8Array | null {
  try {
    // Real webviews' `atob` (per the HTML spec's "forgiving-base64" decode)
    // silently strips ASCII whitespace before decoding, but Node/jsdom's
    // `atob` throws on embedded whitespace instead — strip it ourselves so
    // a key that picked up a line break (e.g. wrapped by an email client)
    // verifies identically in tests and in the shipped app.
    const stripped = input.replace(/\s+/g, '');
    const padded = stripped.replace(/-/g, '+').replace(/_/g, '/');
    const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Verifies `key` against `publicKeyHex` (defaults to the compiled-in
 * production key). Returns the decoded license on success, `null` on
 * any failure — malformed string, bad encoding, wrong length, invalid
 * signature, or an unrecognized tier byte all collapse to the same
 * `null`, deliberately: callers never need to distinguish failure
 * reasons, only valid-vs-not. */
export function verifyLicenseKey(
  key: string,
  publicKeyHex: string = HEARTWOOD_LICENSE_PUBLIC_KEY_HEX
): LicenseInfo | null {
  const parts = key.split('.');
  if (parts.length !== 2) return null;

  const payload = base64UrlToBytes(parts[0]);
  const signature = base64UrlToBytes(parts[1]);
  if (!payload || !signature) return null;
  if (payload.length !== PAYLOAD_BYTES || signature.length !== SIGNATURE_BYTES) return null;

  let publicKey: Uint8Array;
  try {
    publicKey = hexToBytes(publicKeyHex);
  } catch {
    return null;
  }

  let isValid: boolean;
  try {
    // Use strict RFC8032 mode (zip215: false) — never accept torsion-subgroup
    // signatures or keys, which ZIP215's cofactor-8 default would allow. A
    // mathematically degenerate public key could enable trivial forgery under
    // the default semantics; strict mode rejects both the key and any signature.
    isValid = ed.verify(signature, payload, publicKey, { zip215: false });
  } catch {
    return null;
  }
  if (!isValid) return null;

  const licenseId = Array.from(payload.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const issuedAt = new DataView(payload.buffer, payload.byteOffset + 8, 4).getUint32(0, false);
  const tier = payload[12];

  if (tier !== TIER_FULL) return null;

  return { licenseId, issuedAt, tier: TIER_FULL };
}
