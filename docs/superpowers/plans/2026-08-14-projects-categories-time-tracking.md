# Projects, Categories, and Time-Tracking Breakdown — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user optionally tag a focus session with a Project (name + one of Personal/Work/Study), manage projects from a new Projects rail destination, and see a time-tracking breakdown (bar/donut/pie, category then project drill-down) in a new History tab.

**Architecture:** `project_id` is a plain nullable column on `sessions`, set via a dedicated direct `UPDATE` (`updateSessionProject`) — it is **never** threaded through `SessionState`/`serializeSessionState`/`deserializeSessionRow`, exactly like the existing `review_acknowledged_at` column (see `persistence.ts`'s own comment on that field). This keeps the entire timer state machine untouched. A new `src/lib/projects.ts` holds the pure `Project` domain type and row mapping; a new `src/lib/breakdown.ts` holds pure grouping/time-range/chart-math logic; a new `ProjectPicker.svelte` is reused at all three tagging entry points (session start, History reassignment, Projects list "+ New").

**Tech Stack:** Svelte 5 (runes: `$state`, `$props`), Tauri 2 + `@tauri-apps/plugin-sql` (SQLite), Rust migrations via `tauri_plugin_sql::Migration`, `lucide-svelte` icons, Vitest.

## Global Constraints

- `project_id` is nullable everywhere; every existing flow must work identically with it left `null`. No required project-selection step anywhere.
- Category is a fixed 3-value enum: `personal`, `work`, `study`. Not user-extensible in this phase.
- Projects are **archived, never hard-deleted** (`archived_at` column). Archived projects vanish from picker lists but keep showing on sessions/exports/the breakdown graph that already reference them.
- No FK constraints (this schema uses none anywhere — see `parked_thoughts.session_id`); integrity is handled in the repository layer.
- No new npm dependency for the chart — hand-rolled SVG.
- No per-category colors: category display uses a plain text pill (`--text-muted`/`--surface-secondary` tokens, already used in `History.svelte`). The breakdown chart's segment fills derive from the single existing `--timer-accent` token at three opacities (Personal 100%, Work 65%, Study 35%) plus `--border` for Untagged — no new per-theme color authoring.
- `deleteAllData` (both repository backends) leaves the `projects` table untouched, same as it already leaves `settings` untouched — deleting session history shouldn't force recreating your project list. Sessions being gone makes their `project_id` references moot, not dangling in any way that matters (no FK to violate).
- Time ranges for the breakdown graph are rolling windows, not calendar-aligned: "This week" = last 7 days from now, "This month" = last 30 days from now, "All time" = no filter.
- Rename is metadata-only (`UPDATE projects SET name = ...`) and never touches `sessions` rows — renames apply retroactively to history for free, since sessions store `project_id` not a copied name.

---

### Task 1: Rust migration — `projects` table and `sessions.project_id`

**Files:**
- Modify: `src-tauri/src/migrations.rs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `projects` table (`id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `category TEXT NOT NULL CHECK (...)`, `archived_at INTEGER`, `created_at INTEGER NOT NULL`) and `sessions.project_id TEXT` (nullable, no default). Later tasks read/write these via plain SQL — no native Rust command needed for this table (no filesystem coordination, unlike notes/revisions).

- [ ] **Step 1: Add migration version 10**

