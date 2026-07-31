// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsDrawer from './SettingsDrawer.svelte';
import { createSettingsController } from './settingsController.svelte';
import { createTaskQueue } from './taskQueue';
import { DEFAULT_APP_SETTINGS, type AppSettings } from './appearance';

afterEach(cleanup);

function realController(overrides: Partial<AppSettings> = {}) {
  return createSettingsController({
    initial: { ...DEFAULT_APP_SETTINGS, ...overrides },
    writeQueue: createTaskQueue(),
    persist: async () => {},
  });
}

describe('SettingsDrawer', () => {
  it('renders as a labeled, modal dialog', async () => {
    const controller = realController();
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('lists every theme, mode, and accent as a labeled, selectable radio, reflecting the current selection', async () => {
    const controller = realController({ themeFamily: 'graphite', appearanceMode: 'dark', timerAccent: 'green' });
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    for (const name of ['Sunlit', 'Cozy', 'Quiet Natural', 'Coastal Air', 'Night Walk', 'Moon Garden', 'Graphite']) {
      expect(screen.getByRole('radio', { name })).toBeTruthy();
    }
    for (const name of ['Light', 'Dark', 'System']) {
      expect(screen.getByRole('radio', { name })).toBeTruthy();
    }
    for (const name of ['Blue', 'Green', 'Orange', 'Red', 'Yellow']) {
      expect(screen.getByRole('radio', { name })).toBeTruthy();
    }

    expect((screen.getByRole('radio', { name: 'Graphite' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: 'Green' }) as HTMLInputElement).checked).toBe(true);
  });

  it('applies a theme choice to the controller immediately, live', async () => {
    const controller = realController();
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    await fireEvent.click(screen.getByRole('radio', { name: 'Graphite' }));

    expect(controller.current.themeFamily).toBe('graphite');
  });

  it('applies an appearance-mode choice to the controller immediately', async () => {
    const controller = realController();
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    await fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(controller.current.appearanceMode).toBe('dark');
  });

  it('applies a timer-accent choice to the controller immediately', async () => {
    const controller = realController();
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    await fireEvent.click(screen.getByRole('radio', { name: 'Red' }));

    expect(controller.current.timerAccent).toBe('red');
  });

  it('moves the alarm-tone selection and preview into the Audio section, without changing playback behavior', async () => {
    const onPreviewTone = vi.fn();
    const controller = realController({ selectedToneId: 'soft-bell' });
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone });

    expect((screen.getByRole('combobox', { name: 'Alarm tone' }) as HTMLSelectElement).value).toBe('soft-bell');

    await fireEvent.click(screen.getByRole('button', { name: 'Preview alarm tone' }));
    expect(onPreviewTone).toHaveBeenCalledWith('soft-bell');
  });

  it('selects and previews a separate return tone, including Sad Trombone', async () => {
    const onPreviewTone = vi.fn();
    const controller = realController({ selectedReturnToneId: 'sad-trombone' });
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone });

    expect((screen.getByRole('combobox', { name: 'Return tone' }) as HTMLSelectElement).value).toBe(
      'sad-trombone',
    );
    expect(screen.getByRole('option', { name: 'Sad Trombone' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Preview return tone' }));
    expect(onPreviewTone).toHaveBeenCalledWith('sad-trombone');
  });

  it('shows a quiet inline Retry only for a key that failed, and Retry re-persists its current value', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    await fireEvent.click(screen.getByRole('radio', { name: 'Green' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry.*timer accent/i })).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: /Retry.*timer accent/i }));
    await waitFor(() => expect(persist).toHaveBeenLastCalledWith('timerAccent', 'green'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Retry.*timer accent/i })).toBeNull());
  });

  it('shows a Timer section above Audio with a Focus warning preset selector, defaulting to 30 seconds', async () => {
    const controller = realController();
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    const timerIndex = headings.indexOf('Timer');
    const audioIndex = headings.indexOf('Audio');
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    expect(audioIndex).toBeGreaterThan(timerIndex);

    const select = screen.getByRole('combobox', { name: 'Focus warning' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Off',
      '30 seconds',
      '1 minute',
      '2 minutes',
      '5 minutes',
    ]);
    expect(select.value).toBe('30000');
  });

  it('applies a focus-warning preset choice to the controller immediately', async () => {
    const controller = realController();
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    await fireEvent.change(screen.getByRole('combobox', { name: 'Focus warning' }), {
      target: { value: '120000' },
    });

    expect(controller.current.focusWarningLeadMs).toBe('120000');
  });

  it('shows a quiet inline Retry for a failed focus-warning write', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const controller = createSettingsController({
      initial: DEFAULT_APP_SETTINGS,
      writeQueue: createTaskQueue(),
      persist,
    });
    render(SettingsDrawer, { controller, onClose: vi.fn(), onPreviewTone: vi.fn() });

    await fireEvent.change(screen.getByRole('combobox', { name: 'Focus warning' }), {
      target: { value: 'off' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry.*focus warning/i })).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: /Retry.*focus warning/i }));
    await waitFor(() => expect(persist).toHaveBeenLastCalledWith('focusWarningLeadMs', 'off'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Retry.*focus warning/i })).toBeNull());
  });

  it('closes via the close button', async () => {
    const onClose = vi.fn();
    render(SettingsDrawer, { controller: realController(), onClose, onPreviewTone: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes via Escape', async () => {
    const onClose = vi.fn();
    render(SettingsDrawer, { controller: realController(), onClose, onPreviewTone: vi.fn() });

    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on a scrim click, but not a click inside the panel', async () => {
    const onClose = vi.fn();
    const { container } = render(SettingsDrawer, { controller: realController(), onClose, onPreviewTone: vi.fn() });

    await fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    const scrim = container.querySelector('.scrim')!;
    await fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('focuses the close button on mount', async () => {
    render(SettingsDrawer, { controller: realController(), onClose: vi.fn(), onPreviewTone: vi.fn() });

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close settings' })));
  });

  it('wraps Tab forward from the last focusable element back to the first', async () => {
    render(SettingsDrawer, { controller: realController(), onClose: vi.fn(), onPreviewTone: vi.fn() });
    const dialog = screen.getByRole('dialog');
    const closeButton = screen.getByRole('button', { name: 'Close settings' });
    // Let the mount effect's own focus-the-close-button call settle first,
    // so it can't race in later and steal focus back after this test moves
    // it elsewhere.
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    await fireEvent.keyDown(dialog, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab backward from the first focusable element to the last', async () => {
    render(SettingsDrawer, { controller: realController(), onClose: vi.fn(), onPreviewTone: vi.fn() });
    const dialog = screen.getByRole('dialog');
    const closeButton = screen.getByRole('button', { name: 'Close settings' });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first.focus();
    await fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });
});
