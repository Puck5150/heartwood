import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, boolean | string>;
};

function workflow(name: string) {
  return parse(
    readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'),
  );
}

function projectFile(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('GitHub automation', () => {
  it('validates pull requests, main pushes, and reusable callers with read-only contents', () => {
    const ci = workflow('ci.yml');

    expect(Object.keys(ci.on).sort()).toEqual([
      'pull_request',
      'push',
      'workflow_call',
    ]);
    expect(ci.on).toHaveProperty('pull_request');
    expect(ci.on.push.branches).toEqual(['main']);
    expect(ci.on.push).not.toHaveProperty('tags');
    expect(ci.on).toHaveProperty('workflow_call');
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(ci.concurrency).toEqual({
      group: 'ci-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    });

    const validate = ci.jobs.validate;
    expect(validate).not.toHaveProperty('permissions');
    expect(validate['runs-on']).toBe('ubuntu-22.04');

    const steps = validate.steps as WorkflowStep[];
    expect(steps[0].uses).toBe('actions/checkout@v7');
    expect(steps[1].run).toContain('libwebkit2gtk-4.1-dev');
    expect(steps[1].run).toContain('libappindicator3-dev');
    expect(steps[1].run).toContain('librsvg2-dev');
    expect(steps[1].run).toContain('patchelf');
    expect(steps[1].run).toContain('xdg-utils');
    expect(steps[2]).toMatchObject({
      uses: 'actions/setup-node@v6',
      with: { 'node-version': '24', cache: 'npm' },
    });
    expect(steps[3].uses).toBe('dtolnay/rust-toolchain@stable');
    expect(steps[4]).toMatchObject({
      uses: 'swatinem/rust-cache@v2',
      with: { workspaces: './src-tauri -> target' },
    });

    expect(steps.slice(5).map((step) => step.run)).toEqual([
      'npm ci',
      'npm run release:check-version',
      'npm run check',
      'npm test',
      'npm run build',
      'cargo check --manifest-path src-tauri/Cargo.toml',
      'cargo test --manifest-path src-tauri/Cargo.toml',
    ]);
  });

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

    const preflight = release.jobs.preflight;
    expect(preflight['runs-on']).toBe('ubuntu-22.04');
    expect(preflight.permissions).toEqual({ contents: 'read' });
    const preflightSteps = preflight.steps as WorkflowStep[];
    expect(preflightSteps).toHaveLength(1);
    expect(preflightSteps[0].env).toEqual({
      GH_TOKEN: '${{ secrets.RELEASE_SETTINGS_TOKEN }}',
    });
    expect(preflightSteps[0].run).toContain(
      'repos/$GITHUB_REPOSITORY/immutable-releases',
    );
    expect(preflightSteps[0].run).toContain(
      'X-GitHub-Api-Version: 2026-03-10',
    );
    expect(preflightSteps[0].run).toContain("--jq '.enabled'");
    expect(preflightSteps[0].run).toMatch(/!=\s*"true"/);
    const serializedPreflight = JSON.stringify(preflight);
    expect(serializedPreflight).not.toContain('contents":"write');
    expect(serializedPreflight).not.toContain('github.token');
    expect(serializedPreflight).not.toContain('gh release');

    const validate = release.jobs.validate;
    expect(validate).toEqual({
      needs: 'preflight',
      uses: './.github/workflows/ci.yml',
    });

    const build = release.jobs.build;
    expect(build.needs).toBe('validate');
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(build['runs-on']).toBe('${{ matrix.platform }}');
    expect(build.strategy['fail-fast']).toBe(false);
    expect(build.strategy.matrix.include).toEqual([
      {
        platform: 'macos-latest',
        // 'app' is what emits the .app.tar.gz updater artifact.
        bundles: 'dmg,app',
        target: 'universal-apple-darwin',
        rustTargets: 'aarch64-apple-darwin,x86_64-apple-darwin',
      },
      {
        platform: 'windows-latest',
        bundles: 'nsis',
        target: 'x86_64-pc-windows-msvc',
        rustTargets: 'x86_64-pc-windows-msvc',
      },
      {
        platform: 'ubuntu-22.04',
        bundles: 'appimage,deb',
        target: 'x86_64-unknown-linux-gnu',
        rustTargets: 'x86_64-unknown-linux-gnu',
      },
    ]);

    const buildSteps = build.steps as WorkflowStep[];
    expect(buildSteps.map((step) => step.uses ?? step.run)).toEqual([
      'actions/checkout@v7',
      expect.stringContaining('libwebkit2gtk-4.1-dev'),
      'actions/setup-node@v6',
      'dtolnay/rust-toolchain@stable',
      'swatinem/rust-cache@v2',
      'npm ci',
      'node scripts/releaseVersion.mjs "$GITHUB_REF_NAME"',
      'tauri-apps/tauri-action@v1',
      'actions/upload-artifact@v7',
    ]);
    expect(buildSteps[1]).toMatchObject({ if: "runner.os == 'Linux'" });
    expect(buildSteps[2].with).toEqual({ 'node-version': '24', cache: 'npm' });
    expect(buildSteps[3].with).toEqual({ targets: '${{ matrix.rustTargets }}' });
    expect(buildSteps[4].with).toEqual({ workspaces: './src-tauri -> target' });
    expect(buildSteps[6]).toMatchObject({
      run: 'node scripts/releaseVersion.mjs "$GITHUB_REF_NAME"',
      shell: 'bash',
    });
    expect(buildSteps[7]).toMatchObject({
      env: { APPLE_SIGNING_IDENTITY: "${{ runner.os == 'macOS' && '-' || '' }}" },
      with: {
        // --no-sign keeps unsigned builds from hard-failing on an empty secret,
        // but never on macOS — dropping 'app' there disables updater signing
        // without disabling the ad-hoc codesign the .app needs to launch.
        args:
          '--target ${{ matrix.target }} ' +
          "--bundles ${{ matrix.platform == 'macos-latest' && secrets.TAURI_SIGNING_PRIVATE_KEY == '' && 'dmg' || matrix.bundles }} " +
          "${{ secrets.TAURI_SIGNING_PRIVATE_KEY == '' && matrix.platform != 'macos-latest' && '--no-sign' || '' }}",
        uploadWorkflowArtifacts: true,
        workflowArtifactNamePattern: '[platform]-[arch]-[bundle]',
      },
    });
    expect(buildSteps[8]).toMatchObject({
      uses: 'actions/upload-artifact@v7',
      with: {
        name: '${{ matrix.platform }}-${{ matrix.target }}-updater',
        // tauri-action's own allowlist never uploads .sig or updater payloads.
        path: expect.stringContaining('release/bundle/**/*.sig'),
        'if-no-files-found': 'ignore',
      },
    });

    const serializedBuild = JSON.stringify(build);
    expect(serializedBuild).not.toContain('contents":"write');
    expect(serializedBuild).not.toMatch(/gh release|tagName|releaseName|releaseId/);

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

    const releaseJob = release.jobs.release;
    expect(releaseJob.needs).toEqual(['build', 'build-android']);
    expect(releaseJob['runs-on']).toBe('ubuntu-22.04');
    expect(releaseJob.permissions).toEqual({ contents: 'write' });

    const releaseSteps = releaseJob.steps as WorkflowStep[];
    expect(releaseSteps[0]).toMatchObject({
      uses: 'actions/checkout@v7',
      with: { 'fetch-depth': 0, 'persist-credentials': false },
    });
    expect(releaseSteps[1]).toMatchObject({
      uses: 'actions/setup-node@v6',
      with: { 'node-version': '24', cache: 'npm' },
    });
    expect(releaseSteps[2]).toMatchObject({
      uses: 'actions/download-artifact@v8',
      with: {
        path: 'release-artifacts',
        pattern: '*-*-*',
        'merge-multiple': true,
      },
    });
    expect(releaseSteps[3].run).toContain(
      'node scripts/buildUpdaterManifest.mjs release-artifacts "$GITHUB_REF_NAME"',
    );
    expect(releaseSteps[3].run).toContain(
      'https://github.com/$GITHUB_REPOSITORY/releases/download/$GITHUB_REF_NAME',
    );

    expect(releaseSteps[4].env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(releaseSteps[4].run).toContain('release-artifacts/latest.json');
    expect(releaseSteps[4].run).toContain('gh auth setup-git');
    expect(releaseSteps[4].run).toContain('git fetch origin main');
    expect(releaseSteps[4].run).toContain('git worktree add "$RUNNER_TEMP/main-worktree" origin/main');
    expect(releaseSteps[4].run).toContain('docs/updates/latest.json');
    // Staged before the "anything changed?" check — an unstaged git diff
    // ignores untracked files, which would silently skip the very first
    // publish (docs/updates/latest.json doesn't exist on main yet).
    const publishScript = releaseSteps[4].run ?? '';
    const addIndex = publishScript.indexOf('git add docs/updates/latest.json');
    const diffCheckIndex = publishScript.indexOf('git diff --cached --quiet');
    const pushIndex = publishScript.indexOf('git push origin HEAD:main');
    expect(addIndex).toBeGreaterThan(-1);
    expect(diffCheckIndex).toBeGreaterThan(addIndex);
    expect(pushIndex).toBeGreaterThan(diffCheckIndex);

    expect(releaseSteps[5].run).toBe(
      'node scripts/prepareBetaAssets.mjs release-artifacts release-assets',
    );
    expect(releaseSteps[6].run).toContain(
      's/__RELEASE_COMMIT_SHA__/$GITHUB_SHA/g',
    );
    expect(releaseSteps[6].run).toContain(
      '$RUNNER_TEMP/beta-release-notes.md',
    );
    expect(releaseSteps[6]).not.toHaveProperty('env');

    expect(releaseSteps[7].env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(releaseSteps[7].run).toContain('gh auth setup-git');
    expect(releaseSteps[7].run).toContain('refs/heads/main:refs/remotes/origin/main');
    expect(releaseSteps[7].run).toContain(
      'refs/tags/$GITHUB_REF_NAME:refs/tags/$GITHUB_REF_NAME',
    );
    expect(releaseSteps[7].run).toContain(
      'git rev-parse "$GITHUB_REF_NAME^{commit}"',
    );
    expect(releaseSteps[7].run).toMatch(/tag_commit.*GITHUB_SHA/s);
    expect(releaseSteps[7].run).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    );
    expect(releaseSteps[7].run).toContain('gh release create "$GITHUB_REF_NAME"');
    expect(releaseSteps[7].run).toContain('release-assets/*');
    expect(releaseSteps[7].run).toContain('--verify-tag');
    expect(releaseSteps[7].run).toContain('--prerelease');
    expect(releaseSteps[7].run).toContain(
      '--title "Heartwood $GITHUB_REF_NAME"',
    );
    expect(releaseSteps[7].run).toContain(
      '--notes-file "$RUNNER_TEMP/beta-release-notes.md"',
    );
    expect(releaseSteps[7].run).not.toContain('--latest');

    const publicationCommand = releaseSteps[7].run ?? '';
    const fetchIndex = publicationCommand.indexOf('git fetch --force');
    const peelIndex = publicationCommand.indexOf('git rev-parse');
    const ancestryIndex = publicationCommand.indexOf('git merge-base --is-ancestor');
    const releaseIndex = publicationCommand.indexOf('gh release create');
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(peelIndex).toBeGreaterThan(fetchIndex);
    expect(ancestryIndex).toBeGreaterThan(peelIndex);
    expect(releaseIndex).toBeGreaterThan(ancestryIndex);

    const releaseText = JSON.stringify(release);
    expect(releaseText.match(/contents":"write/g)).toHaveLength(1);
    expect(releaseText.match(/RELEASE_SETTINGS_TOKEN/g)).toHaveLength(1);
    // Two now: the updater-manifest publish step and the prerelease-creation
    // step each need GH_TOKEN for their own git/gh operations.
    expect(releaseText.match(/github\.token/g)).toHaveLength(2);
    expect(releaseText.match(/gh release create/g)).toHaveLength(1);
  });

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
    expect(fields.get('diagnostics')?.validations).toEqual({ required: false });
    expect(fields.get('privacy-check')?.validations).toEqual({ required: true });
    expect(JSON.stringify(form)).toMatch(/remove.*private|redact.*private/i);
    expect(JSON.stringify(form)).toMatch(/saniti[sz]ed.*logs|logs.*saniti[sz]ed/i);
    expect(config).toEqual({
      blank_issues_enabled: false,
      contact_links: [],
    });
  });

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

  it('ships a complete role-based beta smoke and feedback guide', () => {
    const guide = projectFile('docs/beta-testing.md');

    expect(guide).toMatch(/owner.*daily workflow.*soundscape/is);
    expect(guide).toMatch(/usability tester.*first-run/is);
    expect(guide).toMatch(/developer tester.*recovery.*packaging/is);
    expect(guide).toMatch(/blocker.*data loss/is);
    expect(guide).toMatch(/fresh install.*first launch/is);
    expect(guide).toMatch(/upgrade.*without losing local data/is);
    expect(guide).toMatch(/start.*new task.*parked thought/is);
    expect(guide).toMatch(/quiet overtime/is);
    expect(guide).toMatch(/sleep.*wake/is);
    expect(guide).toMatch(/notes.*revisions/is);
    expect(guide).toMatch(/external.*conflict/is);
    expect(guide).toMatch(/history.*export.*delet/is);
    expect(guide).toMatch(/soundscapes.*tones/is);
    expect(guide).toMatch(/appearance.*accessibility/is);
    expect(guide).toMatch(/android/i);
    expect(guide).toMatch(/background|foreground/i);
    expect(guide).toMatch(/Open Notes Folder.*authoritative/is);
    expect(guide).toMatch(/quit.*before.*copy/is);
    expect(guide).toContain(
      '~/Library/Application Support/com.heartwood.app',
    );
    expect(guide).toContain('%APPDATA%\\com.heartwood.app');
    expect(guide).toContain('$XDG_CONFIG_HOME/com.heartwood.app');
    expect(guide).toContain('~/.config/com.heartwood.app');
    expect(guide).toContain('$XDG_DATA_HOME/com.heartwood.app');
    expect(guide).toContain('~/.local/share/com.heartwood.app');
    expect(guide).toMatch(/Linux.*two\s+separate\s+roots/is);
    expect(guide).toMatch(/backup.*both.*config.*data/is);
    expect(guide).toMatch(
      /Gatekeeper.*System Settings.*Privacy\s+&\s+Security.*Open\s+Anyway.*(?:older|fallback).*Control-click/is,
    );
    expect(guide.match(/^- \[ \]/gm)?.length ?? 0).toBeGreaterThanOrEqual(25);
    expect(guide).not.toMatch(/disable (Gatekeeper|SmartScreen)/i);
    expect(guide).toMatch(/attach only sanitized logs or screenshots/i);
    expect(guide).toMatch(/private note.*removed or redacted/is);
  });

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
});
