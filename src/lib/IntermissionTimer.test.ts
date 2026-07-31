// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IntermissionTimer from './IntermissionTimer.svelte';

afterEach(cleanup);

describe('IntermissionTimer', () => {
  it('shows a practical Break countdown and returns explicitly', async () => {
    const onReturn = vi.fn();
    render(IntermissionTimer, {
      task: 'Write report',
      kind: 'break',
      displayMs: 65_000,
      isOvertime: false,
      onReturn,
    });

    expect(screen.getByRole('heading', { name: 'Break' })).toBeTruthy();
    expect(screen.getByText('01:05')).toBeTruthy();
    expect(screen.getByText(/Get water, stretch/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: "I'm back" }));
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('uses the approved Touch Grass copy', () => {
    render(IntermissionTimer, {
      task: 'Write report',
      kind: 'touchGrass',
      displayMs: 15 * 60_000,
      isOvertime: false,
      onReturn: vi.fn(),
    });

    expect(screen.getByRole('heading', { name: 'Touch Grass' })).toBeTruthy();
    expect(screen.getByText("Go for a frickin' walk.")).toBeTruthy();
  });

  it('counts upward in quiet overtime without returning automatically', () => {
    const onReturn = vi.fn();
    render(IntermissionTimer, {
      task: 'Write report',
      kind: 'touchGrass',
      displayMs: 45_000,
      isOvertime: true,
      onReturn,
    });

    expect(screen.getByText('Quiet overtime')).toBeTruthy();
    expect(screen.getByText('+00:45')).toBeTruthy();
    expect(onReturn).not.toHaveBeenCalled();
  });
});
