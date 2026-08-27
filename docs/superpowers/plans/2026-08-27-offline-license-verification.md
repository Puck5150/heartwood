# Offline License Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add offline, signature-verified license-key support to Heartwood — a paid-user check with no network call anywhere in the path, ever.

**Architecture:** A new dependency-free `src/lib/license.ts` module verifies an Ed25519-signed key string against a compiled-in public key. The raw key string is stored as one more field on the existing `AppSettings`/`SettingsController` machinery. `App.svelte` hydrates it at startup and derives `isPaidUser` reactively (re-verified, never cached as a boolean) for `SettingsDrawer.svelte` to render and let the user enter/replace a key.

**Tech Stack:** `@noble/ed25519` + `@noble/hashes` (signature verification, zero-dependency, no native/Rust build surface), Svelte 5 runes (`$state`, `$derived`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-offline-license-verification-design.md`

## Global Constraints

- No network call anywhere in the verification path — offline signature math only (spec "Approaches Considered #1").
- The private signing key is never generated, stored, or transmitted through this codebase or an assistant session (spec Acceptance Criteria #2). Only the public key is committed.
- `AppSettings.licenseKey` stores the raw signed key string, never a derived boolean (spec Acceptance Criteria #3).
- `isPaidUser` is derived fresh from `verifyLicenseKey()` every time it's needed — never read from a cached/persisted boolean (spec Acceptance Criteria #4).
- An invalid key entered in Settings shows an inline error and is **not** persisted. A previously-valid stored key that fails verification on a later launch fails **silently** to the free tier — no error banner (spec Acceptance Criteria #5).
- Tier byte `0x01` = Full version; any other tier byte is treated as invalid (spec "License Key Format").
- This plan builds the verification mechanism only. No existing feature is gated behind `isPaidUser` as part of this plan — deciding which features move behind it is a separate, later decision (spec "Rollout Note").

---

### Task 1: Add signature-verification dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `@noble/ed25519` and `@noble/hashes` available to import in later tasks.

- [ ] **Step 1: Install the packages**

Run: `npm install @noble/ed25519 @noble/hashes`

This resolves and pins current versions itself — don't hand-edit version numbers into `package.json`.

- [ ] **Step 2: Verify they installed as direct dependencies**

Run: `grep -E '"@noble/(ed25519|hashes)"' package.json`
Expected: both lines present under `"dependencies"`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @noble/ed25519 and @noble/hashes for offline license verification"
```

---

### Task 2: Core license verification module

**Files:**
- Create: `src/lib/license.ts`
- Create: `src/lib/license.testHelpers.ts` (test-only — never imported by production code)
- Create: `src/lib/license.test.ts`

**Interfaces:**
- Consumes: `@noble/ed25519`, `@noble/hashes` (Task 1).
- Produces: `export interface LicenseInfo { licenseId: string; issuedAt: number; tier: 1 }`, `export const HEARTWOOD_LICENSE_PUBLIC_KEY_HEX: string`, `export function verifyLicenseKey(key: string, publicKeyHex?: string): LicenseInfo | null` from `./license`. Task 3 imports nothing from here directly; Task 5 (`App.svelte`) and Task 6 (`SettingsDrawer.svelte`) both import `verifyLicenseKey`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/license.test.ts
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
```

```ts
// src/lib/license.testHelpers.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/license.test.ts`
Expected: FAIL — `Cannot find module './license'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/license.ts
//
// Offline license-key verification. Every check here is pure signature
// math against bytes already on disk — no network call anywhere in this
// module, ever. See docs/superpowers/specs/2026-08-27-offline-license-
// verification-design.md for the format and the reasoning.
//
// HEARTWOOD_LICENSE_PUBLIC_KEY_HEX below is a placeholder (32 zero
// bytes) and must be replaced with the real public key before any paid
// build ships. The private key that signs real licenses is generated
// and held by the maintainer outside this repository — the same
// custody discipline as the auto-updater's signing key (see the
// 2026-08-05 auto-updater spec's "Signing key custody"). It must never
// be generated or stored here, and never appears in this codebase, in
// CI, or in any assistant-authored file.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';

ed.hashes.sha512 = sha512;

export const HEARTWOOD_LICENSE_PUBLIC_KEY_HEX = '0'.repeat(64);

export interface LicenseInfo {
  licenseId: string;
  issuedAt: number;
  tier: 1;
}

const PAYLOAD_BYTES = 13; // 8-byte licenseId + 4-byte issuedAt (u32 BE) + 1-byte tier
const SIGNATURE_BYTES = 64;
const TIER_FULL = 1;

function base64UrlToBytes(input: string): Uint8Array | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
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
    isValid = ed.verify(signature, payload, publicKey);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/license.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/license.ts src/lib/license.testHelpers.ts src/lib/license.test.ts
git commit -m "feat: add offline Ed25519 license-key verification"
```

---

### Task 3: Add `licenseKey` to `AppSettings`

**Files:**
- Modify: `src/lib/appearance.ts:68-84` (interface), `:91-104` (`APP_SETTING_KEYS`), `:106-119` (`DEFAULT_APP_SETTINGS`), and add a new parser near `parseToneId` (`:224-226`)
- Modify: `src/lib/appearance.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AppSettings.licenseKey: string`, `APP_SETTING_KEYS.licenseKey === 'licenseKey'`, `DEFAULT_APP_SETTINGS.licenseKey === ''`, `export function parseLicenseKey(value: unknown): string`. Task 4 and Task 5 both consume `APP_SETTING_KEYS.licenseKey` and `parseLicenseKey`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/appearance.test.ts` (near the other `parse*` describe blocks):

```ts
describe('parseLicenseKey', () => {
  it.each([
    ['some-key-string', 'some-key-string'],
    ['', ''],
    [null, ''],
    [undefined, ''],
    [42, ''],
  ])('parses %p as %p', (input, expected) => {
    expect(parseLicenseKey(input)).toBe(expected);
  });

  it('defaults to an empty string, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.licenseKey).toBe('');
  });
});
```

Update the import line at the top of the file to include `parseLicenseKey` alongside the other imported parsers.

Also find the existing "exposes exactly the twelve persisted keys" completeness test (`appearance.test.ts:121-144`) and update both its description and its expected list/count to include `licenseKey` (thirteen keys).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/appearance.test.ts`
Expected: FAIL — `parseLicenseKey` is not exported, and the key-count test fails on the old count.

