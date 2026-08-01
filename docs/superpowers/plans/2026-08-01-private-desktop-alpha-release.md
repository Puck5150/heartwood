# Private Desktop Alpha Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a repeatable, private `v0.1.0-alpha.1` desktop release with unsigned native installers for macOS, Windows, and Linux, visible CI validation, checksums, tester guidance, and structured defect intake.

**Architecture:** Keep product behavior unchanged and add a small release toolchain around the existing Tauri application. A read-only repository-policy preflight and reusable validation workflow gate a tag-only native build matrix; native jobs upload workflow artifacts, and one final job validates the complete artifact set, tag provenance, and commit-pinned release notes before creating the prerelease. Pure Node utilities own version agreement and artifact/checksum rules so those release invariants are unit-tested outside GitHub Actions.

**Tech Stack:** Node.js 24, Vitest, `yaml`, GitHub Actions, GitHub CLI, Rust stable, Tauri 2, `tauri-apps/tauri-action@v1`.

## Global Constraints

- The first alpha version is exactly `0.1.0-alpha.1`, tagged `v0.1.0-alpha.1`.
- `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the root package entry in `src-tauri/Cargo.lock` must agree.
- macOS produces one universal `.dmg` for Apple Silicon and Intel.
- Windows x86-64 produces one NSIS `.exe`.
- Linux x86-64 produces one AppImage and one `.deb`.
- The alpha is unsigned. macOS may use ad-hoc identity `-`; no certificate, notarization, updater key, or fake signing secret is introduced.
- Pull requests and pushes to `main` validate but never publish.
- Only a pushed tag matching `v*-alpha.*` may enter the release workflow.
- A prerelease is created only after validation and every native build succeeds.
- Validation and build jobs use `contents: read`; only the final release job uses `contents: write`.
- Repository release immutability is an external prerequisite. The workflow checks it through the official GET endpoint before validation or native builds and fails closed when disabled, inaccessible, or malformed.
- The immutable-release preflight alone receives `RELEASE_SETTINGS_TOKEN`, a fine-grained token limited to repository Administration read permission; this branch does not enable the setting or create the secret.
- Immediately before publication, the current remote tag must resolve to `GITHUB_SHA`, and that commit must be contained in `origin/main`.
- Release notes link to the testing guide at the exact release commit; published assets remain four installers plus `SHA256SUMS.txt`.
- No product feature, persistence behavior, database schema, audio asset, or mobile target changes in this phase.
- Current action majors follow the official August 2026 guidance: `actions/checkout@v7`, `actions/setup-node@v6`, `actions/download-artifact@v8`, and `tauri-apps/tauri-action@v1`.
- The repository's GitHub plan does not enforce protected-branch checks; a green run remains a documented human gate.

---

### Task 1: Version Agreement And Tag Gate

**Files:**
- Create: `scripts/releaseVersion.mjs`
- Create: `scripts/releaseVersion.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Defines: `ReleaseVersions = { packageVersion: string; packageLockVersion: string; packageLockRootVersion: string; tauriVersion: string; cargoVersion: string; cargoLockVersion: string }`
- Produces: `normalizeAlphaTag(tag: string): string`
- Produces: `assertVersionAgreement(versions: ReleaseVersions, tag?: string): string`
- Produces: `readRepositoryVersions(root: string): ReleaseVersions`
- Produces CLI: `node scripts/releaseVersion.mjs [vX.Y.Z-alpha.N]`
- Later workflows call `npm run release:check-version` with an optional tag argument.
- The agreement validates `package.json`, both root version fields in `package-lock.json`, `src-tauri/tauri.conf.json`, the Cargo manifest metadata, and the root `app` package in `src-tauri/Cargo.lock`.

- [ ] **Step 1: Write failing unit tests for agreement, tag validation, and repository metadata**

Create `scripts/releaseVersion.test.ts`:

```ts
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
      packageVersion: '0.1.0-alpha.1',
      packageLockVersion: '0.1.0-alpha.1',
      packageLockRootVersion: '0.1.0-alpha.1',
      tauriVersion: '0.1.0-alpha.1',
      cargoVersion: '0.1.0-alpha.1',
      cargoLockVersion: '0.1.0-alpha.1',
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- scripts/releaseVersion.test.ts
```

Expected: FAIL because `scripts/releaseVersion.mjs` does not exist.

