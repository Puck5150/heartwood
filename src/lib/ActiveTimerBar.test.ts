// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActiveTimerBar from './ActiveTimerBar.svelte';
import ActiveTimerBarWithPromptHarness from './ActiveTimerBarWithPromptHarness.test.svelte';

afterEach(cleanup);

describe('ActiveTimerBar', () => {
  it('shows the task and clock while focusing, and pauses without navigating', async () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onFinish = vi.fn();
    render(ActiveTimerBar, {
      task: 'Write launch brief',
      mode: 'focus',
      displayMs: 65_000,
      isPaused: false,
      onPause,
      onResume,
      onFinish,
    });

    expect(screen.getByText('Write launch brief')).toBeTruthy();
    expect(screen.getByText('01:05')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(onResume).not.toHaveBeenCalled();
  });

  it('shows Resume instead of Pause once paused', async () => {
    const onResume = vi.fn();
    render(ActiveTimerBar, {
      task: 'Write launch brief',
      mode: 'focus',
      displayMs: 65_000,
      isPaused: true,
      onPause: vi.fn(),
      onResume,
      onFinish: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('labels the finish action per mode and omits pause during a break', async () => {
    const onFinish = vi.fn();
    render(ActiveTimerBar, {
      task: 'Write launch brief',
      mode: 'break',
      displayMs: 30_000,
      isPaused: false,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish,
    });

    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'End break' }));
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('shows the flow finish label', () => {
    render(ActiveTimerBar, {
      task: 'Write launch brief',
      mode: 'flow',
      displayMs: 10_000,
      isPaused: false,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });

    expect(screen.getByRole('button', { name: 'Finish session' })).toBeTruthy();
  });

  it('reads a displayLabel override instead of the mode label, keeping Flow styling (Phase 5B)', () => {
    const { container } = render(ActiveTimerBar, {
      task: 'Write launch brief',
      mode: 'flow',
      displayMs: 10_000,
      isPaused: false,
      displayLabel: 'Quiet overtime',
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });

    expect(screen.getByText('Quiet overtime')).toBeTruthy();
    expect(container.querySelector('.active-timer-bar.flow')).toBeTruthy();
  });

  it('renders the same prompt state as the full Timer, above the compact bar\'s own controls (Phase 5B)', () => {
    render(ActiveTimerBarWithPromptHarness, {
      task: 'Write launch brief',
      mode: 'focus',
      displayMs: 10_000,
      isPaused: false,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });

    expect(screen.getByTestId('prompt-slot')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });
});
