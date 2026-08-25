// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UpdateBanner from './UpdateBanner.svelte';

afterEach(cleanup);

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    stage: 'ready' as const,
    version: '0.1.0-beta.5',
    error: null,
    finalizeLabel: 'Restart now',
    onUpdate: vi.fn(),
    onRestart: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

describe('UpdateBanner finalize label', () => {
  it('uses the desktop wording by default', () => {
    render(UpdateBanner, baseProps());
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeTruthy();
  });

  it('uses Android-appropriate wording when finalizeLabel is Install', () => {
    render(UpdateBanner, baseProps({ finalizeLabel: 'Install' }));
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
  });
});
