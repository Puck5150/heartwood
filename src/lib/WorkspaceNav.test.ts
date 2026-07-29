// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceNav from './WorkspaceNav.svelte';

afterEach(cleanup);

describe('WorkspaceNav', () => {
  it('marks the active workspace and navigates on click', async () => {
    const onNavigate = vi.fn();
    render(WorkspaceNav, { current: 'focus', showRevisions: false, onNavigate });

    const focusButton = screen.getByRole('button', { name: 'Focus' });
    const historyButton = screen.getByRole('button', { name: 'History' });
    expect(focusButton.getAttribute('aria-current')).toBe('page');
    expect(historyButton.getAttribute('aria-current')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revisions' })).toBeNull();

    await fireEvent.click(historyButton);
    expect(onNavigate).toHaveBeenCalledWith('history');
  });

  it('shows Revisions only when a revision view is active, and marks it current', () => {
    render(WorkspaceNav, { current: 'revisions', showRevisions: true, onNavigate: vi.fn() });

    const revisionsButton = screen.getByRole('button', { name: 'Revisions' });
    expect(revisionsButton.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Focus' }).getAttribute('aria-current')).toBeNull();
  });

  it('navigates back to Focus', async () => {
    const onNavigate = vi.fn();
    render(WorkspaceNav, { current: 'history', showRevisions: false, onNavigate });

    await fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(onNavigate).toHaveBeenCalledWith('focus');
  });
});