- [ ] **Step 3: Implement**

In `src/lib/appearance.ts`:

Add to the `AppSettings` interface (`:68-84`), as the last field:

```ts
  /** Raw signed license-key string, '' = no license entered. Never a
   * derived boolean — see license.ts for why. */
  licenseKey: string;
```

Add to `APP_SETTING_KEYS` (`:91-104`):

```ts
  licenseKey: 'licenseKey',
```

Add to `DEFAULT_APP_SETTINGS` (`:106-119`):

```ts
  licenseKey: '',
```

Add a new exported parser near `parseToneId` (`:224-226`):

```ts
export function parseLicenseKey(value: unknown): string {
  return typeof value === 'string' ? value : DEFAULT_APP_SETTINGS.licenseKey;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/appearance.test.ts`
Expected: PASS, including the updated key-count test.

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no new errors. (This will surface every other call site that constructs an `AppSettings` object without `licenseKey` — fix any such site by adding the field; Task 5 is expected to be the only one, but let the compiler confirm.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/appearance.ts src/lib/appearance.test.ts
git commit -m "feat: add licenseKey to AppSettings"
```

---

### Task 4: Wire `licenseKey` into `SettingsController`

**Files:**
- Modify: `src/lib/settingsController.svelte.ts:80-93` (`requestSequence`)
- Modify: `src/lib/settingsController.test.ts`

**Interfaces:**
- Consumes: `AppSettings.licenseKey`, `APP_SETTING_KEYS.licenseKey` (Task 3).
- Produces: `controller.set('licenseKey', value)` / `controller.retry('licenseKey')` work through the same write-queue/staleness machinery as every other setting. Task 6 consumes this via `controller.set`/`controller.errors.licenseKey`/`controller.retry`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/settingsController.test.ts`, mirroring the existing `focusWarningLeadMs` test (`:180-197`):

```ts
it('tracks the new licenseKey key through the same set/retry/staleness machinery as every other setting', async () => {
  const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
  const controller = createSettingsController({
    initial: DEFAULT_APP_SETTINGS,
    writeQueue: createTaskQueue(),
    persist,
  });

  controller.set('licenseKey', 'some-signed-key-string');
  await flushPromises();
  expect(controller.current.licenseKey).toBe('some-signed-key-string');
  expect(controller.errors.licenseKey).toBeTruthy();

  controller.retry('licenseKey');
  await flushPromises();
  expect(persist).toHaveBeenLastCalledWith('licenseKey', 'some-signed-key-string');
  expect(controller.errors.licenseKey).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/settingsController.test.ts`
Expected: FAIL — without a `licenseKey` entry in `requestSequence`, `persistCurrent()` throws or behaves incorrectly for this key (e.g. `TypeError` reading an undefined sequence number, or the staleness check silently misbehaves).

- [ ] **Step 3: Implement**

In `src/lib/settingsController.svelte.ts`, add to the `requestSequence` object literal (`:80-93`), alongside the other keys:

```ts
  licenseKey: 0,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/settingsController.test.ts`
Expected: PASS, including the new test and every pre-existing one (this file's full suite, not just the new case).

- [ ] **Step 5: Commit**

```bash
git add src/lib/settingsController.svelte.ts src/lib/settingsController.test.ts
git commit -m "feat: wire licenseKey through SettingsController's write queue"
```

---

### Task 5: Hydrate `licenseKey` and thread `isPaidUser` down to Settings

**Files:**
- Modify: `src/App.svelte` (hydration `Promise.all` at `:618-644`, `initialSettings` at `:646-659`, new `isPaidUser` derived value, and the `<AppShell ...>` call at `:2377-2386`)
- Modify: `src/lib/AppShell.svelte` (props type at `:11-31`, `<SettingsDrawer ...>` call at `:84-91`)

**Interfaces:**
- Consumes: `APP_SETTING_KEYS.licenseKey`, `parseLicenseKey` (Task 3), `verifyLicenseKey` (Task 2).
- Produces: a reactive `isPaidUser: boolean`, threaded `App.svelte` → `AppShell.svelte` → `SettingsDrawer.svelte`. Task 6 consumes it as a new `SettingsDrawer` prop.

`SettingsDrawer` isn't rendered directly by `App.svelte` — it's rendered inside `AppShell.svelte` (confirmed: `grep -rln SettingsDrawer src --include='*.svelte'` returns only `AppShell.svelte` outside the test file), which `App.svelte` renders via `<AppShell settings={settingsController} ...>`. `isPaidUser` has to cross both hops.

No new automated test for this task: it's thin hydration/threading glue with no independent logic of its own (the actual decision logic is `verifyLicenseKey`, already unit-tested in Task 2; the setting round-trip is already tested in Tasks 3-4). This mirrors the auto-updater plan's own precedent of not testing plugin-registration wiring that has no logic to test.

- [ ] **Step 1: Add `licenseKey` to the startup hydration**

In `src/App.svelte`, in the `Promise.all` destructure and array at `:618-644`, add `licenseKey` as the 13th entry in both the destructured `const [...]` list and the `Promise.all([...])` array, immediately after `pomodoroStreak` in each:

```ts
    const [
      themeFamily,
      appearanceMode,
      timerAccent,
      toneId,
      returnToneId,
      focusWarningLeadMs,
      touchGrassReminderThresholdMs,
      selectedSoundscapeId,
      soundscapeVolume,
      dismissedHints,
      timerProgressStyle,
      pomodoroStreak,
      licenseKey,
    ] = await Promise.all([
      getSetting(APP_SETTING_KEYS.themeFamily).catch(() => null),
      getSetting(APP_SETTING_KEYS.appearanceMode).catch(() => null),
      getSetting(APP_SETTING_KEYS.timerAccent).catch(() => null),
      getSetting(APP_SETTING_KEYS.selectedToneId).catch(() => null),
      getSetting(APP_SETTING_KEYS.selectedReturnToneId).catch(() => null),
      getSetting(APP_SETTING_KEYS.focusWarningLeadMs).catch(() => null),
      getSetting(APP_SETTING_KEYS.touchGrassReminderThresholdMs).catch(() => null),
      getSetting(APP_SETTING_KEYS.selectedSoundscapeId).catch(() => null),
      getSetting(APP_SETTING_KEYS.soundscapeVolume).catch(() => null),
      getSetting(APP_SETTING_KEYS.dismissedHints).catch(() => null),
      getSetting(APP_SETTING_KEYS.timerProgressStyle).catch(() => null),
      getSetting(APP_SETTING_KEYS.pomodoroStreak).catch(() => null),
      getSetting(APP_SETTING_KEYS.licenseKey).catch(() => null),
    ]);
```

- [ ] **Step 2: Add `licenseKey` to `initialSettings`**

In the `initialSettings: AppSettings` object literal at `:646-659`, add as the last field:

```ts
      licenseKey: parseLicenseKey(licenseKey),
```

Add `parseLicenseKey` to whatever existing `import { ... } from './lib/appearance'` line already imports the other `parse*` functions in this file.

- [ ] **Step 3: Derive `isPaidUser`**

`settingsController` is declared `let settingsController = $state<SettingsController | null>(null);` (`:219`) — nullable until `runStartup()` assigns it — so the derived value must guard for that. Import `verifyLicenseKey` from `./lib/license` at the top of `App.svelte`, and add near that declaration (top-level component script, not inside `runStartup()`):

```ts
  let isPaidUser = $derived(
    settingsController !== null && verifyLicenseKey(settingsController.current.licenseKey) !== null
  );
```

This is `$derived`, not computed once at startup — entering a valid key in Settings unlocks immediately, in the same session, with no restart, because it re-runs whenever `settingsController.current.licenseKey` changes.

- [ ] **Step 4: Thread it through `AppShell`**

In `src/lib/AppShell.svelte`, add `isPaidUser: boolean;` to the inline props type at `:11-31` (alongside `settings: SettingsController;`), and add `isPaidUser` to the destructured `let { ... } = $props();` list at the same location.

In that same file's `<SettingsDrawer ...>` call (`:84-91`), add the prop:

```svelte
    <SettingsDrawer
      controller={settings}
      {isPaidUser}
      {updateController}
      {showUpdateCheck}
      onClose={closeSettings}
      {onPreviewTone}
      onOpenHelp={() => (helpOpen = true)}
    />
```

- [ ] **Step 5: Pass it from `App.svelte` into `AppShell`**

In `src/App.svelte`'s `<AppShell ...>` call (`:2377-2386`), add the prop:

```svelte
    <AppShell
      currentWorkspace={workspaceView}
      showRevisions={workspaceView === 'revisions'}
      onNavigate={handleNavigate}
      settings={settingsController}
      {isPaidUser}
      {updateController}
      showUpdateCheck={!isIOSPlatform}
      onPreviewTone={handlePreviewTone}
      {railActions}
    >
```

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: fails until Task 6 adds `isPaidUser` to `SettingsDrawer`'s props — that's expected and resolved by the next task. If any *other* error appears, fix it now.

- [ ] **Step 7: Commit**

```bash
git add src/App.svelte src/lib/AppShell.svelte
git commit -m "feat: hydrate licenseKey and thread isPaidUser to Settings"
```

---

### Task 6: License-key UI in Settings

**Files:**
- Modify: `src/lib/SettingsDrawer.svelte` (props type at `:30-47`, new License section inserted before the `{#if showUpdateCheck}` Updates section at `:327`)
- Modify: `src/lib/SettingsDrawer.test.ts`

**Interfaces:**
- Consumes: `verifyLicenseKey` (Task 2), `isPaidUser` prop (Task 5), `controller.set`/`controller.errors.licenseKey`/`controller.retry` (Task 4, via the existing `SettingsController` already threaded into this component).
- Produces: nothing consumed by later tasks (final UI surface).

`SettingsDrawer.svelte` has no separate `interface Props` — its props are an inline object-literal type on the `let { ... }: {...} = $props();` destructure at `:30-47`. Every existing error uses the class `setting-error` (singular "setting") with the copy pattern `Not saved` + an inline `Retry <thing>` link-styled button — see the `themeFamily` block at `:152-157` for the exact precedent. `SettingsDrawer.test.ts` renders with a **flat** props object (`render(SettingsDrawer, { controller, ... })`, not `{ props: {...} }`), and already has a `realController(overrides)` helper (`:15-21`) for the common case and inline `createSettingsController({ ..., persist: vi.fn()... })` for the custom-mock-persist case (see `:157-172`) — both patterns are reused below rather than reinvented.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/SettingsDrawer.test.ts` (this file already imports `createSettingsController`, `createTaskQueue`, `DEFAULT_APP_SETTINGS` — no new imports needed):

```ts
// ...inside the existing `describe('SettingsDrawer', ...)` block:

it('shows the free-tier message when isPaidUser is false', () => {
  const controller = realController();
  render(SettingsDrawer, {
    updateController: fakeUpdateController(),
    controller,
    isPaidUser: false,
    onClose: vi.fn(),
    onPreviewTone: vi.fn(),
  });

  expect(screen.getByText(/free tier/i)).toBeTruthy();
});

it('shows the unlocked message when isPaidUser is true', () => {
  const controller = realController();
  render(SettingsDrawer, {
    updateController: fakeUpdateController(),
    controller,
    isPaidUser: true,
    onClose: vi.fn(),
    onPreviewTone: vi.fn(),
  });

  expect(screen.getByText(/full version unlocked/i)).toBeTruthy();
});

it('does not call persist while the key field is empty', () => {
  const persist = vi.fn().mockResolvedValue(undefined);
  const controller = createSettingsController({
    initial: DEFAULT_APP_SETTINGS,
    writeQueue: createTaskQueue(),
    persist,
  });
  render(SettingsDrawer, {
    updateController: fakeUpdateController(),
    controller,
    isPaidUser: false,
    onClose: vi.fn(),
    onPreviewTone: vi.fn(),
  });

  expect(persist).not.toHaveBeenCalled();
});

it('shows a validation error and does not save an invalid license key', async () => {
  const persist = vi.fn().mockResolvedValue(undefined);
  const controller = createSettingsController({
    initial: DEFAULT_APP_SETTINGS,
    writeQueue: createTaskQueue(),
    persist,
  });
  render(SettingsDrawer, {
    updateController: fakeUpdateController(),
    controller,
    isPaidUser: false,
    onClose: vi.fn(),
    onPreviewTone: vi.fn(),
  });

  await fireEvent.input(screen.getByLabelText('License key'), { target: { value: 'not-a-real-key' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Save license key' }));

  expect(screen.getByText(/isn't valid/i)).toBeTruthy();
  expect(persist).not.toHaveBeenCalled();
});
```

This file deliberately has no "saves a valid key and persists it" test: doing that here would require the component to verify against a test keypair rather than its compiled-in production public key, which means smuggling a test-only public-key override into production code just to make one UI test convenient. `license.test.ts` (Task 2) already fully covers what counts as a valid key; this file's job is UI wiring only — the empty-field and invalid-key tests above already exercise both branches of `submitLicenseKey()` that don't require a real signature (early-return-on-empty, and reject-on-invalid), which is everything this component's own logic needs covered.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/SettingsDrawer.test.ts`
Expected: FAIL — no license UI exists yet, `isPaidUser` isn't an accepted prop.

- [ ] **Step 3: Implement**

Add `isPaidUser: boolean;` to the inline props type at `:30-47` (alongside `controller: SettingsController;`), and add `isPaidUser` to the destructured `let { controller, updateController, onClose, onPreviewTone, onOpenHelp, showUpdateCheck = true }: {...} = $props();` list at the same location.

Add local script state and a submit handler near the top of the `<script>` block (after the existing imports):

```ts
  import { verifyLicenseKey } from './license';

  let licenseInput = $state(controller.current.licenseKey);
  let licenseValidationError = $state<string | null>(null);

  function submitLicenseKey() {
    const trimmed = licenseInput.trim();
    if (trimmed === '') {
      licenseValidationError = null;
      controller.set('licenseKey', '');
      return;
    }
    if (verifyLicenseKey(trimmed) === null) {
      licenseValidationError = "That license key isn't valid.";
      return;
    }
    licenseValidationError = null;
    controller.set('licenseKey', trimmed);
  }
```

Insert a new section into the template immediately before the existing `{#if showUpdateCheck}` Updates section (`:327`), matching the existing `.settings-section`/`.setting-error` conventions used by every section above it:

```svelte
    <section class="settings-section">
      <h3>License</h3>
      {#if isPaidUser}
        <p>Full version unlocked.</p>
      {:else}
        <p>Free tier. Enter a license key to unlock the full version.</p>
      {/if}
      <label for="license-key-input">License key</label>
      <input
        id="license-key-input"
        type="text"
        bind:value={licenseInput}
        placeholder="Paste your license key"
      />
      <button type="button" onclick={submitLicenseKey}>Save license key</button>
      {#if licenseValidationError}
        <p class="setting-error">{licenseValidationError}</p>
      {/if}
      {#if controller.errors.licenseKey}
        <p class="setting-error">
          Not saved
          <button type="button" class="link" onclick={() => controller.retry('licenseKey')}>Retry license key</button>
        </p>
      {/if}
    </section>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/SettingsDrawer.test.ts`
Expected: PASS, including the new tests and every pre-existing test in the file.

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors (this also resolves Task 5 Step 6's expected failure).

- [ ] **Step 6: Commit**

```bash
git add src/lib/SettingsDrawer.svelte src/lib/SettingsDrawer.test.ts
git commit -m "feat: add license key entry UI to Settings"
```

---

### Task 7: Full verification pass

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing (final gate).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including every new one from Tasks 2-6 and every pre-existing test in the repo (nothing regressed).

- [ ] **Step 2: Run the full typecheck**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 3: Confirm no real credential material was ever written**

Run: `grep -rn "PRIVATE" src/lib/license.ts src/lib/license.testHelpers.ts`
Expected: no match (the word "private" appears only in comments about custody, never as an actual embedded key). Manually re-read `license.ts`'s `HEARTWOOD_LICENSE_PUBLIC_KEY_HEX` constant and confirm it is still the all-zero placeholder — this line is the one that must be swapped by the maintainer, out-of-band, before any paid build ships.

- [ ] **Step 4: Commit**

Only if Steps 1-3 required any fixes — otherwise there's nothing to commit here.

```bash
git add -A
git commit -m "test: full verification pass for offline license verification"
```
