// @vitest-environment jsdom
//
// Named ProjectsDetail, not Projects: this filesystem is case-insensitive,
// and `projects.test.ts` (the pure-logic test for projects.ts) already
// exists — `Projects.test.ts` would silently collide with it. See
// HistoryTabs.test.ts for the same reasoning.

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Projects from './Projects.svelte';
import type { Project } from './projects';
import type { Task } from './tasks';

function project(overrides: Partial<Project> = {}): Project {
  return { id: 'p1', name: 'Q3 Launch', category: 'work', archivedAt: null, createdAt: 1_700_000_000_000, ...overrides };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'Write the report',
    notes: null,
    status: 'backlog',
    priority: 'medium',
    dueAt: null,
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof Projects>[1]> = {}) {
  return {
    projects: [project()],
    summaries: [],
    tasks: [],
    onBack: vi.fn(),
    onCreateProject: vi.fn(async () => project()),
    onRenameProject: vi.fn(async () => {}),
    onArchiveProject: vi.fn(async () => {}),
    onCreateTask: vi.fn(async () => {}),
    onUpdateTask: vi.fn(async () => {}),
    onMoveTask: vi.fn(async () => {}),
    onDeleteTask: vi.fn(async () => {}),
    onStartFocusFromTask: vi.fn(),
    canStartFocus: true,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('Projects detail Board/Sessions tabs', () => {
  it('defaults to the Board tab when a project is opened', async () => {
    render(Projects, baseProps());
    await fireEvent.click(screen.getByText('Q3 Launch'));
    expect(screen.getByText('Backlog')).toBeTruthy(); // a TaskBoard column, proving Board is showing
  });

  it('switches to the Sessions tab, showing the existing session list', async () => {
    render(Projects, baseProps());
    await fireEvent.click(screen.getByText('Q3 Launch'));
    await fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(screen.getByText('No sessions tagged with this project yet.')).toBeTruthy();
  });

  it('passes only this project\'s tasks to the board', async () => {
    render(Projects, baseProps({
      tasks: [task({ id: 't1', projectId: 'p1', title: 'In this project' }), task({ id: 't2', projectId: 'other', title: 'Different project' })],
    }));
    await fireEvent.click(screen.getByText('Q3 Launch'));
    expect(screen.getByText('In this project')).toBeTruthy();
    expect(screen.queryByText('Different project')).toBeNull();
  });

  it('calls onStartFocusFromTask with the task title and this project\'s id', async () => {
    const onStartFocusFromTask = vi.fn();
    render(Projects, baseProps({ tasks: [task({ title: 'Do the thing' })], onStartFocusFromTask }));
    await fireEvent.click(screen.getByText('Q3 Launch'));
    await fireEvent.click(screen.getByText('Do the thing'));
    await fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));
    expect(onStartFocusFromTask).toHaveBeenCalledWith('Do the thing', 'p1');
  });
});