- [ ] **Step 3: Implement the pure version contract and CLI adapter**

Create `scripts/releaseVersion.mjs` with this shape:

```js
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from '@iarna/toml';
import path from 'node:path';

const ALPHA_TAG = /^v(\d+\.\d+\.\d+-alpha\.\d+)$/;

export function normalizeAlphaTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tag must start with v.');
  const match = ALPHA_TAG.exec(tag);
  if (!match) throw new Error('Release tag must use vX.Y.Z-alpha.N.');
  return match[1];
}

export function assertVersionAgreement(versions, tag) {
  const values = [
    versions.packageVersion,
    versions.packageLockVersion,
    versions.packageLockRootVersion,
    versions.tauriVersion,
    versions.cargoVersion,
    versions.cargoLockVersion,
  ];
  if (new Set(values).size !== 1) {
    throw new Error(`Version mismatch: ${values.join(', ')}`);
  }
  if (tag && normalizeAlphaTag(tag) !== values[0]) {
    throw new Error(`Version mismatch: tag ${tag} does not match ${values[0]}.`);
  }
  return values[0];
}

export function readRepositoryVersions(root) {
  const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const packageLockVersion = packageLock.version;
  const packageLockRootVersion = packageLock.packages?.['']?.version;
  const tauriVersion = JSON.parse(
    readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
  ).version;
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  const cargoVersion = metadata.packages.find((entry) => entry.name === 'app')?.version;
  if (!cargoVersion) throw new Error('Cargo metadata did not contain the app package.');
  const cargoLock = parseToml(readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'));
  const cargoLockVersion = cargoLock.package?.find((entry) => entry.name === 'app')?.version;
  return {
    packageVersion,
    packageLockVersion,
    packageLockRootVersion,
    tauriVersion,
    cargoVersion,
    cargoLockVersion,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const version = assertVersionAgreement(readRepositoryVersions(root), process.argv[2]);
  console.log(version);
}
```

Keep command execution at the CLI boundary; the agreement function remains pure.

- [ ] **Step 4: Align every checked-in version source**

Update the npm manifest and both npm lockfile version entries mechanically:

```bash
npm version 0.1.0-alpha.1 --no-git-tag-version
```

Set the native version sources to `0.1.0-alpha.1`:

```json
// src-tauri/tauri.conf.json
"version": "0.1.0-alpha.1"
```

```toml
# src-tauri/Cargo.toml
version = "0.1.0-alpha.1"
```

Run `cargo check --manifest-path src-tauri/Cargo.toml` once to update the root
`app` entry in `src-tauri/Cargo.lock` through Cargo rather than editing the lockfile manually.

Add this package script:

```json
"release:check-version": "node scripts/releaseVersion.mjs"
```

- [ ] **Step 5: Run focused and metadata verification**

Run:

```bash
npm test -- scripts/releaseVersion.test.ts
npm run release:check-version
node scripts/releaseVersion.mjs v0.1.0-alpha.1
```

Expected: all commands pass and both CLI commands print `0.1.0-alpha.1`.

- [ ] **Step 6: Commit the version contract**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock \
  src-tauri/tauri.conf.json scripts/releaseVersion.mjs scripts/releaseVersion.test.ts
git commit -m "build: establish alpha version contract"
```

---

### Task 2: Complete Artifact Set And Checksums

**Files:**
- Create: `scripts/prepareAlphaAssets.mjs`
- Create: `scripts/prepareAlphaAssets.test.ts`

**Interfaces:**
- Defines: `AlphaArtifact = { sourcePath: string; filename: string; kind: 'macos' | 'windows' | 'linux-appimage' | 'linux-deb' }`
- Produces: `collectAlphaArtifacts(inputDir: string): Promise<AlphaArtifact[]>`
- Produces: `prepareAlphaAssets(inputDir: string, outputDir: string): Promise<string[]>`
- Produces CLI: `node scripts/prepareAlphaAssets.mjs <download-dir> <release-dir>`
- The release workflow uploads only files returned in the release directory.

- [ ] **Step 1: Write failing tests for the complete matrix and deterministic checksums**

Create temporary fixture files in `scripts/prepareAlphaAssets.test.ts` and assert:

```ts
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareAlphaAssets } from './prepareAlphaAssets.mjs';

