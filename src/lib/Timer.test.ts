// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Timer from './Timer.svelte';
import TimerWithPromptHarness from './TimerWithPromptHarness.test.svelte';
import { formatDuration } from './format';

afterEach(cleanup);

describe('Timer', () => {
  it('renders the task, mode label, and formatted clock', () => {
    render(Timer, {
      task: 'Write launch brief',
      mode: 'focus',
      isPaused: false,
      displayMs: 65_000,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });

    expect(screen.getByRole('heading', { name: 'Write launch brief' })).toBeTruthy();
    expect(screen.getByText('Focusing')).toBeTruthy();
    expect(screen.getByText(formatDuration(65_000))).toBeTruthy();
  });

  it('shows Pause/Resume based on isPaused, and never for break mode', async () => {
    const onPause = vi.fn();
    const { rerender } = render(Timer, {
      task: 'Task',
      mode: 'focus',
      isPaused: false,
      displayMs: 0,
      onPause,
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledOnce();

    await rerender({
      task: 'Task',
      mode: 'focus',
      isPaused: true,
      displayMs: 0,
      onPause,
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();

    await rerender({
      task: 'Task',
      mode: 'break',
      isPaused: false,
      displayMs: 0,
      onPause,
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('labels the finish action per mode and calls onFinish', async () => {
    const onFinish = vi.fn();
    const { rerender } = render(Timer, {
      task: 'Task',
      mode: 'focus',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish,
    });
    expect(screen.getByRole('button', { name: 'Finish early' })).toBeTruthy();

    await rerender({
      task: 'Task',
      mode: 'flow',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish,
    });
    expect(screen.getByRole('button', { name: 'Finish session' })).toBeTruthy();

    await rerender({
      task: 'Task',
      mode: 'break',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish,
    });
    const endBreak = screen.getByRole('button', { name: 'End break' });
    await fireEvent.click(endBreak);
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('renders no progress track when progress is null, and clamps it to 100% when given', () => {
    const { rerender, container } = render(Timer, {
      task: 'Task',
      mode: 'focus',
      isPaused: false,
      displayMs: 0,
      progress: null,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });
    expect(container.querySelector('.progress-track')).toBeNull();

    rerender({
      task: 'Task',
      mode: 'focus',
      isPaused: false,
      displayMs: 0,
      progress: 1.5, // over 100% — must clamp, never overflow the track
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });
    const fill = container.querySelector<HTMLElement>('.progress-fill')!;
    expect(fill.style.width).toBe('100%');
  });

  it('keeps the clock using tabular numerals so digit widths stay stable', () => {
    // jsdom doesn't evaluate scoped <style> blocks via getComputedStyle,
    // so this checks the authored CSS text directly rather than a
    // rendered computed style.
    const source = readFileSync(join(process.cwd(), 'src/lib/Timer.svelte'), 'utf8');
    const clockRule = source.match(/\.clock\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(clockRule).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('reads "Quiet overtime" instead of "Flow" when displayLabel overrides the mode label, keeping Flow styling (Phase 5B)', () => {
    const { container } = render(Timer, {
      task: 'Task',
      mode: 'flow',
      isPaused: false,
      displayMs: 0,
      displayLabel: 'Quiet overtime',
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });

    expect(screen.getByText('Quiet overtime')).toBeTruthy();
    expect(screen.queryByText('Flow')).toBeNull();
    expect(container.querySelector('.timer.flow')).toBeTruthy();
  });

  it('offers an optional View history link, calling onViewHistory when clicked', async () => {
    const onViewHistory = vi.fn();
    render(Timer, {
      task: 'Task',
      mode: 'focus',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
      onViewHistory,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'View history' }));
    expect(onViewHistory).toHaveBeenCalledOnce();
  });

  it('omits the View history link when onViewHistory is not provided', () => {
    render(Timer, {
      task: 'Task',
      mode: 'focus',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: 'View history' })).toBeNull();
  });

  it('renders an optional prompt below the controls without disturbing them (Phase 5B)', () => {
    render(TimerWithPromptHarness, {
      task: 'Task',
      mode: 'focus',
      isPaused: false,
      displayMs: 0,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onFinish: vi.fn(),
    });

    expect(screen.getByTestId('prompt-slot')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Finish early' })).toBeTruthy();
  });
});
