// Pure domain module for Tasks: the type, its fixed Status/Priority
// enums, and row<->domain mapping. No database access here, matching
// projects.ts's own separation of concerns — this module only ever
// describes the Task entity itself.

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';

export const TASK_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'done'];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high'];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export interface Task {
  id: string;
  projectId: string;
  title: string;
  /** Optional free-text detail, shown when a card is opened for editing. */
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** Epoch ms of local midnight on the due day, or null if no due date is
   * set. Date-only — a due date is "by this day," not a specific moment,
   * so this never carries a meaningful time-of-day component. */
  dueAt: number | null;
  /** Fractional position within its (project_id, status) column — see
   * taskPosition.ts's positionBetween for how new values are computed.
   * ORDER BY position ASC is the display order within a column. */
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  notes: string | null;
  status: string;
  priority: string;
  due_at: number | null;
  position: number;
  created_at: number;
  updated_at: number;
}

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as string[]).includes(value);
}

function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as string[]).includes(value);
}

/** Throws on an unknown status/priority rather than silently defaulting —
 * a row with a bad value indicates real data corruption (the CHECK
 * constraint should have prevented it at the SQL layer), and hiding that
 * behind a fallback would make it invisible to the user and to tests. */
export function toTask(row: TaskRow): Task {
  if (!isTaskStatus(row.status)) {
    throw new Error(`Malformed task row "${row.id}": unknown status "${row.status}".`);
  }
  if (!isTaskPriority(row.priority)) {
    throw new Error(`Malformed task row "${row.id}": unknown priority "${row.priority}".`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeTask(task: Task): TaskRow {
  return {
    id: task.id,
    project_id: task.projectId,
    title: task.title,
    notes: task.notes,
    status: task.status,
    priority: task.priority,
    due_at: task.dueAt,
    position: task.position,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}