const names = [
  'Pomodoro.Parking.Lot_0.1.0-alpha.1_universal.dmg',
  'Pomodoro.Parking.Lot_0.1.0-alpha.1_x64-setup.exe',
  'pomodoro-parking-lot_0.1.0-alpha.1_amd64.AppImage',
  'pomodoro-parking-lot_0.1.0-alpha.1_amd64.deb',
];

describe('alpha release assets', () => {
  it('flattens exactly one artifact of each required kind and writes sorted checksums', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alpha-assets-'));
    const input = path.join(root, 'input');
    const output = path.join(root, 'output');
    await mkdir(path.join(input, 'nested'), { recursive: true });
    for (const name of names) await writeFile(path.join(input, 'nested', name), name);

    expect(await prepareAlphaAssets(input, output)).toEqual([...names].sort());
    const checksums = await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
    expect(checksums.trim().split('\n').map((line) => line.split('  ')[1])).toEqual([...names].sort());
  });

  it('rejects a missing, duplicate, or unexpected installer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'alpha-assets-'));
    const input = path.join(root, 'input');
    await mkdir(input);
    await writeFile(path.join(input, names[0]), 'dmg');
    await expect(prepareAlphaAssets(input, path.join(root, 'output'))).rejects.toThrow(/missing/i);
  });
});
```

Expand the second test into separate missing, duplicate-kind, duplicate-filename,
and unsupported-extension cases so each failure message names the violated invariant.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- scripts/prepareAlphaAssets.test.ts
```

Expected: FAIL because `scripts/prepareAlphaAssets.mjs` does not exist.

- [ ] **Step 3: Implement recursive collection, exact classification, flattening, and hashing**

Implement with Node standard-library `fs/promises`, `path`, and `crypto`:

```js
const REQUIRED = new Map([
  ['.dmg', 'macos'],
  ['.exe', 'windows'],
  ['.AppImage', 'linux-appimage'],
  ['.deb', 'linux-deb'],
]);
```

`collectAlphaArtifacts` must recursively enumerate regular files, classify with
case-sensitive suffix checks, reject unsupported files, reject more than one file
of any required kind, and report every missing kind in one error. `prepareAlphaAssets`
must recreate an empty output directory, reject filename collisions, copy the four
installers, hash their bytes with SHA-256, and write sorted lines in this form:

```regex
^[0-9a-f]{64}  .+$
```

The CLI must require exactly two paths and exit nonzero with the thrown message on
failure. It must not invoke `gh` or perform network operations.

- [ ] **Step 4: Run focused verification**

```bash
npm test -- scripts/prepareAlphaAssets.test.ts
```

Expected: all complete, missing, duplicate, and unsupported-file cases pass.

- [ ] **Step 5: Commit artifact integrity tooling**

```bash
git add scripts/prepareAlphaAssets.mjs scripts/prepareAlphaAssets.test.ts
git commit -m "build: validate alpha release artifacts"
```

---

### Task 3: Reusable Continuous Integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `scripts/githubAutomation.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces reusable workflow: `.github/workflows/ci.yml` via `workflow_call`
- Produces visible checks on `pull_request` and pushes to `main`
- The release workflow in Task 4 consumes the reusable workflow as job `validate`.

- [ ] **Step 1: Add the structured YAML parser used by configuration tests**

```bash
npm install --save-dev yaml
```

Commit lockfile changes only with this task.

- [ ] **Step 2: Write a failing structural test for CI triggers, permissions, and commands**

Create `scripts/githubAutomation.test.ts` with a helper that parses YAML rather
than searching raw strings:

```ts
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

function workflow(name: string) {
  return parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
}

describe('GitHub automation', () => {
  it('validates pull requests, main pushes, and reusable callers with read-only contents', () => {
    const ci = workflow('ci.yml');
    expect(ci.on).toHaveProperty('pull_request');
    expect(ci.on.push.branches).toEqual(['main']);
    expect(ci.on).toHaveProperty('workflow_call');
    expect(ci.permissions).toEqual({ contents: 'read' });

    const commands = ci.jobs.validate.steps.flatMap((step: { run?: string }) => step.run ?? []);
    expect(commands).toContain('npm ci');
    expect(commands).toContain('npm run release:check-version');
    expect(commands).toContain('npm run check');
    expect(commands).toContain('npm test');
    expect(commands).toContain('npm run build');
    expect(commands).toContain('cargo check --manifest-path src-tauri/Cargo.toml');
    expect(commands).toContain('cargo test --manifest-path src-tauri/Cargo.toml');
  });
});
```

