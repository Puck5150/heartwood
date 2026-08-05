# Auto-Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an in-app updater so Heartwood alpha testers stop manually redownloading installers, using `tauri-plugin-updater` against a signed manifest published alongside each tagged alpha release.

**Architecture:** CI (`release-alpha.yml`) already builds signed-capable installers via `tauri-action`; adding two signing secrets makes the Tauri bundler also emit a `.sig` file next to each platform's updater-relevant bundle artifact. A new script assembles those `.sig` files into one `latest.json` manifest, which the existing `prepareAlphaAssets.mjs` gate then validates and ships as a normal release asset. On the client, a new `updateController.svelte.ts` (mirroring `settingsController.svelte.ts`'s factory-with-injected-dependencies shape) drives `@tauri-apps/plugin-updater`'s `check()`/`downloadAndInstall()` through an explicit state machine, rendered by a new banner component styled like `FirstTimeHint.svelte`. `App.svelte` triggers the check once on startup and gates the restart prompt on `session.status === 'idle'`.

**Tech Stack:** Tauri 2 (`tauri-plugin-updater`, `tauri-plugin-process`), `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`, Svelte 5 runes, Vitest, Node ESM scripts (existing `scripts/` conventions).

## Global Constraints

- Automatic, silent check only — a few seconds after launch, at most once per launch. No manual "Check for updates" control anywhere in Settings.
- Downloading requires explicit user consent (clicking "Update"); installing/restarting requires a second, separate explicit consent (clicking "Restart now").
- The restart prompt must never appear while `session.status` is `'focus'`, `'flow'`, or `'break'` — only when `session.status === 'idle'`, even if the download finished mid-session.
- A failed check is completely silent (no banner, no error, retries next launch). A failed download or signature verification is surfaced as a dismissible, retryable error — never auto-retries in a loop, never installs on a verification failure.
- The signing private key is generated and stored by the maintainer directly as GitHub Actions secrets. No task in this plan generates, prints, stores, or transmits the private key. Only the public key (supplied by the maintainer, out of band) is committed, in `src-tauri/tauri.conf.json`.
- Linux `.deb` installs do not get self-update (Tauri's updater plugin doesn't support `.deb`); this is accepted, not a defect to fix here.
- The existing `release-alpha.yml` architecture — validate before build, build before an explicit gated `release` job creates the GitHub prerelease — is preserved exactly. No task creates a draft/early GitHub release; `tauri-action`'s own release-upload path (`releaseId`/`tagName` inputs) is deliberately not used, so it never runs.
- Match existing repo conventions exactly: settings-style controllers are factory functions returning `$state`, with dependencies (persistence, plugin calls) injected as options for testability — never imported and called directly inside the controller. Presentational components take primitive props and callbacks, never a whole controller object.

---

## File Structure

- `src-tauri/Cargo.toml` — modify: add `tauri-plugin-updater`, `tauri-plugin-process` dependencies.
- `src-tauri/src/lib.rs` — modify: register both plugins.
- `src-tauri/tauri.conf.json` — modify: add `plugins.updater` block (placeholder `pubkey`, GitHub-releases `endpoints`).
- `src-tauri/capabilities/default.json` — modify: add `updater:default`, `process:allow-restart` permissions.
- `package.json` — modify: add `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`.
- `scripts/buildUpdaterManifest.mjs` — new: assembles `latest.json` from CI's raw downloaded artifacts.
- `scripts/buildUpdaterManifest.test.ts` — new.
- `scripts/prepareAlphaAssets.mjs` — modify: accept `latest.json` and updater `.sig`/bundle artifacts through the release-asset gate.
- `scripts/prepareAlphaAssets.test.ts` — modify: cover the new acceptance/rejection cases.
- `.github/workflows/release-alpha.yml` — modify: signing env vars on the `build` job's `tauri-action` step; a new "Build the updater manifest" step in the `release` job, before the existing "Validate and prepare release assets" step.
- `src/lib/updateController.svelte.ts` — new: the update state machine.
- `src/lib/updateController.test.ts` — new.
- `src/lib/UpdateBanner.svelte` — new: presentational two-stage banner.
- `src/App.svelte` — modify: import and wire `updateController`, trigger the startup check, render `UpdateBanner`, compute the idle-gated visible stage.
- `src/App.test.ts` — modify: integration coverage for the banner appearing/hiding and the idle gate.
- `docs/alpha-testing.md` — modify: document the maintainer's one-time signing-key setup and what testers should expect.

---

### Task 1: Register the updater and process plugins (Rust)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: the `updater`/`process` Tauri plugins registered and permitted, so `@tauri-apps/plugin-updater`'s `check()` and `@tauri-apps/plugin-process`'s `relaunch()` (added in Task 5) resolve instead of throwing a "plugin not found"/permission-denied error at runtime.

- [ ] **Step 1: Add the two Rust plugin dependencies**

In `src-tauri/Cargo.toml`, add these two lines to `[dependencies]`, alongside the existing `tauri-plugin-notification = "2.3.3"` line:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

- [ ] **Step 2: Register both plugins in `lib.rs`**

