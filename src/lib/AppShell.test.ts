// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShellHarness from './AppShellHarness.test.svelte';
import { createSettingsController } from './settingsController.svelte';
import { createTaskQueue } from './taskQueue';
import { DEFAULT_APP_SETTINGS } from './appearance';

afterEach(cleanup);

function realController() {
  return createSettingsController({
    initial: DEFAULT_APP_SETTINGS,
    writeQueue: createTaskQueue(),
    persist: async () => {},
  });
}

describe('AppShell', () => {
  it('renders exactly one Workspace navigation tree', () => {
    render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings: realController(),
      onPreviewTone: vi.fn(),
    });

    expect(document.querySelectorAll('nav[aria-label="Workspace"]')).toHaveLength(1);
  });

  it('exposes the resolved theme/appearance/accent as root data attributes', () => {
    const settings = realController();
    settings.set('themeFamily', 'graphite');
    settings.set('timerAccent', 'red');
    settings.set('appearanceMode', 'dark');

    const { container } = render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings,
      onPreviewTone: vi.fn(),
    });

    const shell = container.querySelector('.app-shell')!;
    expect(shell.getAttribute('data-theme')).toBe('graphite');
    expect(shell.getAttribute('data-appearance')).toBe('dark');
    expect(shell.getAttribute('data-timer-accent')).toBe('red');
  });

  it('opens Settings from the gear icon and returns focus to it after every close path', async () => {
    render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings: realController(),
      onPreviewTone: vi.fn(),
    });

    const trigger = screen.getByRole('button', { name: 'Open settings' });
    await fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Escape closes it too, and still restores focus to the trigger.
    await fireEvent.click(trigger);
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('keeps rendered child content mounted (not remounted) while Settings opens and closes', async () => {
    render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings: realController(),
      onPreviewTone: vi.fn(),
    });

    const input = screen.getByRole('textbox', { name: 'Harness input' }) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'unsaved draft' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    const sameInput = screen.getByRole('textbox', { name: 'Harness input' }) as HTMLInputElement;
    expect(sameInput).toBe(input); // same DOM node — never unmounted
    expect(sameInput.value).toBe('unsaved draft');
  });

  it('shows Revisions only when contextually active, and forwards navigation clicks', async () => {
    const onNavigate = vi.fn();
    render(AppShellHarness, {
      currentWorkspace: 'revisions',
      showRevisions: true,
      onNavigate,
      settings: realController(),
      onPreviewTone: vi.fn(),
    });

    expect(screen.getByRole('button', { name: 'Revisions' }).getAttribute('aria-current')).toBe('page');
    await fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(onNavigate).toHaveBeenCalledWith('focus');
  });
});
