// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BreakdownChart from './BreakdownChart.svelte';

const { getSetting, setSetting } = vi.hoisted(() => ({
  getSetting: vi.fn(async () => null as string | null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock('./repository', () => ({ getSetting, setSetting }));

afterEach(() => {
  cleanup();
  getSetting.mockReset().mockResolvedValue(null);
  setSetting.mockReset().mockResolvedValue(undefined);
});

describe('BreakdownChart', () => {
  it('renders two entries with the same label but distinct keys without throwing', async () => {
    const { container } = render(BreakdownChart, {
      data: [
        { label: 'Website', totalMs: 60_000, key: 'project-a' },
        { label: 'Website', totalMs: 120_000, key: 'project-b' },
      ],
    });

    // Let the async onMount settle so we exercise the fully-mounted tree.
    await Promise.resolve();

    expect(screen.getAllByText('Website')).toHaveLength(2);
    expect(container.querySelectorAll('.bar-row')).toHaveLength(2);
  });

  it('defaults to the bar chart and switches to donut on toggle, persisting the choice', async () => {
    const { container } = render(BreakdownChart, {
      data: [{ label: 'Personal', totalMs: 60_000, key: 'personal' }],
    });
    await Promise.resolve();

    expect(container.querySelector('.bar-list')).toBeTruthy();
    expect(container.querySelector('.donut')).toBeNull();

    await fireEvent.click(screen.getByTitle('donut'));

    expect(container.querySelector('.donut')).toBeTruthy();
    expect(container.querySelector('.bar-list')).toBeNull();
    expect(setSetting).toHaveBeenCalledWith('breakdown_chart_type', 'donut');
  });

  it('switches to pie on toggle and persists the choice', async () => {
    const { container } = render(BreakdownChart, {
      data: [{ label: 'Personal', totalMs: 60_000, key: 'personal' }],
    });
    await Promise.resolve();

    await fireEvent.click(screen.getByTitle('pie'));

    expect(container.querySelector('.pie')).toBeTruthy();
    expect(setSetting).toHaveBeenCalledWith('breakdown_chart_type', 'pie');
  });

  it('shows the previously-saved chart type on mount instead of the bar default', async () => {
    getSetting.mockResolvedValue('pie');

    const { container } = render(BreakdownChart, {
      data: [{ label: 'Personal', totalMs: 60_000, key: 'personal' }],
    });

    await screen.findByTitle('pie');
    await vi.waitFor(() => {
      expect(container.querySelector('.pie')).toBeTruthy();
    });
    expect(container.querySelector('.bar-list')).toBeNull();
  });

  it('renders zero-total data without NaN anywhere and without throwing', async () => {
    const { container } = render(BreakdownChart, {
      data: [
        { label: 'Personal', totalMs: 0, key: 'personal' },
        { label: 'Work', totalMs: 0, key: 'work' },
      ],
    });
    await Promise.resolve();

    expect(container.innerHTML).not.toContain('NaN');

    await fireEvent.click(screen.getByTitle('pie'));
    expect(container.innerHTML).not.toContain('NaN');

    await fireEvent.click(screen.getByTitle('donut'));
    expect(container.innerHTML).not.toContain('NaN');
  });

  it('calls onSegmentClick with the clicked entry label in bar mode', async () => {
    const onSegmentClick = vi.fn();
    const { container } = render(BreakdownChart, {
      data: [
        { label: 'Personal', totalMs: 60_000, key: 'personal' },
        { label: 'Work', totalMs: 30_000, key: 'work' },
      ],
      onSegmentClick,
    });
    await Promise.resolve();

    const rows = container.querySelectorAll('.bar-row');
    await fireEvent.click(rows[1]);

    expect(onSegmentClick).toHaveBeenCalledWith('Work');
  });
});