In `src-tauri/src/lib.rs`, add both plugins to the existing `.plugin(...)` chain, right after `.plugin(tauri_plugin_notification::init())`:

```rust
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
```

- [ ] **Step 3: Add the updater config block to `tauri.conf.json`**

In `src-tauri/tauri.conf.json`, add a `plugins` object as a sibling of `"bundle"` (after the closing `}` of `"bundle"`, before the file's final closing `}`):

```json
  "plugins": {
    "updater": {
      "pubkey": "REPLACE_WITH_MAINTAINER_GENERATED_PUBLIC_KEY",
      "endpoints": [
        "https://github.com/Puck5150/heartwood/releases/latest/download/latest.json"
      ]
    }
  }
```

Leave `pubkey` exactly as the placeholder string above — do not attempt to generate a real key. The maintainer replaces it by hand once they've run `npm run tauri signer generate` themselves (see Task 8's docs update). Add a one-line comment-equivalent note directly above the `"plugins"` key isn't possible in strict JSON, so instead record this requirement in Task 8's docs step, not inline in the config file.

- [ ] **Step 4: Grant the updater/process permissions**

In `src-tauri/capabilities/default.json`, add two entries to the existing `"permissions"` array, after `"notification:default"`:

```json
    "updater:default",
    "process:allow-restart"
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: `Finished` with no errors. (The placeholder `pubkey` string is syntactically a valid key-shaped value to Tauri's config parser only if it's the correct length/format for a real key — if `cargo check` fails specifically on parsing `plugins.updater.pubkey`, replace the placeholder with any syntactically-valid throwaway base64 string of the same shape, e.g. by running `npx tauri signer generate -w /tmp/throwaway.key` once locally and copying only the printed public key — never the private key file it writes — into this config. Delete `/tmp/throwaway.key` immediately after. This throwaway key is not used for anything beyond satisfying local config parsing during development; the maintainer's real key replaces it before Task 8's CI wiring goes live.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat: register tauri-plugin-updater and tauri-plugin-process"
```

---

### Task 2: `buildUpdaterManifest.mjs` — assemble `latest.json` from signed artifacts

**Files:**
- Create: `scripts/buildUpdaterManifest.mjs`
- Test: `scripts/buildUpdaterManifest.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `classifyUpdaterSignature(filename: string): 'darwin' | 'windows' | 'linux'` (throws on an unrecognized `.sig` filename) and `buildUpdaterManifest({ version, notes, pubDate, artifactsDir, downloadBaseUrl }): { version, notes, pub_date, platforms }`, both exported for Task 3 (`prepareAlphaAssets.mjs`) and for this task's own tests to consume.

Tauri's exact updater-bundle filenames vary by what's signed (macOS signs `.app.tar.gz` or occasionally `.dmg` directly depending on bundler version; Windows signs either `.nsis.zip` or the raw `.exe`; Linux signs `.AppImage` directly). Rather than hardcoding one exact name, this classifies by whichever `.sig` suffix is actually present, so it doesn't need updating if the exact Tauri sidecar name changes between versions.

- [ ] **Step 1: Write the failing tests**

Create `scripts/buildUpdaterManifest.test.ts`:

```typescript
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildUpdaterManifest, classifyUpdaterSignature } from './buildUpdaterManifest.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'updater-manifest-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('classifyUpdaterSignature', () => {
  it('classifies known macOS, Windows, and Linux signature suffixes', () => {
    expect(classifyUpdaterSignature('Heartwood.app.tar.gz.sig')).toBe('darwin');
    expect(classifyUpdaterSignature('Heartwood_universal.dmg.sig')).toBe('darwin');
    expect(classifyUpdaterSignature('Heartwood.nsis.zip.sig')).toBe('windows');
    expect(classifyUpdaterSignature('Heartwood_x64-setup.exe.sig')).toBe('windows');
    expect(classifyUpdaterSignature('Heartwood_amd64.AppImage.sig')).toBe('linux');
  });

  it('rejects an unrecognized signature suffix', () => {
    expect(() => classifyUpdaterSignature('Heartwood_amd64.deb.sig')).toThrow(
      /unrecognized updater signature/i,
    );
  });
});

