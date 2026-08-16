// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TaskBoard from './TaskBoard.svelte';
import type { Task } from './tasks';

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

function baseProps(overrides: Partial<Parameters<typeof TaskBoard>[1]> = {}) {
  return {
    tasks: [],
    onCreateTask: vi.fn(async () => {}),
    onUpdateTask: vi.fn(async () => {}),
    onDeleteTask: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('TaskBoard', () => {
  it('renders all four columns', () => {
    render(TaskBoard, baseProps());
    expect(screen.getByText('Backlog')).toBeTruthy();
    expect(screen.getByText('To Do')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('groups tasks into their status column', () => {
    render(TaskBoard, baseProps({
      tasks: [task({ id: 't1', status: 'backlog', title: 'Backlog task' }), task({ id: 't2', status: 'done', title: 'Done task' })],
    }));
    expect(screen.getByText('Backlog task')).toBeTruthy();
    expect(screen.getByText('Done task')).toBeTruthy();
  });

  it('shows priority as a text tag on the card', () => {
    render(TaskBoard, baseProps({ tasks: [task({ priority: 'high' })] }));
    expect(screen.getByText('High')).toBeTruthy();
  });

  it('shows a due date, styled as overdue when in the past and not done', () => {
    const past = Date.now() - 24 * 60 * 60 * 1000;
    const { container } = render(TaskBoard, baseProps({ tasks: [task({ dueAt: past, status: 'todo' })] }));
    const overdue = container.querySelector('.overdue');
    expect(overdue).toBeTruthy();
  });

  it('does not mark a done task as overdue even with a past due date', () => {
    const past = Date.now() - 24 * 60 * 60 * 1000;
    const { container } = render(TaskBoard, baseProps({ tasks: [task({ dueAt: past, status: 'done' })] }));
    expect(container.querySelector('.overdue')).toBeNull();
  });

  it('creates a task via the inline form, landing in Backlog', async () => {
    const onCreateTask = vi.fn(async () => {});
    render(TaskBoard, baseProps({ onCreateTask }));

    await fireEvent.click(screen.getByRole('button', { name: '+ Add task' }));
    await fireEvent.input(screen.getByLabelText('New task title'), { target: { value: 'New task' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreateTask).toHaveBeenCalledWith({ title: 'New task', notes: null, priority: 'medium', dueAt: null });
  });

  it('does not submit an empty title', async () => {
    const onCreateTask = vi.fn(async () => {});
    render(TaskBoard, baseProps({ onCreateTask }));

    await fireEvent.click(screen.getByRole('button', { name: '+ Add task' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreateTask).not.toHaveBeenCalled();
  });

  it('opens a task for editing and saves changes', async () => {
    const onUpdateTask = vi.fn(async () => {});
    render(TaskBoard, baseProps({ tasks: [task({ title: 'Original' })], onUpdateTask }));

    await fireEvent.click(screen.getByText('Original'));
    const titleInput = screen.getByLabelText('Task title');
    await fireEvent.input(titleInput, { target: { value: 'Edited title' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdateTask).toHaveBeenCalledWith('t1', { title: 'Edited title', notes: null, priority: 'medium', dueAt: null });
  });

  it('deletes a task behind a confirm step', async () => {
    const onDeleteTask = vi.fn(async () => {});
    render(TaskBoard, baseProps({ tasks: [task()], onDeleteTask }));

    await fireEvent.click(screen.getByText('Write the report'));
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteTask).not.toHaveBeenCalled(); // confirm step, not immediate

    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onDeleteTask).toHaveBeenCalledWith('t1');
  });
});
