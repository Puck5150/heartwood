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
    onMoveTask: vi.fn(async () => {}),
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

  it('pre-fills the edit due date input using local time, not UTC (regression for the toISOString bug)', async () => {
    const originalTz = process.env.TZ;
    // A positive-UTC-offset zone is what exposed the bug: formatting a local
    // midnight timestamp via toISOString() (UTC) rolled it back a calendar day.
    process.env.TZ = 'Asia/Tokyo';
    try {
      const dueAt = new Date(2026, 2, 15).getTime(); // local midnight, March 15 2026
      render(TaskBoard, baseProps({ tasks: [task({ dueAt })] }));

      await fireEvent.click(screen.getByText('Write the report'));
      const dueDateInput = screen.getByLabelText('Task due date') as HTMLInputElement;

      expect(dueDateInput.value).toBe('2026-03-15');
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('round-trips a due date through create then edit without shifting days', async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      const onCreateTask = vi.fn(
        async (_fields: { title: string; notes: string | null; priority: string; dueAt: number | null }) => {},
      );
      render(TaskBoard, baseProps({ onCreateTask }));

      await fireEvent.click(screen.getByRole('button', { name: '+ Add task' }));
      await fireEvent.input(screen.getByLabelText('New task title'), { target: { value: 'Round trip task' } });
      await fireEvent.input(screen.getByLabelText('New task due date'), { target: { value: '2026-03-15' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      const dueAt = onCreateTask.mock.calls[0][0].dueAt as number;
      cleanup();

      render(TaskBoard, baseProps({ tasks: [task({ dueAt })] }));
      await fireEvent.click(screen.getByText('Write the report'));
      const dueDateInput = screen.getByLabelText('Task due date') as HTMLInputElement;

      expect(dueDateInput.value).toBe('2026-03-15');
    } finally {
      process.env.TZ = originalTz;
    }
  });
});

describe('TaskBoard moving cards', () => {
  it('moves a task to another column via the keyboard "Move to..." control', async () => {
    const onMoveTask = vi.fn(async () => {});
    render(TaskBoard, baseProps({ tasks: [task({ id: 't1', status: 'backlog' })], onMoveTask }));

    await fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'To Do' }));

    expect(onMoveTask).toHaveBeenCalledWith('t1', 'todo', expect.any(Number));
  });

  it('places a task moved into an empty column at position 0', async () => {
    const onMoveTask = vi.fn(async () => {});
    render(TaskBoard, baseProps({ tasks: [task({ id: 't1', status: 'backlog' })], onMoveTask }));

    await fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }));

    expect(onMoveTask).toHaveBeenCalledWith('t1', 'done', 0);
  });

  it('places a task moved into a non-empty column after the existing last item', async () => {
    const onMoveTask = vi.fn(async () => {});
    render(
      TaskBoard,
      baseProps({
        tasks: [task({ id: 't1', status: 'backlog' }), task({ id: 't2', status: 'done', position: 5 })],
        onMoveTask,
      }),
    );

    await fireEvent.click(screen.getAllByRole('button', { name: 'Move to…' })[0]);
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }));

    expect(onMoveTask).toHaveBeenCalledWith('t1', 'done', 6);
  });

  it('reorders within a column using the down arrow, moving after the next task', async () => {
    const onMoveTask = vi.fn(async () => {});
    render(
      TaskBoard,
      baseProps({
        tasks: [
          task({ id: 't1', status: 'backlog', position: 0, title: 'First' }),
          task({ id: 't2', status: 'backlog', position: 1, title: 'Second' }),
        ],
        onMoveTask,
      }),
    );

    const moveDownButtons = screen.getAllByRole('button', { name: 'Move down' });
    await fireEvent.click(moveDownButtons[0]); // moves "First" past "Second"

    expect(onMoveTask).toHaveBeenCalledWith('t1', 'backlog', 2);
  });

  it('reorders within a column using the up arrow, moving before the previous task', async () => {
    const onMoveTask = vi.fn(async () => {});
    render(
      TaskBoard,
      baseProps({
        tasks: [
          task({ id: 't1', status: 'backlog', position: 0, title: 'First' }),
          task({ id: 't2', status: 'backlog', position: 1, title: 'Second' }),
        ],
        onMoveTask,
      }),
    );

    const moveUpButtons = screen.getAllByRole('button', { name: 'Move up' });
    await fireEvent.click(moveUpButtons[1]); // moves "Second" before "First"

    expect(onMoveTask).toHaveBeenCalledWith('t2', 'backlog', -1);
  });

  it('disables "Move up" for the first card and "Move down" for the last card in a column', () => {
    render(
      TaskBoard,
      baseProps({
        tasks: [task({ id: 't1', status: 'backlog', position: 0 }), task({ id: 't2', status: 'backlog', position: 1 })],
      }),
    );

    const upButtons = screen.getAllByRole('button', { name: 'Move up' }) as HTMLButtonElement[];
    const downButtons = screen.getAllByRole('button', { name: 'Move down' }) as HTMLButtonElement[];
    expect(upButtons[0].disabled).toBe(true);
    expect(downButtons[1].disabled).toBe(true);
    expect(upButtons[1].disabled).toBe(false);
    expect(downButtons[0].disabled).toBe(false);
  });

  it('sets draggable="true" on cards and calls onMoveTask on drop into another column', async () => {
    const onMoveTask = vi.fn(async () => {});
    const { container } = render(TaskBoard, baseProps({ tasks: [task({ id: 't1', status: 'backlog' })], onMoveTask }));

    const card = container.querySelector('[draggable="true"]') as HTMLElement;
    expect(card).toBeTruthy();

    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => 't1') };
    await fireEvent.dragStart(card, { dataTransfer });

    const doneColumn = screen.getByText('Done').closest('.column') as HTMLElement;
    await fireEvent.drop(doneColumn, { dataTransfer });

    expect(onMoveTask).toHaveBeenCalledWith('t1', 'done', 0);
  });
});
