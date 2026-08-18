# Beta Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the alpha release tier and stand up a beta tier that ships the same unsigned desktop matrix plus a signed Android APK, through one CI workflow, with all supporting docs/scripts/tests renamed and extended to match.

**Architecture:** `release-alpha.yml` is adapted in place (renamed, retagged, given a new parallel Android build job) rather than duplicated. A new Gradle `signingConfigs` block in the already-committed `src-tauri/gen/android/app/build.gradle.kts` reads four CI-only secrets and produces a signed release APK; the same block is a no-op (unsigned output, as today) when those env vars are absent, so local `tauri android build` still works untouched. `scripts/prepareAlphaAssets.mjs` becomes `scripts/prepareBetaAssets.mjs` and gains `.apk` as a fifth *required* artifact kind, so a release without a working Android build fails closed exactly like a release missing a desktop installer does today. Every doc, issue template, and the exhaustive `scripts/githubAutomation.test.ts` structural test suite move in lockstep.

**Tech Stack:** GitHub Actions, Node.js/vitest, Gradle/Kotlin DSL, Tauri 2 CLI, Android SDK/NDK, `keytool`/`apksigner` (Android build-tools).

**Spec:** `docs/superpowers/specs/2026-08-18-beta-release-design.md`

## Global Constraints

- Beta **replaces** alpha — no more alpha tags are cut after this ships. There is exactly one active release tier at a time; the workflow does not need to support both.
- Tag pattern: `v*-beta.*` (e.g. `v0.1.0-beta.1`). Version bumping the actual repo files to `0.1.0-beta.1` and cutting the tag happens *after* this plan, when the release is actually cut — no task here changes `package.json`/`package-lock.json`/`src-tauri/tauri.conf.json`/`src-tauri/Cargo.toml`/`src-tauri/Cargo.lock`'s version fields.
- All artifacts stay unsigned/self-signed: macOS ad-hoc codesign only, Windows unsigned, Android signed with a dedicated CI-only keystore (never a Play Store key, never committed).
- Android ships `arm64-v8a` only (`--target aarch64`).
- No Android auto-update in this phase — the existing desktop Tauri updater is untouched by every task below.
- `src-tauri/gen/android/.gitignore` already excludes `*.keystore` and `*.jks` — no task should ever `git add` a keystore file.
- Every renamed file keeps its git history: use `git mv`, not delete+recreate.

---

## Task 1: `releaseVersion.mjs` accepts beta tags

**Files:**
- Modify: `scripts/releaseVersion.mjs`
- Modify: `scripts/releaseVersion.test.ts`

**Interfaces:**
- Produces: `normalizeBetaTag(tag: string): string` (replaces `normalizeAlphaTag`, same signature/behavior, exported from `scripts/releaseVersion.mjs`).
- Consumes: nothing new.

- [ ] **Step 1: Update the failing tests first**

Edit `scripts/releaseVersion.test.ts`:

```ts
// old
import {
  assertVersionAgreement,
  normalizeAlphaTag,
  readRepositoryVersions,
} from './releaseVersion.mjs';
```
```ts
// new
import {
  assertVersionAgreement,
  normalizeBetaTag,
  readRepositoryVersions,
} from './releaseVersion.mjs';
```

```ts
// old
  it('normalizes only an alpha release tag', () => {
    expect(normalizeAlphaTag('v0.1.0-alpha.1')).toBe('0.1.0-alpha.1');
    expect(() => normalizeAlphaTag('0.1.0-alpha.1')).toThrow(/must start with v/i);
    expect(() => normalizeAlphaTag('v0.1.0')).toThrow(/alpha/i);
  });
```
```ts
// new
  it('normalizes only a beta release tag', () => {
    expect(normalizeBetaTag('v0.1.0-beta.1')).toBe('0.1.0-beta.1');
    expect(() => normalizeBetaTag('0.1.0-beta.1')).toThrow(/must start with v/i);
    expect(() => normalizeBetaTag('v0.1.0')).toThrow(/beta/i);
  });
```

```ts
// old (inside 'requires every version source and the tag to agree')
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
```
```ts
// new
    const versions = {
      packageVersion: '0.1.0-beta.1',
      packageLockVersion: '0.1.0-beta.1',
      packageLockRootVersion: '0.1.0-beta.1',
      tauriVersion: '0.1.0-beta.1',
      cargoVersion: '0.1.0-beta.1',
      cargoLockVersion: '0.1.0-beta.1',
    };
    expect(assertVersionAgreement(versions, 'v0.1.0-beta.1')).toBe('0.1.0-beta.1');
    expect(() =>
      assertVersionAgreement({ ...versions, packageVersion: '0.1.0' }, 'v0.1.0-beta.1'),
    ).toThrow(/version mismatch/i);
```

Leave every other test in this file untouched — `'keeps checked-in release metadata aligned'` reads `package.json`'s real version dynamically, and the four lockfile-mismatch tests never pass a tag argument at all.

- [ ] **Step 2: Run the test file to confirm it now fails**

Run: `npx vitest run scripts/releaseVersion.test.ts`
Expected: FAIL — `normalizeBetaTag` is not exported yet.

- [ ] **Step 3: Update the implementation**

Edit `scripts/releaseVersion.mjs`:

```js
// old
const ALPHA_TAG = /^v(\d+\.\d+\.\d+)-alpha\.\d+$/;
```

Wait — re-check the real regex before editing (it captures the numeric prerelease group differently than shown above); use this exact replacement pair instead:

```js
// old
const ALPHA_TAG = /^v(\d+\.\d+\.\d+-alpha\.\d+)$/;

export function normalizeAlphaTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const match = ALPHA_TAG.exec(tag);
  if (!match) throw new Error('Release tag must use vX.Y.Z-alpha.N.');
  return match[1];
}
```
```js
// new
const BETA_TAG = /^v(\d+\.\d+\.\d+-beta\.\d+)$/;

export function normalizeBetaTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const match = BETA_TAG.exec(tag);
  if (!match) throw new Error('Release tag must use vX.Y.Z-beta.N.');
  return match[1];
}
```

```js
// old
  if (tag && normalizeAlphaTag(tag) !== values[0]) {
```
```js
// new
  if (tag && normalizeBetaTag(tag) !== values[0]) {
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `npx vitest run scripts/releaseVersion.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add scripts/releaseVersion.mjs scripts/releaseVersion.test.ts
git commit -m "feat: accept beta release tags in version agreement check"
```

---

## Task 2: `buildUpdaterManifest.mjs` accepts beta tags

**Files:**
- Modify: `scripts/buildUpdaterManifest.mjs`
- Modify: `scripts/buildUpdaterManifest.test.ts`

**Interfaces:**
- Produces: unchanged public API (`classifyUpdaterSignature`, `updaterSignatureFiles`, `buildUpdaterManifest`) — only the internal tag regex/normalizer and its error text change. `normalizeAlphaTag` here is a *private, unexported* function (this file deliberately does not import `releaseVersion.mjs`, per its own comment, to avoid an npm dependency at release time) — rename it to `normalizeBetaTag` for consistency with Task 1, but it stays unexported.

- [ ] **Step 1: Update the failing test first**

`scripts/buildUpdaterManifest.test.ts` has these literal version strings (confirmed via `grep -n "alpha" scripts/buildUpdaterManifest.test.ts`): `'0.1.0-alpha.4'` (5 occurrences) and `'v0.1.0-alpha.4'` (5 occurrences), all naming the same fixture version. Replace every occurrence of `0.1.0-alpha.4` with `0.1.0-beta.4` throughout the file (this covers both the bare and `v`-prefixed forms since it's a substring replace). No other content in this file changes.

- [ ] **Step 2: Run the test file to confirm it now fails**

Run: `npx vitest run scripts/buildUpdaterManifest.test.ts`
Expected: FAIL — the CLI invocation tests (e.g. `execFileAsync(process.execPath, [script, dir, 'v0.1.0-beta.4', 'https://example.test'])`) now pass a beta tag into a script that still only accepts `-alpha.` tags, so `normalizeAlphaTag` throws and the test's expectations on `latest.json` output no longer match.

- [ ] **Step 3: Update the implementation**

Edit `scripts/buildUpdaterManifest.mjs`:

```js
// old
const ALPHA_TAG = /^v(\d+\.\d+\.\d+-alpha\.\d+)$/;

function normalizeAlphaTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const match = ALPHA_TAG.exec(tag);
  if (!match) throw new Error('Release tag must use vX.Y.Z-alpha.N.');
  return match[1];
}
```
```js
// new
const BETA_TAG = /^v(\d+\.\d+\.\d+-beta\.\d+)$/;

function normalizeBetaTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const match = BETA_TAG.exec(tag);
  if (!match) throw new Error('Release tag must use vX.Y.Z-beta.N.');
  return match[1];
}
```

```js
// old (inside runCli)
  const version = normalizeAlphaTag(tag);
  // Zero signatures means signing simply isn't configured yet (the two
  // GitHub secrets are absent), which docs/alpha-testing.md promises is a
  // no-op rather than a failure. A *partial* set is still a real
  // misconfiguration and still throws below.
```
```js
// new
  const version = normalizeBetaTag(tag);
  // Zero signatures means signing simply isn't configured yet (the two
  // GitHub secrets are absent), which docs/beta-testing.md promises is a
  // no-op rather than a failure. A *partial* set is still a real
  // misconfiguration and still throws below.
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `npx vitest run scripts/buildUpdaterManifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/buildUpdaterManifest.mjs scripts/buildUpdaterManifest.test.ts
git commit -m "feat: accept beta release tags in updater manifest builder"
```

---

## Task 3: `prepareBetaAssets.mjs` — rename and add Android as a required artifact

**Files:**
- Create (via `git mv`): `scripts/prepareBetaAssets.mjs` (from `scripts/prepareAlphaAssets.mjs`)
- Create (via `git mv`): `scripts/prepareBetaAssets.test.ts` (from `scripts/prepareAlphaAssets.test.ts`)

