# Offline License Verification Design

**Status:** Proposed design
**Date:** 2026-08-27

## Purpose

Heartwood is free/ungated today — every feature (all soundscapes, notes,
export, session analytics) is available with no license check anywhere in
the codebase. `docs/product-brief.md` §18 ("Monetization Assumptions")
names a paid desktop license as the preferred later model and explicitly
rules out monetizing user behavior, notes, listening activity, or focus
history. `docs/architecture-review.md` (line 146) adds one constraint on
however that license check gets built: *"if a license-validation network
call is added later, an offline-verifiable key or a check-once-and-cache
model keeps it consistent with §11.2's 'optional, explicitly enabled,
revocable' requirement — avoid anything that phones home on every
launch."*

This spec is that mechanism: a signed license key the app verifies
entirely offline, matching the marketing site's already-published pricing
(`heartwood-web`: Free tier vs. $19 one-time "Full version", no
subscription, no accounts) and the product's own no-telemetry,
no-phone-home posture.

Scope: this spec covers **app-side verification only** — the key format,
storage, and gating logic inside `heartwood-app`. Issuing keys (the
Stripe checkout + signing service that generates a key after purchase) is
a separate, external system, out of scope here, for the same reason the
auto-updater spec (2026-08-05) treats signing-key custody as the
maintainer's own concern rather than something this repo implements.

## Approaches Considered

### 1. Ed25519-signed offline key, verified in the TS/Svelte layer (selected)

A compact string — `base64url(payload) + "." + base64url(signature)` —
containing a license ID, issue timestamp, and tier byte, signed with a
private key the maintainer holds outside this repository. The app ships
only the corresponding **public** key, compiled into the frontend bundle.
Verification is pure signature math against bytes already on disk: no
network call, ever, at any point after the user pastes the key in once.

Verification lives in a new dependency-free module
(`src/lib/license.ts`, mirroring `appearance.ts`'s pattern) using
`@noble/ed25519` (small, zero-dependency, audited, adds no native/Rust
build surface). It runs in the TS layer rather than the Rust backend for
the same reason `settingsController.svelte.ts` already owns validation
logic while Rust owns only storage: verification is pure computation, not
OS or filesystem access, so it doesn't need a Tauri command or IPC
round-trip.

### 2. Verify in the Rust backend (rejected)

Would need a new Tauri command (`verify_license`), a Rust Ed25519 crate,
and an IPC round-trip for every check — real added surface for no benefit,
since nothing about verification needs OS access. The only mild argument
for Rust is that a determined user reading the compiled JS bundle can find
the public key and the check logic more easily than compiled Rust — but
the public key is, by definition, safe to expose (that's the point of
asymmetric signing), and obscuring the check logic doesn't meaningfully
raise the bar against someone willing to patch a binary. Not worth the
IPC surface.

### 3. Check-once-and-cache against a license server (rejected)

Verify against a small hosted endpoint on first entry, cache a boolean
locally, never check again. Rejected in favor of Option 1: it still
requires a network call at least once (an offline-purchased or
gifted-key user could get stuck), and the cached boolean is exactly the
kind of trivially-editable local flag Option 1's re-verify-every-launch
approach is designed to avoid. Option 1 gets the same "check once,
mostly" cost profile with no network dependency at all.

## License Key Format

```
payload  = licenseId (8 random bytes) || issuedAt (4-byte u32 unix seconds) || tier (1 byte)
signature = Ed25519_sign(privateKey, payload)   // 64 bytes
key = base64url(payload) + "." + base64url(signature)
```

- **`tier`**: `0x01` = Full version (the only tier that exists today).
  Reserved, not `0x00`/unused, so a future paid-upgrade tier (§18's
  "optional paid major upgrades") can be added without changing the
  format — a new tier byte, a new verification-time comparison, no key
  format migration.
- ~110-character string. Not designed for hand-typing — delivered via
  email/receipt page for copy-paste, same assumption as every consumer
  license key of this shape.
- The **private** key that signs this never exists in this repository, in
  CI, or in any assistant-authored file or session — same custody
  discipline as the auto-updater's signing key (2026-08-05 spec,
  "Signing key custody"). Only the public key is committed, embedded as a
  constant in `src/lib/license.ts`.

## App-Side Storage

Extends the existing `AppSettings` shape in `src/lib/appearance.ts`
(`APP_SETTING_KEYS`, `DEFAULT_APP_SETTINGS`, per-key parse functions —
the same pattern every other setting already follows):

```ts
export interface AppSettings {
  // ...existing keys
  licenseKey: string; // raw key string, '' = unset. Never a derived boolean.
}
```

```ts
export const DEFAULT_APP_SETTINGS = Object.freeze({
  // ...existing defaults
  licenseKey: '',
});

export function parseLicenseKey(value: unknown): string {
  return typeof value === 'string' ? value : DEFAULT_APP_SETTINGS.licenseKey;
}
```

