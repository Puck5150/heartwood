# Project Task Boards — Design Spec (Phase 2 of 2)

Date: 2026-08-15

## Product framing (read this first)

Phase 1 (`docs/superpowers/specs/2026-08-14-projects-categories-time-tracking-design.md`)
shipped the Project/Category data model, optional session→project tagging,
the Projects rail destination (list + detail page), and the time-tracking
breakdown graph — deliberately narrower than the full original ask, which
also wanted a **task list, due dates, priority/ordering, and status per
project**, standing beside the existing focus-session core loop. That
spec explicitly deferred this to "a separate spec, to follow":

> Phase 2 (a separate spec, to follow) adds tasks, due dates, priority, and
> status on top of the Project entity this phase creates.

This is that spec. Every feature here stays **optional and decoupled**,
matching Phase 1's own framing: a project with no tasks works exactly
like it does today — nothing here becomes a required step in the
focus-session loop, and nothing here changes the timer, greenhouse,
notes, or revisions behavior.

**Documentation follow-up (part of this feature, not optional):**
`docs/product-direction.md`'s "Explicit early boundaries" list currently
excludes "Due dates" and "Priorities" pending this spec, and `README.md`
still frames the app as "not a task manager." Both need updating once
this ships, following the same one-line-update pattern Phase 1 used for
"Projects."

## Goal

Let a user optionally track a **task board** per project — a 4-column
kanban (Backlog / To Do / In Progress / Done), each task carrying a
title, optional notes, a priority level, and an optional due date. Tasks
can be dragged (or moved via keyboard) between columns and reordered
within a column. A task can be promoted into a focus session the same
way a parked thought is today.

## Data model

New migration (version 11, following the existing pattern in
`src-tauri/src/migrations.rs`):

```sql
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
```

- No `FOREIGN KEY` on `tasks.project_id` — this schema uses no FK
  constraints anywhere (see `parked_thoughts.session_id`,
  `sessions.project_id`); integrity is handled explicitly in the
  repository layer. A project is never hard-deleted (archive-only, per
  Phase 1), so an orphaned task is not a reachable state.
- `notes` and `due_at` are nullable — both optional per task.
- `status` defaults every new task to `'backlog'` at creation (the
  repository layer enforces this, not a SQL `DEFAULT`, matching how
  `project_id` on sessions is nullable-with-no-default rather than
  relying on column defaults elsewhere in this schema).
- `position` is a `REAL`, using fractional/midpoint indexing (the
  classic Trello-style scheme): inserting or moving a task to a spot
  between two existing tasks sets its `position` to the numeric midpoint
  of its new neighbors' positions. Moving to the very top/bottom of a
  column halves the distance to the nearest edge (e.g. neighbor's
  position minus/plus 1). This means a reorder is always a single
  `UPDATE` on the moved row — no renumbering the rest of the column.
  Ordering within a column/status is `ORDER BY position ASC`.
- No `completed_at` column — `status = 'done'` combined with `updated_at`
  (already bumped on every status change) is sufficient; a separate
  timestamp isn't needed by anything in this spec (YAGNI).

## Task board (new tab in the project detail page)

`Projects.svelte`'s detail view (per-project, reached from the Projects
list) gains a second tab alongside the existing session list, following
the same tab pattern `History.svelte` already uses for
List/Breakdown — **Board** and **Sessions**:

- **Sessions** tab: today's existing read-only list of sessions tagged
  with this project, unchanged.
- **Board** tab (new, and the default when the detail page first opens):
  the 4-column kanban board.

### Columns

Fixed, not user-customizable: **Backlog**, **To Do**, **In Progress**,
**Done**, left to right. Every new task starts in Backlog.

### Cards

Each card shows:
- Title
- Priority as a small text-only tag (`Low` / `Medium` / `High`) — no new
  per-theme color, matching Phase 1's own explicit reasoning for the
  session-start project picker's category pill (inventing a new color ×
  7 theme-families × 2 modes is real, unreviewed design work; a plain
  text tag with existing `--text-muted`/`--surface-secondary` tokens
  reads the priority without it). High priority is visually distinguished
  by weight (bold), not a new hue.
- Due date, if set, shown as a date only (no time-of-day — a due date is
  "by this day," not a specific moment). Stored as the epoch-ms
  timestamp of local midnight on the chosen day, formatted for display
  with `toLocaleDateString` (a plain date string, not `formatDateTime`'s
  date-plus-time format, since a due date never carries a meaningful
  time component). A task whose `due_at` is in the past (before today's
  local midnight) and whose `status !== 'done'` renders its due-date
  text in `var(--danger)` — the existing token, already proven ≥4.5:1
  across every theme in `appearanceTokens.test.ts`, not a new color.

### Creating a task

A **"+ Add task"** control at the top of the Backlog column opens an
inline create form — title (required), notes (optional, collapsed by
default behind a "add notes" toggle to keep the common case fast),
priority (radio, default Medium), due date (optional date input) — the
same inline-form pattern already established for creating a project and
a parked thought. The new task lands at the top of Backlog (`position`
set below the current minimum in that column, or `0` if the column is
empty).

### Editing a task