- [ ] **Step 3: Run the structural test and verify RED**

```bash
npm test -- scripts/githubAutomation.test.ts
```

Expected: FAIL because `.github/workflows/ci.yml` does not exist.

- [ ] **Step 4: Implement `.github/workflows/ci.yml`**

Use these exact trigger and permission boundaries:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  workflow_call:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Create one `validate` job on `ubuntu-22.04`. Its ordered steps are:

1. `actions/checkout@v7`
2. Install `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`,
   `patchelf`, and `xdg-utils`
3. `actions/setup-node@v6` with Node `24` and npm cache
4. `dtolnay/rust-toolchain@stable`
5. `swatinem/rust-cache@v2` with `./src-tauri -> target`
6. Each validated command as its own named step, in the order asserted above

Do not grant write permission, use repository secrets, upload releases, or trigger
on tags in this workflow.

- [ ] **Step 5: Run the focused workflow test and local validation commands**

```bash
npm test -- scripts/githubAutomation.test.ts
npm run release:check-version
npm run check
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: YAML assertions pass and every existing project check remains green.

- [ ] **Step 6: Commit reusable CI**

```bash
git add .github/workflows/ci.yml scripts/githubAutomation.test.ts package.json package-lock.json
git commit -m "ci: validate desktop application changes"
```

---

### Task 4: Tag-Only Cross-Platform Prerelease Workflow

**Files:**
- Create: `.github/workflows/release-alpha.yml`
- Modify: `scripts/githubAutomation.test.ts`
- Consume: `scripts/releaseVersion.mjs`
- Consume: `scripts/prepareAlphaAssets.mjs`
- Consume later: `docs/alpha-release-notes.md` from Task 5

**Interfaces:**
- Consumes secret `RELEASE_SETTINGS_TOKEN` only in job `preflight` to call `GET /repos/{owner}/{repo}/immutable-releases`
- Consumes reusable CI job from `.github/workflows/ci.yml`
- Produces workflow artifacts from native matrix job `build`
- Consumes `__RELEASE_COMMIT_SHA__` in `docs/alpha-release-notes.md` and renders it with `GITHUB_SHA`
- Produces GitHub prerelease only from final job `release`, after current remote-tag and `main` ancestry checks

- [ ] **Step 1: Extend configuration tests with release safety invariants**

Add assertions that:

```ts
it('publishes only a complete tag-triggered alpha matrix', () => {
  const release = workflow('release-alpha.yml');
  expect(release.on.push.tags).toEqual(['v*-alpha.*']);
  expect(release.on).not.toHaveProperty('pull_request');
  expect(release.permissions).toEqual({ contents: 'read' });
  expect(release.jobs.preflight.permissions).toEqual({ contents: 'read' });
  expect(release.jobs.validate.needs).toBe('preflight');
  expect(release.jobs.validate.uses).toBe('./.github/workflows/ci.yml');
  expect(release.jobs.build.needs).toBe('validate');
  expect(release.jobs.release.needs).toBe('build');
  expect(release.jobs.release.permissions).toEqual({ contents: 'write' });

  const matrix = release.jobs.build.strategy.matrix.include;
  expect(matrix.map((entry: { bundles: string }) => entry.bundles)).toEqual([
    'dmg',
    'nsis',
    'appimage,deb',
  ]);
});
```

Also assert that no build-matrix job contains `contents: write`, `gh release`,
`tagName`, `releaseName`, or `releaseId`.

- [ ] **Step 2: Run the release workflow test and verify RED**

```bash
npm test -- scripts/githubAutomation.test.ts
```

Expected: FAIL because `.github/workflows/release-alpha.yml` does not exist.

- [ ] **Step 3: Implement the validation and native build graph**

Create `.github/workflows/release-alpha.yml` with a read-only `preflight` job
that calls `GET /repos/{owner}/{repo}/immutable-releases` using API version
`2026-03-10`, requires `.enabled == true`, and receives the fine-grained
`RELEASE_SETTINGS_TOKEN` only on that step. A missing token, inaccessible
endpoint, disabled setting, or unexpected response must stop the workflow
before reusable validation and native packaging. Continue with:

```yaml
name: Alpha release