**Interfaces:**
- Produces: `collectBetaArtifacts(inputDir): Promise<Artifact[]>` and `prepareBetaAssets(inputDir, outputDir): Promise<string[]>` (renamed from `collectAlphaArtifacts`/`prepareAlphaAssets`, same behavior plus a new required `.apk` → `'android'` kind).
- Consumes: `classifyUpdaterSignature` from `./buildUpdaterManifest.mjs` (Task 2 already renamed that file's *internal* tag logic, not this export — no change needed to the import).

- [ ] **Step 1: Rename both files, preserving history**

```bash
git mv scripts/prepareAlphaAssets.mjs scripts/prepareBetaAssets.mjs
git mv scripts/prepareAlphaAssets.test.ts scripts/prepareBetaAssets.test.ts
```

- [ ] **Step 2: Update the test file first (still red until Step 4)**

Edit `scripts/prepareBetaAssets.test.ts`:

```ts
// old
import { collectAlphaArtifacts, prepareAlphaAssets } from './prepareAlphaAssets.mjs';
```
```ts
// new
import { collectBetaArtifacts, prepareBetaAssets } from './prepareBetaAssets.mjs';
```

```ts
// old
const names = [
  'Heartwood_0.1.0-alpha.1_universal.dmg',
  'Heartwood_0.1.0-alpha.1_x64-setup.exe',
  'heartwood_0.1.0-alpha.1_amd64.AppImage',
  'heartwood_0.1.0-alpha.1_amd64.deb',
];
```
```ts
// new
const names = [
  'Heartwood_0.1.0-beta.1_universal.dmg',
  'Heartwood_0.1.0-beta.1_x64-setup.exe',
  'heartwood_0.1.0-beta.1_amd64.AppImage',
  'heartwood_0.1.0-beta.1_amd64.deb',
  'heartwood_0.1.0-beta.1_universal.apk',
];
```

```ts
// old
async function writeCompleteSet(input: string) {
  const locations = ['mac/deep', 'windows', 'linux/appimage', 'linux/deb'];
```
```ts
// new
async function writeCompleteSet(input: string) {
  const locations = ['mac/deep', 'windows', 'linux/appimage', 'linux/deb', 'android'];
```

```ts
// old
  'latest.json': '{"version":"0.1.0-alpha.4","platforms":{}}',
```
```ts
// new
  'latest.json': '{"version":"0.1.0-beta.4","platforms":{}}',
```

```ts
// old
describe('alpha release assets', () => {
  it('recursively collects exactly one artifact of each required kind', async () => {
    const { input } = await fixture();
    await writeCompleteSet(input);

    const artifacts = await collectAlphaArtifacts(input);

    expect(
      artifacts.map(({ filename, kind }) => ({ filename, kind })).sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual(
      [
        { filename: names[0], kind: 'macos' },
        { filename: names[1], kind: 'windows' },
        { filename: names[2], kind: 'linux-appimage' },
        { filename: names[3], kind: 'linux-deb' },
      ].sort((a, b) => a.kind.localeCompare(b.kind)),
    );
  });
```
```ts
// new
describe('beta release assets', () => {
  it('recursively collects exactly one artifact of each required kind', async () => {
    const { input } = await fixture();
    await writeCompleteSet(input);

    const artifacts = await collectBetaArtifacts(input);

    expect(
      artifacts.map(({ filename, kind }) => ({ filename, kind })).sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual(
      [
        { filename: names[0], kind: 'macos' },
        { filename: names[1], kind: 'windows' },
        { filename: names[2], kind: 'linux-appimage' },
        { filename: names[3], kind: 'linux-deb' },
        { filename: names[4], kind: 'android' },
      ].sort((a, b) => a.kind.localeCompare(b.kind)),
    );
  });
```

```ts
// old
    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(
      /missing required artifact kinds: windows, linux-appimage, linux-deb/i,
    );
```
```ts
// new
    await expect(prepareBetaAssets(input, output)).rejects.toThrow(
      /missing required artifact kinds: windows, linux-appimage, linux-deb, android/i,
    );
```

Every remaining occurrence of `prepareAlphaAssets(` in this file becomes `prepareBetaAssets(` (mechanical, same arguments each time — apply to all remaining call sites in the file, there is no behavioral difference at any of those call sites). Every remaining occurrence of the literal path string `'scripts/prepareAlphaAssets.mjs'` (the two CLI-invocation tests) becomes `'scripts/prepareBetaAssets.mjs'`.

- [ ] **Step 3: Run the test file to confirm it now fails**

Run: `npx vitest run scripts/prepareBetaAssets.test.ts`
Expected: FAIL — `prepareBetaAssets`/`collectBetaArtifacts` aren't exported by that name yet, and `.apk` isn't a recognized suffix yet.

- [ ] **Step 4: Update the implementation**

Edit `scripts/prepareBetaAssets.mjs`:

```js
// old
const REQUIRED = new Map([
  ['.dmg', 'macos'],
  ['.exe', 'windows'],
  ['.AppImage', 'linux-appimage'],
  ['.deb', 'linux-deb'],
]);
```
```js
// new
const REQUIRED = new Map([
  ['.dmg', 'macos'],
  ['.exe', 'windows'],
  ['.AppImage', 'linux-appimage'],
  ['.deb', 'linux-deb'],
  ['.apk', 'android'],
]);
```

```js
// old
export async function collectAlphaArtifacts(inputDir) {
```
```js
// new
export async function collectBetaArtifacts(inputDir) {
```

```js
// old
export async function prepareAlphaAssets(inputDir, outputDir) {
  await assertSeparateDirectories(inputDir, outputDir);
  const artifacts = await collectAlphaArtifacts(inputDir);
```
```js
// new
export async function prepareBetaAssets(inputDir, outputDir) {
  await assertSeparateDirectories(inputDir, outputDir);
  const artifacts = await collectBetaArtifacts(inputDir);
```

```js
// old
async function runCli() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error('Usage: node scripts/prepareAlphaAssets.mjs <download-dir> <release-dir>');
  }
  const filenames = await prepareAlphaAssets(args[0], args[1]);
```
```js
// new
async function runCli() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error('Usage: node scripts/prepareBetaAssets.mjs <download-dir> <release-dir>');
  }
  const filenames = await prepareBetaAssets(args[0], args[1]);
```

- [ ] **Step 5: Run the test file to confirm it passes**

Run: `npx vitest run scripts/prepareBetaAssets.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/prepareBetaAssets.mjs scripts/prepareBetaAssets.test.ts
git commit -m "feat: require an Android APK as a beta release artifact"
```

---

## Task 4: Generate the dedicated Android beta-signing keystore

This is an operational task, not a code change — it produces the secret material Task 5 and Task 6 depend on. It has no automated test; verification is `keytool`/`apksigner` output inspection.

**Files:** none in the repository (the keystore must never be committed — `src-tauri/gen/android/.gitignore` already blocks `*.keystore`/`*.jks`).

- [ ] **Step 1: Generate a fresh keystore outside the repository**

```bash
mkdir -p ~/.android-keys
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
"$JAVA_HOME/bin/keytool" -genkeypair -v \
  -keystore ~/.android-keys/heartwood-beta-release.keystore \
  -alias heartwood-beta \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Heartwood, OU=Release, O=Heartwood, L=Unknown, ST=Unknown, C=US"
```

This prompts twice for a keystore password and once for a key password (they may be the same value) — use a real generated password from a password manager, not a placeholder like the throwaway one used for local testing earlier. Record the keystore password, key alias (`heartwood-beta`), and key password somewhere durable (password manager) — losing them means a future beta can never be signed with the same identity again, which breaks upgrade continuity for anyone who already installed a beta.

- [ ] **Step 2: Verify the keystore**

```bash
"$JAVA_HOME/bin/keytool" -list -v -keystore ~/.android-keys/heartwood-beta-release.keystore -alias heartwood-beta
```

Expected: prints the certificate details (owner `CN=Heartwood, OU=Release, O=Heartwood, L=Unknown, ST=Unknown, C=US`, RSA 2048, SHA256withRSA) after the keystore password is entered. Confirm there is exactly one alias listed.

- [ ] **Step 3: Base64-encode it for the GitHub secret**

```bash
base64 -i ~/.android-keys/heartwood-beta-release.keystore -o ~/.android-keys/heartwood-beta-release.keystore.b64
```

- [ ] **Step 4: Add the four GitHub Actions secrets**

This step changes shared repository state — confirm with the repository owner before running it, or run it yourself if you are the owner:

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < ~/.android-keys/heartwood-beta-release.keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --body "<the keystore password from Step 1>"
gh secret set ANDROID_KEY_ALIAS --body "heartwood-beta"
gh secret set ANDROID_KEY_PASSWORD --body "<the key password from Step 1>"
gh secret list
```

Expected: `gh secret list` shows all four new secrets alongside the existing `RELEASE_SETTINGS_TOKEN` and `TAURI_SIGNING_PRIVATE_KEY`.

- [ ] **Step 5: Delete the local plaintext copies**

```bash
rm ~/.android-keys/heartwood-beta-release.keystore.b64
```

Keep `~/.android-keys/heartwood-beta-release.keystore` itself only if you want a local backup outside the repository (recommended — store it in a password manager or encrypted volume, since it cannot be regenerated identically). Never move it into the repository directory.

No commit — nothing in the git working tree changes in this task.

---

## Task 5: Wire Android release signing into Gradle

**Files:**
- Modify: `src-tauri/gen/android/app/build.gradle.kts`

**Interfaces:**
- Consumes (at build time, via `System.getenv`): `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Note this is `ANDROID_KEYSTORE_PATH` (a filesystem path), not the `ANDROID_KEYSTORE_BASE64` secret from Task 4 — Task 6's CI job decodes the secret to a file and exports its path under this name before invoking the build.
- Produces: when all four env vars are non-empty, `buildTypes.release` is signed and Gradle's normal output naming drops the `-unsigned` suffix (`app-universal-release.apk` instead of `app-universal-release-unsigned.apk`). When any are absent, behavior is unchanged from today (unsigned release output), so this task cannot break local `tauri android build` runs that have never set these variables.

- [ ] **Step 1: Edit the Gradle file**

Edit `src-tauri/gen/android/app/build.gradle.kts`:

```kotlin
// old
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
```
```kotlin
// new
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// CI-only release signing: absent locally, so a developer running
// `tauri android build` without these set still gets today's unsigned
// output rather than a confusing Gradle failure about a missing keystore.
val androidKeystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")
val androidKeystorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val androidKeyAlias: String? = System.getenv("ANDROID_KEY_ALIAS")
val androidKeyPassword: String? = System.getenv("ANDROID_KEY_PASSWORD")
val hasReleaseSigningEnv =
    !androidKeystorePath.isNullOrEmpty() &&
        !androidKeystorePassword.isNullOrEmpty() &&
        !androidKeyAlias.isNullOrEmpty() &&
        !androidKeyPassword.isNullOrEmpty()
```

```kotlin
// old
    buildTypes {
        getByName("debug") {
```
```kotlin
// new
    signingConfigs {
        if (hasReleaseSigningEnv) {
            create("release") {
                storeFile = file(androidKeystorePath!!)
                storePassword = androidKeystorePassword
                keyAlias = androidKeyAlias
                keyPassword = androidKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
```

```kotlin
// old
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
```
```kotlin
// new
        getByName("release") {
            isMinifyEnabled = true
            if (hasReleaseSigningEnv) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
```

- [ ] **Step 2: Verify unsigned behavior is unchanged (no env vars set)**

```bash
cd src-tauri/gen/android
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
cd ../../..
npx tauri android build --target aarch64
ls src-tauri/gen/android/app/build/outputs/apk/universal/release/
```

Expected: `app-universal-release-unsigned.apk` is produced, same as before this task — confirms the `hasReleaseSigningEnv` guard correctly falls back when the env vars are unset.

- [ ] **Step 3: Verify signed behavior (env vars set, using a throwaway local keystore)**

Reuse the existing local test keystore created earlier this session — it is not the real beta-signing key from Task 4, it only proves the Gradle wiring works:

```bash
export ANDROID_KEYSTORE_PATH="$(pwd)/src-tauri/gen/android/heartwood-release.keystore"
export ANDROID_KEYSTORE_PASSWORD="heartwood123"
export ANDROID_KEY_ALIAS="heartwood"
export ANDROID_KEY_PASSWORD="heartwood123"
npx tauri android build --target aarch64
ls src-tauri/gen/android/app/build/outputs/apk/universal/release/
```

Expected: `app-universal-release.apk` (no `-unsigned` suffix) is produced. Verify it's actually signed:

```bash
"$ANDROID_HOME/build-tools/34.0.0/apksigner" verify src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk && echo "VERIFIED OK"
```

Expected: `VERIFIED OK`.

- [ ] **Step 4: Unset the throwaway env vars**

```bash
unset ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/gen/android/app/build.gradle.kts
git commit -m "feat: sign Android release builds when CI signing env is present"
```

---

## Task 6: Rename and extend the release workflow

**Files:**
- Create (via `git mv`): `.github/workflows/release-beta.yml` (from `.github/workflows/release-alpha.yml`)
- Modify: `scripts/githubAutomation.test.ts` (the `'publishes only a complete tag-triggered alpha matrix'` test)

**Interfaces:**
- Produces: a `build-android` job (new) alongside the existing `build` job, both required by `release`.
- Consumes: Task 3's `scripts/prepareBetaAssets.mjs` CLI, Task 4's four `ANDROID_*` secrets, Task 5's Gradle signing wiring.

- [ ] **Step 1: Rename the workflow file**

```bash
git mv .github/workflows/release-alpha.yml .github/workflows/release-beta.yml
```

- [ ] **Step 2: Update the workflow's identity and trigger**

Edit `.github/workflows/release-beta.yml`:

```yaml
# old
name: Alpha release

on:
  push:
    tags: ['v*-alpha.*']
```
```yaml
# new
name: Beta release

on:
  push:
    tags: ['v*-beta.*']
```

- [ ] **Step 3: Add the `build-android` job**

Insert a new job after the existing `build:` job (i.e. between the closing of `build:`'s steps and the `release:` job), so the file reads `preflight` → `validate` → `build` → `build-android` → `release`:

```yaml
  build-android:
    needs: validate
    permissions:
      contents: read
    runs-on: ubuntu-22.04
    steps:
      - name: Check out repository
        uses: actions/checkout@v7

      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version: '24'
          cache: npm

      - name: Set up JDK
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Set up Android SDK
        uses: android-actions/setup-android@v3

      - name: Install Android SDK packages
        run: sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.0.12077973"

      - name: Set up Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-linux-android

      - name: Cache Rust build
        uses: swatinem/rust-cache@v2
        with:
          workspaces: ./src-tauri -> target

      - name: Install JavaScript dependencies
        run: npm ci

      - name: Check release tag and version agreement
        shell: bash
        run: node scripts/releaseVersion.mjs "$GITHUB_REF_NAME"

      - name: Decode Android signing keystore
        env:
          ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
        run: echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$RUNNER_TEMP/heartwood-beta-release.keystore"

      - name: Build Android release APK
        env:
          ANDROID_KEYSTORE_PATH: ${{ runner.temp }}/heartwood-beta-release.keystore
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: npx tauri android build --target aarch64

      - name: Upload Android release artifact
        uses: actions/upload-artifact@v7
        with:
          name: android-aarch64-apk
          path: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
          if-no-files-found: error
```

- [ ] **Step 4: Make `release` depend on both build jobs and prepare beta assets**

```yaml
# old
  release:
    needs: build
```
```yaml
# new
  release:
    needs: [build, build-android]
```

```yaml
# old
      - name: Validate and prepare release assets
        run: node scripts/prepareAlphaAssets.mjs release-artifacts release-assets
```
```yaml
# new
      - name: Validate and prepare release assets
        run: node scripts/prepareBetaAssets.mjs release-artifacts release-assets
```

The `release` job's existing `Download native installers` step (`actions/download-artifact@v8` with `pattern: '*-*-*'`, `merge-multiple: true`) already matches the new `android-aarch64-apk` artifact name (it satisfies the `*-*-*` glob) — no change needed there; it will download the desktop platform artifacts and the Android APK into the same flat `release-artifacts` directory, which `prepareBetaAssets.mjs` (Task 3) now expects to contain five required kinds instead of four.

- [ ] **Step 5: Rename the release-notes template reference**

```yaml
# old
      - name: Render commit-pinned release notes
        run: |
          sed "s/__RELEASE_COMMIT_SHA__/$GITHUB_SHA/g" \
            docs/alpha-release-notes.md > "$RUNNER_TEMP/alpha-release-notes.md"
          grep -q "$GITHUB_SHA" "$RUNNER_TEMP/alpha-release-notes.md"
          if grep -q '__RELEASE_COMMIT_SHA__' "$RUNNER_TEMP/alpha-release-notes.md"; then
            echo "::error::Release notes contain an unresolved commit placeholder."
            exit 1
          fi
```
```yaml
# new
      - name: Render commit-pinned release notes
        run: |
          sed "s/__RELEASE_COMMIT_SHA__/$GITHUB_SHA/g" \
            docs/beta-release-notes.md > "$RUNNER_TEMP/beta-release-notes.md"
          grep -q "$GITHUB_SHA" "$RUNNER_TEMP/beta-release-notes.md"
          if grep -q '__RELEASE_COMMIT_SHA__' "$RUNNER_TEMP/beta-release-notes.md"; then
            echo "::error::Release notes contain an unresolved commit placeholder."
            exit 1
          fi
```

(`docs/beta-release-notes.md` doesn't exist yet — Task 8 creates it. This workflow file is not executed by any test in this task, only structurally parsed, so the forward reference is fine.)

```yaml
# old
          gh release create "$GITHUB_REF_NAME" release-assets/* \
            --verify-tag \
            --prerelease \
            --title "Heartwood $GITHUB_REF_NAME" \
            --notes-file "$RUNNER_TEMP/alpha-release-notes.md"
```
```yaml
# new
          gh release create "$GITHUB_REF_NAME" release-assets/* \
            --verify-tag \
            --prerelease \
            --title "Heartwood $GITHUB_REF_NAME" \
            --notes-file "$RUNNER_TEMP/beta-release-notes.md"
```

- [ ] **Step 6: Update the structural test to match**

Edit `scripts/githubAutomation.test.ts`. Rename the whole test and update its assertions:

```ts
// old
  it('publishes only a complete tag-triggered alpha matrix', () => {
    const release = workflow('release-alpha.yml');

    expect(Object.keys(release.on)).toEqual(['push']);
    expect(release.on.push).toEqual({ tags: ['v*-alpha.*'] });
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(release.jobs)).toEqual([
      'preflight',
      'validate',
      'build',
      'release',
    ]);
```
```ts
// new
  it('publishes only a complete tag-triggered beta matrix', () => {
    const release = workflow('release-beta.yml');

    expect(Object.keys(release.on)).toEqual(['push']);
    expect(release.on.push).toEqual({ tags: ['v*-beta.*'] });
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(release.jobs)).toEqual([
      'preflight',
      'validate',
      'build',
      'build-android',
      'release',
    ]);
```

Immediately after the existing `build` job assertions block (everything from `const build = release.jobs.build;` through the `expect(serializedBuild).not.toMatch(...)` line — leave that whole block untouched, the desktop matrix job itself doesn't change), insert new assertions for the Android job before `const releaseJob = release.jobs.release;`:

```ts
    const buildAndroid = release.jobs['build-android'];
    expect(buildAndroid.needs).toBe('validate');
    expect(buildAndroid.permissions).toEqual({ contents: 'read' });
    expect(buildAndroid['runs-on']).toBe('ubuntu-22.04');

    const androidSteps = buildAndroid.steps as WorkflowStep[];
    expect(androidSteps.map((step) => step.uses ?? step.run)).toEqual([
      'actions/checkout@v7',
      'actions/setup-node@v6',
      'actions/setup-java@v4',
      'android-actions/setup-android@v3',
      expect.stringContaining('sdkmanager'),
      'dtolnay/rust-toolchain@stable',
      'swatinem/rust-cache@v2',
      'npm ci',
      'node scripts/releaseVersion.mjs "$GITHUB_REF_NAME"',
      expect.stringContaining('base64 -d'),
      'npx tauri android build --target aarch64',
      'actions/upload-artifact@v7',
    ]);
    expect(androidSteps[2].with).toEqual({ distribution: 'temurin', 'java-version': '17' });
    expect(androidSteps[5].with).toEqual({ targets: 'aarch64-linux-android' });
    expect(androidSteps[6].with).toEqual({ workspaces: './src-tauri -> target' });
    expect(androidSteps[9].env).toEqual({
      ANDROID_KEYSTORE_BASE64: '${{ secrets.ANDROID_KEYSTORE_BASE64 }}',
    });
    expect(androidSteps[10].env).toEqual({
      ANDROID_KEYSTORE_PATH: '${{ runner.temp }}/heartwood-beta-release.keystore',
      ANDROID_KEYSTORE_PASSWORD: '${{ secrets.ANDROID_KEYSTORE_PASSWORD }}',
      ANDROID_KEY_ALIAS: '${{ secrets.ANDROID_KEY_ALIAS }}',
      ANDROID_KEY_PASSWORD: '${{ secrets.ANDROID_KEY_PASSWORD }}',
    });
    expect(androidSteps[11]).toMatchObject({
      uses: 'actions/upload-artifact@v7',
      with: {
        name: 'android-aarch64-apk',
        path: expect.stringContaining('app-universal-release.apk'),
        'if-no-files-found': 'error',
      },
    });
```

Then update the `releaseJob` section:

```ts
// old
    const releaseJob = release.jobs.release;
    expect(releaseJob.needs).toBe('build');
```
```ts
// new
    const releaseJob = release.jobs.release;
    expect(releaseJob.needs).toEqual(['build', 'build-android']);
```

```ts
// old
    expect(releaseSteps[5].run).toBe(
      'node scripts/prepareAlphaAssets.mjs release-artifacts release-assets',
    );
```
```ts
// new
    expect(releaseSteps[5].run).toBe(
      'node scripts/prepareBetaAssets.mjs release-artifacts release-assets',
    );
```

```ts
// old
    expect(releaseSteps[6].run).toContain(
      's/__RELEASE_COMMIT_SHA__/$GITHUB_SHA/g',
    );
    expect(releaseSteps[6].run).toContain(
      '$RUNNER_TEMP/alpha-release-notes.md',
    );
```
```ts
// new
    expect(releaseSteps[6].run).toContain(
      's/__RELEASE_COMMIT_SHA__/$GITHUB_SHA/g',
    );
    expect(releaseSteps[6].run).toContain(
      '$RUNNER_TEMP/beta-release-notes.md',
    );
```

```ts
// old
    expect(releaseSteps[7].run).toContain(
      '--notes-file "$RUNNER_TEMP/alpha-release-notes.md"',
    );
```
```ts
// new
    expect(releaseSteps[7].run).toContain(
      '--notes-file "$RUNNER_TEMP/beta-release-notes.md"',
    );
```

Every other assertion in this `it()` block (the `preflight` job, the desktop `build` job's matrix/steps, the release job's checkout/download/updater-manifest-publish/provenance-check steps and their ordering, the `serializedBuild`/`releaseText` secret-leak checks) is unchanged — those behaviors are identical between alpha and beta.

- [ ] **Step 7: Run the test to confirm it now fails, then passes**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "publishes only a complete tag-triggered"`
Expected before Steps 1–5 of this task: FAIL (file not found / old assertions).
Expected after Steps 1–6: PASS.

(This single `it()` block will pass once this task is done; the file's other `it()` blocks — issue template, release notes, testing guide, README/CHANGELOG — stay red until Tasks 7–10 land. That's expected mid-plan, not a regression.)

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/release-beta.yml scripts/githubAutomation.test.ts
git commit -m "feat: build and release a signed Android APK alongside the beta desktop matrix"
```

---

## Task 7: Rename the defect issue template for beta

**Files:**
- Create (via `git mv`): `.github/ISSUE_TEMPLATE/beta-defect.yml` (from `.github/ISSUE_TEMPLATE/alpha-defect.yml`)
- Modify: `scripts/githubAutomation.test.ts` (the `'requires reproducible and privacy-conscious alpha defect reports'` test)

- [ ] **Step 1: Update the test first**

```ts
// old
  it('requires reproducible and privacy-conscious alpha defect reports', () => {
    const form = parse(projectFile('.github/ISSUE_TEMPLATE/alpha-defect.yml'));
    const config = parse(projectFile('.github/ISSUE_TEMPLATE/config.yml'));

    expect(form.name).toMatch(/alpha defect/i);
    expect(form.labels).toContain('bug');

    const fields = new Map(
      form.body
        .filter((field: { id?: string }) => field.id)
        .map((field: { id: string }) => [field.id, field]),
    );
    const requiredIds = [
      'alpha-version',
      'platform',
      'os-version',
      'artifact',
      'reproduction',
      'expected',
      'actual',
      'data-impact',
    ];

    expect([...fields.keys()]).toEqual(expect.arrayContaining(requiredIds));
    for (const id of requiredIds) {
      expect(fields.get(id)?.validations).toEqual({ required: true });
    }
    expect(fields.get('platform')?.attributes.options).toEqual([
      'macOS',
      'Windows',
      'Linux',
    ]);
    expect(fields.get('artifact')?.attributes.options).toEqual([
      'macOS universal .dmg',
      'Windows x64 NSIS .exe',
      'Linux x64 AppImage',
      'Linux x64 .deb',
    ]);
```
```ts
// new
  it('requires reproducible and privacy-conscious beta defect reports', () => {
    const form = parse(projectFile('.github/ISSUE_TEMPLATE/beta-defect.yml'));
    const config = parse(projectFile('.github/ISSUE_TEMPLATE/config.yml'));

    expect(form.name).toMatch(/beta defect/i);
    expect(form.labels).toContain('bug');

    const fields = new Map(
      form.body
        .filter((field: { id?: string }) => field.id)
        .map((field: { id: string }) => [field.id, field]),
    );
    const requiredIds = [
      'beta-version',
      'platform',
      'os-version',
      'artifact',
      'reproduction',
      'expected',
      'actual',
      'data-impact',
    ];

    expect([...fields.keys()]).toEqual(expect.arrayContaining(requiredIds));
    for (const id of requiredIds) {
      expect(fields.get(id)?.validations).toEqual({ required: true });
    }
    expect(fields.get('platform')?.attributes.options).toEqual([
      'macOS',
      'Windows',
      'Linux',
      'Android',
    ]);
    expect(fields.get('artifact')?.attributes.options).toEqual([
      'macOS universal .dmg',
      'Windows x64 NSIS .exe',
      'Linux x64 AppImage',
      'Linux x64 .deb',
      'Android .apk',
    ]);
```

The rest of this `it()` block (`diagnostics` optional, `privacy-check` required, the two `JSON.stringify(form)` regex checks, and the `config` equality check) is unchanged.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "privacy-conscious"`
Expected: FAIL (file not found at the old path, field ids don't match).

- [ ] **Step 3: Rename and edit the template**

```bash
git mv .github/ISSUE_TEMPLATE/alpha-defect.yml .github/ISSUE_TEMPLATE/beta-defect.yml
```

Edit `.github/ISSUE_TEMPLATE/beta-defect.yml`:

```yaml
# old
name: Alpha defect
description: Report a reproducible problem in a private alpha build
title: '[Alpha]: '
```
```yaml
# new
name: Beta defect
description: Report a reproducible problem in a private beta build
title: '[Beta]: '
```

```yaml
# old
  - type: input
    id: alpha-version
    attributes:
      label: Alpha version
      description: Enter the exact tag shown on the GitHub prerelease.
      placeholder: v0.1.0-alpha.1
    validations:
      required: true
  - type: dropdown
    id: platform
    attributes:
      label: Platform
      description: Select the operating system where the defect occurred.
      options: [macOS, Windows, Linux]
    validations:
      required: true
  - type: input
    id: os-version
    attributes:
      label: Operating system version
      placeholder: macOS 15.6, Windows 11 24H2, or Ubuntu 24.04
    validations:
      required: true
  - type: dropdown
    id: artifact
    attributes:
      label: Installation artifact
      options:
        - macOS universal .dmg
        - Windows x64 NSIS .exe
        - Linux x64 AppImage
        - Linux x64 .deb
    validations:
      required: true
```
```yaml
# new
  - type: input
    id: beta-version
    attributes:
      label: Beta version
      description: Enter the exact tag shown on the GitHub prerelease.
      placeholder: v0.1.0-beta.1
    validations:
      required: true
  - type: dropdown
    id: platform
    attributes:
      label: Platform
      description: Select the operating system where the defect occurred.
      options: [macOS, Windows, Linux, Android]
    validations:
      required: true
  - type: input
    id: os-version
    attributes:
      label: Operating system version
      placeholder: macOS 15.6, Windows 11 24H2, Ubuntu 24.04, or Android 14
    validations:
      required: true
  - type: dropdown
    id: artifact
    attributes:
      label: Installation artifact
      options:
        - macOS universal .dmg
        - Windows x64 NSIS .exe
        - Linux x64 AppImage
        - Linux x64 .deb
        - Android .apk
    validations:
      required: true
```

Leave every other field (`reproduction`, `expected`, `actual`, `data-impact`, `diagnostics`, `additional-context`, `privacy-check`) untouched.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "privacy-conscious"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/ISSUE_TEMPLATE/beta-defect.yml scripts/githubAutomation.test.ts
git commit -m "feat: rename defect issue template for beta, add Android options"
```

---

## Task 8: Rename and extend the release notes for beta + Android

**Files:**
- Create (via `git mv`): `docs/beta-release-notes.md` (from `docs/alpha-release-notes.md`)
- Modify: `scripts/githubAutomation.test.ts` (the `'ships version-neutral alpha notes...'` test)

- [ ] **Step 1: Update the test first**

```ts
// old
  it('ships version-neutral alpha notes with safe unsigned install guidance', () => {
    const releaseNotes = projectFile('docs/alpha-release-notes.md');

    expect(releaseNotes).toMatch(/desktop alpha/i);
    expect(releaseNotes).not.toMatch(/v0\.1\.0-alpha\.1/);
    expect(releaseNotes).toMatch(/universal.*\.dmg/is);
    expect(releaseNotes).toMatch(/x64.*NSIS.*\.exe/is);
    expect(releaseNotes).toMatch(/x64.*AppImage/is);
    expect(releaseNotes).toMatch(/x64.*\.deb/is);
    expect(releaseNotes).toMatch(/macOS.*Windows.*unsigned/is);
    expect(releaseNotes).toMatch(/Gatekeeper/);
    expect(releaseNotes).toMatch(/SmartScreen/);
    expect(releaseNotes).toMatch(/chmod \+x/);
    expect(releaseNotes).toMatch(/SHA256SUMS\.txt/);
    expect(releaseNotes).toMatch(/alpha-testing\.md/);
    expect(releaseNotes.match(/__RELEASE_COMMIT_SHA__/g)).toHaveLength(1);
    expect(releaseNotes).not.toContain('/blob/main/');
    expect(releaseNotes).toMatch(/backup.*delet/is);
    expect(releaseNotes).toMatch(/complete Linux backup requires both/i);
    expect(releaseNotes).toContain(
      '$XDG_CONFIG_HOME/com.heartwood.app or ~/.config/com.heartwood.app',
    );
    expect(releaseNotes).toContain(
      '$XDG_DATA_HOME/com.heartwood.app or ~/.local/share/com.heartwood.app',
    );
    expect(releaseNotes).toMatch(
      /Gatekeeper.*System Settings.*Privacy\s+&\s+Security.*Open\s+Anyway.*(?:older|fallback).*Control-click/is,
    );
    expect(releaseNotes).toMatch(/desktop-only/i);
    expect(releaseNotes).toMatch(/no automatic updates/i);
    expect(releaseNotes).toMatch(/no mobile build/i);
    expect(releaseNotes).toMatch(/no therapeutic claims/i);
    expect(releaseNotes).not.toMatch(/disable (Gatekeeper|SmartScreen)/i);
    expect(releaseNotes).not.toMatch(/spctl\s+--master-disable/i);
  });
```
```ts
// new
  it('ships version-neutral beta notes with safe unsigned install guidance', () => {
    const releaseNotes = projectFile('docs/beta-release-notes.md');

    expect(releaseNotes).toMatch(/beta/i);
    expect(releaseNotes).not.toMatch(/v0\.1\.0-beta\.1/);
    expect(releaseNotes).toMatch(/universal.*\.dmg/is);
    expect(releaseNotes).toMatch(/x64.*NSIS.*\.exe/is);
    expect(releaseNotes).toMatch(/x64.*AppImage/is);
    expect(releaseNotes).toMatch(/x64.*\.deb/is);
    expect(releaseNotes).toMatch(/arm64-v8a.*\.apk|\.apk.*arm64-v8a/is);
    expect(releaseNotes).toMatch(/macOS.*Windows.*unsigned/is);
    expect(releaseNotes).toMatch(/Gatekeeper/);
    expect(releaseNotes).toMatch(/SmartScreen/);
    expect(releaseNotes).toMatch(/chmod \+x/);
    expect(releaseNotes).toMatch(/install unknown apps/i);
    expect(releaseNotes).toMatch(/SHA256SUMS\.txt/);
    expect(releaseNotes).toMatch(/beta-testing\.md/);
    expect(releaseNotes.match(/__RELEASE_COMMIT_SHA__/g)).toHaveLength(1);
    expect(releaseNotes).not.toContain('/blob/main/');
    expect(releaseNotes).toMatch(/backup.*delet/is);
    expect(releaseNotes).toMatch(/complete Linux backup requires both/i);
    expect(releaseNotes).toContain(
      '$XDG_CONFIG_HOME/com.heartwood.app or ~/.config/com.heartwood.app',
    );
    expect(releaseNotes).toContain(
      '$XDG_DATA_HOME/com.heartwood.app or ~/.local/share/com.heartwood.app',
    );
    expect(releaseNotes).toMatch(
      /Gatekeeper.*System Settings.*Privacy\s+&\s+Security.*Open\s+Anyway.*(?:older|fallback).*Control-click/is,
    );
    expect(releaseNotes).toMatch(/no automatic updates? (?:for|on) android/i);
    expect(releaseNotes).toMatch(/no therapeutic claims/i);
    expect(releaseNotes).not.toMatch(/disable (Gatekeeper|SmartScreen)/i);
    expect(releaseNotes).not.toMatch(/spctl\s+--master-disable/i);
  });
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "safe unsigned install guidance"`
Expected: FAIL (old file gone/renamed, content still says alpha).

- [ ] **Step 3: Rename and rewrite the file**

```bash
git mv docs/alpha-release-notes.md docs/beta-release-notes.md
```

Replace the entire contents of `docs/beta-release-notes.md` with:

```markdown
# Heartwood Beta

This is an unsigned beta for hands-on testing. It may contain defects,
including defects that affect local data. Quit the app and back up all
storage roots listed below before testing deletion, note recovery, or
upgrades. Do not use this build as the only copy of important information.

## Downloads

Choose the artifact for the device you are testing:

| Platform | Architecture | Download |
| --- | --- | --- |
| macOS | Universal Apple Silicon and Intel | `.dmg` |
| Windows | x64 | NSIS `.exe` |
| Linux | x64 | AppImage |
| Linux | x64 | `.deb` |
| Android | arm64-v8a | `.apk` |

The macOS and Windows packages are unsigned; the Android package is signed
with a dedicated beta signing key that implies no trust beyond "built by
this project's release pipeline," not a Play Store identity. Confirm that
the file came from this release and compare its SHA-256 value with
`SHA256SUMS.txt` before opening it. The checksum detects an incomplete or
changed download; it is not a code-signing certificate.

## Installing An Unsigned Build

- **macOS:** Open the `.dmg`, move Heartwood to Applications, and
  attempt the first launch. If Gatekeeper blocks it, open **System Settings >
  Privacy & Security**, find the app's security message, then choose **Open
  Anyway**. As a fallback on older macOS versions, use Finder's Control-click
  **Open** path. Do not turn Gatekeeper off.
- **Windows:** Run the NSIS `.exe`. If SmartScreen appears, confirm the source
  and checksum, choose **More info**, then **Run anyway**. Do not turn
  SmartScreen off.
- **Linux AppImage:** Make the downloaded file executable with
  `chmod +x <downloaded-file>.AppImage`, then run it. If AppImage support is
  unavailable, install the x64 `.deb` instead with your software manager or
  `sudo apt install ./<downloaded-file>.deb`.
- **Android:** Download the `.apk` on the device itself (or transfer it over),
  then tap it to install. Android will prompt to **install unknown apps**
  for whichever app opened the file (browser or file manager) — allow it for
  that app only, then tap Install. Do not enable "install unknown apps"
  globally beyond that one app.

For checksums, run `shasum -a 256 <file>` on macOS,
`Get-FileHash <file> -Algorithm SHA256` in PowerShell, `sha256sum <file>` on
Linux, or a checksum-calculator app on Android, and compare the result with
the matching line in `SHA256SUMS.txt`.

## Before Testing

Read the complete [beta testing guide](https://github.com/Puck5150/heartwood/blob/__RELEASE_COMMIT_SHA__/docs/beta-testing.md).
It contains backup locations, the platform smoke checklist, severity guidance,
and privacy-conscious feedback steps. A complete Linux backup requires both:

```text
SQLite/config: $XDG_CONFIG_HOME/com.heartwood.app or ~/.config/com.heartwood.app
Notes/revisions: $XDG_DATA_HOME/com.heartwood.app or ~/.local/share/com.heartwood.app
```

Quit the app before copying both Linux roots or the single location documented
for macOS and Windows, especially before delete-all or another destructive test.
Android's app-private storage isn't accessible for manual backup without a
rooted device — treat Android test data as disposable for this beta.

## Current Limits

- No automatic updates on Android; desktop still checks for updates
  automatically. Android testers redownload the APK for each new beta.
- No signed distribution or macOS notarization; Android's signing key is
  beta-only, not a Play Store identity.
- No therapeutic claims; this is a focus tool, not medical treatment.
- Local data is not synced to another device or service.
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "safe unsigned install guidance"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/beta-release-notes.md scripts/githubAutomation.test.ts
git commit -m "docs: rename release notes for beta, add Android install guidance"
```

---

## Task 9: Rename and extend the testing guide for beta + Android

**Files:**
- Create (via `git mv`): `docs/beta-testing.md` (from `docs/alpha-testing.md`)
- Modify: `scripts/githubAutomation.test.ts` (the `'ships a complete role-based alpha smoke and feedback guide'` test)

- [ ] **Step 1: Update the test first**

```ts
// old
  it('ships a complete role-based alpha smoke and feedback guide', () => {
    const guide = projectFile('docs/alpha-testing.md');
```
```ts
// new
  it('ships a complete role-based beta smoke and feedback guide', () => {
    const guide = projectFile('docs/beta-testing.md');
```

Add one new assertion to the same block, immediately after the existing `expect(guide).toMatch(/appearance.*accessibility/is);` line:

```ts
    expect(guide).toMatch(/android/i);
    expect(guide).toMatch(/backgrounding|foregrounding/i);
```

Every other assertion in this block is unchanged (all still hold for the beta guide's desktop content).

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "role-based"`
Expected: FAIL.

- [ ] **Step 3: Rename and rewrite the file**

```bash
git mv docs/alpha-testing.md docs/beta-testing.md
```

Replace the entire contents of `docs/beta-testing.md` with:

```markdown
# Beta Testing

Use this guide for every beta candidate before it is shared and while testing
it in normal daily work. Record the exact beta tag, operating system version,
and downloaded artifact with every result. The build covers desktop and
Android, is unsigned (Android carries a beta-only signing key, not a Play
Store identity), and stores its working data locally.

## Tester Roles

- **Owner:** emphasize daily workflow, reliability, and soundscape quality over
  several days of normal use.
- **Usability tester:** emphasize first-run clarity and ordinary use without
  prior project knowledge.
- **Developer tester:** emphasize recovery, edge cases, packaging, and useful
  technical diagnostics.

Each tester can run the entire checklist. The role descriptions identify where
their attention is most valuable, not separate permission levels.

## Prepare And Back Up

Before an upgrade, deletion test, or external note edit on desktop, quit
Heartwood completely and copy the listed storage roots to a separate location.
The app identifier is `com.heartwood.app`:

```text
macOS (SQLite/config and notes/revisions): ~/Library/Application Support/com.heartwood.app
Windows (SQLite/config and notes/revisions): %APPDATA%\com.heartwood.app
Linux SQLite/config: $XDG_CONFIG_HOME/com.heartwood.app or ~/.config/com.heartwood.app
Linux notes/revisions: $XDG_DATA_HOME/com.heartwood.app or ~/.local/share/com.heartwood.app
```

Linux uses the corresponding `XDG_CONFIG_HOME` or `XDG_DATA_HOME` path when
that variable is set. Its SQLite/config state and notes/revisions live in two
separate roots, so a complete Linux backup requires both. In the app, **Open
Notes Folder** is the authoritative way to locate the current Markdown notes
directory on desktop. Copying only that notes directory is not a complete
backup. Android's app-private storage has no equivalent manual backup path on
an unrooted device — treat Android test data as disposable for this beta.

Before installing:

- [ ] Record the beta tag, operating system and version, tester role, and
  artifact filename.
- [ ] Compare the artifact's SHA-256 value with its entry in
  `SHA256SUMS.txt`.
- [ ] Quit the app before copying desktop storage. On Linux, back up both the
  config and data roots; on macOS or Windows, back up the single listed root.
  Confirm the copy can be opened at its separate destination.
- [ ] Remove or redact private note and parked-thought content from every log,
  screenshot, export, and issue attachment.

## Installing Unsigned Builds

These instructions use normal operating-system approval paths. Do not disable
Gatekeeper, SmartScreen, or another system-wide security control.

- **macOS:** Open the universal `.dmg`, move the app to Applications, and
  attempt the first launch. If Gatekeeper blocks it, open **System Settings >
  Privacy & Security**, find the message about Heartwood, and choose
  **Open Anyway**. As a fallback on older macOS versions, use Finder's
  Control-click **Open** path for this app.
- **Windows:** Run the x64 NSIS `.exe`. If SmartScreen appears, verify the
  source and checksum, choose **More info**, then **Run anyway**.
- **Linux:** For the x64 AppImage, run
  `chmod +x <downloaded-file>.AppImage` before launching it. The x64 `.deb` is
  the alternative and can be installed with the system software manager or
  `sudo apt install ./<downloaded-file>.deb`.
- **Android:** Download the `.apk` to the device, tap it, allow "install
  unknown apps" for the app that opened it (browser or file manager) when
  prompted, then Install.

## What's New in This Beta

- Heartwood now runs on Android (arm64-v8a) alongside the existing desktop
  platforms, installed by sideloading a signed APK.
- Desktop continues to check for updates automatically a few seconds after
  launch; Android has no update channel yet — redownload for each new beta.

## Smoke Checklist

Mark each check as pass, fail, or not applicable in your notes. When a check
fails, stop before destructive follow-up steps if local data may be at risk.

### Installation And Lifecycle

- [ ] Complete a fresh install and first launch on the target operating
  system through the documented unsigned/sideload path.
- [ ] Quit normally, relaunch, and confirm expected local state returns.
- [ ] Launch the app a second time and confirm the existing window is shown
  rather than creating a second independent data owner (desktop only).
- [ ] Upgrade from the previous beta without losing local data; mark this not
  applicable when no earlier beta is installed. On Android, confirm installing
  the new APK over the old one is accepted as an upgrade, not a signature
  conflict (this proves the signing key stayed consistent between betas).
- [ ] Observe uninstall behavior and record whether local data remains; do not
  assume or promise that uninstall removes it.

### Timer And Recovery

- [ ] Start focus from a new task and from an unresolved parked thought.
- [ ] Pause and resume focus without changing the task, planned duration, or
  saved work.
- [ ] Choose **Continue focusing** and confirm the same planned duration
  restarts in the same session.
- [ ] Allow focus to enter quiet overtime, dismiss a marker with **Stay with
  it**, and confirm later markers repeat at the planned cadence.
- [ ] Exercise the focus warning at 15 seconds, 30 seconds, and Off; confirm
  Off suppresses the advance warning but not expiry or overtime markers.
- [ ] Let an unacknowledged marker play the alarm sequence, then take a break
  and end a session from the available prompts.
- [ ] Start **Break** and **Touch Grass** intermissions, return early, and let
  each expire into quiet intermission overtime before returning.
- [ ] Quit and relaunch during active, paused, quiet overtime, and intermission
  states; confirm recovery is silent and preserves the correct state.
- [ ] On desktop, put the computer to sleep and wake it during active, paused,
  quiet overtime, and intermission states; confirm the timer recovers from
  elapsed wall-clock time without duplicate alarms.
- [ ] On Android, background the app (switch to another app or the home
  screen) during active, paused, quiet overtime, and intermission states,
  then return; confirm the same deadline-based recovery holds even though
  Android can suspend backgrounded apps more aggressively than a desktop OS.
- [ ] Complete a session, inspect its review, use **Back to start**, relaunch,
  and confirm the dismissed review does not reopen.
- [ ] Background or minimize the app near a warning and record whether the
  best-effort silent notification appears; do not treat notification-click
  window behavior as supported on any platform, including Android.
- [ ] On Android specifically, treat every notification observation as
  first-time territory, not a regression check — `ARCHITECTURE.md` already
  documents that the notification adapter was verified only against the
  desktop Tauri backend before this beta.

### Notes, Revisions, History, And Deletion

- [ ] Plant thoughts during focus and confirm unresolved thoughts carry forward
  and remain available on the front page.
- [ ] Type Markdown notes, wait for autosave, quit, and reopen the session to
  confirm the exact content returns.
- [ ] Preview Markdown and confirm raw HTML, images, or unsafe links are not
  rendered as trusted content.
- [ ] Create and inspect a checkpoint revision, rename it, restore it, and
  delete revision history while confirming the current note remains.
- [ ] Edit a note externally, return to the app, and exercise both external
  edit conflict choices without silently losing either version. (Desktop
  only — Android's sandboxed storage has no external-edit path to test.)
- [ ] Use **Open Notes Folder** and confirm the expected portable `.md` files
  are present on desktop. Treat this in-app action as authoritative for their
  location.
- [ ] Open History while a timer is running and confirm navigation does not
  stop or reset the timer. On the task board (Projects), confirm the
  Backlog/To Do/In Progress/Done columns stack full-width on a phone screen
  rather than squeezing four abreast, and that a task's Status can be changed
  from its edit dialog without needing drag-and-drop.
- [ ] Export History as Markdown and JSON and inspect the task, timings, parked
  thoughts, and intermission totals.
- [ ] After making a fresh backup (desktop) or accepting Android data is
  disposable, delete one session and confirm its note and revisions are
  removed while unrelated data remains.
- [ ] After making another fresh backup (desktop) or accepting Android data is
  disposable, use **Delete all data** and confirm sessions, planted thoughts,
  notes, and revisions are removed while preferences remain.

### Soundscapes And Tones

- [ ] Play soundscapes before, during, and after focus; starting or ending a
  timer must not unexpectedly stop user-requested playback.
- [ ] Switch every bundled track, adjust volume, and manually pause and resume
  from the music-note control. On the phone-width nav bar, confirm the Music
  control's active/playing state uses the same visual treatment as every
  other tab rather than a different color.
- [ ] Confirm alarm and timed-intermission audio suppresses soundscapes, then
  restores playback only when it was still user-requested.
- [ ] Manually pause a soundscape, trigger an alarm or intermission tone, and
  confirm it remains paused afterward.
- [ ] Preview each alarm and return tone in Settings, save selections, relaunch,
  and confirm the chosen tones remain selected.

### Appearance And Accessibility

- [ ] Exercise Light, Dark, and System appearance with every theme family and
  timer accent; confirm text and controls remain legible.
- [ ] Resize the desktop window and inspect narrow responsive layouts without
  overlapping, clipped, or lost controls. On Android, confirm the same on a
  real phone screen — specifically that the History screen's **Delete**
  action and **+ Project** pill never overlap.
- [ ] Navigate the start, focus, History, Revisions, music, Settings, prompts,
  and confirmations using the keyboard (desktop) or touch (Android — every
  control reachable this way, nothing requiring a mouse-only interaction like
  drag-and-drop).
- [ ] Confirm keyboard focus remains visible and returns to the invoking
  control after closing Settings or a confirmation (desktop).
- [ ] Confirm primary labels, timer state, warnings, failures, and status
  changes are understandable without relying only on appearance, color, or
  sound.

### Feedback

- [ ] Record concise reproduction steps, expected behavior, actual behavior,
  and whether any timer, note, parked thought, preference, or other local data
  was lost or changed.
- [ ] Classify the result as blocker, non-blocking defect, usability friction,
  or feature request.
- [ ] Reproduce a defect once when doing so cannot risk more data, and record
  whether it happens consistently.
- [ ] Submit the **Beta defect** issue form, or send the same fields privately
  to the owner when repository access is unavailable.
- [ ] Attach only sanitized logs or screenshots and confirm private note and
  parked-thought content has been removed or redacted. On Android, pull
  relevant lines from `adb logcat` rather than a desktop log path.

## Severity And Release Gates

A **blocker** is data loss or corruption, broken timer/session recovery, a
crash in a core workflow, an installer that cannot launch through the
documented unsigned/sideload path, an inaccessible core control, or a missing
supported artifact — including a missing or broken Android build. Stop
distribution and report it immediately.

Cosmetic defects, low-impact friction, and feature requests belong in the
beta backlog unless they prevent practical use. A replacement build receives
a new beta number; published beta assets are not silently replaced.

## Reporting A Defect

Use the repository's **Beta defect** issue form. Include the exact beta tag,
operating system and version, artifact, numbered reproduction steps, expected
and actual behavior, and local-data impact. Logs and screenshots are optional
and must be sanitized. If the tester does not have a GitHub account,
send those same fields to the owner so the owner can file the report without
including private content.
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "role-based"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/beta-testing.md scripts/githubAutomation.test.ts
git commit -m "docs: rename testing guide for beta, add Android checklist items"
```

---

## Task 10: Update README and CHANGELOG for beta

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `scripts/githubAutomation.test.ts` (the `'links alpha tester documentation...'` test)

- [ ] **Step 1: Update the test first**

```ts
// old
  it('links alpha tester documentation and records release readiness', () => {
    const readme = projectFile('README.md');
    const changelog = projectFile('CHANGELOG.md');
    const readiness = changelog.split('## Phase 5E:')[0];

    expect(readme).toMatch(/## Get the app/);
    expect(readme).toMatch(/docs\/alpha-testing\.md/);
    expect(readme).toMatch(/docs\/alpha-release-notes\.md/);
    expect(readiness).toMatch(/## Alpha release readiness/);
    expect(readiness).toMatch(/version agreement/i);
    expect(readiness).toMatch(/Visible CI/i);
    expect(readiness).toMatch(/complete native matrix/i);
    expect(readiness).toMatch(/release immutability/i);
    expect(readiness).toMatch(/remote tag.*main/is);
    expect(readiness).toMatch(/commit-pinned testing guide/i);
    expect(readiness).toMatch(/checksums/i);
    expect(readiness).toMatch(/Tester guidance/i);
    expect(readiness).toMatch(/deferred: signed.*mobile/is);
  });
```
```ts
// new
  it('links beta tester documentation and records release readiness', () => {
    const readme = projectFile('README.md');
    const changelog = projectFile('CHANGELOG.md');
    const readiness = changelog.split('## Alpha release readiness')[0];

    expect(readme).toMatch(/## Get the app/);
    expect(readme).toMatch(/docs\/beta-testing\.md/);
    expect(readme).toMatch(/docs\/beta-release-notes\.md/);
    expect(readiness).toMatch(/## Beta release readiness/);
    expect(readiness).toMatch(/version agreement/i);
    expect(readiness).toMatch(/Android/i);
    expect(readiness).toMatch(/signed Android APK|Android APK.*signed/is);
    expect(readiness).toMatch(/release immutability/i);
    expect(readiness).toMatch(/remote tag.*main/is);
    expect(readiness).toMatch(/commit-pinned testing guide/i);
    expect(readiness).toMatch(/checksums/i);
    expect(readiness).toMatch(/Tester guidance/i);
    expect(readiness).toMatch(/deferred:.*signed.*notariz/is);
    expect(readiness).toMatch(/android automatic updates/i);
  });
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "tester documentation"`
Expected: FAIL.

- [ ] **Step 3: Update README.md**

```markdown
# old
| Platform | Architecture | Download |
| --- | --- | --- |
| macOS | Universal (Apple Silicon and Intel) | `.dmg` |
| Windows | x64 | NSIS `.exe` |
| Linux | x64 | AppImage or `.deb` |

These are alpha builds: **unsigned** on macOS and Windows, so your OS will
warn you on first launch (Gatekeeper / SmartScreen) — that's expected, not a
sign of tampering. Verify the file's SHA-256 against the release's
`SHA256SUMS.txt` before opening it if you want to double-check the download.
Full install steps per platform, backup locations, and current limitations
are in the [alpha release notes](docs/alpha-release-notes.md); testers
following a structured checklist should use the
[alpha testing guide](docs/alpha-testing.md) instead.
```
```markdown
# new
| Platform | Architecture | Download |
| --- | --- | --- |
| macOS | Universal (Apple Silicon and Intel) | `.dmg` |
| Windows | x64 | NSIS `.exe` |
| Linux | x64 | AppImage or `.deb` |
| Android | arm64-v8a | `.apk` |

These are beta builds: **unsigned** on macOS and Windows, so your OS will
warn you on first launch (Gatekeeper / SmartScreen) — that's expected, not a
sign of tampering. The Android build is signed with a beta-only key, not a
Play Store identity. Verify the file's SHA-256 against the release's
`SHA256SUMS.txt` before opening it if you want to double-check the download.
Full install steps per platform, backup locations, and current limitations
are in the [beta release notes](docs/beta-release-notes.md); testers
following a structured checklist should use the
[beta testing guide](docs/beta-testing.md) instead.
```

- [ ] **Step 4: Update CHANGELOG.md**

Insert a new entry above the existing `## Alpha release readiness` heading (newest-first ordering, matching the file's own convention):

```markdown
## Beta release readiness

Moves from a desktop-only private alpha to a beta that also ships Android,
without adding new product behavior beyond what the mobile pass itself
already fixed.

- **One enforced version agreement** now recognizes beta tags
  (`vX.Y.Z-beta.N`) in place of alpha tags across the JavaScript manifest and
  lock, Tauri configuration, and Rust manifest and lock.
- **A signed Android APK joins the native matrix:** `tauri android build`
  targets arm64-v8a and is signed through a Gradle signing config reading a
  dedicated, CI-secret-only keystore — never committed, never the alpha's
  ad-hoc/unsigned posture. A missing or failed Android build now fails the
  release closed exactly like a missing desktop installer already did.
- **Explicit beta tags build the complete matrix:** the existing universal
  macOS `.dmg`, Windows x64 NSIS `.exe`, and Linux x64 AppImage plus `.deb`,
  now joined by the Android `.apk`. A failed platform — including
  Android — prevents the tester-facing prerelease from being created.
- **Release integrity is unchanged in kind:** the same immutable-release
  preflight, remote-tag-against-main revalidation, deterministic checksums,
  and commit-pinned testing guide now cover five platforms instead of three
  operating systems.
- **Tester guidance and the defect intake form** gain Android-specific
  install, backup, and feedback steps alongside the existing desktop
  coverage.
- Explicitly deferred: signed desktop distribution, macOS notarization,
  public distribution, iOS packaging, and **Android automatic updates** —
  called out as the next phase after this one, since Tauri's updater plugin
  has no mobile equivalent today.

## Alpha release readiness
```

- [ ] **Step 5: Run to confirm it passes**

Run: `npx vitest run scripts/githubAutomation.test.ts -t "tester documentation"`
Expected: PASS.

- [ ] **Step 6: Run the entire suite to confirm every task landed correctly**

Run: `npm test`
Expected: all test files pass, including every `it()` block in `scripts/githubAutomation.test.ts`.

Run: `npm run check`
Expected: 0 errors (the pre-existing `ProjectPicker.svelte` warning is unrelated and expected to remain).

- [ ] **Step 7: Commit**

```bash
git add README.md CHANGELOG.md scripts/githubAutomation.test.ts
git commit -m "docs: update README and CHANGELOG for the beta release"
```

---

## Post-plan: cutting the actual release

Out of scope for this plan (per the Global Constraints), but the next steps once every task above is merged:

1. Bump the version to `0.1.0-beta.1` across `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`, then run `node scripts/releaseVersion.mjs` locally to confirm agreement.
2. Commit that version bump.
3. Push `main`, then tag: `git tag v0.1.0-beta.1 && git push origin v0.1.0-beta.1`.
4. Watch the `Beta release` workflow run; it will fail closed at the `preflight` job unless repository release immutability is already enabled (same prerequisite the alpha pipeline has always had).
