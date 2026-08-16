// @vitest-environment jsdom
//
// Named ProjectsRail rather than Projects.test.ts (which the plan's brief
// specifies) to avoid a real collision on this machine's default
// case-insensitive-but-case-preserving filesystem: "Projects.test.ts" and
// the pre-existing domain-module test "projects.test.ts" differ only in
// case, so creating one clobbers the other on disk even though git treats
// them as distinct tracked paths. See task-7-report.md for the incident.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Projects from './Projects.svelte';
import type { Project } from './projects';
import type { SessionSummary } from './history';
import type { Task, TaskPriority, TaskStatus } from './tasks';

afterEach(cleanup);

function fakeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Alpha',
    category: 'work',
    archivedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

function fakeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    task: 'Write report',
    completedAt: 1_700_000_000_000,
    plannedFocusMs: 0,
    actualFocusMs: 0,
    flowMs: 0,
    tookBreak: false,
    breakMs: 0,
    breakIntermissionMs: 0,
    touchGrassMs: 0,
    totalElapsedMs: 0,
    parkedThoughtCount: 0,
    noteContent: null,
    revisionCount: 0,
    projectId: null,
    ...overrides,
  };
}

interface ProjectsProps {
  projects: Project[];
  summaries: SessionSummary[];
  tasks: Task[];
  onBack: () => void;
  onCreateProject: (name: string, category: 'personal' | 'work' | 'study') => Promise<Project>;
  onRenameProject: (id: string, name: string) => Promise<void>;
  onArchiveProject: (id: string, archived: boolean) => Promise<void>;
  onCreateTask: (projectId: string, fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null }) => Promise<void>;
  onUpdateTask: (id: string, fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null }) => Promise<void>;
  onMoveTask: (id: string, status: TaskStatus, position: number) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onStartFocusFromTask: (title: string, projectId: string) => void;
  canStartFocus: boolean;
}

function props(overrides: Partial<ProjectsProps> = {}): ProjectsProps {
  return {
    projects: [],
    summaries: [],
    tasks: [],
    onBack: vi.fn(),
    onCreateProject: vi.fn(async (name, category) =>
      fakeProject({ id: 'new-id', name, category }),
    ),
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

const alpha = fakeProject({ id: 'p1', name: 'Alpha', category: 'work', archivedAt: null });
const beta = fakeProject({ id: 'p2', name: 'Beta', category: 'personal', archivedAt: 5_000 });

const alphaSessionA = fakeSummary({
  id: 's1',
  task: 'Write report',
  projectId: 'p1',
  actualFocusMs: 600_000,
  completedAt: 3,
});
const alphaSessionB = fakeSummary({
  id: 's2',
  task: 'Review PR',
  projectId: 'p1',
  actualFocusMs: 300_000,
  completedAt: 4,
});
const betaSession = fakeSummary({
  id: 's3',
  task: 'Study notes',
  projectId: 'p2',
  actualFocusMs: 120_000,
  completedAt: 5,
});

describe('Projects', () => {
  it('lists only active projects by default, revealing archived ones via the toggle', async () => {
    render(Projects, props({ projects: [alpha, beta] }));

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();

    await fireEvent.click(screen.getByLabelText('Show archived'));

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    const betaRow = screen.getByRole('button', { name: /Beta/ });
    expect(within(betaRow).getByText('Archived')).toBeTruthy();
  });

  it("shows each project row's correct session count, and its total focus time in the detail view", async () => {
    const { container } = render(
      Projects,
      props({
        projects: [alpha, beta],
        summaries: [alphaSessionA, alphaSessionB, betaSession],
      }),
    );

    const alphaRow = screen.getByRole('button', { name: /Alpha/ });
    expect(within(alphaRow).getByText('2 sessions')).toBeTruthy();

    await fireEvent.click(alphaRow);
    const statLine = container.querySelector('.stat-line')?.textContent ?? '';
    expect(statLine).toContain('2 sessions');
    expect(statLine).toContain('15:00 focused');
  });

  it('switches to detail view on row click, showing name, category, and only that project\'s sessions', async () => {
    render(
      Projects,
      props({
        projects: [alpha, beta],
        summaries: [alphaSessionA, alphaSessionB, betaSession],
      }),
    );

    await fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));

    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeTruthy();
    expect(screen.getByText('Work')).toBeTruthy();

    // Session list now lives behind the Sessions tab (Board is the entry
    // tab) — see Task 6's Board/Sessions split.
    await fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(screen.getByText('Write report')).toBeTruthy();
    expect(screen.getByText('Review PR')).toBeTruthy();
    expect(screen.queryByText('Study notes')).toBeNull();
  });

  it('renames a project: entering edit mode, changing the name, and saving calls onRenameProject', async () => {
    const onRenameProject = vi.fn(async () => {});
    render(Projects, props({ projects: [alpha], summaries: [], onRenameProject }));

    await fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    const input = screen.getByLabelText('Rename project');
    await fireEvent.input(input, { target: { value: 'Alpha Renamed' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onRenameProject).toHaveBeenCalledWith('p1', 'Alpha Renamed');
  });

  it('archives an active project and unarchives an archived one via the toggled boolean', async () => {
    const onArchiveProject = vi.fn(async () => {});
    render(Projects, props({ projects: [alpha, beta], summaries: [], onArchiveProject }));

    await fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onArchiveProject).toHaveBeenCalledWith('p1', true);

    await fireEvent.click(screen.getByText(/All projects/));
    await fireEvent.click(screen.getByLabelText('Show archived'));
    await fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(onArchiveProject).toHaveBeenCalledWith('p2', false);
  });

  it('returns to the list view via "All projects"', async () => {
    render(Projects, props({ projects: [alpha], summaries: [] }));

    await fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeTruthy();

    await fireEvent.click(screen.getByText(/All projects/));
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('button', { name: /Alpha/ })).toBeTruthy();
  });

  it('reveals the create form (not a bare dropdown) on "+ New Project", then hides it after creating', async () => {
    const onCreateProject = vi.fn(async (name: string, category: 'personal' | 'work' | 'study') =>
      fakeProject({ id: 'new-id', name, category }),
    );
    render(Projects, props({ projects: [], summaries: [], onCreateProject }));

    expect(screen.queryByLabelText('New project name')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: '+ New Project' }));

    const nameInput = screen.getByLabelText('New project name');
    expect(nameInput).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();

    await fireEvent.input(nameInput, { target: { value: 'Gamma' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreateProject).toHaveBeenCalledWith('Gamma', 'personal');
    expect(screen.queryByLabelText('New project name')).toBeNull();
  });
});