Add to the end of the `vec![...]` in `pub fn migrations()`, immediately after the existing version 9 entry (keep version 9's trailing comma, add this as a new entry before the closing `}]`):

```rust
    }, Migration {
        version: 10,
        description: "add projects table and sessions.project_id",
        sql: r#"
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL CHECK (category IN ('personal', 'work', 'study')),
                archived_at INTEGER,
                created_at INTEGER NOT NULL
            );

            ALTER TABLE sessions ADD COLUMN project_id TEXT;
        "#,
        kind: MigrationKind::Up,
    }]
```

(This replaces the previous final `}]` that closed the `vec![...]` after version 9 — the new version 10 block becomes the last element instead.)

- [ ] **Step 2: Write the migration tests**

Add to the `#[cfg(test)] mod tests` block, following the existing style (e.g. `version_nine_adds_a_nullable_last_touch_grass_at_column`):

```rust
    #[tokio::test]
    async fn version_ten_creates_projects_table_and_nullable_session_project_id() {
        let pool = migrated_pool().await;

        let project_columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('projects')")
            .fetch_all(&pool)
            .await
            .unwrap();
        for expected in ["id", "name", "category", "archived_at", "created_at"] {
            assert!(project_columns.contains(&expected.to_string()), "missing column {expected}");
        }

        let session_columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('sessions')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(session_columns.contains(&"project_id".to_string()));

        // A pre-existing row (inserted before this column existed) survives
        // with a null project_id rather than failing the insert.
        insert_session(&pool, "legacy-1").await;
        let project_id: Option<String> =
            sqlx::query_scalar("SELECT project_id FROM sessions WHERE id = 'legacy-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(project_id, None);
    }

    #[tokio::test]
    async fn projects_category_check_rejects_unknown_values() {
        let pool = migrated_pool().await;

        assert!(sqlx::query(
            "INSERT INTO projects (id, name, category, created_at) VALUES ('p1', 'Test', 'bogus', 1000)",
        )
        .execute(&pool)
        .await
        .is_err());

        assert!(sqlx::query(
            "INSERT INTO projects (id, name, category, created_at) VALUES ('p1', 'Test', 'work', 1000)",
        )
        .execute(&pool)
        .await
        .is_ok());
    }
```

- [ ] **Step 3: Run the Rust test suite**

Run: `cd src-tauri && cargo test migrations:: 2>&1 | tail -40`
Expected: all `migrations::tests::*` pass, including the two new tests.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/migrations.rs
git commit -m "feat: add projects table and sessions.project_id migration"
```

---

### Task 2: `projects.ts` domain module + `SessionRow.project_id`

**Files:**
- Create: `src/lib/projects.ts`
- Create: `src/lib/projects.test.ts`
- Modify: `src/lib/persistence.ts`

**Interfaces:**
- Consumes: nothing beyond existing `persistence.ts` exports.
- Produces: `ProjectCategory` type (`'personal' | 'work' | 'study'`), `PROJECT_CATEGORIES: readonly ProjectCategory[]`, `Project` interface (`{ id: string; name: string; category: ProjectCategory; archivedAt: number | null; createdAt: number }`), `ProjectRow` interface (`{ id: string; name: string; category: string; archived_at: number | null; created_at: number }`), `toProject(row: ProjectRow): Project`, `serializeProject(project: Project): ProjectRow`, `CATEGORY_LABELS: Record<ProjectCategory, string>` (`{ personal: 'Personal', work: 'Work', study: 'Study' }`). `SessionRow` (in `persistence.ts`) gains `project_id: string | null`. Later tasks (repository layer, History, breakdown) import `Project`/`ProjectCategory`/`toProject`/`CATEGORY_LABELS` from this file.

- [ ] **Step 1: Write `src/lib/projects.ts`**

```ts
// Pure domain module for Projects: the type, its fixed Category enum, and
// row<->domain mapping. No database access here, matching persistence.ts's
// own separation of concerns. Project assignment on a session is handled
// entirely outside SessionState (see repository.ts's updateSessionProject)
// — this module only ever describes the Project entity itself.

export type ProjectCategory = 'personal' | 'work' | 'study';

export const PROJECT_CATEGORIES: readonly ProjectCategory[] = ['personal', 'work', 'study'];

export const CATEGORY_LABELS: Record<ProjectCategory, string> = {
  personal: 'Personal',
  work: 'Work',
  study: 'Study',
};

export interface Project {
  id: string;
  name: string;
  category: ProjectCategory;
  /** Null while active. Archived projects are hidden from picker lists but
   * keep displaying on sessions/exports/the breakdown graph that already
   * reference them — see the plan's Global Constraints. */
  archivedAt: number | null;
  createdAt: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  category: string;
  archived_at: number | null;
  created_at: number;
}

function isProjectCategory(value: string): value is ProjectCategory {
  return (PROJECT_CATEGORIES as string[]).includes(value);
}

/** Throws on an unknown category rather than silently defaulting — a row
 * with a bad category value indicates real data corruption (the CHECK
 * constraint should have prevented it at the SQL layer), and hiding that
 * behind a fallback would make it invisible to the user and to tests. */
export function toProject(row: ProjectRow): Project {
  if (!isProjectCategory(row.category)) {
    throw new Error(`Malformed project row "${row.id}": unknown category "${row.category}".`);
  }
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

export function serializeProject(project: Project): ProjectRow {
  return {
    id: project.id,
    name: project.name,
    category: project.category,
    archived_at: project.archivedAt,
    created_at: project.createdAt,
  };
}

/** True when a project should appear in a "pick a project" list — i.e.
 * not archived. Named for the picker's use case rather than just negating
 * archivedAt, so call sites read as intent. */
export function isSelectable(project: Project): boolean {
  return project.archivedAt === null;
}
```

- [ ] **Step 2: Write `src/lib/projects.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { isSelectable, serializeProject, toProject, type ProjectRow } from './projects';

describe('toProject', () => {
  it('maps a valid row to the domain shape', () => {
    const row: ProjectRow = {
      id: 'p1',
      name: 'Thesis',
      category: 'study',
      archived_at: null,
      created_at: 1000,
    };
    expect(toProject(row)).toEqual({
      id: 'p1',
      name: 'Thesis',
      category: 'study',
      archivedAt: null,
      createdAt: 1000,
    });
  });

  it('throws on an unknown category', () => {
    const row: ProjectRow = {
      id: 'p1',
      name: 'Thesis',
      category: 'bogus',
      archived_at: null,
      created_at: 1000,
    };
    expect(() => toProject(row)).toThrow(/unknown category/);
  });
});

describe('serializeProject', () => {
  it('round-trips through toProject', () => {
    const row: ProjectRow = {
      id: 'p1',
      name: 'Freelance client X',
      category: 'work',
      archived_at: 2000,
      created_at: 1000,
    };
    expect(serializeProject(toProject(row))).toEqual(row);
  });
});

describe('isSelectable', () => {
  it('is true for an active project and false for an archived one', () => {
    const active = toProject({ id: 'p1', name: 'A', category: 'personal', archived_at: null, created_at: 1000 });
    const archived = toProject({ id: 'p2', name: 'B', category: 'personal', archived_at: 2000, created_at: 1000 });
    expect(isSelectable(active)).toBe(true);
    expect(isSelectable(archived)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `npx vitest run src/lib/projects.test.ts`
Expected: 4 tests passing.

- [ ] **Step 4: Add `project_id` to `SessionRow`**

In `src/lib/persistence.ts`, add the field to the `SessionRow` interface (after `review_acknowledged_at`, before `updated_at`):

```ts
  review_acknowledged_at: number | null;
  /** Optional tag set by a dedicated UPDATE (repository.ts's
   * updateSessionProject), never by serializeSessionState — this is
   * deliberately outside the timer state machine, exactly like
   * review_acknowledged_at above. Present on every row returned by
   * `SELECT *`; simply unused by serialize/deserialize in this file. */
  project_id: string | null;
  updated_at: number;
```

Do not add `project_id` to `EMPTY_ROW_FIELDS` or any branch of `serializeSessionState`'s `switch` — this field is intentionally never produced by that function. `deserializeSessionRow`/`deserializeIntermissionRow` also stay untouched; they never read `row.project_id`.

- [ ] **Step 5: Run the full existing persistence test suite to confirm nothing broke**

Run: `npx vitest run src/lib/persistence.test.ts`
Expected: all existing tests still pass (this step only added a field to an interface — TypeScript will flag any place that constructs a `SessionRow` object literal without it as a type error; if that happens, it means a test fixture builds a `SessionRow` by hand rather than via `serializeSessionState` — add `project_id: null` to that fixture).

- [ ] **Step 6: Commit**

```bash
git add src/lib/projects.ts src/lib/projects.test.ts src/lib/persistence.ts
git commit -m "feat: add Project domain module and SessionRow.project_id"
```

---

### Task 3: Repository layer — project CRUD and session project assignment

**Files:**
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/memoryRepository.ts`
- Modify: `src/lib/repository.ts`

**Interfaces:**
- Consumes: `Project`, `ProjectRow`, `toProject`, `serializeProject` from Task 2's `projects.ts`; `SessionRow` from `persistence.ts` (Task 2).
- Produces (exported from `repository.ts`, the single entry point later tasks import from): `insertProject(project: Project): Promise<void>`, `renameProject(id: string, name: string): Promise<void>`, `setProjectArchived(id: string, archivedAt: number | null): Promise<void>`, `loadAllProjects(): Promise<Project[]>`, `updateSessionProject(sessionId: string, projectId: string | null): Promise<void>`.

- [ ] **Step 1: Add to `src/lib/tauriRepository.ts`**

Add near the bottom of the file (after the revisions functions), and add `import { toProject, type Project, type ProjectRow } from './projects';` to the top import block:

```ts
export async function insertProject(project: Project): Promise<void> {
  const db = await getDb();
  const row = serializeProject(project);
  await db.execute(
    'INSERT INTO projects (id, name, category, archived_at, created_at) VALUES ($1, $2, $3, $4, $5)',
    [row.id, row.name, row.category, row.archived_at, row.created_at],
  );
}

export async function renameProject(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE projects SET name = $1 WHERE id = $2', [name, id]);
}

export async function setProjectArchived(id: string, archivedAt: number | null): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE projects SET archived_at = $1 WHERE id = $2', [archivedAt, id]);
}

/** All projects, most recently created first. Includes archived ones —
 * callers filter with isSelectable() when they specifically need an
 * active-only list (see ProjectPicker.svelte). */
export async function loadAllProjects(): Promise<Project[]> {
  const db = await getDb();
  const rows = await db.select<ProjectRow[]>('SELECT * FROM projects ORDER BY created_at DESC');
  return rows.map(toProject);
}

/** Sets or clears a session's project tag. Deliberately outside
 * saveSession/serializeSessionState — see persistence.ts's SessionRow
 * comment on project_id and this plan's architecture note. Unlike
 * acknowledgeSessionReview, this is valid for a session in any status
 * (tagging isn't restricted to completed sessions — the picker also
 * appears on the still-open start form), so there is no status guard
 * here and no thrown error for a missing row: a session row always
 * exists by the time this is called (the initial saveSession happens
 * first), so an affected-rows check would only catch a caller bug, not
 * a real runtime condition — matching renameProject/setProjectArchived's
 * same unchecked-UPDATE style directly above.
 */
export async function updateSessionProject(sessionId: string, projectId: string | null): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE sessions SET project_id = $1 WHERE id = $2', [projectId, sessionId]);
}
```

Also add `import { serializeProject } from './projects';` (combine with the `toProject`/`Project`/`ProjectRow` import above into one import statement).

- [ ] **Step 2: Add to `src/lib/memoryRepository.ts`**

Add `import { serializeProject, toProject, type Project } from './projects';` to the top imports, and a new `const projects = new Map<string, Project>();` alongside the existing `const sessions = new Map<string, SessionRow>();` declaration. Then add near the bottom of the file:

```ts
export async function insertProject(project: Project): Promise<void> {
  projects.set(project.id, project);
}

export async function renameProject(id: string, name: string): Promise<void> {
  const existing = projects.get(id);
  if (!existing) return;
  projects.set(id, { ...existing, name });
}

export async function setProjectArchived(id: string, archivedAt: number | null): Promise<void> {
  const existing = projects.get(id);
  if (!existing) return;
  projects.set(id, { ...existing, archivedAt });
}

export async function loadAllProjects(): Promise<Project[]> {
  return [...projects.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateSessionProject(sessionId: string, projectId: string | null): Promise<void> {
  const existing = sessions.get(sessionId);
  if (!existing) return;
  sessions.set(sessionId, { ...existing, project_id: projectId });
}
```

(`serializeProject`/`toProject` are imported for parity with the real backend's shape even though this in-memory version doesn't need row translation — remove `serializeProject`/`toProject` from the import if your editor flags them as unused, keeping only `type Project`.)

- [ ] **Step 3: Re-export from `src/lib/repository.ts`**

Add to the existing `const backend = isTauri() ? tauriRepository : memoryRepository;` export list:

```ts
export const insertProject = backend.insertProject;
export const renameProject = backend.renameProject;
export const setProjectArchived = backend.setProjectArchived;
export const loadAllProjects = backend.loadAllProjects;
export const updateSessionProject = backend.updateSessionProject;
```

- [ ] **Step 4: Verify the project builds and existing repository tests still pass**

Run: `npx tsc --noEmit && npx vitest run src/lib/memoryRepository.test.ts`
Expected: no TypeScript errors, existing memory-repository tests pass (this task added new exports; it should not have changed any existing behavior).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tauriRepository.ts src/lib/memoryRepository.ts src/lib/repository.ts
git commit -m "feat: add project CRUD and session project assignment to repository layer"
```

---

### Task 4: `ProjectPicker.svelte` — reusable picker + inline create

**Files:**
- Create: `src/lib/ProjectPicker.svelte`
- Create: `src/lib/ProjectPicker.test.ts`

**Interfaces:**
- Consumes: `Project`, `ProjectCategory`, `PROJECT_CATEGORIES`, `CATEGORY_LABELS`, `isSelectable` from Task 2's `projects.ts`.
- Produces: `ProjectPicker.svelte` with props `{ projects: Project[]; selectedId: string | null; onSelect: (id: string | null) => void; onCreate: (name: string, category: ProjectCategory) => Promise<Project>; initiallyCreating?: boolean }`. Used by Tasks 5, 6, and 7 (session start, History reassignment, Projects list "+ New" — Task 7 is the one that passes `initiallyCreating`).

- [ ] **Step 1: Write `src/lib/ProjectPicker.svelte`**

```svelte
<script lang="ts">
  import { CATEGORY_LABELS, PROJECT_CATEGORIES, isSelectable, type Project, type ProjectCategory } from './projects';

  let {
    projects,
    selectedId,
    onSelect,
    onCreate,
    initiallyCreating = false,
  }: {
    projects: Project[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onCreate: (name: string, category: ProjectCategory) => Promise<Project>;
    /** Skips straight to the create form instead of the dropdown — used by
     * Projects.svelte's "+ New Project" button, where showing a dropdown
     * (with nothing sensible to select yet) before the create form would
     * be a confusing extra click. */
    initiallyCreating?: boolean;
  } = $props();

  let creating = $state(initiallyCreating);
  let newName = $state('');
  let newCategory = $state<ProjectCategory>('personal');
  let createError = $state<string | null>(null);

  const selectable = $derived(projects.filter(isSelectable));

  function handleChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '__new__') {
      creating = true;
      return;
    }
    onSelect(value === '' ? null : value);
  }

  async function submitNewProject() {
    const trimmed = newName.trim();
    if (!trimmed) {
      createError = 'Give the project a name.';
      return;
    }
    try {
      const project = await onCreate(trimmed, newCategory);
      creating = false;
      newName = '';
      newCategory = 'personal';
      createError = null;
      onSelect(project.id);
    } catch (err) {
      console.error('Failed to create project:', err);
      createError = 'Failed to create project.';
    }
  }

  function cancelCreate() {
    creating = false;
    newName = '';
    newCategory = 'personal';
    createError = null;
  }
</script>

{#if creating}
  <div class="create-form">
    <input
      type="text"
      placeholder="Project name"
      bind:value={newName}
      aria-label="New project name"
    />
    <div class="category-radios" role="radiogroup" aria-label="Category">
      {#each PROJECT_CATEGORIES as category (category)}
        <label>
          <input type="radio" name="new-project-category" value={category} bind:group={newCategory} />
          {CATEGORY_LABELS[category]}
        </label>
      {/each}
    </div>
    {#if createError}
      <p class="error" role="alert">{createError}</p>
    {/if}
    <div class="create-actions">
      <button type="button" class="link" onclick={cancelCreate}>Cancel</button>
      <button type="button" class="link" onclick={submitNewProject}>Create</button>
    </div>
  </div>
{:else}
  <select value={selectedId ?? ''} onchange={handleChange} aria-label="Project">
    <option value="">No project</option>
    {#each selectable as project (project.id)}
      <option value={project.id}>{project.name} · {CATEGORY_LABELS[project.category]}</option>
    {/each}
    <option value="__new__">+ New project</option>
  </select>
{/if}

<style>
  select {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }

  .create-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .create-form input[type='text'] {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }

  .category-radios {
    display: flex;
    gap: 1rem;
    font-size: 0.85rem;
    color: var(--text);
  }

  .category-radios label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--danger);
  }

  .create-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
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
</style>
```

- [ ] **Step 2: Write `src/lib/ProjectPicker.test.ts`**

This tests the two pure/logical concerns extractable without a DOM: that `isSelectable` filtering (already tested in Task 2) is what the component relies on, and that the component's category default is a valid category. Since this component has no exported pure functions of its own (it's UI-only, matching the codebase's convention of testing Svelte components via `.test.svelte` harnesses rather than plain `.test.ts` for interactive behavior), write a minimal harness-based test instead, matching `History.svelte`'s existing test pattern:

First, check how an existing simple component test is structured — run:

Run: `cat src/lib/SoundscapePopover.test.ts | head -30`

Then write `src/lib/ProjectPicker.test.ts` following that exact same harness/render/assert pattern (using `@testing-library/svelte` or whatever this file shows — match it exactly), covering:
1. Renders "No project" as the default selected option when `selectedId` is `null`.
2. Only non-archived projects appear as `<option>` elements (an archived project passed in `projects` must not render).
3. Selecting an existing project's option calls `onSelect` with that project's id.
4. Choosing "+ New project" reveals the create form; submitting with a name and category calls `onCreate`, and on success calls `onSelect` with the newly created project's id.
5. Submitting the create form with a blank/whitespace-only name shows the error message and does not call `onCreate`.
6. Passing `initiallyCreating={true}` renders the create form immediately, with no dropdown shown first.

- [ ] **Step 3: Run the new tests**

Run: `npx vitest run src/lib/ProjectPicker.test.ts`
Expected: all 6 cases passing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ProjectPicker.svelte src/lib/ProjectPicker.test.ts
git commit -m "feat: add reusable ProjectPicker component"
```

---

### Task 5: Wire `ProjectPicker` into session start

**Files:**
- Modify: `src/App.svelte`

**Interfaces:**
- Consumes: `ProjectPicker` (Task 4), `loadAllProjects`, `insertProject`, `updateSessionProject` from `repository.ts` (Task 3), `Project`/`ProjectCategory` from `projects.ts` (Task 2).
- Produces: nothing new consumed by later tasks (this is a leaf integration; Task 6 wires the same `ProjectPicker` independently into `History.svelte`).

- [ ] **Step 1: Locate the exact start-form region**

Run: `grep -n "taskDraft\|durationMinutes" src/App.svelte | head -20`

Confirm the `bind:value={taskDraft}` (around line 2234) and `bind:value={durationMinutes}` (around line 2244) locations noted in the design spec still match; if the surrounding markup has shifted, use the actual current lines as the insertion point instead of the line numbers below.

- [ ] **Step 2: Add project state and loading**

Near the top of the `<script>` block, alongside the existing `let workspaceView = $state<WorkspaceView>('focus');` declaration, add:

```ts
import ProjectPicker from './lib/ProjectPicker.svelte';
import { insertProject, loadAllProjects, updateSessionProject } from './lib/repository';
import type { Project, ProjectCategory } from './lib/projects';
```

(merge the `import ... from './lib/repository'` line with any existing `repository` import if App.svelte already imports other names from it — check the top of the file for an existing `from './lib/repository'` import and add these three names to it rather than creating a second import statement.)

```ts
let projects = $state<Project[]>([]);
let selectedProjectId = $state<string | null>(null);

async function refreshProjects() {
  projects = await loadAllProjects();
}

async function handleCreateProject(name: string, category: ProjectCategory): Promise<Project> {
  const project: Project = { id: crypto.randomUUID(), name, category, archivedAt: null, createdAt: Date.now() };
  await insertProject(project);
  await refreshProjects();
  return project;
}
```

Call `void refreshProjects();` once at the same point the app already does its initial async setup (find the existing top-level `onMount`-equivalent initialization — search for where `initializeNoteStorage()` or the initial `loadLatestSessionRow()` call happens, and add `void refreshProjects();` alongside it, not inside the timer-recovery logic itself).

- [ ] **Step 3: Render the picker in the start form**

Immediately after the duration input's closing markup (near line 2244's `bind:value={durationMinutes}`, inside the same form region), add:

```svelte
<ProjectPicker
  projects={projects}
  selectedId={selectedProjectId}
  onSelect={(id) => (selectedProjectId = id)}
  onCreate={handleCreateProject}
/>
```

- [ ] **Step 4: Tag the session once it's created**

Find the existing handler that starts a new focus session (the function that calls `startFocus(...)` and then the first `saveSession(...)` for the new session id — search for `startFocus(` in `src/App.svelte`). Immediately after that first successful save, add:

```ts
if (selectedProjectId) {
  await updateSessionProject(sessionId, selectedProjectId);
}
selectedProjectId = null;
```

(`sessionId` here is whatever the existing handler's local variable/binding for the newly created session's id is called — use the actual name from the surrounding code, not necessarily `sessionId` verbatim.) Resetting `selectedProjectId = null` after every start (successful or not — put it after the tagging `if`, unconditionally) means the picker defaults back to "No project" for the next session, matching the "zero added friction" default from the spec.

- [ ] **Step 5: Manual verification (no automated test for this wiring step — App.svelte has no dedicated test file of its own; behavior is covered by the underlying units in Tasks 2-4)**

Run: `npm run dev`
In the browser: start a session with a project selected via the picker; confirm no console errors. This step's correctness is mechanical wiring of already-tested units, so a manual smoke check is the appropriate verification here rather than inventing an App.svelte test file this codebase doesn't otherwise have.

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors, all existing tests still passing.

- [ ] **Step 7: Commit**

```bash
git add src/App.svelte
git commit -m "feat: add optional project selection to session start"
```

---

### Task 6: Wire `ProjectPicker` into History reassignment

**Files:**
- Modify: `src/lib/History.svelte`
- Modify: `src/lib/History.test.ts` (if it exists — check first)
- Modify: `src/App.svelte`

**Interfaces:**
- Consumes: `ProjectPicker` (Task 4), `CATEGORY_LABELS` (Task 2), `Project` (Task 2), `updateSessionProject` (Task 3). Consumes `SessionSummary.projectId` — **this field does not exist yet**; Task 8 adds it to `history.ts`. Order note: if executing tasks strictly in file order, either resequence Task 8 before this task, or (recommended) implement this task's `History.svelte` changes against a `projectId: string | null` field added directly here as a minimal, self-contained addition to `SessionSummary` in `history.ts` (one field, one line in `toSessionSummary`), and let Task 8 build on top of it rather than introducing it — see Task 8's note.
- Produces: nothing new consumed by later tasks beyond the `projectId` field noted above.

- [ ] **Step 1: Add `projectId` to `SessionSummary`**

In `src/lib/history.ts`, add to the `SessionSummary` interface:

```ts
  /** The session's tagged project, or null if untagged. Set independently
   * of every other field here via repository.ts's updateSessionProject —
   * see persistence.ts's SessionRow.project_id comment. */
  projectId: string | null;
```

And in `toSessionSummary`, add `projectId: row.project_id,` to the returned object.

- [ ] **Step 2: Update `history.test.ts`'s row fixtures**

Run: `npx vitest run src/lib/history.test.ts`

If this fails with a TypeScript error about a missing `project_id` field on a hand-built `SessionRow`-like object, add `project_id: null` to that fixture (same as Task 2 Step 5's note). If `history.test.ts` builds its rows exclusively via `serializeSessionState` (per the file excerpt already reviewed, it does — see `completedRow`'s use of `serializeSessionState`), this step should need no fixture changes and the run should already pass, since `serializeSessionState` never sets `project_id` and TypeScript's structural typing will complain only if a literal object is missing the field — confirm by running the command above either way.

- [ ] **Step 3: Add the project tag + picker to `History.svelte`**

Add to the imports:

```ts
import ProjectPicker from './ProjectPicker.svelte';
import { CATEGORY_LABELS, type Project } from './projects';
```

Add a new prop to the existing `$props()` destructure:

```ts
    projects,
    onAssignProject,
```

with types:

```ts
    projects: Project[];
    onAssignProject: (sessionId: string, projectId: string | null) => Promise<void>;
```

Add local state for which row's picker is open:

```ts
  let assigningProjectId = $state<string | null>(null);

  function projectFor(summary: SessionSummary): Project | undefined {
    return projects.find((p) => p.id === summary.projectId);
  }
```

Add `onCreateProject: (name: string, category: ProjectCategory) => Promise<Project>;` to the `$props()` type (import `ProjectCategory` alongside `Project`/`CATEGORY_LABELS` above) — `History.svelte` has no direct repository access today (all persistence flows through callback props from `App.svelte`, per the existing `onDeleteSession`/`onDeleteAll` pattern), so project creation triggered from this picker must flow back through a prop the same way, not a local repository call.

In the template, inside the `<li>` for each `summary`, add a project tag/picker row — place it in `.row-top-text`, right after the existing `<span class="when">{formatDateTime(summary.completedAt)}</span>`:

```svelte
              {#if assigningProjectId === summary.id}
                <ProjectPicker
                  projects={projects}
                  selectedId={summary.projectId}
                  onSelect={async (id) => {
                    await onAssignProject(summary.id, id);
                    assigningProjectId = null;
                  }}
                  onCreate={onCreateProject}
                />
              {:else}
                <button type="button" class="project-tag" onclick={() => (assigningProjectId = summary.id)}>
                  {#if projectFor(summary)}
                    {projectFor(summary)?.name} · {CATEGORY_LABELS[projectFor(summary)!.category]}
                  {:else}
                    + Project
                  {/if}
                </button>
              {/if}
```

- [ ] **Step 4: Style the new `.project-tag` button**

Add to `History.svelte`'s `<style>` block, near the existing `.when` rule:

```css
  .project-tag {
    font-size: 0.78rem;
    padding: 0.15rem 0.5rem;
    border-radius: 100px;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
  }
```

- [ ] **Step 5: Wire the new props from `App.svelte`**

Find the existing `<History ... />` invocation (around line 2172-2196 per the earlier grep). Add:

```svelte
        projects={projects}
        onAssignProject={async (sessionId, projectId) => {
          await updateSessionProject(sessionId, projectId);
          await refreshHistorySummaries();
        }}
        onCreateProject={handleCreateProject}
```

(`refreshHistorySummaries` and `handleCreateProject` already exist — the former from `History.svelte`'s existing `onclick={() => void refreshHistorySummaries()}`-style calls visible in the earlier grep output, the latter from Task 5 Step 2. `projects` is the `$state` array from Task 5 Step 2 as well.)

- [ ] **Step 6: Run the test suite and typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors, all tests passing (including the updated `history.test.ts` from Step 2).

- [ ] **Step 7: Commit**

```bash
git add src/lib/History.svelte src/lib/history.ts src/lib/history.test.ts src/App.svelte
git commit -m "feat: allow reassigning a session's project from History"
```

---

### Task 7: Projects rail destination — nav, list, and detail view

**Files:**
- Modify: `src/lib/workspace.ts`
- Modify: `src/lib/WorkspaceNav.svelte`
- Create: `src/lib/Projects.svelte`
- Create: `src/lib/Projects.test.ts` (harness-based, matching the pattern found in Task 4 Step 2's investigation of an existing component test)
- Modify: `src/App.svelte`

**Interfaces:**
- Consumes: `ProjectPicker` (Task 4, for the "+ New project" entry point), `Project`/`ProjectCategory`/`CATEGORY_LABELS`/`isSelectable` (Task 2), `loadAllProjects`/`insertProject`/`renameProject`/`setProjectArchived` (Task 3), `SessionSummary` (Task 6's `projectId` field).
- Produces: `'projects'` added to `WorkspaceView`. `Projects.svelte` props: `{ projects: Project[]; summaries: SessionSummary[]; onBack: () => void; onCreateProject: (name: string, category: ProjectCategory) => Promise<Project>; onRenameProject: (id: string, name: string) => Promise<void>; onArchiveProject: (id: string, archived: boolean) => Promise<void> }`.

- [ ] **Step 1: Add `'projects'` to `WorkspaceView`**

In `src/lib/workspace.ts`:

```ts
export type WorkspaceView = 'focus' | 'history' | 'revisions' | 'greenhouse' | 'projects';
```

- [ ] **Step 2: Add the nav item**

In `src/lib/WorkspaceNav.svelte`, add the import:

```ts
  import FolderIcon from 'lucide-svelte/icons/folder';
```

Add a new nav button after the Greenhouse button and before the `{#if showRevisions}` block:

```svelte
  <button
    type="button"
    class="nav-item"
    aria-current={current === 'projects' ? 'page' : undefined}
    title="Projects"
    onclick={() => onNavigate('projects')}
  >
    <FolderIcon size={20} aria-hidden="true" />
    <span class="nav-label">Projects</span>
  </button>
```

- [ ] **Step 3: Write `src/lib/Projects.svelte`**

```svelte
<script lang="ts">
  import ProjectPicker from './ProjectPicker.svelte';
  import { CATEGORY_LABELS, isSelectable, type Project, type ProjectCategory } from './projects';
  import type { SessionSummary } from './history';
  import { formatDateTime, formatDuration } from './format';

  let {
    projects,
    summaries,
    onBack,
    onCreateProject,
    onRenameProject,
    onArchiveProject,
  }: {
    projects: Project[];
    summaries: SessionSummary[];
    onBack: () => void;
    onCreateProject: (name: string, category: ProjectCategory) => Promise<Project>;
    onRenameProject: (id: string, name: string) => Promise<void>;
    onArchiveProject: (id: string, archived: boolean) => Promise<void>;
  } = $props();

  let selectedProjectId = $state<string | null>(null);
  let showArchived = $state(false);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');

  const visibleProjects = $derived(
    showArchived ? projects : projects.filter(isSelectable),
  );

  function sessionCount(projectId: string): number {
    return summaries.filter((s) => s.projectId === projectId).length;
  }

  function totalFocusMs(projectId: string): number {
    return summaries
      .filter((s) => s.projectId === projectId)
      .reduce((sum, s) => sum + s.actualFocusMs, 0);
  }

  function selectedProject(): Project | undefined {
    return projects.find((p) => p.id === selectedProjectId);
  }

  function sessionsForSelected(): SessionSummary[] {
    return summaries
      .filter((s) => s.projectId === selectedProjectId)
      .sort((a, b) => b.completedAt - a.completedAt);
  }

  function startRename(project: Project) {
    renamingId = project.id;
    renameDraft = project.name;
  }

  async function submitRename() {
    if (!renamingId) return;
    const trimmed = renameDraft.trim();
    if (trimmed) await onRenameProject(renamingId, trimmed);
    renamingId = null;
  }

  // "+ New Project" reuses ProjectPicker's own create form (via
  // initiallyCreating) rather than a second name+category implementation.
  // Hidden behind a click rather than always-rendered, so the list view
  // doesn't open with a bare, nothing-to-select dropdown.
  let showingNewProjectForm = $state(false);
</script>

<section class="projects">
  <div class="header">
    <p class="eyebrow">Projects</p>
    <button class="link" onclick={onBack}>Back</button>
  </div>

  {#if selectedProjectId && selectedProject()}
    {@const project = selectedProject()!}
    <div class="detail">
      <button class="link" onclick={() => (selectedProjectId = null)}>&larr; All projects</button>
      <div class="detail-header">
        {#if renamingId === project.id}
          <input type="text" bind:value={renameDraft} aria-label="Rename project" />
          <button class="link" onclick={submitRename}>Save</button>
          <button class="link" onclick={() => (renamingId = null)}>Cancel</button>
        {:else}
          <h2>{project.name}</h2>
          <span class="pill">{CATEGORY_LABELS[project.category]}</span>
          <button class="link" onclick={() => startRename(project)}>Rename</button>
          <button
            class="link"
            onclick={() => onArchiveProject(project.id, project.archivedAt === null)}
          >
            {project.archivedAt === null ? 'Archive' : 'Unarchive'}
          </button>
        {/if}
      </div>

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
    </div>
  {:else}
    <div class="new-project">
      {#if showingNewProjectForm}
        <ProjectPicker
          projects={[]}
          selectedId={null}
          onSelect={() => (showingNewProjectForm = false)}
          onCreate={onCreateProject}
          initiallyCreating={true}
        />
      {:else}
        <button type="button" class="link" onclick={() => (showingNewProjectForm = true)}>+ New Project</button>
      {/if}
    </div>

    {#if visibleProjects.length === 0}
      <p class="empty">No projects yet.</p>
    {:else}
      <ul>
        {#each visibleProjects as project (project.id)}
          <li>
            <button type="button" class="project-row" onclick={() => (selectedProjectId = project.id)}>
              <span class="name">{project.name}</span>
              <span class="pill">{CATEGORY_LABELS[project.category]}</span>
              <span class="count">{sessionCount(project.id)} session{sessionCount(project.id) === 1 ? '' : 's'}</span>
              {#if project.archivedAt !== null}
                <span class="pill archived-pill">Archived</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <label class="show-archived">
      <input type="checkbox" bind:checked={showArchived} />
      Show archived
    </label>
  {/if}
</section>

<style>
  .projects {
    padding: 2.5rem 2rem;
    border-radius: 0.5rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .eyebrow {
    margin: 0;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
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

  .new-project {
    margin-bottom: 1.5rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .project-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }

  .name {
    font-weight: 600;
    flex: 1;
  }

  .pill {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 100px;
    background: var(--surface);
    color: var(--text-muted);
  }

  .archived-pill {
    color: var(--danger);
  }

  .count {
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .show-archived {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0.75rem 0;
  }

  .detail-header h2 {
    margin: 0;
    font-size: 1.2rem;
  }

  .stat-line {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin: 0 0 1rem;
  }

  .detail li {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .detail .task {
    font-weight: 600;
    flex: 1;
  }

  .detail .when,
  .detail .focus {
    font-size: 0.78rem;
    color: var(--text-muted);
  }
</style>
```

- [ ] **Step 2: Write `src/lib/Projects.test.ts`**

Investigate the existing harness pattern (same command as Task 4 Step 2: `cat src/lib/SoundscapePopover.test.ts | head -30`, and also check `src/lib/AppShellHarness.test.svelte` for how a harness wrapper component is structured) and follow it exactly. Cover:
1. List view shows only active (non-archived) projects by default; toggling "Show archived" reveals archived ones too.
2. Each project row shows its correct session count and total focus time, computed from the `summaries` prop.
3. Clicking a project row switches to detail view showing that project's name, category, and its sessions (filtered correctly by `projectId`).
4. Rename: entering edit mode, changing the name, and saving calls `onRenameProject` with the new name.
5. Archive/Unarchive button calls `onArchiveProject` with the toggled boolean.
6. "&larr; All projects" returns to the list view.
7. Clicking "+ New Project" reveals the create form (not a bare dropdown first); submitting it calls `onCreateProject` and then hides the form again.

- [ ] **Step 3: Run the new tests**

Run: `npx vitest run src/lib/Projects.test.ts`
Expected: all 7 cases passing.

- [ ] **Step 4: Wire into `App.svelte`**

Add the import: `import Projects from './lib/Projects.svelte';`

Add a new conditional render block, following the exact pattern of the existing `{#if workspaceView === 'history'}` block (around line 2172):

```svelte
    {:else if workspaceView === 'projects'}
      <Projects
        projects={projects}
        summaries={historySummaries}
        onBack={() => (workspaceView = 'focus')}
        onCreateProject={handleCreateProject}
        onRenameProject={renameProject}
        onArchiveProject={(id, archived) => setProjectArchived(id, archived ? Date.now() : null)}
      />
```

(`renameProject`/`setProjectArchived` are `repository.ts` functions from Task 3 — import them alongside the existing `updateSessionProject`/`insertProject`/`loadAllProjects` import from Task 5 Step 2. `historySummaries` is the existing state array `History.svelte` already consumes; confirm its exact name via `grep -n "historySummaries" src/App.svelte` if it differs.)

Add `'projects': 'Projects',` to the existing `WORKSPACE_LABELS` record (around line 1600).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors, all tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workspace.ts src/lib/WorkspaceNav.svelte src/lib/Projects.svelte src/lib/Projects.test.ts src/App.svelte
git commit -m "feat: add Projects rail destination with list and detail views"
```

---

### Task 8: `breakdown.ts` — pure grouping, time-range, and chart-math logic

**Files:**
- Create: `src/lib/breakdown.ts`
- Create: `src/lib/breakdown.test.ts`

**Interfaces:**
- Consumes: `SessionSummary` (with `.projectId`, from Task 6), `Project`/`ProjectCategory`/`CATEGORY_LABELS` (Task 2).
- Produces: `TimeRange` type (`'week' | 'month' | 'all'`), `filterSummariesByRange(summaries: SessionSummary[], range: TimeRange, now: number): SessionSummary[]`, `CategoryTotal` interface (`{ key: ProjectCategory | 'untagged'; label: string; totalMs: number }`), `groupByCategory(summaries, projectsById: Map<string, Project>): CategoryTotal[]`, `ProjectTotal` interface (`{ projectId: string; label: string; totalMs: number }`), `groupByProjectInCategory(summaries, projectsById, category: ProjectCategory): ProjectTotal[]`, `ChartType` type (`'bar' | 'donut' | 'pie'`), `toChartSegments(totals: { label: string; totalMs: number }[]): ChartSegment[]` where `ChartSegment` is `{ label: string; totalMs: number; percent: number; startAngle: number; endAngle: number }`, `describeArcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string`. Used by Task 9's `BreakdownChart.svelte`.

- [ ] **Step 1: Write `src/lib/breakdown.ts`**

```ts
// Pure logic for the History "Breakdown" tab: time-range filtering,
// category/project grouping, and the angle/path math BreakdownChart.svelte
// needs for its donut and pie renderings. No DOM, no repository access —
// matches history.ts's and export.ts's own separation of concerns.

import type { SessionSummary } from './history';
import { CATEGORY_LABELS, type Project, type ProjectCategory } from './projects';

export type TimeRange = 'week' | 'month' | 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rolling windows, not calendar-aligned — see the plan's Global
 * Constraints for why (simpler, and "the last 7 days" is what a user
 * checking in mid-week actually wants to see, not "since Sunday"). */
export function filterSummariesByRange(
  summaries: SessionSummary[],
  range: TimeRange,
  now: number,
): SessionSummary[] {
  if (range === 'all') return summaries;
  const windowMs = range === 'week' ? 7 * DAY_MS : 30 * DAY_MS;
  const cutoff = now - windowMs;
  return summaries.filter((s) => s.completedAt >= cutoff);
}

export interface CategoryTotal {
  key: ProjectCategory | 'untagged';
  label: string;
  totalMs: number;
}

/** Always includes every category plus 'untagged', even at zero, so the
 * breakdown visibly accounts for all time in range rather than silently
 * omitting an empty segment — see the design spec's Breakdown section. */
export function groupByCategory(
  summaries: SessionSummary[],
  projectsById: Map<string, Project>,
): CategoryTotal[] {
  const totals: Record<ProjectCategory | 'untagged', number> = {
    personal: 0,
    work: 0,
    study: 0,
    untagged: 0,
  };

  for (const summary of summaries) {
    const project = summary.projectId ? projectsById.get(summary.projectId) : undefined;
    const key = project ? project.category : 'untagged';
    totals[key] += summary.actualFocusMs;
  }

  return [
    { key: 'personal', label: CATEGORY_LABELS.personal, totalMs: totals.personal },
    { key: 'work', label: CATEGORY_LABELS.work, totalMs: totals.work },
    { key: 'study', label: CATEGORY_LABELS.study, totalMs: totals.study },
    { key: 'untagged', label: 'Untagged', totalMs: totals.untagged },
  ];
}

export interface ProjectTotal {
  projectId: string;
  label: string;
  totalMs: number;
}

/** Only projects with at least one session's worth of time in the
 * filtered range appear here — unlike groupByCategory, a zero-total
 * project drilled into from its (non-zero) category would be noise, not
 * useful accounting. */
export function groupByProjectInCategory(
  summaries: SessionSummary[],
  projectsById: Map<string, Project>,
  category: ProjectCategory,
): ProjectTotal[] {
  const totals = new Map<string, number>();

  for (const summary of summaries) {
    if (!summary.projectId) continue;
    const project = projectsById.get(summary.projectId);
    if (!project || project.category !== category) continue;
    totals.set(summary.projectId, (totals.get(summary.projectId) ?? 0) + summary.actualFocusMs);
  }

  return [...totals.entries()]
    .map(([projectId, totalMs]) => ({
      projectId,
      label: projectsById.get(projectId)?.name ?? 'Unknown project',
      totalMs,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

export type ChartType = 'bar' | 'donut' | 'pie';

export interface ChartSegment {
  label: string;
  totalMs: number;
  /** 0-100. Zero-total entries get percent 0 and are still returned (the
   * chart renders them as empty/omitted segments, not as a data error) —
   * BreakdownChart.svelte decides whether to skip drawing a zero-width
   * wedge, this function just reports the true proportion. */
  percent: number;
  /** Degrees, 0 at the top, clockwise — matches describeArcPath's own
   * convention below. */
  startAngle: number;
  endAngle: number;
}

/** Converts a list of {label, totalMs} entries into chart segments with
 * cumulative angles. Entries with totalMs <= 0 across the board (an empty
 * range) all get percent 0 and zero-width angles rather than dividing by
 * zero. */
export function toChartSegments(entries: { label: string; totalMs: number }[]): ChartSegment[] {
  const grandTotal = entries.reduce((sum, e) => sum + e.totalMs, 0);
  let cursor = 0;
  return entries.map((entry) => {
    const percent = grandTotal > 0 ? (entry.totalMs / grandTotal) * 100 : 0;
    const sweep = grandTotal > 0 ? (entry.totalMs / grandTotal) * 360 : 0;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    cursor = endAngle;
    return { label: entry.label, totalMs: entry.totalMs, percent, startAngle, endAngle };
  });
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

/** SVG path `d` attribute for a filled pie wedge from startAngle to
 * endAngle (degrees, clockwise from the top, matching toChartSegments).
 * A full-circle wedge (360deg exactly) is nudged by 0.001deg so the arc
 * flags don't degenerate into a zero-length path — SVG's elliptical arc
 * command can't describe a complete circle in one segment. */
export function describeArcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const clampedEnd = endAngle - startAngle >= 360 ? startAngle + 359.999 : endAngle;
  const start = polarToCartesian(cx, cy, r, clampedEnd);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = clampedEnd - startAngle <= 180 ? '0' : '1';
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
}
```

- [ ] **Step 2: Write `src/lib/breakdown.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  describeArcPath,
  filterSummariesByRange,
  groupByCategory,
  groupByProjectInCategory,
  toChartSegments,
} from './breakdown';
import type { Project } from './projects';
import type { SessionSummary } from './history';

const T0 = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'default-id',
    task: 'Task',
    completedAt: T0,
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

function project(overrides: Partial<Project>): Project {
  return {
    id: 'default-project',
    name: 'Project',
    category: 'work',
    archivedAt: null,
    createdAt: T0,
    ...overrides,
  };
}

describe('filterSummariesByRange', () => {
  const summaries = [
    summary({ id: 's1', completedAt: T0 }),
    summary({ id: 's2', completedAt: T0 - 3 * DAY_MS }),
    summary({ id: 's3', completedAt: T0 - 10 * DAY_MS }),
    summary({ id: 's4', completedAt: T0 - 40 * DAY_MS }),
  ];

  it('week keeps only the last 7 days', () => {
    const result = filterSummariesByRange(summaries, 'week', T0);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('month keeps only the last 30 days', () => {
    const result = filterSummariesByRange(summaries, 'month', T0);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('all returns everything unfiltered', () => {
    expect(filterSummariesByRange(summaries, 'all', T0)).toEqual(summaries);
  });
});

describe('groupByCategory', () => {
  it('buckets sessions by their project\'s category, and untagged sessions separately', () => {
    const projectsById = new Map([
      ['p-work', project({ id: 'p-work', category: 'work' })],
      ['p-study', project({ id: 'p-study', category: 'study' })],
    ]);
    const summaries = [
      summary({ id: 's1', projectId: 'p-work', actualFocusMs: 1000 }),
      summary({ id: 's2', projectId: 'p-work', actualFocusMs: 500 }),
      summary({ id: 's3', projectId: 'p-study', actualFocusMs: 2000 }),
      summary({ id: 's4', projectId: null, actualFocusMs: 300 }),
    ];

    const totals = groupByCategory(summaries, projectsById);
    expect(totals).toEqual([
      { key: 'personal', label: 'Personal', totalMs: 0 },
      { key: 'work', label: 'Work', totalMs: 1500 },
      { key: 'study', label: 'Study', totalMs: 2000 },
      { key: 'untagged', label: 'Untagged', totalMs: 300 },
    ]);
  });

  it('a project_id that no longer resolves to a project counts as untagged', () => {
    const summaries = [summary({ id: 's1', projectId: 'deleted-project', actualFocusMs: 100 })];
    const totals = groupByCategory(summaries, new Map());
    expect(totals.find((t) => t.key === 'untagged')?.totalMs).toBe(100);
  });
});

describe('groupByProjectInCategory', () => {
  it('only includes projects in the requested category, sorted by total descending', () => {
    const projectsById = new Map([
      ['p1', project({ id: 'p1', name: 'Alpha', category: 'work' })],
      ['p2', project({ id: 'p2', name: 'Beta', category: 'work' })],
      ['p3', project({ id: 'p3', name: 'Gamma', category: 'study' })],
    ]);
    const summaries = [
      summary({ id: 's1', projectId: 'p1', actualFocusMs: 100 }),
      summary({ id: 's2', projectId: 'p2', actualFocusMs: 500 }),
      summary({ id: 's3', projectId: 'p3', actualFocusMs: 900 }),
    ];

    const result = groupByProjectInCategory(summaries, projectsById, 'work');
    expect(result).toEqual([
      { projectId: 'p2', label: 'Beta', totalMs: 500 },
      { projectId: 'p1', label: 'Alpha', totalMs: 100 },
    ]);
  });
});

describe('toChartSegments', () => {
  it('computes cumulative percent and angle ranges', () => {
    const segments = toChartSegments([
      { label: 'A', totalMs: 300 },
      { label: 'B', totalMs: 100 },
    ]);
    expect(segments[0]).toEqual({ label: 'A', totalMs: 300, percent: 75, startAngle: 0, endAngle: 270 });
    expect(segments[1]).toEqual({ label: 'B', totalMs: 100, percent: 25, startAngle: 270, endAngle: 360 });
  });

  it('returns all-zero segments for an empty total rather than dividing by zero', () => {
    const segments = toChartSegments([{ label: 'A', totalMs: 0 }]);
    expect(segments[0].percent).toBe(0);
    expect(Number.isFinite(segments[0].startAngle)).toBe(true);
  });
});

describe('describeArcPath', () => {
  it('returns a valid SVG path string for a quarter circle', () => {
    const d = describeArcPath(50, 50, 40, 0, 90);
    expect(d).toMatch(/^M 50 50 L/);
    expect(d).toContain('A 40 40 0 0 0');
  });

  it('does not degenerate for a full 360-degree sweep', () => {
    const d = describeArcPath(50, 50, 40, 0, 360);
    expect(d.length).toBeGreaterThan(0);
    expect(d).not.toContain('NaN');
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `npx vitest run src/lib/breakdown.test.ts`
Expected: all cases passing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/breakdown.ts src/lib/breakdown.test.ts
git commit -m "feat: add pure grouping, time-range, and chart-math logic for the breakdown tab"
```

---

### Task 9: `BreakdownChart.svelte` — bar/donut/pie renderer with persisted chart-type preference

**Files:**
- Create: `src/lib/BreakdownChart.svelte`

**Interfaces:**
- Consumes: `ChartType`, `toChartSegments`, `describeArcPath` from Task 8's `breakdown.ts`; `getSetting`/`setSetting` from `repository.ts` (already exist, unchanged).
- Produces: `BreakdownChart.svelte` props `{ data: { label: string; totalMs: number }[]; onSegmentClick?: (label: string) => void }`. Manages its own chart-type toggle state and persistence internally (reads/writes the `breakdown_chart_type` setting itself, so `History.svelte` in Task 10 only needs to pass `data`). Used by Task 10.

- [ ] **Step 1: Write `src/lib/BreakdownChart.svelte`**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import BarChartIcon from 'lucide-svelte/icons/bar-chart-2';
  import CircleIcon from 'lucide-svelte/icons/circle';
  import PieChartIcon from 'lucide-svelte/icons/pie-chart';
  import { describeArcPath, toChartSegments, type ChartType } from './breakdown';
  import { formatDuration } from './format';
  import { getSetting, setSetting } from './repository';

  let { data, onSegmentClick }: { data: { label: string; totalMs: number }[]; onSegmentClick?: (label: string) => void } =
    $props();

  const CHART_TYPE_SETTING_KEY = 'breakdown_chart_type';
  const CHART_TYPES: ChartType[] = ['bar', 'donut', 'pie'];

  let chartType = $state<ChartType>('bar');

  onMount(async () => {
    const stored = await getSetting(CHART_TYPE_SETTING_KEY);
    if (stored === 'bar' || stored === 'donut' || stored === 'pie') {
      chartType = stored;
    }
  });

  async function selectChartType(type: ChartType) {
    chartType = type;
    await setSetting(CHART_TYPE_SETTING_KEY, type);
  }

  const segments = $derived(toChartSegments(data));
  const maxMs = $derived(Math.max(1, ...data.map((d) => d.totalMs)));

  // Personal/Work/Study/Untagged-shaped data always arrives in that fixed
  // order from groupByCategory; project-drill-down data has no such fixed
  // order. Either way, opacity is assigned by position, not by identity —
  // see the plan's Global Constraints for why (no new per-theme colors).
  const OPACITIES = [1, 0.65, 0.35, 0.2];
  function opacityFor(index: number): number {
    return OPACITIES[index] ?? 0.2;
  }
</script>

<div class="breakdown-chart">
  <div class="chart-type-toggle" role="radiogroup" aria-label="Chart type">
    {#each CHART_TYPES as type (type)}
      <button
        type="button"
        class="toggle-button"
        aria-pressed={chartType === type}
        title={type}
        onclick={() => selectChartType(type)}
      >
        {#if type === 'bar'}
          <BarChartIcon size={16} aria-hidden="true" />
        {:else if type === 'donut'}
          <CircleIcon size={16} aria-hidden="true" />
        {:else}
          <PieChartIcon size={16} aria-hidden="true" />
        {/if}
      </button>
    {/each}
  </div>

  {#if chartType === 'bar'}
    <ul class="bar-list">
      {#each data as entry, index (entry.label)}
        <li>
          <button type="button" class="bar-row" onclick={() => onSegmentClick?.(entry.label)}>
            <span class="bar-label">{entry.label}</span>
            <span class="bar-track">
              <span
                class="bar-fill"
                style={`width: ${(entry.totalMs / maxMs) * 100}%; opacity: ${opacityFor(index)};`}
              ></span>
            </span>
            <span class="bar-value">{formatDuration(entry.totalMs)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else if chartType === 'donut'}
    <svg viewBox="0 0 200 200" class="donut" role="img" aria-label="Time breakdown donut chart">
      {#each segments as segment, index (segment.label)}
        {#if segment.percent > 0}
          <circle
            cx="100"
            cy="100"
            r="70"
            fill="none"
            stroke="var(--timer-accent)"
            stroke-opacity={opacityFor(index)}
            stroke-width="36"
            stroke-dasharray={`${(segment.percent / 100) * 2 * Math.PI * 70} ${2 * Math.PI * 70}`}
            stroke-dashoffset={-((segment.startAngle / 360) * 2 * Math.PI * 70)}
            transform="rotate(-90 100 100)"
            role="button"
            tabindex="0"
            onclick={() => onSegmentClick?.(segment.label)}
            onkeydown={(e) => e.key === 'Enter' && onSegmentClick?.(segment.label)}
          >
            <title>{segment.label}: {formatDuration(segment.totalMs)}</title>
          </circle>
        {/if}
      {/each}
    </svg>
    <ul class="legend">
      {#each segments as segment, index (segment.label)}
        <li>
          <span class="swatch" style={`opacity: ${opacityFor(index)};`}></span>
          {segment.label} — {formatDuration(segment.totalMs)}
        </li>
      {/each}
    </ul>
  {:else}
    <svg viewBox="0 0 200 200" class="pie" role="img" aria-label="Time breakdown pie chart">
      {#each segments as segment, index (segment.label)}
        {#if segment.percent > 0}
          <path
            d={describeArcPath(100, 100, 90, segment.startAngle, segment.endAngle)}
            fill="var(--timer-accent)"
            fill-opacity={opacityFor(index)}
            role="button"
            tabindex="0"
            onclick={() => onSegmentClick?.(segment.label)}
            onkeydown={(e) => e.key === 'Enter' && onSegmentClick?.(segment.label)}
          >
            <title>{segment.label}: {formatDuration(segment.totalMs)}</title>
          </path>
        {/if}
      {/each}
    </svg>
    <ul class="legend">
      {#each segments as segment, index (segment.label)}
        <li>
          <span class="swatch" style={`opacity: ${opacityFor(index)};`}></span>
          {segment.label} — {formatDuration(segment.totalMs)}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .breakdown-chart {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .chart-type-toggle {
    display: flex;
    gap: 0.5rem;
    align-self: flex-end;
  }

  .toggle-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
  }

  .toggle-button[aria-pressed='true'] {
    background: var(--surface-secondary);
    color: var(--text);
    border-color: var(--timer-accent);
  }

  .bar-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .bar-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text);
  }

  .bar-label {
    width: 6rem;
    flex-shrink: 0;
    font-size: 0.85rem;
    text-align: left;
  }

  .bar-track {
    flex: 1;
    height: 0.9rem;
    border-radius: 100px;
    background: var(--surface-secondary);
    overflow: hidden;
  }

  .bar-fill {
    display: block;
    height: 100%;
    background: var(--timer-accent);
    border-radius: 100px;
  }

  .bar-value {
    width: 4.5rem;
    flex-shrink: 0;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    text-align: right;
  }

  .donut,
  .pie {
    width: 100%;
    max-width: 220px;
    align-self: center;
  }

  .donut circle,
  .pie path {
    cursor: pointer;
  }

  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .swatch {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 2px;
    background: var(--timer-accent);
  }
</style>
```

- [ ] **Step 2: Verify it builds**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/BreakdownChart.svelte
git commit -m "feat: add BreakdownChart with bar, donut, and pie modes"
```

---

### Task 10: Wire the "Breakdown" tab into `History.svelte`

**Files:**
- Modify: `src/lib/History.svelte`
- Modify: `src/App.svelte`

**Interfaces:**
- Consumes: `BreakdownChart` (Task 9), `filterSummariesByRange`/`groupByCategory`/`groupByProjectInCategory`/`TimeRange` (Task 8), `Project` (Task 2). Consumes the `projects` prop already added to `History.svelte` in Task 6.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add tab state and imports to `History.svelte`**

Add imports:

```ts
import BreakdownChart from './BreakdownChart.svelte';
import { filterSummariesByRange, groupByCategory, groupByProjectInCategory, type TimeRange } from './breakdown';
import type { ProjectCategory } from './projects';
```

Add state:

```ts
let activeTab = $state<'list' | 'breakdown'>('list');
let timeRange = $state<TimeRange>('all');
let drilledCategory = $state<ProjectCategory | null>(null);

const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));
const rangedSummaries = $derived(filterSummariesByRange(summaries, timeRange, Date.now()));
const categoryTotals = $derived(groupByCategory(rangedSummaries, projectsById));
const projectTotalsInDrilledCategory = $derived(
  drilledCategory ? groupByProjectInCategory(rangedSummaries, projectsById, drilledCategory) : [],
);

const CATEGORY_KEYS: ProjectCategory[] = ['personal', 'work', 'study'];

function handleCategorySegmentClick(label: string) {
  const match = categoryTotals.find((c) => c.label === label);
  if (match && CATEGORY_KEYS.includes(match.key as ProjectCategory)) {
    drilledCategory = match.key as ProjectCategory;
  }
}
```

- [ ] **Step 2: Add the tab toggle and Breakdown panel to the template**

Immediately after the `<div class="header">...</div>` block and before the existing `<div class="export-row">`, add:

```svelte
  <div class="tabs" role="tablist">
    <button type="button" role="tab" aria-selected={activeTab === 'list'} onclick={() => (activeTab = 'list')}>
      Sessions
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === 'breakdown'}
      onclick={() => (activeTab = 'breakdown')}
    >
      Breakdown
    </button>
  </div>

  {#if activeTab === 'breakdown'}
    <div class="breakdown-panel">
      <div class="range-toggle" role="radiogroup" aria-label="Time range">
        {#each [['week', 'This week'], ['month', 'This month'], ['all', 'All time']] as [value, label] (value)}
          <button
            type="button"
            aria-pressed={timeRange === value}
            onclick={() => {
              timeRange = value as TimeRange;
              drilledCategory = null;
            }}
          >
            {label}
          </button>
        {/each}
      </div>

      {#if drilledCategory}
        <button type="button" class="link" onclick={() => (drilledCategory = null)}>&larr; All categories</button>
        <BreakdownChart data={projectTotalsInDrilledCategory.map((p) => ({ label: p.label, totalMs: p.totalMs }))} />
      {:else}
        <BreakdownChart
          data={categoryTotals.map((c) => ({ label: c.label, totalMs: c.totalMs }))}
          onSegmentClick={handleCategorySegmentClick}
        />
      {/if}
    </div>
  {:else}
```

Then wrap the entire existing body — from the `<div class="export-row">` block through the closing of the `{#if summaries.length === 0}...{/if}` block — so it only renders `{#if activeTab === 'list'}`. Concretely: the `{:else}` opened just above pairs with the file's very last content before `</section>`; add the matching `{/if}` immediately before `</section>`.

- [ ] **Step 3: Style the new elements**

Add to `History.svelte`'s `<style>` block:

```css
  .tabs {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    background: none;
    border: none;
    padding: 0.5rem 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }

  .tabs button[aria-selected='true'] {
    color: var(--text);
    border-bottom-color: var(--timer-accent);
  }

  .breakdown-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .range-toggle {
    display: flex;
    gap: 0.5rem;
  }

  .range-toggle button {
    font-size: 0.8rem;
    padding: 0.3rem 0.7rem;
    border-radius: 100px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
  }

  .range-toggle button[aria-pressed='true'] {
    background: var(--surface-secondary);
    color: var(--text);
    border-color: var(--timer-accent);
  }
```

- [ ] **Step 4: Pass `projects` from `App.svelte`**

Confirm the `<History ... projects={projects} ... />` prop from Task 6 Step 5 is already present — no change needed here if so; this step is just verification.

Run: `grep -n "projects={projects}" src/App.svelte`
Expected: at least one match, inside the `<History>` invocation.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors, all tests passing.

- [ ] **Step 6: Manual verification**

Run: `npm run dev`
In the browser: complete a couple of sessions with different projects/categories tagged, open History → Breakdown, confirm the category totals look right, switch chart types (bar/donut/pie), drill into a category, switch time ranges.

- [ ] **Step 7: Commit**

```bash
git add src/lib/History.svelte
git commit -m "feat: add Breakdown tab to History with category/project drill-down"
```

---

### Task 11: Export gains Project and Category columns

**Files:**
- Modify: `src/lib/export.ts`
- Modify: `src/lib/export.test.ts`
- Modify: `src/App.svelte`

**Interfaces:**
- Consumes: `SessionSummary.projectId` (Task 6), `Project`/`CATEGORY_LABELS` (Task 2).
- Produces: nothing new consumed by later tasks (leaf).

- [ ] **Step 1: Update `SessionExportEntry` and `buildExportData`**

In `src/lib/export.ts`, add to `SessionExportEntry`:

```ts
  /** Null when untagged. Resolved from SessionSummary.projectId at export
   * time (not stored redundantly on SessionSummary itself) — see
   * buildExportData's new `projects` parameter below. */
  projectName: string | null;
  categoryLabel: string | null;
```

Update `buildExportData`'s signature and body:

```ts
export function buildExportData(
  summaries: SessionSummary[],
  parkedThoughts: ParkedThought[],
  exportedAt: number,
  projects: Project[] = [],
): ExportData {
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const sessions: SessionExportEntry[] = summaries.map((summary) => {
    const project = summary.projectId ? projectsById.get(summary.projectId) : undefined;
    return {
      id: summary.id,
      task: summary.task,
      completedAt: summary.completedAt,
      plannedFocusMs: summary.plannedFocusMs,
      actualFocusMs: summary.actualFocusMs,
      flowMs: summary.flowMs,
      breakMs: summary.breakMs,
      ...(summary.breakIntermissionMs > 0
        ? { breakIntermissionMs: summary.breakIntermissionMs }
        : {}),
      ...(summary.touchGrassMs > 0 ? { touchGrassMs: summary.touchGrassMs } : {}),
      totalElapsedMs: summary.totalElapsedMs,
      parkedThoughtCount: summary.parkedThoughtCount,
      parkedThoughts: parkedThoughts
        .filter((thought) => thought.sessionId === summary.id)
        .map((thought) => thought.text),
      noteContent: summary.noteContent,
      projectName: project?.name ?? null,
      categoryLabel: project ? CATEGORY_LABELS[project.category] : null,
    };
  });

  return {
    version: EXPORT_FORMAT_VERSION,
    exportedAt,
    sessions,
    parkedThoughts: parkedThoughts.map((thought) => ({
      id: thought.id,
      sessionId: thought.sessionId,
      text: thought.text,
      createdAt: thought.createdAt,
    })),
  };
}
```

Add `import { CATEGORY_LABELS, type Project } from './projects';` to the top imports. Bump `EXPORT_FORMAT_VERSION` from `2` to `3` (a real, additive schema change to the exported payload).

- [ ] **Step 2: Update `formatExportAsCsv`**

Add `'project'` and `'category'` to the header row and each data row:

```ts
  lines.push(
    csvRow([
      'id',
      'task',
      'completedAt',
      'plannedFocusMs',
      'actualFocusMs',
      'flowMs',
      'breakMs',
      'breakIntermissionMs',
      'touchGrassMs',
      'totalElapsedMs',
      'parkedThoughtCount',
      'parkedThoughts',
      'noteContent',
      'project',
      'category',
    ]),
  );
  for (const session of data.sessions) {
    lines.push(
      csvRow([
        session.id,
        session.task,
        formatDateTime(session.completedAt),
        session.plannedFocusMs,
        session.actualFocusMs,
        session.flowMs,
        session.breakMs,
        session.breakIntermissionMs ?? 0,
        session.touchGrassMs ?? 0,
        session.totalElapsedMs,
        session.parkedThoughtCount,
        session.parkedThoughts.join('; '),
        session.noteContent ?? '',
        session.projectName ?? '',
        session.categoryLabel ?? '',
      ]),
    );
  }
```

- [ ] **Step 3: Update `formatExportAsMarkdown`**

Add a project/category line after the existing `Completed:` line:

```ts
      lines.push(`- Completed: ${formatDateTime(session.completedAt)}`);
      lines.push(`- Project: ${session.projectName ? `${session.projectName} (${session.categoryLabel})` : '—'}`);
```

- [ ] **Step 4: Update `export.test.ts`**

Run: `npx vitest run src/lib/export.test.ts`

Update any fixture that constructs a `SessionExportEntry` literal to add `projectName: null, categoryLabel: null` (or real values for a new test case), and update any snapshot/exact-string assertions on the CSV header row or Markdown output to account for the two new fields. Add one new test case: a session with a tagged project produces the expected `project`/`category` CSV columns and the expected `- Project: Name (Category)` Markdown line; a session with no project produces blank CSV columns and `- Project: —`.

- [ ] **Step 5: Pass `projects` from `App.svelte`'s export calls**

In `History.svelte`'s `exportMarkdown`/`exportCsv` functions (both already call `buildExportData(summaries, parkedThoughts, Date.now())`), add the `projects` prop already available in scope: `buildExportData(summaries, parkedThoughts, Date.now(), projects)`.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/export.ts src/lib/export.test.ts src/lib/History.svelte
git commit -m "feat: include project and category in CSV/Markdown export"
```

---

### Task 12: Documentation follow-up

**Files:**
- Modify: `README.md`
- Modify: `docs/product-direction.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (final task).

- [ ] **Step 1: Update `README.md`**

Find the paragraph (around line 12-13 per the design spec's citation):

```
window you leave open. It is not a task manager or a project planner —
there's no backlog or multi-project view, on purpose. Use History and
```

Replace with:

```
window you leave open. It is not a task manager — there's no backlog or
Kanban view. Sessions can optionally be tagged with a Project (grouped
under Personal, Work, or Study) purely for time tracking: see them and
their totals from the Projects view, or a category/project breakdown
graph in History. Tagging is entirely optional and never required to
start or run a session. Use History and
```

(Adjust surrounding punctuation/line-wrap to fit the paragraph's existing style — this is prose, not code, so match voice over exact line breaks.)

- [ ] **Step 2: Update `docs/product-direction.md`**

Find the "Explicit early boundaries" list (`Do not include early:`) and remove `Projects` from it, adding a note directly below the list:

```
Projects (grouping sessions under Personal/Work/Study for time tracking)
shipped as an optional, decoupled feature — see
docs/superpowers/specs/2026-08-14-projects-categories-time-tracking-design.md.
Due dates, priorities, and subtasks remain excluded pending the Phase 2
task-planning spec.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/product-direction.md
git commit -m "docs: reflect Projects/Categories in README and product-direction"
```

---

## Self-Review Notes

- **Spec coverage:** data model → Task 1-2; session tagging (start + reassignment) → Tasks 4-6; Projects rail destination (list + detail) → Task 7; breakdown graph (grouping, time range, chart types, persistence) → Tasks 8-10; export → Task 11; documentation → Task 12. All spec sections have a task.
- **Placeholder scan:** no TBD/TODO steps. Task 5 Step 1 and Task 7 Step 4 ask the implementer to `grep` for an exact current line/variable name before editing rather than trusting a possibly-stale line number from earlier exploration — this is a verification step with a concrete command, not a vague "find the right place."
- **Type/interface consistency:** `Project`/`ProjectCategory`/`ProjectRow`/`toProject`/`serializeProject`/`CATEGORY_LABELS`/`PROJECT_CATEGORIES`/`isSelectable` (Task 2) are used with identical names and signatures across Tasks 3-11. `SessionSummary.projectId` (introduced in Task 6, not Task 8, per Task 6's explicit ordering note — Task 8 only *consumes* it) is used consistently by Tasks 7-11. `updateSessionProject`/`insertProject`/`renameProject`/`setProjectArchived`/`loadAllProjects` (Task 3) match their Task 5-7 call sites.
- **Known ordering wrinkle, resolved explicitly:** Task 6 originally would have depended on Task 8 for `SessionSummary.projectId`, but Task 6 Step 1 adds that one field itself and Task 8 simply consumes it — no forward dependency remains. Flagging this here in case a fresh implementer reads Task 8 before Task 6 and wonders why `projectId` already exists.
