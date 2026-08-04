// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FocusCompletionPrompt from './FocusCompletionPrompt.svelte';

afterEach(cleanup);

describe('FocusCompletionPrompt — warning', () => {
  it('shows the exact approved copy, reflecting the selected lead label', () => {
    render(FocusCompletionPrompt, {
      kind: 'warning',
      leadLabel: '30 seconds',
      announcement: null,
      onPrimary: vi.fn(),
      onSecondary: vi.fn(),
    });

    expect(screen.getByText('30 seconds left')).toBeTruthy();
    expect(screen.getByText('Ready for a break?')).toBeTruthy();
    expect(screen.getByText('The timer keeps moving. Ignore this and the alarm will sound at zero.')).toBeTruthy();
  });

  it('reflects a different preset label exactly', () => {
    render(FocusCompletionPrompt, {
      kind: 'warning',
      leadLabel: '2 minutes',
      announcement: null,
      onPrimary: vi.fn(),
      onSecondary: vi.fn(),
    });

    expect(screen.getByText('2 minutes left')).toBeTruthy();
  });

  it('offers Take break now and Continue focusing, firing the correct callback for each', async () => {
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    render(FocusCompletionPrompt, {
      kind: 'warning',
      leadLabel: '30 seconds',
      announcement: null,
      onPrimary,
      onSecondary,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Take break now' }));
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(onSecondary).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Continue focusing' }));
    expect(onSecondary).toHaveBeenCalledOnce();
  });
});

describe('FocusCompletionPrompt — overtime', () => {
  it('shows the initial phase copy and actions in the approved order', () => {
    render(FocusCompletionPrompt, {
      kind: 'overtime',
      phase: 'initial',
      leadLabel: null,
      announcement: null,
      onStay: vi.fn(),
      onBreak: vi.fn(),
      onEnd: vi.fn(),
    });

    expect(screen.getByText('Planned focus complete')).toBeTruthy();
    expect(screen.getByText('Stay with it, or step away')).toBeTruthy();
    expect(screen.getByText('Overtime stays quiet while you decide.')).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Stay with it',
      'Take a break',
      'End session',
    ]);
    expect(buttons[0].classList.contains('primary')).toBe(true);
    expect(buttons[1].classList.contains('primary')).toBe(false);
    // End session is a successful completion, not a destructive action — it
    // must never carry the danger styling reserved for real errors/deletes.
    expect(buttons[2].classList.contains('danger')).toBe(false);
  });

  it('shows the warning phase copy and warning detail', () => {
    render(FocusCompletionPrompt, {
      kind: 'overtime',
      phase: 'warning',
      leadLabel: '30 seconds',
      announcement: '30 seconds to next focus check-in',
      onStay: vi.fn(),
      onBreak: vi.fn(),
      onEnd: vi.fn(),
    });

    expect(screen.getByText('30 seconds to next check-in')).toBeTruthy();
    expect(screen.getByText('Stay with it, or step away')).toBeTruthy();
    expect(screen.getByText('Ignore this and the alarm will sound at the next check-in.')).toBeTruthy();
  });

  it('shows the due phase copy and quiet detail', () => {
    const { container } = render(FocusCompletionPrompt, {
      kind: 'overtime',
      phase: 'due',
      leadLabel: null,
      announcement: 'Focus check-in',
      onStay: vi.fn(),
      onBreak: vi.fn(),
      onEnd: vi.fn(),
    });

    expect(container.querySelector('.headline')?.textContent?.trim()).toBe('Focus check-in');
    expect(screen.getByText('Stay with it, or step away')).toBeTruthy();
    expect(screen.getByText('Overtime stays quiet while you decide.')).toBeTruthy();
  });

  it('fires only the callback named by each action', async () => {
    const onStay = vi.fn();
    const onBreak = vi.fn();
    const onEnd = vi.fn();
    render(FocusCompletionPrompt, {
      kind: 'overtime',
      phase: 'warning',
      leadLabel: '30 seconds',
      announcement: null,
      onStay,
      onBreak,
      onEnd,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Stay with it' }));
    expect(onStay).toHaveBeenCalledOnce();
    expect(onBreak).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Take a break' }));
    expect(onBreak).toHaveBeenCalledOnce();
    expect(onEnd).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(onEnd).toHaveBeenCalledOnce();
  });
});

describe('FocusCompletionPrompt — shared nonmodal semantics', () => {
  it('is not a dialog, alertdialog, or modal, and has no scrim', () => {
    const { container } = render(FocusCompletionPrompt, {
      kind: 'overtime',
      phase: 'initial',
      leadLabel: null,
      announcement: null,
      onStay: vi.fn(),
      onBreak: vi.fn(),
      onEnd: vi.fn(),
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(container.querySelector('[aria-modal]')).toBeNull();
    expect(container.querySelector('.scrim')).toBeNull();
  });

  it('renders one aria-live="polite" region that holds only a non-null announcement', () => {
    const { container, rerender } = render(FocusCompletionPrompt, {
      kind: 'warning',
      leadLabel: '30 seconds',
      announcement: null,
      onPrimary: vi.fn(),
      onSecondary: vi.fn(),
    });

    const regions = container.querySelectorAll('[aria-live="polite"]');
    expect(regions.length).toBe(1);
    expect(regions[0].textContent?.trim()).toBe('');

    rerender({
      kind: 'warning',
      leadLabel: '30 seconds',
      announcement: '30 seconds left',
      onPrimary: vi.fn(),
      onSecondary: vi.fn(),
    });
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('30 seconds left');
  });

  it('never moves document.activeElement on render', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    render(FocusCompletionPrompt, {
      kind: 'overtime',
      phase: 'initial',
      leadLabel: null,
      announcement: null,
      onStay: vi.fn(),
      onBreak: vi.fn(),
      onEnd: vi.fn(),
    });

    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('lets the headline/subline/detail text wrap instead of forcing no-wrap', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/FocusCompletionPrompt.svelte'), 'utf8');
    for (const selector of ['.headline', '.subline', '.detail']) {
      const rule = source.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
      expect(rule).not.toMatch(/white-space:\s*nowrap/);
      expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it('caps every radius at 8px', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/FocusCompletionPrompt.svelte'), 'utf8');
    const radii = [...source.matchAll(/border-radius:\s*([\d.]+)(rem|px|em)/g)].map(
      ([, value, unit]) => Number(value) * (unit === 'px' ? 1 : 16),
    );
    expect(radii.length).toBeGreaterThan(0);
    for (const px of radii) expect(px).toBeLessThanOrEqual(8);
  });

  it('stacks actions on mobile and keeps 44px targets', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/FocusCompletionPrompt.svelte'), 'utf8');
    expect(source).toMatch(/min-height:\s*44px/);
    expect(source).toMatch(/@media \(max-width: 639px\)/);
  });

  it('removes transitions under reduced motion', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/FocusCompletionPrompt.svelte'), 'utf8');
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
