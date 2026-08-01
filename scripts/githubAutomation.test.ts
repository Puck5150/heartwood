import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

function workflow(name: string) {
  return parse(
    readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'),
  );
}

describe('GitHub automation', () => {
  it('validates pull requests, main pushes, and reusable callers with read-only contents', () => {
    const ci = workflow('ci.yml');

    expect(ci.on).toHaveProperty('pull_request');
    expect(ci.on.push.branches).toEqual(['main']);
    expect(ci.on).toHaveProperty('workflow_call');
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(ci.concurrency).toEqual({
      group: 'ci-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    });

    const validate = ci.jobs.validate;
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
});