describe('buildUpdaterManifest', () => {
  it('builds a manifest with darwin, windows, and linux platform entries', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'Heartwood_universal.dmg'), 'dmg bytes');
    await writeFile(path.join(dir, 'Heartwood_universal.dmg.sig'), 'darwin-signature');
    await writeFile(path.join(dir, 'Heartwood_x64-setup.exe'), 'exe bytes');
    await writeFile(path.join(dir, 'Heartwood_x64-setup.exe.sig'), 'windows-signature');
    await writeFile(path.join(dir, 'Heartwood_amd64.AppImage'), 'appimage bytes');
    await writeFile(path.join(dir, 'Heartwood_amd64.AppImage.sig'), 'linux-signature');

    const manifest = buildUpdaterManifest({
      version: '0.1.0-alpha.4',
      notes: 'Alpha release',
      pubDate: '2026-08-05T00:00:00.000Z',
      artifactsDir: dir,
      downloadBaseUrl: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4',
    });

    expect(manifest).toEqual({
      version: '0.1.0-alpha.4',
      notes: 'Alpha release',
      pub_date: '2026-08-05T00:00:00.000Z',
      platforms: {
        'darwin-x86_64': {
          signature: 'darwin-signature',
          url: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4/Heartwood_universal.dmg',
        },
        'darwin-aarch64': {
          signature: 'darwin-signature',
          url: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4/Heartwood_universal.dmg',
        },
        'windows-x86_64': {
          signature: 'windows-signature',
          url: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4/Heartwood_x64-setup.exe',
        },
        'linux-x86_64': {
          signature: 'linux-signature',
          url: 'https://github.com/Puck5150/heartwood/releases/download/v0.1.0-alpha.4/Heartwood_amd64.AppImage',
        },
      },
    });
  });

  it('trims trailing whitespace from signature file contents', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'darwin-signature\n');
    await writeFile(path.join(dir, 'b.exe.sig'), 'windows-signature\n');
    await writeFile(path.join(dir, 'c.AppImage.sig'), 'linux-signature\n');

    const manifest = buildUpdaterManifest({
      version: '0.1.0-alpha.4',
      notes: '',
      pubDate: '2026-08-05T00:00:00.000Z',
      artifactsDir: dir,
      downloadBaseUrl: 'https://example.test',
    });

    expect(manifest.platforms['darwin-x86_64'].signature).toBe('darwin-signature');
  });

  it('throws when a platform signature is missing', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'darwin-signature');
    await writeFile(path.join(dir, 'b.exe.sig'), 'windows-signature');

    expect(() =>
      buildUpdaterManifest({
        version: '0.1.0-alpha.4',
        notes: '',
        pubDate: '2026-08-05T00:00:00.000Z',
        artifactsDir: dir,
        downloadBaseUrl: 'https://example.test',
      }),
    ).toThrow(/missing updater signature.*linux/i);
  });

  it('throws on two signature files for the same platform', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'a.dmg.sig'), 'one');
    await writeFile(path.join(dir, 'b.dmg.sig'), 'two');
    await writeFile(path.join(dir, 'c.exe.sig'), 'windows-signature');
    await writeFile(path.join(dir, 'd.AppImage.sig'), 'linux-signature');

    expect(() =>
      buildUpdaterManifest({
        version: '0.1.0-alpha.4',
        notes: '',
        pubDate: '2026-08-05T00:00:00.000Z',
        artifactsDir: dir,
        downloadBaseUrl: 'https://example.test',
      }),
    ).toThrow(/duplicate updater signature.*darwin/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/buildUpdaterManifest.test.ts`
Expected: FAIL — `Cannot find module './buildUpdaterManifest.mjs'`.

- [ ] **Step 3: Implement `buildUpdaterManifest.mjs`**

Create `scripts/buildUpdaterManifest.mjs`:

```javascript
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeAlphaTag } from './releaseVersion.mjs';

const DARWIN_SUFFIXES = ['.app.tar.gz.sig', '.dmg.sig'];
const WINDOWS_SUFFIXES = ['.nsis.zip.sig', '.msi.sig', '.exe.sig'];
const LINUX_SUFFIXES = ['.AppImage.sig'];

