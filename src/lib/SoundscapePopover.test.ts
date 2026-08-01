// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SoundscapePopover from './SoundscapePopover.svelte';
import type {
  SoundscapeController,
  SoundscapePlaybackSnapshot,
} from './soundscapeController.svelte';
import type { SoundscapeId } from './soundscapeCatalog';

afterEach(cleanup);

function fakeController(
  overrides: Partial<SoundscapePlaybackSnapshot> = {},
): SoundscapeController {
  const snapshot: SoundscapePlaybackSnapshot = {
    status: 'idle',
    error: null,
    temporarilySuppressed: false,
    ...overrides,
  };
  return {
    snapshot,
    selectPreset: vi.fn(async () => {}),
    setVolume: vi.fn(),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    syncLifecycle: vi.fn(),
    setAlarmOutputSuppressed: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

interface PopoverProps {
  controller: SoundscapeController;
  selectedPresetId: SoundscapeId;
  volume: string;
  disabledReason: 'intermission' | 'alarm' | null;
  selectionError: string | null;
  volumeError: string | null;
  onSelect: (id: SoundscapeId) => void;
  onVolume: (value: string) => void;
  onRetrySelection: () => void;
  onRetryVolume: () => void;
}

function props(overrides: Partial<PopoverProps> = {}): PopoverProps {
  return {
    controller: fakeController(),
    selectedPresetId: 'deep-focus',
    volume: '0.35',
    disabledReason: null,
    selectionError: null,
    volumeError: null,
    onSelect: vi.fn(),
    onVolume: vi.fn(),
    onRetrySelection: vi.fn(),
    onRetryVolume: vi.fn(),
    ...overrides,
  };
}

describe('SoundscapePopover', () => {
  it('opens from one named music-note control without starting audio', async () => {
    const controller = fakeController();
    render(SoundscapePopover, props({ controller }));

    const trigger = screen.getByRole('button', { name: 'Flow-state music' });
    expect(trigger.getAttribute('title')).toBe('Flow-state music');
    expect(trigger.getAttribute('aria-controls')).toBe('soundscape-popover');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.focus();
    await fireEvent.click(trigger);

    expect(screen.getByRole('region', { name: 'Flow-state music' })).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByText('Local and offline')).toBeTruthy();
    expect(controller.play).not.toHaveBeenCalled();
  });

  it('announces one selected preset and forwards a new selection', async () => {
    const onSelect = vi.fn();
    render(SoundscapePopover, props({ selectedPresetId: 'still-air', onSelect }));
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));

    const group = screen.getByRole('radiogroup', { name: 'Soundscape' });
    const selected = within(group).getByRole('radio', { name: /Still Air/ }) as HTMLInputElement;
    expect(selected.checked).toBe(true);
    await fireEvent.click(within(group).getByRole('radio', { name: /Rain Room/ }));
    expect(onSelect).toHaveBeenCalledWith('rain-room');
  });

  it('offers Lo-Fi Hip Hop and Slow Pulse and forwards their ids', async () => {
    const onSelect = vi.fn();
    render(SoundscapePopover, props({ onSelect }));
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));

    const group = screen.getByRole('radiogroup', { name: 'Soundscape' });
    await fireEvent.click(within(group).getByRole('radio', { name: /Lo-Fi Hip Hop/ }));
    await fireEvent.click(within(group).getByRole('radio', { name: /Slow Pulse/ }));

    expect(onSelect).toHaveBeenNthCalledWith(1, 'lofi-hip-hop');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'slow-pulse');
  });

  it('uses Play, Pause, Resume audio, and Retry labels for current playback state', async () => {
    for (const [status, label] of [
      ['idle', 'Play soundscape'],
      ['paused', 'Play soundscape'],
      ['playing', 'Pause soundscape'],
      ['suspended', 'Resume audio'],
      ['error', 'Retry music'],
    ] as const) {
      cleanup();
      const controller = fakeController({ status, error: status === 'error' ? 'Could not start.' : null });
      render(SoundscapePopover, props({ controller }));
      await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));
      const action = screen.getByRole('button', { name: label });
      await fireEvent.click(action);
      if (status === 'playing') expect(controller.pause).toHaveBeenCalled();
      else expect(controller.play).toHaveBeenCalledWith();
    }
  });

  it('starts an idle soundscape without a session', async () => {
    const controller = fakeController();
    render(SoundscapePopover, props({ controller }));

    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Play soundscape' }));

    expect(controller.play).toHaveBeenCalledOnce();
    expect(controller.play).toHaveBeenCalledWith();
  });

  it('forwards accessible numeric volume and persistence retries', async () => {
    const onVolume = vi.fn();
    const onRetrySelection = vi.fn();
    const onRetryVolume = vi.fn();
    render(
      SoundscapePopover,
      props({
        volume: '0.6',
        volumeError: 'Not saved',
        selectionError: 'Not saved',
        onVolume,
        onRetrySelection,
        onRetryVolume,
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));

    const slider = screen.getByRole('slider', { name: 'Soundscape volume' }) as HTMLInputElement;
    expect(slider.value).toBe('0.6');
    await fireEvent.input(slider, { target: { value: '0.75' } });
    expect(onVolume).toHaveBeenCalledWith('0.75');

    await fireEvent.click(screen.getByRole('button', { name: 'Retry soundscape selection' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Retry soundscape volume' }));
    expect(onRetrySelection).toHaveBeenCalledTimes(1);
    expect(onRetryVolume).toHaveBeenCalledTimes(1);
  });

  it('prevents manual playback during an intermission and restores trigger focus on Escape', async () => {
    const controller = fakeController({ status: 'suppressed', temporarilySuppressed: true });
    render(SoundscapePopover, props({ controller, disabledReason: 'intermission' }));
    const trigger = screen.getByRole('button', { name: 'Flow-state music' });
    await fireEvent.click(trigger);

    expect(screen.getByRole('button', { name: 'Soundscape paused during intermission' })).toHaveProperty(
      'disabled',
      true,
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Soundscape paused during intermission' }));
    expect(controller.play).not.toHaveBeenCalled();
    await fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Flow-state music' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('labels alarm suppression accurately and keeps playback disabled', async () => {
    const controller = fakeController({ status: 'suppressed', temporarilySuppressed: true });
    render(SoundscapePopover, props({ controller, disabledReason: 'alarm' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));

    const action = screen.getByRole('button', { name: 'Soundscape paused during alarm' });
    expect(action).toHaveProperty('disabled', true);
    await fireEvent.click(action);
    expect(controller.play).not.toHaveBeenCalled();
  });

  it('does not steal focus when an outside click closes the popover', async () => {
    render(SoundscapePopover, props());
    const trigger = screen.getByRole('button', { name: 'Flow-state music' });
    await fireEvent.click(trigger);

    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.append(outside);
    outside.focus();
    await fireEvent.click(outside);

    expect(screen.queryByRole('region', { name: 'Flow-state music' })).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
