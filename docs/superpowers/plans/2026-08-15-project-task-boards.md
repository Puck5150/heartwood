# Project Task Boards (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 4-column kanban task board per project (Backlog/To Do/In Progress/Done), with title/notes/priority/due-date per task, drag-and-drop plus full keyboard support for moving/reordering cards, and a "Start focus" action that immediately starts a session using the task's title.

**Architecture:** New `tasks` SQLite table (migration 11), a pure `tasks.ts` domain module (mirrors `projects.ts` exactly) plus a pure `taskPosition.ts` fractional-indexing helper, five new repository functions mirrored across the existing three-file pattern, a new `TaskBoard.svelte` component embedded in `Projects.svelte`'s detail view behind a new Board/Sessions tab pair (mirrors `History.svelte`'s List/Breakdown tabs), and `App.svelte` wiring that loads tasks once (like `projects`) and routes every mutation through `writeQueue`.

**Tech Stack:** Svelte 5 (runes), TypeScript, SQLite via `@tauri-apps/plugin-sql`, native HTML5 Drag and Drop API (no new npm dependency), Vitest.

## Global Constraints

- Migration version is **11** (the last migration in `src-tauri/src/migrations.rs` is version 10, "add projects table and sessions.project_id").
- No `FOREIGN KEY` on `tasks.project_id` — this schema uses no FK constraints anywhere; integrity is handled explicitly in the repository layer.
- Every repository write goes through the existing three-file pattern: `src/lib/tauriRepository.ts` (real, plain `db.execute()` — no new Rust command needed), `src/lib/memoryRepository.ts` (browser-dev fallback), `src/lib/repository.ts` (dispatcher re-exporting both). Never add a function to only one.
- Every repository mutation `App.svelte` triggers must be wrapped in `writeQueue.enqueue(...)`, matching every existing mutation in that file (`saveSession`, `insertProject`, `updateSessionProject`, etc.).
- `position` is a `REAL` column using fractional/midpoint indexing: a new position is the numeric midpoint of its two new neighbors (or `neighbor ± 1` at either edge of a column, or `0` for an empty column). This is computed client-side (in `taskPosition.ts`) before calling a repository function — no repository function ever renumbers a whole column.
- No new per-theme colors. Priority is a text-only tag (`Low`/`Medium`/`High`, High distinguished by font-weight, not hue). Overdue due dates use the existing `var(--danger)` token. Everything else uses `var(--text-muted)`/`var(--surface-secondary)`/`var(--border)`/`var(--timer-accent)`, matching every existing component in `src/lib`.
- A due date is date-only (no time-of-day): stored as the epoch-ms timestamp of local midnight on the chosen day, displayed via `toLocaleDateString()`, never `formatDateTime`.
- Task delete is a hard delete (unlike projects, which are archive-only) — behind the existing `.row-confirm`/`.row-confirm-text` confirm pattern already used in `Greenhouse.svelte`/`History.svelte`.
- "Start focus" from a task reuses `App.svelte`'s existing `startFreshFocus`/`handleStartParkedThought` mechanism exactly: it starts a session **immediately** (no intermediate pre-filled form), guarded by `session.status === 'idle'` and `sessionRecovered` and `isValidDurationMinutes(durationMinutes)` (the same guard `ParkingLot`'s own `startDisabled` prop already uses, minus the parked-thoughts-specific `thoughtsRecovered` check, which doesn't apply here). Before calling `startFreshFocus(task.title)`, set `selectedProjectId = task.projectId` so the resulting session is automatically tagged with the task's own project (reusing `startFreshFocus`'s own existing project-tagging behavior — no new tagging code needed).
- Test files: this filesystem is case-insensitive. `tasks.ts`/`tasks.test.ts`, `taskPosition.ts`/`taskPosition.test.ts`, and `TaskBoard.svelte`/`TaskBoard.test.ts` are all new, unique names with no existing collisions (confirmed: no existing `Tasks.*`/`taskPosition.*`/`TaskBoard.*` files; `taskQueue.ts` is a distinct, unrelated existing file).
- No raw hex/rgb color literals in `.svelte` files — only `var(--token)` references (enforced by `appearanceTokens.test.ts`).
- Out of scope (per the design spec, do not build): task export/import, session↔task linking beyond the title pre-fill, column customization, due-date notifications, a cross-project task view.

---

### Task 1: Rust migration — `tasks` table

**Files:**
- Modify: `src-tauri/src/migrations.rs`

**Interfaces:**
- Produces: a `tasks` table with columns `id, project_id, title, notes, status, priority, due_at, position, created_at, updated_at`, and an index `idx_tasks_project_id`. Task 2/3 depend on this exact column set and exact `status`/`priority` CHECK values.

- [ ] **Step 1: Add the migration**

Find the closing `}]` after migration version 10's block (currently the last entry in the `vec![...]`). Insert a new migration entry immediately before that closing bracket:

```rust
    }, Migration {
        version: 11,
        description: "add tasks table for per-project kanban boards",
        sql: r#"
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                notes TEXT,
                status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'done')),
                priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
                due_at INTEGER,
                position REAL NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX idx_tasks_project_id ON tasks(project_id);
        "#,
        kind: MigrationKind::Up,
    }]
}
```

- [ ] **Step 2: Write the migration test**

Find the test module (`#[cfg(test)] mod tests { ... }`) and the existing `version_ten_creates_projects_table_and_nullable_session_project_id` test for the pattern. Add a new test near it:

```rust
    #[tokio::test]
    async fn version_eleven_creates_tasks_table() {
        let pool = migrated_pool().await;

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('tasks')")
            .fetch_all(&pool)
            .await
            .unwrap();
        for expected in [
            "id", "project_id", "title", "notes", "status", "priority", "due_at", "position",
            "created_at", "updated_at",
        ] {
            assert!(columns.contains(&expected.to_string()), "missing column {expected}");
        }

        let indexes: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_index_list('tasks')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(indexes.contains(&"idx_tasks_project_id".to_string()));
    }

    #[tokio::test]
    async fn tasks_status_check_rejects_unknown_values() {
        let pool = migrated_pool().await;

        assert!(sqlx::query(
            "INSERT INTO tasks (id, project_id, title, status, priority, position, created_at, updated_at) VALUES ('t1', 'p1', 'Test', 'bogus', 'low', 0, 1000, 1000)",
        )
        .execute(&pool)
        .await
        .is_err());

        assert!(sqlx::query(
            "INSERT INTO tasks (id, project_id, title, status, priority, position, created_at, updated_at) VALUES ('t1', 'p1', 'Test', 'backlog', 'low', 0, 1000, 1000)",
        )
        .execute(&pool)
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn tasks_priority_check_rejects_unknown_values() {
        let pool = migrated_pool().await;

        assert!(sqlx::query(
            "INSERT INTO tasks (id, project_id, title, status, priority, position, created_at, updated_at) VALUES ('t1', 'p1', 'Test', 'backlog', 'urgent', 0, 1000, 1000)",
        )
        .execute(&pool)
        .await
        .is_err());
    }
```

- [ ] **Step 3: Run the Rust tests**

Run: `cd src-tauri && cargo test migrations`
Expected: PASS for all three new tests, and no regression in the existing migration tests.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migrations.rs
git commit -m "feat: add tasks table migration for per-project kanban boards"
```

---

### Task 2: `tasks.ts` domain module and `taskPosition.ts` fractional-indexing helper

**Files:**
- Create: `src/lib/tasks.ts`
- Create: `src/lib/tasks.test.ts`
- Create: `src/lib/taskPosition.ts`
- Create: `src/lib/taskPosition.test.ts`

**Interfaces:**
- Produces: `Task`, `TaskRow`, `TaskStatus`, `TaskPriority`, `TASK_STATUSES`, `TASK_PRIORITIES`, `STATUS_LABELS`, `PRIORITY_LABELS`, `toTask`, `serializeTask` from `tasks.ts`; `positionBetween(before: number | null, after: number | null): number` from `taskPosition.ts`. Task 3 (repository layer) and Task 4/5 (`TaskBoard.svelte`) both consume these.

- [ ] **Step 1: Write failing tests for `taskPosition.ts`**

Create `src/lib/taskPosition.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { positionBetween } from './taskPosition';

describe('positionBetween', () => {
  it('returns 0 for an empty column (no neighbors)', () => {
    expect(positionBetween(null, null)).toBe(0);
  });

  it('returns one less than the first item when inserting at the top', () => {
    expect(positionBetween(null, 5)).toBe(4);
  });

  it('returns one more than the last item when inserting at the bottom', () => {
    expect(positionBetween(5, null)).toBe(6);
  });

  it('returns the midpoint when inserting between two items', () => {
    expect(positionBetween(2, 4)).toBe(3);
    expect(positionBetween(1, 2)).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/taskPosition.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `taskPosition.ts`**

```ts
// Pure fractional/midpoint-indexing math for ordering tasks within a
// kanban column without ever renumbering the rest of the column on a
// single move — the classic Trello-style scheme. `before`/`after` are
// the positions of the two tasks the moved/created task will sit
// between; null means "no neighbor on that side" (top or bottom of the
// column, or the column is empty).

export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return after! - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run src/lib/taskPosition.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for `tasks.ts`**

Create `src/lib/tasks.test.ts`, following `projects.ts`'s own test file for the pattern (check if `src/lib/projects.test.ts` exists — if so, mirror its structure; if not, use this):

```ts
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
```

- [ ] **Step 6: Run, confirm failure**

Run: `npx vitest run src/lib/tasks.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 7: Implement `tasks.ts`**

```ts
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
```

- [ ] **Step 8: Run, confirm pass**

Run: `npx vitest run src/lib/tasks.test.ts src/lib/taskPosition.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/lib/tasks.ts src/lib/tasks.test.ts src/lib/taskPosition.ts src/lib/taskPosition.test.ts
git commit -m "feat: add Task domain module and fractional-position helper"
```

---

### Task 3: Repository layer — task CRUD across all three files

**Files:**
- Modify: `src/lib/tauriRepository.ts`, `src/lib/memoryRepository.ts`, `src/lib/repository.ts`
- Test: `src/lib/memoryRepository.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: `Task`, `TaskRow`, `TaskStatus`, `toTask`, `serializeTask` from `./tasks` (Task 2).
- Produces:
  ```ts
  export async function insertTask(task: Task): Promise<void>;
  export async function updateTask(
    id: string,
    fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null },
    now: number,
  ): Promise<void>;
  export async function moveTask(id: string, status: TaskStatus, position: number, now: number): Promise<void>;
  export async function deleteTask(id: string): Promise<void>;
  export async function loadAllTasks(): Promise<Task[]>;
  ```
  `moveTask` covers both cross-column moves and within-column reordering — a reorder is just "move to the same status, new position," so one function handles both rather than two nearly-identical ones. Task 4/6 consume all five via `./repository`.

- [ ] **Step 1: Write failing tests in `memoryRepository.test.ts`**

Read the existing file's imports and `resetMemoryStore()`/`beforeEach` pattern first, then add near the project-related tests:

```ts
describe('task repository functions', () => {
  const baseTask: Task = {
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
  };

  it('inserts a task and loads it back', async () => {
    await insertTask(baseTask);
    expect(await loadAllTasks()).toEqual([baseTask]);
  });

  it('loads tasks ordered by position ascending', async () => {
    await insertTask({ ...baseTask, id: 't1', position: 2 });
    await insertTask({ ...baseTask, id: 't2', position: 0 });
    await insertTask({ ...baseTask, id: 't3', position: 1 });
    expect((await loadAllTasks()).map((t) => t.id)).toEqual(['t2', 't3', 't1']);
  });

  it('updateTask changes title/notes/priority/dueAt and bumps updatedAt, leaving status/position untouched', async () => {
    await insertTask(baseTask);
    await updateTask('t1', { title: 'Revised title', notes: 'New notes', priority: 'high', dueAt: 1_700_500_000_000 }, 1_700_100_000_000);
    const [updated] = await loadAllTasks();
    expect(updated).toMatchObject({
      title: 'Revised title',
      notes: 'New notes',
      priority: 'high',
      dueAt: 1_700_500_000_000,
      status: 'backlog',
      position: 0,
      updatedAt: 1_700_100_000_000,
    });
  });

  it('moveTask changes status and position and bumps updatedAt', async () => {
    await insertTask(baseTask);
    await moveTask('t1', 'in_progress', 5, 1_700_200_000_000);
    const [moved] = await loadAllTasks();
    expect(moved).toMatchObject({ status: 'in_progress', position: 5, updatedAt: 1_700_200_000_000 });
  });

  it('deleteTask removes the task', async () => {
    await insertTask(baseTask);
    await deleteTask('t1');
    expect(await loadAllTasks()).toEqual([]);
  });
});
```

Add `insertTask, updateTask, moveTask, deleteTask, loadAllTasks` to the file's existing top-of-file import from `./memoryRepository`, and `import type { Task } from './tasks';`.

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/memoryRepository.test.ts`
Expected: FAIL — functions don't exist yet.

- [ ] **Step 3: Implement in `memoryRepository.ts`**

Add to the imports at the top: `import type { Task, TaskPriority, TaskStatus } from './tasks';`

Add a new store near the existing `const projects = new Map<string, Project>();`:

```ts
const tasks = new Map<string, Task>();
```

Add `tasks.clear();` to `resetMemoryStore()`, alongside `projects.clear();`.

Add the five functions, near the project functions:

```ts
export async function insertTask(task: Task): Promise<void> {
  tasks.set(task.id, task);
}

export async function updateTask(
  id: string,
  fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null },
  now: number,
): Promise<void> {
  const existing = tasks.get(id);
  if (!existing) return;
  tasks.set(id, { ...existing, ...fields, updatedAt: now });
}

export async function moveTask(id: string, status: TaskStatus, position: number, now: number): Promise<void> {
  const existing = tasks.get(id);
  if (!existing) return;
  tasks.set(id, { ...existing, status, position, updatedAt: now });
}

export async function deleteTask(id: string): Promise<void> {
  tasks.delete(id);
}

export async function loadAllTasks(): Promise<Task[]> {
  return [...tasks.values()].sort((a, b) => a.position - b.position);
}
```

- [ ] **Step 4: Run memoryRepository tests, confirm pass**

Run: `npx vitest run src/lib/memoryRepository.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Implement in `tauriRepository.ts`**

Add to the imports: `import { serializeTask, toTask, type Task, type TaskPriority, type TaskRow, type TaskStatus } from './tasks';`

Add the five functions:

```ts
export async function insertTask(task: Task): Promise<void> {
  const db = await getDb();
  const row = serializeTask(task);
  await db.execute(
    'INSERT INTO tasks (id, project_id, title, notes, status, priority, due_at, position, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [row.id, row.project_id, row.title, row.notes, row.status, row.priority, row.due_at, row.position, row.created_at, row.updated_at],
  );
}

export async function updateTask(
  id: string,
  fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null },
  now: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE tasks SET title = $1, notes = $2, priority = $3, due_at = $4, updated_at = $5 WHERE id = $6',
    [fields.title, fields.notes, fields.priority, fields.dueAt, now, id],
  );
}

export async function moveTask(id: string, status: TaskStatus, position: number, now: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE tasks SET status = $1, position = $2, updated_at = $3 WHERE id = $4',
    [status, position, now, id],
  );
}

export async function deleteTask(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM tasks WHERE id = $1', [id]);
}

export async function loadAllTasks(): Promise<Task[]> {
  const db = await getDb();
  const rows = await db.select<TaskRow[]>('SELECT * FROM tasks ORDER BY position ASC');
  return rows.map(toTask);
}
```

- [ ] **Step 6: Wire up `repository.ts`**

Add near the other project-related exports:

```ts
export const insertTask = backend.insertTask;
export const updateTask = backend.updateTask;
export const moveTask = backend.moveTask;
export const deleteTask = backend.deleteTask;
export const loadAllTasks = backend.loadAllTasks;
```

- [ ] **Step 7: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/tauriRepository.ts src/lib/memoryRepository.ts src/lib/repository.ts src/lib/memoryRepository.test.ts
git commit -m "feat: add task repository CRUD across all three backend files"
```

---

### Task 4: `TaskBoard.svelte` — board layout, columns, and task CRUD (no move yet)

**Files:**
- Create: `src/lib/TaskBoard.svelte`
- Create: `src/lib/TaskBoard.test.ts`

**Interfaces:**
- Consumes: `Task`, `TaskStatus`, `TaskPriority`, `TASK_STATUSES`, `TASK_PRIORITIES`, `STATUS_LABELS`, `PRIORITY_LABELS` from `./tasks`.
- Produces props:
  ```ts
  {
    tasks: Task[]; // already filtered to one project by the caller
    onCreateTask: (fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null }) => Promise<void>;
    onUpdateTask: (id: string, fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null }) => Promise<void>;
    onDeleteTask: (id: string) => Promise<void>;
  }
  ```
  Task 5 extends this same component/file with move/reorder props. Task 6 renders `<TaskBoard>` from `Projects.svelte`.

- [ ] **Step 1: Write failing tests**

Create `src/lib/TaskBoard.test.ts`:

```ts
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
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/TaskBoard.test.ts`
Expected: FAIL — component doesn't exist yet.

- [ ] **Step 3: Implement `TaskBoard.svelte`**

```svelte
<script lang="ts">
  import { PRIORITY_LABELS, STATUS_LABELS, TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskPriority, type TaskStatus } from './tasks';

  let {
    tasks,
    onCreateTask,
    onUpdateTask,
    onDeleteTask,
  }: {
    tasks: Task[];
    onCreateTask: (fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null }) => Promise<void>;
    onUpdateTask: (
      id: string,
      fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null },
    ) => Promise<void>;
    onDeleteTask: (id: string) => Promise<void>;
  } = $props();

  function tasksFor(status: TaskStatus): Task[] {
    return tasks.filter((t) => t.status === status);
  }

  function isOverdue(task: Task): boolean {
    return task.dueAt !== null && task.status !== 'done' && task.dueAt < Date.now();
  }

  function dateInputValue(ms: number | null): string {
    if (ms === null) return '';
    return new Date(ms).toISOString().slice(0, 10);
  }

  /** Local midnight for the chosen calendar day — a due date is date-only,
   * never a specific moment (see the plan's Global Constraints). */
  function parseDateInput(value: string): number | null {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).getTime();
  }

  let addingTask = $state(false);
  let newTitle = $state('');
  let newNotes = $state('');
  let newPriority = $state<TaskPriority>('medium');
  let newDueDate = $state('');

  function startAddTask() {
    addingTask = true;
  }

  function cancelAddTask() {
    addingTask = false;
    newTitle = '';
    newNotes = '';
    newPriority = 'medium';
    newDueDate = '';
  }

  async function submitNewTask() {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    await onCreateTask({
      title: trimmed,
      notes: newNotes.trim() || null,
      priority: newPriority,
      dueAt: parseDateInput(newDueDate),
    });
    cancelAddTask();
  }

  let editingTaskId = $state<string | null>(null);
  let editTitle = $state('');
  let editNotes = $state('');
  let editPriority = $state<TaskPriority>('medium');
  let editDueDate = $state('');
  let confirmingDeleteId = $state<string | null>(null);

  function openTask(task: Task) {
    editingTaskId = task.id;
    editTitle = task.title;
    editNotes = task.notes ?? '';
    editPriority = task.priority;
    editDueDate = dateInputValue(task.dueAt);
    confirmingDeleteId = null;
  }

  function closeTask() {
    editingTaskId = null;
    confirmingDeleteId = null;
  }

  async function submitEditTask() {
    if (!editingTaskId) return;
    const trimmed = editTitle.trim();
    if (!trimmed) return;
    await onUpdateTask(editingTaskId, {
      title: trimmed,
      notes: editNotes.trim() || null,
      priority: editPriority,
      dueAt: parseDateInput(editDueDate),
    });
    closeTask();
  }

  async function confirmDeleteTask() {
    if (!confirmingDeleteId) return;
    await onDeleteTask(confirmingDeleteId);
    closeTask();
  }
</script>

<div class="board">
  {#each TASK_STATUSES as status (status)}
    <div class="column">
      <h3 class="column-title">{STATUS_LABELS[status]}</h3>
      {#if status === 'backlog'}
        {#if addingTask}
          <div class="create-form">
            <input type="text" placeholder="Task title" bind:value={newTitle} aria-label="New task title" />
            <textarea placeholder="Notes (optional)" bind:value={newNotes} aria-label="New task notes"></textarea>
            <div class="priority-radios" role="radiogroup" aria-label="Priority">
              {#each TASK_PRIORITIES as priority (priority)}
                <label>
                  <input type="radio" name="new-task-priority" value={priority} bind:group={newPriority} />
                  {PRIORITY_LABELS[priority]}
                </label>
              {/each}
            </div>
            <input type="date" bind:value={newDueDate} aria-label="New task due date" />
            <div class="create-actions">
              <button type="button" class="link" onclick={cancelAddTask}>Cancel</button>
              <button type="button" class="link" onclick={submitNewTask}>Create</button>
            </div>
          </div>
        {:else}
          <button type="button" class="link add-task" onclick={startAddTask}>+ Add task</button>
        {/if}
      {/if}
      <ul>
        {#each tasksFor(status) as task (task.id)}
          <li>
            <button type="button" class="card" onclick={() => openTask(task)}>
              <span class="title">{task.title}</span>
              <span class="tags">
                <span class="pill priority-{task.priority}">{PRIORITY_LABELS[task.priority]}</span>
                {#if task.dueAt !== null}
                  <span class="due" class:overdue={isOverdue(task)}>{new Date(task.dueAt).toLocaleDateString()}</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
</div>

{#if editingTaskId}
  <div class="task-detail" role="dialog" aria-label="Edit task">
    <input type="text" bind:value={editTitle} aria-label="Task title" />
    <textarea bind:value={editNotes} aria-label="Task notes"></textarea>
    <div class="priority-radios" role="radiogroup" aria-label="Priority">
      {#each TASK_PRIORITIES as priority (priority)}
        <label>
          <input type="radio" name="edit-task-priority" value={priority} bind:group={editPriority} />
          {PRIORITY_LABELS[priority]}
        </label>
      {/each}
    </div>
    <input type="date" bind:value={editDueDate} aria-label="Task due date" />

    {#if confirmingDeleteId === editingTaskId}
      <div class="row-confirm">
        <span class="row-confirm-text">Delete this task?</span>
        <button type="button" class="link" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
        <button type="button" class="link danger" onclick={confirmDeleteTask}>Confirm</button>
      </div>
    {:else}
      <div class="detail-actions">
        <button type="button" class="link danger" onclick={() => (confirmingDeleteId = editingTaskId)}>Delete</button>
        <button type="button" class="link" onclick={closeTask}>Cancel</button>
        <button type="button" class="link" onclick={submitEditTask}>Save</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .board {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1rem;
    align-items: start;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .column-title {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 100%;
    padding: 0.65rem 0.8rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }

  .title {
    font-weight: 600;
    font-size: 0.85rem;
  }

  .tags {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .pill {
    font-size: 0.72rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--surface-secondary);
    color: var(--text-muted);
  }

  .priority-high {
    font-weight: 700;
  }

  .due {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .due.overdue {
    color: var(--danger);
  }

  .add-task {
    align-self: flex-start;
  }

  .link {
    background: none;
    border: none;
    color: var(--timer-accent);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .link.danger {
    color: var(--danger);
  }

  .create-form,
  .task-detail {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    background: var(--surface);
  }

  .task-detail {
    margin-top: 1rem;
    background: var(--surface-secondary);
  }

  .create-form input[type='text'],
  .create-form textarea,
  .task-detail input[type='text'],
  .task-detail textarea {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }

  .priority-radios {
    display: flex;
    gap: 1rem;
    font-size: 0.85rem;
    color: var(--text);
  }

  .priority-radios label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .create-actions,
  .detail-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }

  .row-confirm {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  .row-confirm-text {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
</style>
```

- [ ] **Step 4: Run tests, iterate until passing**

Run: `npx vitest run src/lib/TaskBoard.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/TaskBoard.svelte src/lib/TaskBoard.test.ts
git commit -m "feat: add TaskBoard component with 4-column layout and task CRUD"
```

---

### Task 5: Drag-and-drop, keyboard move, and within-column reordering

**Files:**
- Modify: `src/lib/TaskBoard.svelte`
- Modify: `src/lib/TaskBoard.test.ts`

**Interfaces:**
- Consumes: `positionBetween` from `./taskPosition` (Task 2).
- Produces: a new required prop `onMoveTask: (id: string, status: TaskStatus, position: number) => Promise<void>` — Task 6 wires this from `Projects.svelte`/`App.svelte`.

- [ ] **Step 1: Write failing tests**

Add to `src/lib/TaskBoard.test.ts`. First add `onMoveTask: vi.fn(async () => {})` to `baseProps()`'s default object. Then add:

```ts
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
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/TaskBoard.test.ts`
Expected: FAIL — no `onMoveTask` prop, no move controls, no drag handlers yet.

- [ ] **Step 3: Add the `onMoveTask` prop and move/reorder logic**

Add to the imports: `import { positionBetween } from './taskPosition';`

Add `onMoveTask` to the props destructure and its type:

```ts
    onDeleteTask,
    onMoveTask,
  }: {
    // ...existing fields...
    onDeleteTask: (id: string) => Promise<void>;
    onMoveTask: (id: string, status: TaskStatus, position: number) => Promise<void>;
  } = $props();
```

Add near `tasksFor`:

```ts
  const OTHER_STATUSES: Record<TaskStatus, TaskStatus[]> = {
    backlog: ['todo', 'in_progress', 'done'],
    todo: ['backlog', 'in_progress', 'done'],
    in_progress: ['backlog', 'todo', 'done'],
    done: ['backlog', 'todo', 'in_progress'],
  };

  /** New position when a task lands at the END of a column (used for both
   * "Move to..." and a cross-column drop) — the same positionBetween used
   * for every other placement, just always relative to the last item. */
  function positionAtEndOf(status: TaskStatus): number {
    const column = tasksFor(status);
    const last = column.length > 0 ? column[column.length - 1].position : null;
    return positionBetween(last, null);
  }

  async function moveToStatus(task: Task, status: TaskStatus) {
    await onMoveTask(task.id, status, positionAtEndOf(status));
  }

  async function moveWithinColumn(task: Task, direction: 'up' | 'down') {
    const column = tasksFor(task.status);
    const index = column.findIndex((t) => t.id === task.id);
    if (direction === 'up' && index > 0) {
      const before = index >= 2 ? column[index - 2].position : null;
      const after = column[index - 1].position;
      await onMoveTask(task.id, task.status, positionBetween(before, after));
    } else if (direction === 'down' && index < column.length - 1) {
      const before = column[index + 1].position;
      const after = index + 2 < column.length ? column[index + 2].position : null;
      await onMoveTask(task.id, task.status, positionBetween(before, after));
    }
  }

  let openMoveMenuTaskId = $state<string | null>(null);

  function toggleMoveMenu(taskId: string) {
    openMoveMenuTaskId = openMoveMenuTaskId === taskId ? null : taskId;
  }

  async function handleMoveMenuSelect(task: Task, status: TaskStatus) {
    openMoveMenuTaskId = null;
    await moveToStatus(task, status);
  }

  let draggedTaskId = $state<string | null>(null);

  function handleDragStart(event: DragEvent, taskId: string) {
    draggedTaskId = taskId;
    event.dataTransfer?.setData('text/plain', taskId);
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
  }

  async function handleDrop(event: DragEvent, status: TaskStatus) {
    event.preventDefault();
    const taskId = event.dataTransfer?.getData('text/plain') ?? draggedTaskId;
    draggedTaskId = null;
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    await moveToStatus(task, status);
  }
```

Update the column markup to accept drops, and update the card markup to be draggable and carry the move controls. Replace:

```svelte
      <ul>
        {#each tasksFor(status) as task (task.id)}
          <li>
            <button type="button" class="card" onclick={() => openTask(task)}>
              <span class="title">{task.title}</span>
              <span class="tags">
                <span class="pill priority-{task.priority}">{PRIORITY_LABELS[task.priority]}</span>
                {#if task.dueAt !== null}
                  <span class="due" class:overdue={isOverdue(task)}>{new Date(task.dueAt).toLocaleDateString()}</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
```

with:

```svelte
      <ul ondragover={handleDragOver} ondrop={(e) => handleDrop(e, status)}>
        {#each tasksFor(status) as task, index (task.id)}
          <li>
            <div
              class="card"
              draggable="true"
              ondragstart={(e) => handleDragStart(e, task.id)}
            >
              <button type="button" class="card-body" onclick={() => openTask(task)}>
                <span class="title">{task.title}</span>
                <span class="tags">
                  <span class="pill priority-{task.priority}">{PRIORITY_LABELS[task.priority]}</span>
                  {#if task.dueAt !== null}
                    <span class="due" class:overdue={isOverdue(task)}>{new Date(task.dueAt).toLocaleDateString()}</span>
                  {/if}
                </span>
              </button>
              <div class="card-controls">
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Move up"
                  disabled={index === 0}
                  onclick={() => moveWithinColumn(task, 'up')}
                >
                  &uarr;
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Move down"
                  disabled={index === tasksFor(status).length - 1}
                  onclick={() => moveWithinColumn(task, 'down')}
                >
                  &darr;
                </button>
                <div class="move-menu-wrapper">
                  <button type="button" class="link" onclick={() => toggleMoveMenu(task.id)}>Move to&hellip;</button>
                  {#if openMoveMenuTaskId === task.id}
                    <ul class="move-menu" role="menu">
                      {#each OTHER_STATUSES[task.status] as target (target)}
                        <li role="none">
                          <button type="button" role="menuitem" onclick={() => handleMoveMenuSelect(task, target)}>
                            {STATUS_LABELS[target]}
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
```

Add corresponding CSS near the existing `.card` rules:

```css
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.65rem 0.8rem;
    border-radius: 0.5rem;
    background: var(--surface);
    color: var(--text);
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 100%;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    text-align: left;
    padding: 0;
  }

  .card-controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    position: relative;
  }

  .icon-button {
    background: none;
    border: 1px solid var(--border);
    border-radius: 0.3rem;
    color: var(--text-muted);
    cursor: pointer;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
  }

  .icon-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .move-menu-wrapper {
    position: relative;
    margin-left: auto;
  }

  .move-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 1;
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0.25rem;
    border-radius: 0.4rem;
    background: var(--surface);
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    min-width: 8rem;
  }

  .move-menu button {
    background: none;
    border: none;
    color: var(--text);
    font-size: 0.8rem;
    text-align: left;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    border-radius: 0.3rem;
  }

  .move-menu button:hover {
    background: var(--surface-secondary);
  }
```

(Remove the old plain `.card { ...; cursor: pointer; text-align: left; }` rule from Task 4 since the card is no longer itself a `<button>` — replaced by the `.card`/`.card-body` split above.)

- [ ] **Step 4: Run tests, iterate until passing**

Run: `npx vitest run src/lib/TaskBoard.test.ts`
Expected: PASS, all tests. Note: `positionBetween(before, after)` for the "move up" case in the test above (`t2` moving before `t1`, which is at position `0` with nothing before it) computes `positionBetween(null, 0)` = `0 - 1` = `-1`, matching the test's expectation.

- [ ] **Step 5: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/TaskBoard.svelte src/lib/TaskBoard.test.ts
git commit -m "feat: add drag-and-drop, keyboard move, and reordering to TaskBoard"
```

---

### Task 6: Integrate into `Projects.svelte` (Board/Sessions tabs) and wire `App.svelte`

**Files:**
- Modify: `src/lib/Projects.svelte`
- Modify: `src/App.svelte`
- Test: `src/lib/Projects.test.ts` (create if it doesn't already exist — check first) or a distinctly-named new file if `Projects.test.ts` would collide with anything (it won't: no existing `projects.test.ts` was found for the pure `projects.ts` module in this codebase's current state — verify with `ls src/lib/ | grep -i project` before creating, and if a lowercase `projects.test.ts` does exist, name this new file `ProjectsDetail.test.ts` instead, following the same case-collision-avoidance convention as `HistoryTabs.test.ts`).
- Test: `src/App.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: `TaskBoard` (default export) from `./TaskBoard`; `Task`, `TaskPriority`, `TaskStatus` from `./tasks`; `insertTask`, `updateTask`, `moveTask`, `deleteTask`, `loadAllTasks` from `./repository` (App.svelte only — `Projects.svelte`/`TaskBoard.svelte` never import `./repository` directly, matching this codebase's established boundary of routing all writes through callback props from `App.svelte`).
- Produces: `Projects.svelte` gains `tasks: Task[]`, `onCreateTask`, `onUpdateTask`, `onMoveTask`, `onDeleteTask`, `onStartFocusFromTask: (title: string, projectId: string) => void`, `canStartFocus: boolean` props.

- [ ] **Step 1: Check for an existing `Projects.test.ts`/`projects.test.ts` naming collision**

Run: `ls src/lib/ | grep -i project`
If a `projects.test.ts` (lowercase, the pure `projects.ts` module's tests) already exists, name this task's new component-test file `ProjectsDetail.test.ts` instead of `Projects.test.ts` to avoid a case-insensitive collision (mirrors `HistoryTabs.test.ts`'s own documented reason). If no `projects.test.ts` exists at all, `Projects.test.ts` is safe to create directly. Use whichever name is actually safe for the rest of this task's steps.

- [ ] **Step 2: Write failing component tests**

Read `Projects.svelte`'s current full source first (props, state, detail-view markup) to write realistic default props. Create the test file (name resolved in Step 1):

```ts
// @vitest-environment jsdom

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
```

- [ ] **Step 3: Run, confirm failure**

Run: `npx vitest run <the resolved test file name>`
Expected: FAIL — no Board/Sessions tabs, no `TaskBoard` embed, no new props yet.

- [ ] **Step 4: Add tabs and `TaskBoard` embed to `Projects.svelte`**

Add to the imports: `import TaskBoard from './TaskBoard.svelte'; import type { Task, TaskPriority, TaskStatus } from './tasks';`

Add to the props destructure and its type (alongside the existing ones):

```ts
    tasks,
    onCreateTask,
    onUpdateTask,
    onMoveTask,
    onDeleteTask,
    onStartFocusFromTask,
    canStartFocus,
  }: {
    // ...existing fields...
    tasks: Task[];
    onCreateTask: (projectId: string, fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null }) => Promise<void>;
    onUpdateTask: (id: string, fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null }) => Promise<void>;
    onMoveTask: (id: string, status: TaskStatus, position: number) => Promise<void>;
    onDeleteTask: (id: string) => Promise<void>;
    onStartFocusFromTask: (title: string, projectId: string) => void;
    canStartFocus: boolean;
  } = $props();
```

Add near `selectedProjectId`:

```ts
  let detailTab = $state<'board' | 'sessions'>('board');

  function tasksForSelected(): Task[] {
    return tasks.filter((t) => t.projectId === selectedProjectId);
  }

  function selectProject(id: string) {
    selectedProjectId = id;
    detailTab = 'board'; // Board is always the entry tab, per the design spec
  }

  function handleDetailTabKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = detailTab === 'board' ? 'sessions' : 'board';
    detailTab = next;
    document.getElementById(next === 'board' ? 'project-tab-board' : 'project-tab-sessions')?.focus();
  }
```

Change the existing `onclick={() => (selectedProjectId = project.id)}` on the project-row button to `onclick={() => selectProject(project.id)}`.

Replace the detail view's stat-line-and-session-list block:

```svelte
      <p class="stat-line">
        {sessionCount(project.id)} session{sessionCount(project.id) === 1 ? '' : 's'} ·
        {formatDuration(totalFocusMs(project.id))} focused
      </p>

      {#if sessionsForSelected().length === 0}
        <p class="empty">No sessions tagged with this project yet.</p>
      {:else}
        <ul>
          {#each sessionsForSelected() as summary (summary.id)}
            <li>
              <span class="task">{summary.task}</span>
              <span class="when">{formatDateTime(summary.completedAt)}</span>
              <span class="focus">{formatDuration(summary.actualFocusMs)}</span>
            </li>
          {/each}
        </ul>
      {/if}
```

with:

```svelte
      <p class="stat-line">
        {sessionCount(project.id)} session{sessionCount(project.id) === 1 ? '' : 's'} ·
        {formatDuration(totalFocusMs(project.id))} focused
      </p>

      <div class="tabs" role="tablist" aria-label="Project view">
        <button
          type="button"
          role="tab"
          id="project-tab-board"
          aria-selected={detailTab === 'board'}
          aria-controls="project-panel-board"
          tabindex={detailTab === 'board' ? 0 : -1}
          onclick={() => (detailTab = 'board')}
          onkeydown={handleDetailTabKeydown}
        >
          Board
        </button>
        <button
          type="button"
          role="tab"
          id="project-tab-sessions"
          aria-selected={detailTab === 'sessions'}
          aria-controls="project-panel-sessions"
          tabindex={detailTab === 'sessions' ? 0 : -1}
          onclick={() => (detailTab = 'sessions')}
          onkeydown={handleDetailTabKeydown}
        >
          Sessions
        </button>
      </div>

      {#if detailTab === 'board'}
        <div id="project-panel-board" role="tabpanel" aria-labelledby="project-tab-board" tabindex="0">
          <TaskBoard
            tasks={tasksForSelected()}
            onCreateTask={(fields) => onCreateTask(project.id, fields)}
            {onUpdateTask}
            {onMoveTask}
            {onDeleteTask}
            onStartFocus={(title) => onStartFocusFromTask(title, project.id)}
            {canStartFocus}
          />
        </div>
      {:else}
        <div id="project-panel-sessions" role="tabpanel" aria-labelledby="project-tab-sessions" tabindex="0">
          {#if sessionsForSelected().length === 0}
            <p class="empty">No sessions tagged with this project yet.</p>
          {:else}
            <ul>
              {#each sessionsForSelected() as summary (summary.id)}
                <li>
                  <span class="task">{summary.task}</span>
                  <span class="when">{formatDateTime(summary.completedAt)}</span>
                  <span class="focus">{formatDuration(summary.actualFocusMs)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
```

"Start focus" is a **per-task** action, opened from a task's own edit view (`TaskBoard.svelte`'s detail panel) — not a project-level button. `TaskBoard.svelte` gets two more props for this, added now (App-integration-specific, so they belong in this task rather than Task 4/5):

```ts
    onStartFocus: (title: string) => void;
    canStartFocus: boolean;
```

Add to `TaskBoard.svelte`'s `.task-detail` block's `.detail-actions` (next to Delete/Cancel/Save):

```svelte
        <button type="button" class="link" disabled={!canStartFocus} onclick={() => onStartFocus(editTitle)}>
          Start focus
        </button>
```

Since `onStartFocus`/`canStartFocus` are now required props, add `onStartFocus: vi.fn()` and `canStartFocus: true` to `TaskBoard.test.ts`'s existing `baseProps()` default object (from Task 4) — every earlier test in that file uses `baseProps()`, so without this addition all of them fail to type-check/render. Then add a new test confirming `onStartFocus` is called with the current edit title when the button is clicked, and that it's disabled when `canStartFocus` is `false`.

- [ ] **Step 5: Wire `App.svelte`**

Add to the imports:

```ts
  import { insertTask, updateTask, moveTask, deleteTask, loadAllTasks } from './lib/repository';
  import type { Task, TaskPriority, TaskStatus } from './lib/tasks';
```

Add state near `let projects = $state<Project[]>([]);`:

```ts
  let tasks = $state<Task[]>([]);
```

Add a refresh function near `refreshProjects()`, and call it wherever `refreshProjects()` is already called at mount (so tasks load alongside projects on startup):

```ts
  async function refreshTasks() {
    tasks = await loadAllTasks();
  }
```

Add handlers near `handleCreateProject`/`handleRenameProject`:

```ts
  async function handleCreateTask(
    projectId: string,
    fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null },
  ): Promise<void> {
    const now = Date.now();
    const task: Task = {
      id: crypto.randomUUID(),
      projectId,
      title: fields.title,
      notes: fields.notes,
      status: 'backlog',
      priority: fields.priority,
      dueAt: fields.dueAt,
      position: 0,
      createdAt: now,
      updatedAt: now,
    };
    await writeQueue.enqueue(() => insertTask(task));
    await refreshTasks();
  }

  async function handleUpdateTask(
    id: string,
    fields: { title: string; notes: string | null; priority: TaskPriority; dueAt: number | null },
  ): Promise<void> {
    await writeQueue.enqueue(() => updateTask(id, fields, Date.now()));
    await refreshTasks();
  }

  async function handleMoveTask(id: string, status: TaskStatus, position: number): Promise<void> {
    await writeQueue.enqueue(() => moveTask(id, status, position, Date.now()));
    await refreshTasks();
  }

  async function handleDeleteTask(id: string): Promise<void> {
    await writeQueue.enqueue(() => deleteTask(id));
    await refreshTasks();
  }

  /** Starts a session from a task's title, reusing startFreshFocus exactly
   * like handleStartParkedThought does — see the plan's Global Constraints
   * for why this sets selectedProjectId first (so the resulting session is
   * tagged with the task's own project automatically) and why there's no
   * separate "review before start" step. */
  function handleStartFocusFromTask(title: string, projectId: string) {
    if (!sessionRecovered || session.status !== 'idle' || !isValidDurationMinutes(durationMinutes)) return;
    selectedProjectId = projectId;
    startFreshFocus(title);
  }
```

Wire the props onto `<Projects>`:

```svelte
      <Projects
        projects={projects}
        summaries={historySummaries}
        tasks={tasks}
        onBack={handleBackFromProjects}
        onCreateProject={handleCreateProject}
        onRenameProject={handleRenameProject}
        onArchiveProject={handleArchiveProject}
        onCreateTask={handleCreateTask}
        onUpdateTask={handleUpdateTask}
        onMoveTask={handleMoveTask}
        onDeleteTask={handleDeleteTask}
        onStartFocusFromTask={handleStartFocusFromTask}
        canStartFocus={sessionRecovered && session.status === 'idle' && isValidDurationMinutes(durationMinutes)}
      />
```

- [ ] **Step 6: Write an App.svelte integration test**

Read `App.test.ts`'s existing setup (the shared `mocks` object, `render(App)` pattern, and the `'Projects workspace refreshes after rename/archive'` describe block's `fakeProjectStore` helper) before writing this — match its exact conventions rather than guessing. Add `insertTask: vi.fn(async () => {})`, `updateTask: vi.fn(async () => {})`, `moveTask: vi.fn(async () => {})`, `deleteTask: vi.fn(async () => {})`, `loadAllTasks: vi.fn(async () => [] as unknown[])` to the shared `mocks` object (`repository.ts` needs every exported function stubbed there, same reason the import feature's Task 6 needed `insertImportedSession`/`insertParkedThoughtIfAbsent` added).

Add a test (using a fake in-memory task store the same way `fakeProjectStore` fakes projects) confirming: creating a task through the UI results in it appearing on the board without any unrelated refresh trigger, and that starting a focus session from a task actually starts the session (assert the app transitions out of the idle start screen) with the project auto-tagged (assert `updateSessionProject` — already mocked elsewhere in this file — was called with the task's project id).

- [ ] **Step 7: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/Projects.svelte src/lib/TaskBoard.svelte src/lib/TaskBoard.test.ts src/App.svelte src/App.test.ts <the resolved Projects detail test file>
git commit -m "feat: wire task boards into Projects detail page and App.svelte"
```

---

### Task 7: Documentation follow-up

**Files:**
- Modify: `docs/product-direction.md`
- Modify: `README.md`

**Interfaces:** none — documentation only, no code/test changes.

- [ ] **Step 1: Update `docs/product-direction.md`**

In the "Explicit early boundaries" section, remove `Due dates` and `Priorities` from the excluded-early bullet list, and update the paragraph that currently reads:

```
Projects (grouping sessions under Personal/Work/Study for time tracking)
shipped as an optional, decoupled feature — see
docs/superpowers/specs/2026-08-14-projects-categories-time-tracking-design.md.
Due dates, priorities, and subtasks remain excluded pending the Phase 2
task-planning spec.
```

to:

```
Projects (grouping sessions under Personal/Work/Study for time tracking)
shipped as an optional, decoupled feature — see
docs/superpowers/specs/2026-08-14-projects-categories-time-tracking-design.md.
Per-project task boards (Backlog/To Do/In Progress/Done, with priority
and optional due dates) shipped as the Phase 2 follow-up — see
docs/superpowers/specs/2026-08-15-project-task-boards-phase2-design.md.
Subtasks remain excluded; both features stay optional and decoupled from
the core focus-session loop.
```

- [ ] **Step 2: Update `README.md`**

Find the line "It is not a task manager — there's no backlog or..." and update it to reflect that project-scoped task boards now exist, while keeping the "not a general task manager/calendar" framing intact — follow the exact restrained tone Phase 1's own README update used (check `git log -p -- README.md` for that prior commit if unsure of the exact wording style already established).

- [ ] **Step 3: Commit**

```bash
git add docs/product-direction.md README.md
git commit -m "docs: update product-direction/README for Phase 2 task boards"
```

---

## Final Verification (after all tasks)

- [ ] Run `npm run check && npx vitest run` once more from a clean tree; confirm 0 errors and every test passes.
- [ ] Run `cd src-tauri && cargo test` to confirm the Rust migration tests pass alongside the rest of the Rust test suite.
- [ ] Manual Tauri check (`npm run tauri:dev` or a debug build): create a project, add several tasks with different priorities/due dates, drag a card between columns, use the keyboard "Move to…" control, reorder within a column with the up/down buttons, edit and delete a task, and start a focus session from a task — confirm the session starts immediately, is tagged with the task's project, and the due-date overdue styling renders correctly for a past date.
