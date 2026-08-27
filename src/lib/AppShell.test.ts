// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShellHarness from './AppShellHarness.test.svelte';
import { createSettingsController } from './settingsController.svelte';
import { createUpdateController } from './updateController.svelte';
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

function fakeUpdateController() {
  return createUpdateController({
    checkForUpdate: () => Promise.resolve(null),
    relaunch: () => Promise.resolve(),
  });
}

describe('AppShell', () => {
  it('renders exactly one Workspace navigation tree', () => {
    render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings: realController(),
      updateController: fakeUpdateController(),
      onPreviewTone: vi.fn(),
    });

    expect(document.querySelectorAll('nav[aria-label="Workspace"]')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Harness music control' })).toHaveLength(1);
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
      updateController: fakeUpdateController(),
      onPreviewTone: vi.fn(),
    });

    const shell = container.querySelector('.app-shell')!;
    expect(shell.getAttribute('data-theme')).toBe('graphite');
    expect(shell.getAttribute('data-appearance')).toBe('dark');
    expect(shell.getAttribute('data-timer-accent')).toBe('red');
  });

  it('repaints the page background/text on the same element that carries the theme attributes', () => {
    // data-theme/data-appearance live on .app-shell, not <html>/<body> —
    // :root's own `background: var(--app-background)` only ever sees
    // :root's fallback value, so .app-shell itself must repaint using the
    // scoped custom properties or the canvas stays stuck on one theme
    // regardless of what's selected (jsdom doesn't evaluate scoped <style>
    // blocks via getComputedStyle, so this checks the authored CSS text).
    const source = readFileSync(join(process.cwd(), 'src/lib/AppShell.svelte'), 'utf8');
    const shellRule = source.match(/\.app-shell\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(shellRule).toMatch(/background:\s*var\(--app-background\)/);
    expect(shellRule).toMatch(/color:\s*var\(--text\)/);
  });

  it('threads isPaidUser through to the Settings drawer', async () => {
    render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings: realController(),
      updateController: fakeUpdateController(),
      onPreviewTone: vi.fn(),
      isPaidUser: true,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByText(/full version unlocked/i)).toBeTruthy();
  });

  it('opens Settings from the gear icon and returns focus to it after every close path', async () => {
    render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings: realController(),
      updateController: fakeUpdateController(),
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

  it('opens the help guide from Settings, stacked over it, and closes back to just Settings', async () => {
    render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings: realController(),
      updateController: fakeUpdateController(),
      onPreviewTone: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Help guide' }));

    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Close help guide' }));
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it('keeps rendered child content mounted (not remounted) while Settings opens and closes', async () => {
    render(AppShellHarness, {
      currentWorkspace: 'focus',
      showRevisions: false,
      onNavigate: vi.fn(),
      settings: realController(),
      updateController: fakeUpdateController(),
      onPreviewTone: vi.fn(),
    });

    const input = screen.getByRole('textbox', { name: 'Harness input' }) as HTMLInputElement;
    const musicControl = screen.getByRole('button', { name: 'Harness music control' });
    await fireEvent.input(input, { target: { value: 'unsaved draft' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    const sameInput = screen.getByRole('textbox', { name: 'Harness input' }) as HTMLInputElement;
    expect(sameInput).toBe(input); // same DOM node — never unmounted
    expect(sameInput.value).toBe('unsaved draft');
    expect(screen.getByRole('button', { name: 'Harness music control' })).toBe(musicControl);
  });

  it('shows Revisions only when contextually active, and forwards navigation clicks', async () => {
    const onNavigate = vi.fn();
    render(AppShellHarness, {
      currentWorkspace: 'revisions',
      showRevisions: true,
      onNavigate,
      settings: realController(),
      updateController: fakeUpdateController(),
      onPreviewTone: vi.fn(),
    });

    expect(screen.getByRole('button', { name: 'Revisions' }).getAttribute('aria-current')).toBe('page');
    await fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(onNavigate).toHaveBeenCalledWith('focus');
  });

  it('uses one equal-width mobile grid and stacks (never hides) labels at the narrow 360px breakpoint', () => {
    render(AppShellHarness, {
      currentWorkspace: 'revisions',
      showRevisions: true,
      onNavigate: vi.fn(),
      settings: realController(),
      updateController: fakeUpdateController(),
      onPreviewTone: vi.fn(),
    });

    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeTruthy();
    expect(screen.getAllByRole('button')).toEqual(
      expect.arrayContaining([
        screen.getByRole('button', { name: 'Focus' }),
        screen.getByRole('button', { name: 'History' }),
        screen.getByRole('button', { name: 'Revisions' }),
        screen.getByRole('button', { name: 'Harness music control' }),
        screen.getByRole('button', { name: 'Open settings' }),
      ]),
    );

    const shellSource = readFileSync(join(process.cwd(), 'src/lib/AppShell.svelte'), 'utf8');
    const navSource = readFileSync(join(process.cwd(), 'src/lib/WorkspaceNav.svelte'), 'utf8');
    expect(shellSource).toMatch(/grid-auto-columns:\s*minmax\(44px,\s*1fr\)/);
    // Labels stack under their icon and shrink at this width — they must
    // never fall back to the visually-hidden/clip trick, which would
    // leave the app's primary nav icon-only on the smallest supported
    // phones.
    expect(navSource).toMatch(/@media \(max-width:\s*420px\)[\s\S]*?\.nav-item[\s\S]*?flex-direction:\s*column/);
    expect(navSource).not.toMatch(/@media \(max-width:\s*420px\)[\s\S]*?clip:/);
  });
});
