// @vitest-environment jsdom
//
// Named HistoryTabs, not History: this filesystem is case-insensitive, and
// `history.test.ts` (the pure-logic test for history.ts) already exists —
// `History.test.ts` would silently collide with it. See ProjectsRail.test.ts
// for the same naming workaround elsewhere in this codebase.
//
// Scoped narrowly to the Sessions/Breakdown tab's keyboard behavior added by
// the Impeccable audit fix pass — not a full History.svelte component test.

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import History from './History.svelte';

function minimalProps() {
  return {
    summaries: [],
    parkedThoughts: [],
    onBack: vi.fn(),
    onDeleteSession: vi.fn(),
    onDeleteAll: vi.fn(),
    onOpenNotesFolder: vi.fn(async () => {}),
    onViewRevisions: vi.fn(),
    projects: [],
    onAssignProject: vi.fn(async () => {}),
    onCreateProject: vi.fn(async () => ({
      id: 'p1',
      name: 'New Project',
      category: 'work' as const,
      archivedAt: null,
      createdAt: 0,
    })),
    onImport: vi.fn(async () => ({
      sessionsImported: 0,
      sessionsSkipped: 0,
      sessionsFailed: 0,
      thoughtsImported: 0,
      thoughtsSkipped: 0,
      thoughtsFailed: 0,
      tasksImported: 0,
      tasksSkipped: 0,
      tasksFailed: 0,
      projectsCreated: 0,
    })),
    onEditNote: vi.fn(async () => {}),
    tasks: [],
  };
}

afterEach(() => {
  cleanup();
});

describe('History tabs keyboard navigation', () => {
  it('starts on the Sessions tab', () => {
    render(History, minimalProps());

    expect(screen.getByRole('tab', { name: 'Sessions' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Breakdown' }).getAttribute('aria-selected')).toBe('false');
  });

  it('ArrowRight moves both selection and focus from Sessions to Breakdown', async () => {
    render(History, minimalProps());
    const listTab = screen.getByRole('tab', { name: 'Sessions' });
    const breakdownTab = screen.getByRole('tab', { name: 'Breakdown' });

    listTab.focus();
    await fireEvent.keyDown(listTab, { key: 'ArrowRight' });

    expect(breakdownTab.getAttribute('aria-selected')).toBe('true');
    expect(listTab.getAttribute('aria-selected')).toBe('false');
    expect(document.activeElement).toBe(breakdownTab);
  });

  it('ArrowLeft wraps back from Breakdown to Sessions', async () => {
    render(History, minimalProps());
    const listTab = screen.getByRole('tab', { name: 'Sessions' });
    const breakdownTab = screen.getByRole('tab', { name: 'Breakdown' });

    // Get onto Breakdown first — ArrowLeft/Right both read the current
    // `activeTab` state, not which button merely has DOM focus, so
    // focusing breakdownTab without actually selecting it first would
    // make this a no-op, not a real "wrap back" test.
    listTab.focus();
    await fireEvent.keyDown(listTab, { key: 'ArrowRight' });
    await fireEvent.keyDown(breakdownTab, { key: 'ArrowLeft' });

    expect(listTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(listTab);
  });

  it('each tab is linked to its panel via aria-controls/id', () => {
    render(History, minimalProps());
    const listTab = screen.getByRole('tab', { name: 'Sessions' });
    const breakdownTab = screen.getByRole('tab', { name: 'Breakdown' });

    expect(listTab.getAttribute('aria-controls')).toBe('history-panel-list');
    expect(breakdownTab.getAttribute('aria-controls')).toBe('history-panel-breakdown');
    expect(document.getElementById('history-panel-list')).not.toBeNull();
  });
});