Storing the **raw signed string**, not a derived `isPaid: true/false`, is
the load-bearing decision here: a boolean in a local settings row is
trivially hand-edited; a signature is not forgeable without the private
key. Persistence goes through the existing `SettingsController` /
write-queue exactly like every other setting — no new storage mechanism.

## Verification

`src/lib/license.ts` (new, dependency-free except `@noble/ed25519`,
mirrors `appearance.ts`'s testable-in-isolation style):

```ts
export interface LicenseInfo {
  licenseId: string;
  issuedAt: number;
  tier: 1;
}

export function verifyLicenseKey(key: string): LicenseInfo | null;
```

Decodes both segments, verifies the signature against the compiled-in
public key, and returns `null` on any failure (malformed string, bad
base64url, signature mismatch, unrecognized tier byte) — one failure path,
no partial-trust states.

**Re-verified continuously**, not cached as a boolean: `runStartup()`
(the same function that hydrates every other setting from
`getSetting()`) reads the raw `licenseKey` string, and `isPaidUser` is a
reactive value derived from `verifyLicenseKey(licenseKey)` — recomputed
whenever the stored key changes, not just once at launch. This is what
actually defeats casually editing a stored flag (the check that matters
is repeated, not trusted from last time) and also means pasting a valid
key into Settings unlocks the app immediately, in the same session, with
no restart required.

## Gating

`isPaidUser` (derived, not persisted) gates: additional soundscapes beyond
the one free track, session analytics, export, and versioned history —
the exact feature list already on the pricing page
(`heartwood-web/src/pages/pricing.astro`). "Unlimited devices you own" is
**not** enforced anywhere — there is no device count to check without a
server, so it stays what it already is on the marketing site: an
honor-system claim, not a technical gate.

## Error Handling

- **Invalid key entered:** the Settings field shows an inline "That
  license key isn't valid" message, same visual language as an existing
  settings-write error (`SettingsController.errors`). The key is not
  persisted if it fails verification at entry time — no storing-then-
  failing-later for a key that was never valid.
- **Previously-valid key fails verification on a later launch** (e.g. a
  future version deprecates the public key, or the stored string was
  corrupted): silently falls back to the free tier for that launch — no
  error banner, no interruption, consistent with the auto-updater's own
  "a failed background check is silent" precedent. The user's entered key
  string is left untouched in settings; nothing auto-clears it.
- **No revocation path.** Fully offline verification means no live revoke.
  A refund is handled operationally (the `licenseId` can be added to a
  small hardcoded blocklist shipped in a future app update, the standard
  compromise for offline-verified consumer licenses) — not designed here,
  since it's a rare-path maintainer action, not a feature.

## Testing

- `license.test.ts`: unit tests using a **test keypair** generated in the
  test file itself (never the real one) — valid key round-trips, tampered
  payload rejected, tampered signature rejected, malformed/truncated
  string rejected, wrong tier byte rejected. Pure function, no Tauri
  mocking needed, same style as `appearance.test.ts`.
- `settingsController.test.ts`: extended with `licenseKey` alongside the
  other keys it already round-trips through the fake write queue — no new
  test pattern, just one more key.
- No Rust-side changes, so no new Rust tests.

## Rollout Note

Every existing install is already fully unlocked with no license concept
at all. Shipping this update does **not** retroactively lock anything for
current testers — `isPaidUser` only ever gates features added *after*
this lands, or the app explicitly chooses to gate existing features going
forward as a separate product decision. This spec only builds the
verification mechanism; deciding which features move behind it (beyond
the pricing page's already-published list) is out of scope here.

## Acceptance Criteria

1. `src/lib/license.ts` verifies a correctly-signed key and rejects any
   tampered payload, tampered signature, or malformed string, with no
   network call anywhere in the path.
2. The public key is the only cryptographic material committed to this
   repository; the private key is never generated, stored, or transmitted
   through this codebase or an assistant session.
3. `AppSettings.licenseKey` stores the raw key string (not a boolean) and
   round-trips through the existing `SettingsController` write queue like
   every other setting.
4. `isPaidUser` is a reactive value derived fresh from `verifyLicenseKey()`
   whenever the stored `licenseKey` changes (starting from hydration in
   `runStartup()`) — never read from a cached/stored boolean, and never
   requiring a restart to reflect a newly entered key.
5. An invalid key entered in Settings shows an inline error and is not
   persisted; a previously-valid key that fails on a later launch fails
   silently to the free tier with no error banner.
6. Gating covers exactly the paid feature list already published on
   `heartwood-web`'s pricing page (soundscapes beyond the first, session
   analytics, export, versioned history) — "unlimited devices" remains
   unenforced by design.