on:
  push:
    tags: ['v*-alpha.*']

permissions:
  contents: read

jobs:
  preflight:
    runs-on: ubuntu-22.04
    permissions:
      contents: read

  validate:
    needs: preflight
    uses: ./.github/workflows/ci.yml

  build:
    needs: validate
    permissions:
      contents: read
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            bundles: dmg
            target: universal-apple-darwin
            rustTargets: aarch64-apple-darwin,x86_64-apple-darwin
          - platform: windows-latest
            bundles: nsis
            target: x86_64-pc-windows-msvc
            rustTargets: x86_64-pc-windows-msvc
          - platform: ubuntu-22.04
            bundles: appimage,deb
            target: x86_64-unknown-linux-gnu
            rustTargets: x86_64-unknown-linux-gnu
    runs-on: ${{ matrix.platform }}
```

Each matrix leg checks out with `actions/checkout@v7`, installs Linux dependencies
only on Ubuntu, sets up Node 24 with `actions/setup-node@v6`, installs Rust stable
with the matrix targets, enables `swatinem/rust-cache@v2`, runs `npm ci`, and runs:

```bash
node scripts/releaseVersion.mjs "$GITHUB_REF_NAME"
```

Then call `tauri-apps/tauri-action@v1` without release fields:

```yaml
- uses: tauri-apps/tauri-action@v1
  env:
    APPLE_SIGNING_IDENTITY: ${{ runner.os == 'macOS' && '-' || '' }}
  with:
    args: --target ${{ matrix.target }} --bundles ${{ matrix.bundles }}
    uploadWorkflowArtifacts: true
    workflowArtifactNamePattern: '[platform]-[arch]-[bundle]'
```

The macOS `-` identity is ad-hoc and introduces no certificate or secret.

- [ ] **Step 4: Implement the final release job**

The `release` job must depend on the whole matrix through `needs: build`, run on
`ubuntu-22.04`, and alone declare:

```yaml
permissions:
  contents: write
