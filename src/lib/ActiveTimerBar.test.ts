// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActiveTimerBar from './ActiveTimerBar.svelte';

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

  it('offers all completion decisions without navigating', async () => {
    const onBreak = vi.fn();
    const onFlow = vi.fn();
    const onFinish = vi.fn();
    render(ActiveTimerBar, {
      task: 'Write launch brief',
      mode: 'awaitingDecision',
      onBreak,
      onFlow,
      onFinish,
    });

    expect(screen.getByRole('status', { name: 'Focus complete' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Continue in flow' }));
    expect(onFlow).toHaveBeenCalledOnce();
    expect(onBreak).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });
});
