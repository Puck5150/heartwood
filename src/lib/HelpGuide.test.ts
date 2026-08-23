// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HelpGuide from './HelpGuide.svelte';

afterEach(cleanup);

describe('HelpGuide', () => {
  it('renders as a labeled, modal dialog', () => {
    render(HelpGuide, { onClose: vi.fn() });

    const dialog = screen.getByRole('dialog', { name: 'Help' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('covers the pomodoro basics, Greenhouse, Touch Grass/Break, Projects, and Soundscapes', () => {
    render(HelpGuide, { onClose: vi.fn() });

    expect(screen.getByRole('heading', { name: /pomodoro/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Greenhouse' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /break.*touch grass/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Soundscapes' })).toBeTruthy();
  });

  it('closes via the close button and via Escape', async () => {
    const onClose = vi.fn();
    render(HelpGuide, { onClose });

    await fireEvent.click(screen.getByRole('button', { name: 'Close help guide' }));
    expect(onClose).toHaveBeenCalledOnce();

    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