Clicking a card (anywhere except its move controls) opens an edit
view — same fields as creation, plus:
- **Start focus** — navigates to the session-start screen with the
  task's title pre-filled as the session task, exactly like today's
  parked-thought promotion (`handleStartParkedThought` in `App.svelte`
  is the existing analog). The task's status/column does **not** change
  automatically, and the resulting session is **not** linked back to the
  task — matches this spec's "optional, decoupled" framing; a session
  stays taggable by *project* (Phase 1) but not by *task*.
- **Delete** — hard delete, behind a confirm step (the existing
  `.row-confirm`/`.row-confirm-text` pattern already used in
  `History.svelte`/`Greenhouse.svelte`). Unlike projects (archive-only,
  since a project can be referenced by historical sessions), a task has
  no other entity referencing it, so hard delete is safe and matches how
  lightweight/numerous tasks are expected to be relative to projects —
  Done is the "this is finished" state; Delete is for mistakes or
  clutter, not archiving finished work.

### Moving a task between columns

Two ways, both fully supported (not one as primary and one as a
degraded fallback):
- **Drag and drop**, using the native HTML5 Drag and Drop API
  (`draggable`, `dragstart`/`dragover`/`drop`) — no new npm dependency,
  matching Phase 1's own hand-rolled-SVG-chart precedent for the same
  reason (minimal-dependency footprint).
- **Keyboard/click**: each card has a "Move to…" control (a small
  button opening a menu of the other 3 statuses) that sets `status` and
  places the task at the end of the destination column — usable by
  anyone who can't or doesn't want to drag, including keyboard-only and
  screen-reader users. This is not an afterthought: the app already
  invested in full keyboard support for the Breakdown chart's segments
  and History's tabs, and a kanban board is exactly the kind of UI that
  becomes unusable without one.

### Reordering within a column

Same two mechanisms: drag within the column, or small up/down-arrow
buttons on each card that swap it with its immediate neighbor
(recomputing `position` via the midpoint scheme above).

## Repository

New functions across the existing three-file pattern
(`tauriRepository.ts`/`memoryRepository.ts`/`repository.ts`), matching
how `projects`' own CRUD functions are already structured:

```ts
export interface Task {
  id: string;
  projectId: string;
  title: string;
  notes: string | null;
  status: 'backlog' | 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  dueAt: number | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

insertTask(task: Task): Promise<void>
updateTask(id: string, fields: { title: string; notes: string | null; priority: Task['priority']; dueAt: number | null }, now: number): Promise<void>
updateTaskStatus(id: string, status: Task['status'], position: number, now: number): Promise<void>
reorderTask(id: string, position: number, now: number): Promise<void>
deleteTask(id: string): Promise<void>
loadAllTasks(): Promise<Task[]>
```

`loadAllTasks()` loads every task across every project in one call,
filtered client-side by `project_id` in `Projects.svelte`/`TaskBoard.svelte`
— mirrors `loadAllProjects()`/`loadCompletedSessions()`'s existing
load-everything-once convention rather than introducing per-project
queries or pagination, which nothing else in this app does either.

## Cross-cutting / out of scope (this phase)

- **Task export/import.** The session-data import/export feature just
  shipped is explicitly session-scoped (`SessionExportEntry`); this spec
  does not extend it to cover tasks. A user's task boards are not part
  of a `.md`/`.csv` export or import. If task backup/restore is wanted
  later, it's a separate, deliberately-scoped follow-up — not a silent
  gap in this one.
- **Session↔task linking.** A focus session started from a task carries
  only the pre-filled title text, never a `task_id` foreign key. No
  "time spent on this task" rollup exists in this phase.
- **Column customization.** The 4 columns are fixed; no add/rename/reorder/
  delete-column affordance.
- **Notifications/reminders for due dates.** A due date is a visual
  signal on the card only — no OS notification, no digest, nothing
  time-triggered.
- **Cross-project task view.** Tasks are only ever viewed within their
  own project's Board tab; there is no "all my tasks across every
  project" screen in this phase.

## Testing approach

Following the codebase's existing patterns:

- Rust: a migration test asserting `tasks` exists with the right
  columns/CHECK constraints (`status`, `priority`), mirroring
  `migrations.rs`'s existing per-version tests (e.g. the projects-table
  test from migration 10).
- TypeScript: pure-function tests for the fractional-position math
  (midpoint calculation, top/bottom-of-column edge cases) — a dedicated
  small module, tested the same direct-derivation-function style as
  `breakdown.ts`'s own tests, not through the UI.
- Svelte component tests for `TaskBoard.svelte`: card creation, editing,
  delete-with-confirm, drag-and-drop status change, keyboard "Move to…"
  status change (both must produce the same repository call), up/down
  reordering, overdue-due-date styling, and the Board/Sessions tab
  switch — matching the existing `.test.ts` harness pattern used by
  `History.svelte`'s and `BreakdownChart.svelte`'s own test files.
- "Start focus" promotion: a component test confirming the task's title
  reaches the session-start field, matching the existing coverage
  pattern for parked-thought promotion.

## Documentation follow-up

After this phase ships, update `docs/product-direction.md`'s "Explicit
early boundaries" list — remove "Due dates" and "Priorities" from the
excluded-early list, and add a line next to the existing Projects
callout noting task boards shipped as the Phase 2 feature that list
already anticipated. Update `README.md`'s "not a task manager — there's
no backlog or [...]" line to stop contradicting the shipped feature,
following the same restrained, factual tone Phase 1's own documentation
update used.
