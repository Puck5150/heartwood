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

  it('publishes only a complete tag-triggered alpha matrix', () => {
    const release = workflow('release-alpha.yml');

    expect(Object.keys(release.on)).toEqual(['push']);
    expect(release.on.push).toEqual({ tags: ['v*-alpha.*'] });
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(release.jobs)).toEqual(['validate', 'build', 'release']);

    const validate = release.jobs.validate;
    expect(validate).toEqual({ uses: './.github/workflows/ci.yml' });

    const build = release.jobs.build;
    expect(build.needs).toBe('validate');
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(build['runs-on']).toBe('${{ matrix.platform }}');
    expect(build.strategy['fail-fast']).toBe(false);
    expect(build.strategy.matrix.include).toEqual([
      {
        platform: 'macos-latest',
        bundles: 'dmg',
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
        args: '--target ${{ matrix.target }} --bundles ${{ matrix.bundles }}',
        uploadWorkflowArtifacts: true,
        workflowArtifactNamePattern: '[platform]-[arch]-[bundle]',
      },
    });

    const serializedBuild = JSON.stringify(build);
    expect(serializedBuild).not.toContain('contents":"write');
    expect(serializedBuild).not.toMatch(/gh release|tagName|releaseName|releaseId/);

    const releaseJob = release.jobs.release;
    expect(releaseJob.needs).toBe('build');
    expect(releaseJob['runs-on']).toBe('ubuntu-22.04');
    expect(releaseJob.permissions).toEqual({ contents: 'write' });

    const releaseSteps = releaseJob.steps as WorkflowStep[];
    expect(releaseSteps[0]).toMatchObject({
      uses: 'actions/checkout@v7',
      with: { 'persist-credentials': false },
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
    expect(releaseSteps[3].run).toBe(
      'node scripts/prepareAlphaAssets.mjs release-artifacts release-assets',
    );
    expect(releaseSteps[4].env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(releaseSteps[4].run).toContain('gh release create "$GITHUB_REF_NAME"');
    expect(releaseSteps[4].run).toContain('release-assets/*');
    expect(releaseSteps[4].run).toContain('--verify-tag');
    expect(releaseSteps[4].run).toContain('--prerelease');
    expect(releaseSteps[4].run).toContain(
      '--title "Pomodoro Parking Lot $GITHUB_REF_NAME"',
    );
    expect(releaseSteps[4].run).toContain(
      '--notes-file docs/alpha-release-notes.md',
    );
    expect(releaseSteps[4].run).not.toContain('--latest');

    const releaseText = JSON.stringify(release);
    expect(releaseText.match(/contents":"write/g)).toHaveLength(1);
    expect(releaseText.match(/github\.token/g)).toHaveLength(1);
    expect(releaseText.match(/gh release create/g)).toHaveLength(1);
  });

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
    expect(fields.get('diagnostics')?.validations).toEqual({ required: false });
    expect(fields.get('privacy-check')?.validations).toEqual({ required: true });
    expect(JSON.stringify(form)).toMatch(/remove.*private|redact.*private/i);
    expect(JSON.stringify(form)).toMatch(/saniti[sz]ed.*logs|logs.*saniti[sz]ed/i);
    expect(config).toEqual({
      blank_issues_enabled: false,
      contact_links: [],
    });
  });

  it('ships version-neutral alpha notes with safe unsigned install guidance', () => {
    const releaseNotes = projectFile('docs/alpha-release-notes.md');

    expect(releaseNotes).toMatch(/private desktop alpha/i);
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
    expect(releaseNotes).toMatch(/backup.*delet/is);
    expect(releaseNotes).toMatch(/complete Linux backup requires both/i);
    expect(releaseNotes).toContain(
      '$XDG_CONFIG_HOME/com.pomodoroparkinglot.app or ~/.config/com.pomodoroparkinglot.app',
    );
    expect(releaseNotes).toContain(
      '$XDG_DATA_HOME/com.pomodoroparkinglot.app or ~/.local/share/com.pomodoroparkinglot.app',
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

  it('ships a complete role-based alpha smoke and feedback guide', () => {
    const guide = projectFile('docs/alpha-testing.md');

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
    expect(guide).toMatch(/Open Notes Folder.*authoritative/is);
    expect(guide).toMatch(/quit.*before.*copy/is);
    expect(guide).toContain(
      '~/Library/Application Support/com.pomodoroparkinglot.app',
    );
    expect(guide).toContain('%APPDATA%\\com.pomodoroparkinglot.app');
    expect(guide).toContain('$XDG_CONFIG_HOME/com.pomodoroparkinglot.app');
    expect(guide).toContain('~/.config/com.pomodoroparkinglot.app');
    expect(guide).toContain('$XDG_DATA_HOME/com.pomodoroparkinglot.app');
    expect(guide).toContain('~/.local/share/com.pomodoroparkinglot.app');
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

  it('links alpha tester documentation and records release readiness', () => {
    const readme = projectFile('README.md');
    const changelog = projectFile('CHANGELOG.md');
    const readiness = changelog.split('## Phase 5E:')[0];

    expect(readme).toMatch(/## Private alpha testing/);
    expect(readme).toMatch(/docs\/alpha-testing\.md/);
    expect(readme).toMatch(/docs\/alpha-release-notes\.md/);
    expect(readiness).toMatch(/## Alpha release readiness/);
    expect(readiness).toMatch(/version agreement/i);
    expect(readiness).toMatch(/Visible CI/i);
    expect(readiness).toMatch(/complete native matrix/i);
    expect(readiness).toMatch(/Immutable prereleases/i);
    expect(readiness).toMatch(/checksums/i);
    expect(readiness).toMatch(/Tester guidance/i);
    expect(readiness).toMatch(/deferred: signed.*mobile/is);
  });
});
