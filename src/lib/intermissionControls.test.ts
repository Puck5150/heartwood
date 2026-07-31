// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IntermissionControls from './IntermissionControls.svelte';
import { nextIntermissionDuration } from './intermissionControls';

afterEach(cleanup);

describe('nextIntermissionDuration', () => {
  it('cycles Break through 5 and 10 minutes', () => {
    expect(nextIntermissionDuration('break', 5 * 60_000)).toBe(10 * 60_000);
    expect(nextIntermissionDuration('break', 10 * 60_000)).toBe(5 * 60_000);
  });

  it('cycles Touch Grass through 15, 30, 45, and 60 minutes', () => {
    expect(nextIntermissionDuration('touchGrass', 15 * 60_000)).toBe(30 * 60_000);
    expect(nextIntermissionDuration('touchGrass', 30 * 60_000)).toBe(45 * 60_000);
    expect(nextIntermissionDuration('touchGrass', 45 * 60_000)).toBe(60 * 60_000);
    expect(nextIntermissionDuration('touchGrass', 60 * 60_000)).toBe(15 * 60_000);
  });

  it('falls back to each kind default for an unknown current value', () => {
    expect(nextIntermissionDuration('break', 123)).toBe(5 * 60_000);
    expect(nextIntermissionDuration('touchGrass', 123)).toBe(15 * 60_000);
  });
});

describe('IntermissionControls', () => {
  it('starts each intermission independently', async () => {
    const onStartBreak = vi.fn();
    const onStartTouchGrass = vi.fn();
    render(IntermissionControls, {
      breakDurationMs: 5 * 60_000,
      touchGrassDurationMs: 15 * 60_000,
      onStartBreak,
      onStartTouchGrass,
      onCycleBreak: vi.fn(),
      onCycleTouchGrass: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Touch grass' }));
    expect(onStartBreak).toHaveBeenCalledOnce();
    expect(onStartTouchGrass).toHaveBeenCalledOnce();
  });

  it('exposes current durations and cycles them without starting', async () => {
    const onCycleBreak = vi.fn();
    const onCycleTouchGrass = vi.fn();
    const onStartBreak = vi.fn();
    render(IntermissionControls, {
      breakDurationMs: 10 * 60_000,
      touchGrassDurationMs: 45 * 60_000,
      onStartBreak,
      onStartTouchGrass: vi.fn(),
      onCycleBreak,
      onCycleTouchGrass,
    });

    await fireEvent.click(
      screen.getByRole('button', { name: 'Break duration: 10 minutes. Change duration' }),
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Touch Grass duration: 45 minutes. Change duration' }),
    );
    expect(onCycleBreak).toHaveBeenCalledOnce();
    expect(onCycleTouchGrass).toHaveBeenCalledOnce();
    expect(onStartBreak).not.toHaveBeenCalled();
  });
});
