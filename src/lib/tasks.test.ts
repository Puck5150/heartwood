import { describe, expect, it } from 'vitest';
import { serializeTask, toTask, type Task, type TaskRow } from './tasks';

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't1',
    project_id: 'p1',
    title: 'Write the report',
    notes: null,
    status: 'backlog',
    priority: 'medium',
    due_at: null,
    position: 0,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
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

describe('toTask', () => {
  it('maps a row to a Task', () => {
    expect(toTask(row())).toEqual(task());
  });

  it('maps notes and due_at through when present', () => {
    expect(toTask(row({ notes: 'Some notes', due_at: 1_700_100_000_000 }))).toMatchObject({
      notes: 'Some notes',
      dueAt: 1_700_100_000_000,
    });
  });

  it('throws on an unknown status', () => {
    expect(() => toTask(row({ status: 'bogus' }))).toThrow(/unknown status/);
  });

  it('throws on an unknown priority', () => {
    expect(() => toTask(row({ priority: 'urgent' }))).toThrow(/unknown priority/);
  });
});

describe('serializeTask', () => {
  it('maps a Task back to a row', () => {
    expect(serializeTask(task())).toEqual(row());
  });

  it('round-trips through toTask/serializeTask', () => {
    const original = task({ notes: 'Notes here', dueAt: 1_700_200_000_000, priority: 'high', status: 'in_progress' });
    expect(toTask(serializeTask(original))).toEqual(original);
  });
});