```

Its steps:

1. Checkout with `actions/checkout@v7`, `fetch-depth: 0`, and
   `persist-credentials: false`.
2. Setup Node 24 with `actions/setup-node@v6`.
3. Download all matrix artifacts to `release-artifacts` with
   `actions/download-artifact@v8`, `pattern: '*-*-*'`, and `merge-multiple: true`.
4. Run `node scripts/prepareAlphaAssets.mjs release-artifacts release-assets`.
5. Render `docs/alpha-release-notes.md` to a temporary file, replacing
   `__RELEASE_COMMIT_SHA__` with `GITHUB_SHA` and rejecting an unresolved marker.
6. In the final token-scoped step, configure Git authentication, force-fetch the
   current remote `main` and tag, peel the tag to a commit, require that commit
   to equal `GITHUB_SHA`, require `GITHUB_SHA` to be an ancestor of
   `origin/main`, and create the prerelease through the preinstalled GitHub CLI:

```bash
gh release create "$GITHUB_REF_NAME" release-assets/* \
  --verify-tag \
  --prerelease \
  --title "Pomodoro Parking Lot $GITHUB_REF_NAME" \
  --notes-file "$RUNNER_TEMP/alpha-release-notes.md"
```

Set `GH_TOKEN: ${{ github.token }}` only on the combined final provenance and
release-creation step. Do not use `--latest`, updater JSON, draft mutation, or a
release command in any earlier job.

- [ ] **Step 5: Verify workflow structure and artifact tooling together**

```bash
npm test -- scripts/githubAutomation.test.ts scripts/prepareAlphaAssets.test.ts scripts/releaseVersion.test.ts
npm run release:check-version
git diff --check
```

Expected: workflow parsing and every release invariant pass locally.

- [ ] **Step 6: Commit the release workflow**

```bash
git add .github/workflows/release-alpha.yml scripts/githubAutomation.test.ts
git commit -m "ci: package complete desktop alpha releases"
```

---

### Task 5: Tester Guide, Release Notes, And Defect Intake

**Files:**
- Create: `docs/alpha-testing.md`
- Create: `docs/alpha-release-notes.md`
- Create: `.github/ISSUE_TEMPLATE/alpha-defect.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Modify: `scripts/githubAutomation.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- The release workflow consumes `docs/alpha-release-notes.md` as a template and
  replaces its single `__RELEASE_COMMIT_SHA__` marker with the trusted workflow commit.
- Testers consume `docs/alpha-testing.md` as the complete smoke and feedback guide.
- GitHub consumes `.github/ISSUE_TEMPLATE/alpha-defect.yml` as a structured issue form.

- [ ] **Step 1: Write failing tests for tester-facing release metadata**

Extend `scripts/githubAutomation.test.ts` using the same YAML parser:

```ts
it('requires reproducible and privacy-conscious alpha defect reports', () => {
  const form = parse(readFileSync('.github/ISSUE_TEMPLATE/alpha-defect.yml', 'utf8'));
  expect(form.name).toMatch(/alpha defect/i);
  expect(form.labels).toContain('bug');
  const ids = form.body.map((field: { id?: string }) => field.id).filter(Boolean);
  expect(ids).toEqual(expect.arrayContaining([
    'alpha-version',
    'platform',
    'artifact',
    'reproduction',
    'expected',
    'actual',
    'data-impact',
  ]));
  expect(JSON.stringify(form)).toMatch(/remove.*private|redact.*private/i);
});

it('ships alpha notes and a full smoke checklist', () => {
  const releaseNotes = readFileSync('docs/alpha-release-notes.md', 'utf8');
  const guide = readFileSync('docs/alpha-testing.md', 'utf8');
  expect(releaseNotes).toMatch(/unsigned/i);
  expect(releaseNotes).toMatch(/SHA256SUMS\.txt/);
  expect(guide).toMatch(/Gatekeeper/);
  expect(guide).toMatch(/SmartScreen/);
  expect(guide).toMatch(/backup/i);
  expect(guide).toMatch(/sleep.*wake/is);
});
```

- [ ] **Step 2: Run the metadata tests and verify RED**

```bash
npm test -- scripts/githubAutomation.test.ts
```

Expected: FAIL because the guide, notes, and issue form do not exist.

- [ ] **Step 3: Write `docs/alpha-release-notes.md`**

Keep this version-neutral because the GitHub release title carries the exact tag.
Include:

- Private desktop alpha warning
- Artifact map: universal `.dmg`, x64 NSIS `.exe`, x64 AppImage, x64 `.deb`
- A statement that macOS and Windows packages are unsigned
- Normal Gatekeeper and SmartScreen launch paths without disabling security
- AppImage `chmod +x` guidance and `.deb` alternative
- `SHA256SUMS.txt` verification purpose
- Commit-pinned link to `docs/alpha-testing.md` using `__RELEASE_COMMIT_SHA__`
- Local-data backup warning before deletion testing
- Desktop-only, no automatic updates, no mobile build, no therapeutic claims

- [ ] **Step 4: Write `docs/alpha-testing.md`**

Turn every checklist section in the approved spec into checkboxes. Add exact backup
orientation based on identifier `com.pomodoroparkinglot.app`:

```text
macOS: ~/Library/Application Support/com.pomodoroparkinglot.app
Windows: %APPDATA%\com.pomodoroparkinglot.app
Linux: $XDG_DATA_HOME/com.pomodoroparkinglot.app or ~/.local/share/com.pomodoroparkinglot.app
```

State that **Open Notes Folder** is the authoritative in-app way to locate Markdown
notes, and that testers should quit the app before copying the whole app-data folder.
Include the roles for owner, usability tester, and developer tester; blocker severity;
first install; upgrade; timer recovery; notes and revisions; history/export/deletion;
soundscapes and tones; appearance; accessibility; sleep/wake; and feedback steps.

- [ ] **Step 5: Add the structured issue form**

Create `.github/ISSUE_TEMPLATE/alpha-defect.yml` with:

```yaml
name: Alpha defect
description: Report a reproducible problem in a private alpha build
title: '[Alpha]: '
labels: [bug]
body:
  - type: markdown
    attributes:
      value: Remove or redact private note and parked-thought content before attaching files.
  - type: input
    id: alpha-version
    attributes:
      label: Alpha version
      placeholder: v0.1.0-alpha.1
    validations:
      required: true
  - type: dropdown
    id: platform
    attributes:
      label: Platform
      options: [macOS, Windows, Linux]
    validations:
      required: true
```

Add required `artifact`, `reproduction`, `expected`, `actual`, and `data-impact`
fields. Add optional sanitized logs/screenshots and additional-context fields. Create
`.github/ISSUE_TEMPLATE/config.yml` with `blank_issues_enabled: false` and no contact
links.

- [ ] **Step 6: Link the alpha guide and record the phase**

Add a short `Private alpha testing` section to `README.md` linking both alpha docs.
Add a newest-first `Alpha release readiness` entry to `CHANGELOG.md` describing
version agreement, visible CI, the complete native matrix, immutable prereleases,
checksums, tester guidance, and explicitly deferred signed/mobile distribution.

- [ ] **Step 7: Run focused documentation/configuration verification**

```bash
npm test -- scripts/githubAutomation.test.ts
npm run check
git diff --check
```

Expected: issue form parses, required fields are present, documentation assertions
pass, and application type checks remain unchanged.

- [ ] **Step 8: Commit tester materials**

```bash
git add .github/ISSUE_TEMPLATE docs/alpha-testing.md docs/alpha-release-notes.md \
  scripts/githubAutomation.test.ts README.md CHANGELOG.md
git commit -m "docs: prepare private desktop alpha testing"
```

---

### Task 6: Final Local Verification And GitHub Handoff

**Files:**
- Verify all files changed in Tasks 1-5
- Do not create or push an alpha tag in this task

**Interfaces:**
- Produces a PR-ready branch with local evidence.
- GitHub validates the workflow syntax and executes CI after push.
- Actual tag creation remains a separate, explicit post-merge release decision.

- [ ] **Step 1: Run the complete frontend and release-tool suite**

```bash
npm run release:check-version
node scripts/releaseVersion.mjs v0.1.0-alpha.1
npm run check
npm test
npm run build
```

Expected: version commands print `0.1.0-alpha.1`, Svelte/TypeScript report zero
diagnostics, all Vitest files pass, and Vite builds successfully.

- [ ] **Step 2: Run the complete Rust suite**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: both commands exit zero with the alpha package version.

- [ ] **Step 3: Verify release fixtures and repository cleanliness**

```bash
npm test -- scripts/releaseVersion.test.ts scripts/prepareAlphaAssets.test.ts scripts/githubAutomation.test.ts
git diff --check
git status --short --branch
```

Expected: all focused release tests pass, no whitespace errors exist in the new
diff, and only intentional task files differ from the base branch.

- [ ] **Step 4: Review workflow policy line by line**

Confirm from parsed YAML and source that:

- CI has no write permission or release command.
- Release packaging has no write permission.
- Only the final release job has `contents: write`.
- The read-only preflight fails unless release immutability is enabled and its
  scoped `RELEASE_SETTINGS_TOKEN` can read the official endpoint.
- The final job depends on the complete matrix.
- The final checkout does not persist credentials and fetches complete history.
- Final publication force-fetches and peels the current remote tag, checks it
  against `GITHUB_SHA`, and requires that commit to belong to `origin/main`.
- The rendered release notes pin the testing guide to `GITHUB_SHA` and upload no
  additional guide asset.
- The release workflow has no `workflow_dispatch`, branch, or pull-request trigger.
- No certificate, notarization, updater, or mobile configuration was introduced;
  the only new secret contract is the scoped read-only settings token above.

- [ ] **Step 5: Commit any verification-only correction**

If verification required a correction, rerun the affected focused test and full gate.
Run `git diff --name-only`, stage each corrected path explicitly, and commit only
those paths:

```bash
git commit -m "fix: complete alpha release verification"
```

If no correction was needed, do not create an empty commit.

- [ ] **Step 6: Push and open a draft pull request**

Use the repository's PR workflow. The PR body must summarize the platform matrix,
version contract, no-partial-release invariant, unsigned limitation, checks run,
and the fact that no alpha tag has been pushed.

- [ ] **Step 7: Observe GitHub CI before requesting review**

Wait for the new `CI / validate` check. If GitHub rejects workflow syntax or a Linux
dependency/build step fails, inspect the exact log, fix the branch, rerun the complete
local gate, and push normally without force.

- [ ] **Step 8: Keep release publication behind a fresh confirmation**

After this branch is reviewed, merged, and `main` CI is green, present the exact
commit and proposed tag `v0.1.0-alpha.1`. Push that tag only after the owner explicitly
confirms publishing the private alpha. Then observe all native jobs and verify the
prerelease contains exactly four installers plus `SHA256SUMS.txt` before directing
testers to it.