export function classifyUpdaterSignature(filename) {
  if (DARWIN_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'darwin';
  if (WINDOWS_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'windows';
  if (LINUX_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return 'linux';
  throw new Error(`Unrecognized updater signature artifact: ${filename}`);
}

const PLATFORM_KEYS = {
  darwin: ['darwin-x86_64', 'darwin-aarch64'],
  windows: ['windows-x86_64'],
  linux: ['linux-x86_64'],
};

export function buildUpdaterManifest({ version, notes, pubDate, artifactsDir, downloadBaseUrl }) {
  const sigFiles = readdirSync(artifactsDir).filter((name) => name.endsWith('.sig'));

  const byPlatform = new Map();
  for (const sigName of sigFiles) {
    const platform = classifyUpdaterSignature(sigName);
    if (byPlatform.has(platform)) {
      throw new Error(
        `Duplicate updater signature for platform ${platform}: ${byPlatform.get(platform)} and ${sigName}`,
      );
    }
    byPlatform.set(platform, sigName);
  }

  const missing = Object.keys(PLATFORM_KEYS).filter((platform) => !byPlatform.has(platform));
  if (missing.length > 0) {
    throw new Error(`Missing updater signature for platform(s): ${missing.join(', ')}`);
  }

  const platforms = {};
  for (const [platform, sigName] of byPlatform) {
    const signature = readFileSync(path.join(artifactsDir, sigName), 'utf8').trim();
    const assetName = sigName.slice(0, -'.sig'.length);
    const url = `${downloadBaseUrl}/${assetName}`;
    for (const key of PLATFORM_KEYS[platform]) {
      platforms[key] = { signature, url };
    }
  }

  return { version, notes, pub_date: pubDate, platforms };
}

async function runCli() {
  const [artifactsDir, tag, downloadBaseUrl] = process.argv.slice(2);
  if (!artifactsDir || !tag || !downloadBaseUrl) {
    throw new Error('Usage: node scripts/buildUpdaterManifest.mjs <artifacts-dir> <tag> <download-base-url>');
  }
  const version = normalizeAlphaTag(tag);
  const manifest = buildUpdaterManifest({
    version,
    notes: '',
    pubDate: new Date().toISOString(),
    artifactsDir,
    downloadBaseUrl,
  });
  writeFileSync(path.join(artifactsDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${path.join(artifactsDir, 'latest.json')}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/buildUpdaterManifest.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/buildUpdaterManifest.mjs scripts/buildUpdaterManifest.test.ts
git commit -m "feat: assemble the updater manifest from signed release artifacts"
```

---

### Task 3: `prepareAlphaAssets.mjs` — accept the updater manifest and signatures

**Files:**
- Modify: `scripts/prepareAlphaAssets.mjs`
- Modify: `scripts/prepareAlphaAssets.test.ts`

**Interfaces:**
- Consumes: `classifyUpdaterSignature` from Task 2's `scripts/buildUpdaterManifest.mjs`.
- Produces: no change to `prepareAlphaAssets`/`collectAlphaArtifacts`'s existing exported signatures — same return shape, now including the extra accepted filenames in its output list.

- [ ] **Step 1: Write the failing tests**

In `scripts/prepareAlphaAssets.test.ts`, add a `writeCompleteSetWithUpdater` helper and new test cases. Insert this helper right after the existing `writeCompleteSet` function:

```typescript
const updaterFiles = {
  'Heartwood_universal.dmg.sig': 'darwin-signature',
  'Heartwood_x64-setup.exe.sig': 'windows-signature',
  'heartwood_amd64.AppImage.sig': 'linux-signature',
  'latest.json': '{"version":"0.1.0-alpha.4","platforms":{}}',
};

async function writeCompleteSetWithUpdater(input: string) {
  await writeCompleteSet(input);
  for (const [name, contents] of Object.entries(updaterFiles)) {
    await writeFile(path.join(input, name), contents);
  }
}
```

Add these test cases at the end of the `describe('alpha release assets', ...)` block, immediately before its closing `});`:

```typescript
  it('accepts exactly one latest.json plus its platform signature files', async () => {
    const { input, output } = await fixture();
    await writeCompleteSetWithUpdater(input);

    const filenames = await prepareAlphaAssets(input, output);

    expect(filenames).toEqual([...names, ...Object.keys(updaterFiles)].sort());
    expect((await readdir(output)).sort()).toEqual(
      [...names, ...Object.keys(updaterFiles), 'SHA256SUMS.txt'].sort(),
    );
    expect(await readFile(path.join(output, 'latest.json'), 'utf8')).toBe(updaterFiles['latest.json']);
  });

  it('rejects a second latest.json', async () => {
    const { input, output } = await fixture();
    await writeCompleteSetWithUpdater(input);
    await mkdir(path.join(input, 'nested'), { recursive: true });
    await writeFile(path.join(input, 'nested', 'latest.json'), '{}');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(/duplicate artifact filename.*latest\.json/i);
  });

  it('rejects an unrecognized signature suffix', async () => {
    const { input, output } = await fixture();
    await writeCompleteSetWithUpdater(input);
    await writeFile(path.join(input, 'Heartwood_amd64.deb.sig'), 'not a real updater target');

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(/unrecognized updater signature/i);
  });

  it('still requires the four installer kinds even when updater files are present', async () => {
    const { input, output } = await fixture();
    await mkdir(input, { recursive: true });
    for (const [name, contents] of Object.entries(updaterFiles)) {
      await writeFile(path.join(input, name), contents);
    }

    await expect(prepareAlphaAssets(input, output)).rejects.toThrow(/missing required artifact kinds/i);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/prepareAlphaAssets.test.ts`
Expected: FAIL — the new cases fail because `latest.json`/`.sig` files are currently rejected as `Unsupported artifact`.

- [ ] **Step 3: Extend `prepareAlphaAssets.mjs`**

In `scripts/prepareAlphaAssets.mjs`, add the import and change `classify`/`collectAlphaArtifacts` to special-case updater files. Add this import at the top, alongside the existing imports:

```javascript
import { classifyUpdaterSignature } from './buildUpdaterManifest.mjs';
```

Replace the existing `classify` function:

```javascript
function classify(filename) {
  for (const [suffix, kind] of REQUIRED) {
    if (filename.endsWith(suffix)) return kind;
  }
  throw new Error(`Unsupported artifact: ${filename}`);
}
```

with:

```javascript
function classify(filename) {
  for (const [suffix, kind] of REQUIRED) {
    if (filename.endsWith(suffix)) return kind;
  }
  if (filename === 'latest.json') return 'updater-manifest';
  if (filename.endsWith('.sig')) {
    // Throws its own descriptive error for an unrecognized suffix — let
    // it propagate as-is rather than wrapping it in "Unsupported artifact".
    classifyUpdaterSignature(filename);
    return 'updater-signature';
  }
  throw new Error(`Unsupported artifact: ${filename}`);
}
```

`collectAlphaArtifacts` already builds `artifactsByKind` keyed by `classify()`'s return value and only *requires* the four kinds in `REQUIRED`'s values — `updater-manifest` and `updater-signature` are new kinds it will happily collect without requiring them, **except** it currently returns only `[...REQUIRED.values()].map(...)`, which would silently drop the updater files from the output. Update the end of `collectAlphaArtifacts` (the code after `const missing = ...` and its `if` block) from:

```javascript
  return [...REQUIRED.values()].map((kind) => artifactsByKind.get(kind));
```

to:

```javascript
  return [...artifactsByKind.values()];
```

This also requires `artifactsByKind` to preserve deterministic ordering — `Map` already iterates in insertion order, and `regularFiles` already sorts its input alphabetically by directory traversal, so this stays deterministic. Note `collectAlphaArtifacts`'s one existing test (`'recursively collects exactly one artifact of each required kind'`) asserts an exact ordering matching `REQUIRED`'s declaration order (`macos, windows, linux-appimage, linux-deb`) — with this change the order instead follows file-discovery order. Since `writeCompleteSet`'s fixture writes `names` in that same macos/windows/appimage/deb order across four different subdirectories that themselves sort alphabetically as `linux/appimage`, `linux/deb`, `mac/deep`, `windows` (alphabetical), verify this existing test still passes after the change — if it fails on ordering, fix the existing test's `toEqual` expectation to sort by kind first (`.sort((a, b) => a.kind.localeCompare(b.kind))` on both sides) rather than changing production behavior back, since exact discovery-order dependence was never a real contract.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/prepareAlphaAssets.test.ts`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add scripts/prepareAlphaAssets.mjs scripts/prepareAlphaAssets.test.ts
git commit -m "feat: accept the updater manifest and signatures in release assets"
```

---

### Task 4: Wire CI — signing secrets and the manifest-build step

**Files:**
- Modify: `.github/workflows/release-alpha.yml`

**Interfaces:**
- Consumes: `scripts/buildUpdaterManifest.mjs`'s CLI (Task 2), `scripts/prepareAlphaAssets.mjs`'s CLI (Task 3, unchanged invocation).
- Produces: nothing consumed by later tasks — this is CI-only, exercised for real only on the next tagged alpha push.

- [ ] **Step 1: Add signing env vars to the `build` job's `tauri-action` step**

In `.github/workflows/release-alpha.yml`, find the `Build native installer` step:

```yaml
      - name: Build native installer
        uses: tauri-apps/tauri-action@v1
        env:
          APPLE_SIGNING_IDENTITY: ${{ runner.os == 'macOS' && '-' || '' }}
        with:
          args: --target ${{ matrix.target }} --bundles ${{ matrix.bundles }}
          uploadWorkflowArtifacts: true
          workflowArtifactNamePattern: '[platform]-[arch]-[bundle]'
```

Change its `env` block to:

```yaml
      - name: Build native installer
        uses: tauri-apps/tauri-action@v1
        env:
          APPLE_SIGNING_IDENTITY: ${{ runner.os == 'macOS' && '-' || '' }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          args: --target ${{ matrix.target }} --bundles ${{ matrix.bundles }}
          uploadWorkflowArtifacts: true
          workflowArtifactNamePattern: '[platform]-[arch]-[bundle]'
```

Do not add these secrets to the repository yourself — they must already exist (added by the maintainer per Task 8's docs) before this step can produce real signatures. Until they exist, `tauri-action` builds unsigned installers exactly as it does today (the env vars are empty strings, which `tauri-action` treats as "signing disabled") — this step's change is inert, not breaking, until the secrets are added.

- [ ] **Step 2: Add the manifest-build step to the `release` job**

In the same file, find the `release` job's `Validate and prepare release assets` step:

```yaml
      - name: Validate and prepare release assets
        run: node scripts/prepareAlphaAssets.mjs release-artifacts release-assets
```

Insert a new step immediately before it:

```yaml
      - name: Build the updater manifest
        run: >-
          node scripts/buildUpdaterManifest.mjs release-artifacts "$GITHUB_REF_NAME"
          "https://github.com/$GITHUB_REPOSITORY/releases/download/$GITHUB_REF_NAME"

      - name: Validate and prepare release assets
        run: node scripts/prepareAlphaAssets.mjs release-artifacts release-assets
```

- [ ] **Step 3: Verify the workflow YAML is well-formed**

Run: `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/release-alpha.yml'))" && echo OK`
Expected: `OK` (fails loudly on any indentation/syntax mistake from the edits above).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-alpha.yml
git commit -m "feat: sign installers and publish the updater manifest in CI"
```

**Note for the next real tagged release:** once the maintainer's signing secrets exist, the first tagged push after this task merges is the actual end-to-end verification that Tauri's bundler emits `.sig` filenames `classifyUpdaterSignature` (Task 2) recognizes. If that release job's "Build the updater manifest" step fails with "Unrecognized updater signature artifact: ...", update `DARWIN_SUFFIXES`/`WINDOWS_SUFFIXES`/`LINUX_SUFFIXES` in `scripts/buildUpdaterManifest.mjs` to include whatever suffix the failure message names, add a corresponding case to `buildUpdaterManifest.test.ts`, and re-tag.

---

### Task 5: `updateController.svelte.ts` — the update state machine

**Files:**
- Create: `src/lib/updateController.svelte.ts`
- Test: `src/lib/updateController.test.ts`
- Modify: `package.json` (add `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of the CI/manifest work — testable entirely with fakes).
- Produces (for Task 6 and Task 7): `type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'restarting'`; `interface UpdateController { readonly stage: UpdateStage; readonly version: string | null; readonly error: string | null; startCheck(): void; startDownload(): void; dismiss(): void; restart(): void; }`; `createUpdateController(options: { checkForUpdate: () => Promise<{ version: string; downloadAndInstall: () => Promise<void> } | null>; relaunch: () => Promise<void>; }): UpdateController`.

- [ ] **Step 1: Add the two npm dependencies**

In `package.json`, add to `"dependencies"`, alongside the existing `"@tauri-apps/plugin-sql": "^2.4.0",` line:

```json
    "@tauri-apps/plugin-process": "^2.4.0",
    "@tauri-apps/plugin-updater": "^2.9.0",
```

Run: `npm install`
Expected: `package-lock.json` updates with both new packages; no errors.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/updateController.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { createUpdateController } from './updateController.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createUpdateController', () => {
  it('starts idle and never checks until startCheck() is called', () => {
    const checkForUpdate = vi.fn();
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });

    expect(controller.stage).toBe('idle');
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('goes checking -> idle when no update is available', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue(null);
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });

    controller.startCheck();
    expect(controller.stage).toBe('checking');
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('idle');
    expect(controller.version).toBeNull();
  });

  it('goes checking -> available with the found version', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue({
      version: '0.1.0-alpha.4',
      downloadAndInstall: vi.fn(),
    });
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });

    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('available');
    expect(controller.version).toBe('0.1.0-alpha.4');
  });

  it('a failed check is silent: stays idle, no error', async () => {
    const checkForUpdate = vi.fn().mockRejectedValue(new Error('network down'));
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });

    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('idle');
    expect(controller.error).toBeNull();
  });

  it('startDownload() goes available -> downloading -> ready on success', async () => {
    const downloadAndInstall = deferred<void>();
    const checkForUpdate = vi.fn().mockResolvedValue({
      version: '0.1.0-alpha.4',
      downloadAndInstall: () => downloadAndInstall.promise,
    });
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });
    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    controller.startDownload();
    expect(controller.stage).toBe('downloading');

    downloadAndInstall.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('ready');
  });

  it('a failed download surfaces a dismissible, retryable error', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue({
      version: '0.1.0-alpha.4',
      downloadAndInstall: vi.fn().mockRejectedValue(new Error('checksum mismatch')),
    });
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });
    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    controller.startDownload();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('available');
    expect(controller.error).toBe("Couldn't update.");

    controller.dismiss();
    expect(controller.stage).toBe('idle');
    expect(controller.error).toBeNull();
  });

  it('restart() calls relaunch only from the ready stage', async () => {
    const relaunch = vi.fn().mockResolvedValue(undefined);
    const controller = createUpdateController({ checkForUpdate: vi.fn().mockResolvedValue(null), relaunch });

    controller.restart();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('dismiss() from available returns to idle without downloading', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue({
      version: '0.1.0-alpha.4',
      downloadAndInstall: vi.fn(),
    });
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });
    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    controller.dismiss();

    expect(controller.stage).toBe('idle');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/updateController.test.ts`
Expected: FAIL — `Cannot find module './updateController.svelte'`.

- [ ] **Step 4: Implement `updateController.svelte.ts`**

Create `src/lib/updateController.svelte.ts`:

```typescript
// Drives the update-check/download/restart state machine. Dependencies
// (checking for an update, relaunching the app) are injected exactly like
// settingsController.svelte.ts's `persist` — this module never imports
// @tauri-apps/plugin-updater or @tauri-apps/plugin-process directly, so
// tests can substitute fakes instead of a real Tauri runtime.
//
// A failed check is silent by design (see the auto-updater design spec):
// checking is opportunistic, never worth alarming a tester over, so a
// check failure simply returns to 'idle' with no error surfaced. A failed
// download/install *is* surfaced, because at that point the user has
// already explicitly asked for the update.

export type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'restarting';

export interface PendingUpdate {
  version: string;
  downloadAndInstall: () => Promise<void>;
}

export interface UpdateController {
  readonly stage: UpdateStage;
  readonly version: string | null;
  readonly error: string | null;
  startCheck(): void;
  startDownload(): void;
  dismiss(): void;
  restart(): void;
}

export function createUpdateController(options: {
  checkForUpdate: () => Promise<PendingUpdate | null>;
  relaunch: () => Promise<void>;
}): UpdateController {
  let stage = $state<UpdateStage>('idle');
  let version = $state<string | null>(null);
  let error = $state<string | null>(null);
  let pending: PendingUpdate | null = null;

  function startCheck(): void {
    if (stage !== 'idle') return;
    stage = 'checking';
    void options
      .checkForUpdate()
      .then((update) => {
        if (stage !== 'checking') return;
        if (!update) {
          stage = 'idle';
          return;
        }
        pending = update;
        version = update.version;
        stage = 'available';
      })
      .catch(() => {
        if (stage !== 'checking') return;
        stage = 'idle';
      });
  }

  function startDownload(): void {
    if (stage !== 'available' || !pending) return;
    const update = pending;
    stage = 'downloading';
    error = null;
    void update
      .downloadAndInstall()
      .then(() => {
        stage = 'ready';
      })
      .catch(() => {
        stage = 'available';
        error = "Couldn't update.";
      });
  }

  function dismiss(): void {
    stage = 'idle';
    error = null;
    pending = null;
    version = null;
  }

  function restart(): void {
    if (stage !== 'ready') return;
    stage = 'restarting';
    void options.relaunch();
  }

  return {
    get stage() {
      return stage;
    },
    get version() {
      return version;
    },
    get error() {
      return error;
    },
    startCheck,
    startDownload,
    dismiss,
    restart,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/updateController.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/updateController.svelte.ts src/lib/updateController.test.ts
git commit -m "feat: add the update-check/download/restart state machine"
```

---

### Task 6: `UpdateBanner.svelte` — the two-stage presentational banner

**Files:**
- Create: `src/lib/UpdateBanner.svelte`

**Interfaces:**
- Consumes: nothing beyond its own props (no import of `updateController.svelte.ts` — App.svelte, in Task 7, passes primitives).
- Produces: `<UpdateBanner stage version onUpdate onRestart onDismiss />`, consumed by Task 7.

- [ ] **Step 1: Implement the component**

Create `src/lib/UpdateBanner.svelte`, styled like `FirstTimeHint.svelte`'s existing banner (`role="status"`, muted background, inline action link) rather than inventing a new visual language:

```svelte
<script lang="ts">
  let {
    stage,
    version,
    onUpdate,
    onRestart,
    onDismiss,
  }: {
    stage: 'available' | 'downloading' | 'ready';
    version: string | null;
    onUpdate: () => void;
    onRestart: () => void;
    onDismiss: () => void;
  } = $props();
</script>

<p class="update-banner" role="status">
  {#if stage === 'available'}
    Heartwood {version} is available.
    <button type="button" class="action-link" onclick={onUpdate}>Update</button>
    <button type="button" class="dismiss-link" onclick={onDismiss}>Later</button>
  {:else if stage === 'downloading'}
    Downloading Heartwood {version}…
  {:else}
    Update ready.
    <button type="button" class="action-link" onclick={onRestart}>Restart now</button>
    <button type="button" class="dismiss-link" onclick={onDismiss}>Later</button>
  {/if}
</p>

<style>
  .update-banner {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .action-link,
  .dismiss-link {
    margin-left: 0.5rem;
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font-weight: 700;
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    cursor: pointer;
  }
</style>
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run check`
Expected: no new errors (this component isn't imported anywhere yet, so it's checked in isolation).

- [ ] **Step 3: Commit**

```bash
git add src/lib/UpdateBanner.svelte
git commit -m "feat: add the update-available/ready banner component"
```

---

### Task 7: Wire it into `App.svelte`

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**
- Consumes: `createUpdateController` (Task 5), `UpdateBanner` (Task 6), `check` from `@tauri-apps/plugin-updater`, `relaunch` from `@tauri-apps/plugin-process` (both added to `package.json` in Task 5).

- [ ] **Step 1: Write the failing integration tests**

In `src/App.test.ts`, find the existing mocks near the top of the file (the `vi.mock('./lib/persistence', ...)`-style blocks) and add a mock for the updater plugin. Add this near the other `vi.mock(...)` calls:

```typescript
const { checkForUpdateMock, relaunchMock } = vi.hoisted(() => ({
  checkForUpdateMock: vi.fn().mockResolvedValue(null),
  relaunchMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkForUpdateMock,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}));
```

(Match this file's existing `vi.hoisted`/`vi.mock` pattern exactly — read the top of `src/App.test.ts` first to place these alongside the existing mocks, using whatever hoisting helper name convention it already uses.)

Add a new `describe` block, placed near the other startup-behavior tests:

```typescript
describe('update banner', () => {
  it('shows the available banner once startup finishes and an update is found', async () => {
    checkForUpdateMock.mockResolvedValueOnce({
      version: '0.1.0-alpha.4',
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    });
    render(App);

    await screen.findByText(/heartwood 0\.1\.0-alpha\.4 is available/i);
  });

  it('never shows the restart-ready banner while a focus session is active', async () => {
    checkForUpdateMock.mockResolvedValueOnce({
      version: '0.1.0-alpha.4',
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    });
    render(App);
    await screen.findByText(/heartwood 0\.1\.0-alpha\.4 is available/i);

    await fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await screen.findByText(/update ready/i);

    // Start a focus session, then simulate the same "ready" stage while
    // active by re-checking that the banner disappears once a session is
    // no longer idle.
    await fireEvent.change(screen.getByPlaceholderText(/what are you focusing on/i), {
      target: { value: 'Deep work' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /start focus/i }));

    expect(screen.queryByText(/update ready/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
  });
});
```

(These two tests are a starting point exercising the two contractually-important behaviors — the banner appearing, and the idle gate hiding it. Read the existing top-of-file test setup — how `render(App)` is invoked, whether a `beforeEach` resets other mocks (session persistence, settings, etc.) — and adjust the exact task-input selector/button-name strings to match what's actually in `App.svelte`'s idle screen, since this plan's earlier reading of the file did not capture every literal label string.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/App.test.ts -t "update banner"`
Expected: FAIL — no `UpdateBanner` rendered yet.

- [ ] **Step 3: Wire `App.svelte`**

Add imports, alongside the existing `FirstTimeHint`/`RevisionSaveNotice` imports:

```typescript
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import UpdateBanner from './lib/UpdateBanner.svelte';
import { createUpdateController } from './lib/updateController.svelte';
```

Create the controller once, as a module-level `$state`-free constant (it owns its own `$state` internally, same as `revisionCoordinator`'s own instantiation pattern) — add this near where `revisionCoordinator` is created:

```typescript
const updateController = createUpdateController({
  checkForUpdate: () =>
    check().then((update) =>
      update ? { version: update.version, downloadAndInstall: () => update.downloadAndInstall() } : null,
    ),
  relaunch,
});
```

Trigger the check once, a few seconds after `ready` becomes true. Add this effect near the existing `$effect(() => { void runStartup(); ... })` block:

```typescript
  $effect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => updateController.startCheck(), 5000);
    return () => window.clearTimeout(timer);
  });
```

Compute the idle-gated visible stage — add this near the other `$derived` declarations:

```typescript
  const visibleUpdateStage = $derived.by(() => {
    if (updateController.stage === 'ready' && session.status !== 'idle') return null;
    if (updateController.stage === 'available') return 'available' as const;
    if (updateController.stage === 'downloading') return 'downloading' as const;
    if (updateController.stage === 'ready') return 'ready' as const;
    return null;
  });
```

Render the banner. Inside `<AppShell>`'s children, immediately after the existing `{#if cleanupWarning}` block and before the `{#if settingsController && session.status === 'flow' ...}` hint block:

```svelte
      {#if visibleUpdateStage}
        <UpdateBanner
          stage={visibleUpdateStage}
          version={updateController.version}
          onUpdate={() => updateController.startDownload()}
          onRestart={() => updateController.restart()}
          onDismiss={() => updateController.dismiss()}
        />
      {/if}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/App.test.ts -t "update banner"`
Expected: PASS. Then run the full file to confirm nothing else broke: `npx vitest run src/App.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte src/App.test.ts
git commit -m "feat: check for updates on launch and show the update banner"
```

---

### Task 8: Docs — maintainer signing-key setup and tester-facing notes

**Files:**
- Modify: `docs/alpha-testing.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a maintainer setup section**

In `docs/alpha-testing.md`, add a new section (placement: wherever the file's existing sections about release process/maintainer setup live — read the file first and match its heading style) with this content:

```markdown
## Enabling the auto-updater (one-time, maintainer only)

Heartwood alpha builds check GitHub for updates automatically. This requires
a signing keypair that only the maintainer generates and holds:

1. Run `npm run tauri signer generate -- -w ~/.tauri/heartwood.key` (pick any
   local path outside this repository). You'll be prompted for a password —
   remember it, it's needed again below.
2. The command prints a public key. Paste it into
   `src-tauri/tauri.conf.json`'s `plugins.updater.pubkey`, replacing the
   placeholder string, and commit that one-line change.
3. In the repository's GitHub settings, add two Actions secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`: the full contents of the private key file
     from step 1.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password from step 1.
4. Delete the local private key file once it's safely stored as a secret,
   or keep it in a password manager — never commit it, and never paste it
   into an assistant session or any file tracked by this repository.

Until both secrets exist, CI builds unsigned installers exactly as before
and the updater silently finds nothing to install — nothing breaks, the
feature just stays dormant.
```

- [ ] **Step 2: Add a tester-facing note**

In the same file's existing tester-facing summary (wherever it lists what's new/what to expect for the current alpha), add one line:

```markdown
- Heartwood now checks for updates automatically a few seconds after
  launch. If one's available you'll see a small banner — updating and
  restarting are both separate, explicit steps, and restarting never
  interrupts an active focus session.
```

- [ ] **Step 3: Commit**

```bash
git add docs/alpha-testing.md
git commit -m "docs: document auto-updater setup and tester-facing behavior"
```

---

### Task 9: Final full validation

**Files:** none (verification only).

- [ ] **Step 1: Type-check**

Run: `npm run check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 2: Full JS/TS test suite**

Run: `npm test -- --run`
Expected: all tests pass, including every test added in Tasks 2, 3, 5, and 7.

- [ ] **Step 3: Rust check and tests**

Run: `cd src-tauri && cargo check && cargo test`
Expected: both succeed with no warnings introduced by Task 1's plugin registration.

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: succeeds, matching this repo's standard pre-release validation.

- [ ] **Step 5: Commit if any of the above required fixes**

If any step above needed a fix, stage exactly the files that changed and commit:

```bash
git add -A
git commit -m "fix: address full-validation findings from the auto-updater work"
```

If nothing needed fixing, skip this step — there is nothing to commit.
