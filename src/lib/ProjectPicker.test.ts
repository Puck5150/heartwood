// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectPicker from './ProjectPicker.svelte';
import type { Project } from './projects';

afterEach(cleanup);

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Thesis',
    category: 'study',
    archivedAt: null,
    createdAt: 1000,
    ...overrides,
  };
}

interface PickerProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string, category: Project['category']) => Promise<Project>;
  initiallyCreating?: boolean;
}

function props(overrides: Partial<PickerProps> = {}): PickerProps {
  return {
    projects: [],
    selectedId: null,
    onSelect: vi.fn(),
    onCreate: vi.fn(async () => project()),
    ...overrides,
  };
}

describe('ProjectPicker', () => {
  it('renders "No project" as the default selected option when selectedId is null', () => {
    render(ProjectPicker, props({ projects: [project()] }));

    const select = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: 'No project' })).toBeTruthy();
  });

  it('only renders non-archived projects as options', () => {
    const active = project({ id: 'p1', name: 'Active Project' });
    const archived = project({ id: 'p2', name: 'Archived Project', archivedAt: 5000 });
    render(ProjectPicker, props({ projects: [active, archived] }));

    expect(screen.getByRole('option', { name: /Active Project/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Archived Project/ })).toBeNull();
  });

  it('calls onSelect with the chosen project id', async () => {
    const onSelect = vi.fn();
    const p = project({ id: 'p1', name: 'Thesis' });
    render(ProjectPicker, props({ projects: [p], onSelect }));

    await fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: 'p1' },
    });

    expect(onSelect).toHaveBeenCalledWith('p1');
  });

  it('reveals the create form on "+ New project" and calls onCreate then onSelect on success', async () => {
    const created = project({ id: 'new-id', name: 'New Thing', category: 'work' });
    const onCreate = vi.fn(async () => created);
    const onSelect = vi.fn();
    render(ProjectPicker, props({ onCreate, onSelect }));

    await fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: '__new__' },
    });

    expect(screen.getByLabelText('New project name')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();

    await fireEvent.input(screen.getByLabelText('New project name'), {
      target: { value: 'New Thing' },
    });
    await fireEvent.click(screen.getByRole('radio', { name: 'Work' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledWith('New Thing', 'work');
    expect(onSelect).toHaveBeenCalledWith('new-id');
  });

  it('shows an error and does not call onCreate for a blank/whitespace-only name', async () => {
    const onCreate = vi.fn();
    render(ProjectPicker, props({ onCreate }));

    await fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: '__new__' },
    });
    await fireEvent.input(screen.getByLabelText('New project name'), {
      target: { value: '   ' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(screen.getByRole('alert').textContent).toBe('Give the project a name.');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('renders the create form immediately when initiallyCreating is true', () => {
    render(ProjectPicker, props({ initiallyCreating: true }));

    expect(screen.getByLabelText('New project name')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
  });
});
