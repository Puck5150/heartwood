# Greenhouse Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Greenhouse a real standalone view — reachable from anywhere via the nav rail, with planting (session or not), removing, and per-thought plain-text notes.

**Architecture:** Adds `'greenhouse'` as a 4th `WorkspaceView`. `ParkedThought.sessionId` becomes optional (undefined = planted while idle) and gains an optional `note` field. A new `Greenhouse.svelte` component is the unified management view; the existing `IdleParkedThoughts.svelte`/`ParkingLot.svelte` fragments are untouched. The SQLite `parked_thoughts` table needs its first-ever recreate-table migration, since SQLite can't drop a column's `NOT NULL` via `ALTER TABLE`.

**Tech Stack:** Svelte 5 runes, TypeScript, Tauri 2 + `tauri-plugin-sql` (sqlx/SQLite), Vitest, Rust `sqlx` migration tests.

## Global Constraints

- `IdleParkedThoughts.svelte` and `ParkingLot.svelte` are explicitly unchanged — no new props, no new UI added to either.
- Greenhouse's plant-input is never session-gated — only disabled while `!thoughtsRecovered`, exactly matching `ParkingLot.svelte`'s existing `disabled={!thoughtsRecovered}` convention in `App.svelte`.
- Delete uses the exact inline confirm-before-delete pattern already in `History.svelte` (`.row-confirm`/`.row-confirm-text`/`.link`/`.link.danger` CSS classes and Cancel/Confirm button structure) — not a new confirm UI.
- Note autosave uses the same 600ms debounce App.svelte already defines as `NOTE_AUTOSAVE_DEBOUNCE_MS` for session notes.
- The Greenhouse nav item is always visible (like Focus/History), never conditional (unlike Revisions).
- Persistence failures for parked-thought mutations are caught and logged via `console.error`, never surfaced as a blocking error — matches `handlePark`/`handleDeleteThought`'s existing trust model exactly; do not introduce save-coordinator-style machinery for this.

---

## File Structure

- `src/lib/parkingLot.ts` — modify: `ParkedThought.sessionId` becomes optional, add `note?: string`; `addParkedThought`'s `sessionId` param becomes optional; new `setParkedThoughtNote`.
- `src/lib/parkingLot.test.ts` — modify: cover the above.
- `src-tauri/src/migrations.rs` — modify: migration 8 (recreate-table).
- `src/lib/persistence.ts` — modify: `ParkedThoughtRow`, `serializeParkedThought`, `deserializeParkedThoughtRow` handle nullable `session_id`/`note`.
- `src/lib/persistence.test.ts` — modify: round-trip coverage for the nullable fields.
- `src/lib/tauriRepository.ts` — modify: `insertParkedThought` passes `null` for absent `session_id`; new `updateParkedThoughtNote`.
- `src/lib/memoryRepository.ts` — modify: same `updateParkedThoughtNote` addition, in-memory.
- `src/lib/workspace.ts` — modify: `WorkspaceView` gains `'greenhouse'`.
- `src/lib/WorkspaceNav.svelte` — modify: new always-visible nav item.
- `src/lib/Greenhouse.svelte` — new: the unified view.
- `src/App.svelte` — modify: `handlePlantFromGreenhouse`, `handleUpdateThoughtNote`, `WORKSPACE_LABELS['greenhouse']`, render branch for `workspaceView === 'greenhouse'`.
- `src/App.test.ts` — modify: nav reachability + wiring coverage.

---

### Task 1: Data model — `parkingLot.ts`

**Files:**
- Modify: `src/lib/parkingLot.ts`
- Test: `src/lib/parkingLot.test.ts`

**Interfaces:**
- Produces: `ParkedThought { id: string; text: string; createdAt: number; sessionId?: string; note?: string }`; `addParkedThought(thoughts: ParkedThought[], id: string, text: string, now: number, sessionId?: string): ParkedThought[]`; `setParkedThoughtNote(thoughts: ParkedThought[], id: string, note: string): ParkedThought[]`. `removeParkedThought` and `splitBySession` keep their current signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/parkingLot.test.ts`, inside the existing `describe('parking lot', ...)` block:

```typescript
  it('allows planting a thought with no owning session', () => {
    const thoughts = addParkedThought([], 't1', 'Idle-planted thought', 1_000);
    expect(thoughts).toEqual([
      { id: 't1', text: 'Idle-planted thought', createdAt: 1_000, sessionId: undefined },
    ]);
  });

  it('treats a sessionless thought as carried-forward for any session under review', () => {
    let thoughts = addParkedThought([], 't1', 'Idle-planted thought', 1_000);
    thoughts = addParkedThought(thoughts, 't2', 'From this session', 2_000, 'session-1');

    const split = splitBySession(thoughts, 'session-1');
    expect(split.current.map((t) => t.id)).toEqual(['t2']);
    expect(split.carriedForward.map((t) => t.id)).toEqual(['t1']);
  });

  it('sets a thought note without touching other thoughts', () => {
    let thoughts = addParkedThought([], 't1', 'First', 1_000, 'session-1');
    thoughts = addParkedThought(thoughts, 't2', 'Second', 2_000, 'session-1');

    thoughts = setParkedThoughtNote(thoughts, 't1', 'Remember the context');
    expect(thoughts.find((t) => t.id === 't1')?.note).toBe('Remember the context');
    expect(thoughts.find((t) => t.id === 't2')?.note).toBeUndefined();
  });

  it('overwrites an existing note rather than appending', () => {
    let thoughts = addParkedThought([], 't1', 'First', 1_000, 'session-1');
    thoughts = setParkedThoughtNote(thoughts, 't1', 'First note');
    thoughts = setParkedThoughtNote(thoughts, 't1', 'Replaced note');
    expect(thoughts.find((t) => t.id === 't1')?.note).toBe('Replaced note');
  });
```

Update the import line at the top of the file to include the new function:

```typescript
import { addParkedThought, removeParkedThought, setParkedThoughtNote, splitBySession } from './parkingLot';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/parkingLot.test.ts`
Expected: FAIL — `setParkedThoughtNote` isn't exported yet; the sessionless-planting test fails TypeScript compilation (`addParkedThought` still requires a 5th argument).

- [ ] **Step 3: Implement**

In `src/lib/parkingLot.ts`, change the interface and `addParkedThought`:

```typescript
export interface ParkedThought {
  id: string;
  text: string;
  createdAt: number;
  /** Undefined when planted with no active session (e.g. from the
   * Greenhouse view while idle) — not every parked thought is "from" a
   * session. */
  sessionId?: string;
  note?: string;
}

export function addParkedThought(
  thoughts: ParkedThought[],
  id: string,
  text: string,
  now: number,
  sessionId?: string,
): ParkedThought[] {
  const trimmed = text.trim();
  if (!trimmed) return thoughts;
  return [...thoughts, { id, text: trimmed, createdAt: now, sessionId }];
}
```

Add after `removeParkedThought`:

```typescript
export function setParkedThoughtNote(thoughts: ParkedThought[], id: string, note: string): ParkedThought[] {
  return thoughts.map((thought) => (thought.id === id ? { ...thought, note } : thought));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/parkingLot.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parkingLot.ts src/lib/parkingLot.test.ts
git commit -m "feat: allow sessionless parked thoughts and per-thought notes"
```

---

### Task 2: SQLite migration 8

**Files:**
- Modify: `src-tauri/src/migrations.rs`

**Interfaces:**
- Consumes: nothing from Task 1 (Rust-side, independent).
- Produces: `parked_thoughts` table with `session_id` nullable and a new nullable `note TEXT` column, for Task 4's Rust-facing SQL to rely on.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/migrations.rs`, after `version_four_creates_the_expected_table_and_index`:

```rust
    #[tokio::test]
    async fn version_eight_drops_session_id_not_null_and_adds_note() {
        let pool = migrated_pool().await;

        let columns: Vec<(String, i64)> =
            sqlx::query_as("SELECT name, \"notnull\" FROM pragma_table_info('parked_thoughts')")
                .fetch_all(&pool)
                .await
                .unwrap();

        let session_id = columns.iter().find(|(name, _)| name == "session_id").unwrap();
        assert_eq!(session_id.1, 0, "session_id must no longer be NOT NULL");

        assert!(columns.iter().any(|(name, _)| name == "note"), "note column must exist");

        let indexes: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_index_list('parked_thoughts')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(
            indexes.iter().any(|name| name.contains("session_id") || name == "idx_parked_thoughts_session_id"),
            "the session_id index must survive the table recreate: {indexes:?}",
        );
    }

    #[tokio::test]
    async fn version_eight_preserves_existing_rows() {
        let pool = migrated_pool().await;
        sqlx::query(
            "INSERT INTO parked_thoughts (id, session_id, text, created_at) VALUES ('t1', 'session-1', 'Old thought', 1000)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let (text,): (String,) = sqlx::query_as("SELECT text FROM parked_thoughts WHERE id = 't1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(text, "Old thought");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test version_eight`
Expected: FAIL — `note` column doesn't exist yet, `session_id` is still `NOT NULL`.

- [ ] **Step 3: Add the migration**

In `src-tauri/src/migrations.rs`, version 7's block currently ends the `vec![...]` exactly like this:

```rust
            ALTER TABLE sessions ADD COLUMN intermission_return_status TEXT;
            ALTER TABLE sessions ADD COLUMN break_intermission_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE sessions ADD COLUMN touch_grass_ms INTEGER NOT NULL DEFAULT 0;
        "#,
        kind: MigrationKind::Up,
    }]
}
```

Replace that closing `    }]` with `    }, Migration {` followed by the new migration, so the end of the function reads:

```rust
            ALTER TABLE sessions ADD COLUMN intermission_return_status TEXT;
            ALTER TABLE sessions ADD COLUMN break_intermission_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE sessions ADD COLUMN touch_grass_ms INTEGER NOT NULL DEFAULT 0;
        "#,
        kind: MigrationKind::Up,
    }, Migration {
        version: 8,
        description: "allow sessionless parked thoughts and per-thought notes",
        sql: r#"
            CREATE TABLE parked_thoughts_new (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                note TEXT
            );
            INSERT INTO parked_thoughts_new (id, session_id, text, created_at)
                SELECT id, session_id, text, created_at FROM parked_thoughts;
            DROP TABLE parked_thoughts;
            ALTER TABLE parked_thoughts_new RENAME TO parked_thoughts;
            CREATE INDEX idx_parked_thoughts_session_id ON parked_thoughts(session_id);
        "#,
        kind: MigrationKind::Up,
    }]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test version_eight`
Expected: PASS, both new tests.

Run: `cd src-tauri && cargo test`
Expected: all 149 tests pass (147 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/migrations.rs
git commit -m "feat: migration 8 — nullable parked_thoughts.session_id, add note column"
```

---

### Task 3: `persistence.ts` — nullable row mapping

**Files:**
- Modify: `src/lib/persistence.ts`
- Test: `src/lib/persistence.test.ts`

**Interfaces:**
- Consumes: `ParkedThought` from Task 1 (`sessionId?: string`, `note?: string`).
- Produces: `ParkedThoughtRow { id: string; session_id: string | null; text: string; created_at: number; note: string | null }`; `serializeParkedThought(thought: ParkedThought): ParkedThoughtRow`; `deserializeParkedThoughtRow(row: ParkedThoughtRow): ParkedThought` — both round-trip `undefined` (frontend) through `null` (SQL) correctly.

- [ ] **Step 1: Write the failing tests**

In `src/lib/persistence.test.ts`, replace the existing `describe('parked thought row round trip', ...)` block with:

```typescript
describe('parked thought row round trip', () => {
  it('round-trips id/sessionId/text/createdAt through snake_case columns', () => {
    const thought = { id: 't1', sessionId: SID, text: 'Check the deploy', createdAt: T0 };
    const row = serializeParkedThought(thought);
    expect(row).toEqual({ id: 't1', session_id: SID, text: 'Check the deploy', created_at: T0, note: null });
    expect(deserializeParkedThoughtRow(row)).toEqual({ ...thought, sessionId: SID, note: undefined });
  });

  it('round-trips a sessionless thought as a null session_id column', () => {
    const thought = { id: 't1', text: 'Idle-planted', createdAt: T0 };
    const row = serializeParkedThought(thought);
    expect(row.session_id).toBeNull();
    expect(deserializeParkedThoughtRow(row).sessionId).toBeUndefined();
  });

  it('round-trips a note through the note column', () => {
    const thought = { id: 't1', sessionId: SID, text: 'Check the deploy', createdAt: T0, note: 'Remember this' };
    const row = serializeParkedThought(thought);
    expect(row.note).toBe('Remember this');
    expect(deserializeParkedThoughtRow(row).note).toBe('Remember this');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/persistence.test.ts`
Expected: FAIL — `row.note` is `undefined` (property doesn't exist), `session_id` isn't nulled for a sessionless thought.

- [ ] **Step 3: Implement**

In `src/lib/persistence.ts`, replace `ParkedThoughtRow`, `serializeParkedThought`, and `deserializeParkedThoughtRow`:

```typescript
export interface ParkedThoughtRow {
  id: string;
  session_id: string | null;
  text: string;
  created_at: number;
  note: string | null;
}

export function serializeParkedThought(thought: ParkedThought): ParkedThoughtRow {
  return {
    id: thought.id,
    session_id: thought.sessionId ?? null,
    text: thought.text,
    created_at: thought.createdAt,
    note: thought.note ?? null,
  };
}

export function deserializeParkedThoughtRow(row: ParkedThoughtRow): ParkedThought {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    text: row.text,
    createdAt: row.created_at,
    note: row.note ?? undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/persistence.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/persistence.ts src/lib/persistence.test.ts
git commit -m "feat: serialize/deserialize nullable parked-thought session_id and note"
```

---

### Task 4: Repository layer — `tauriRepository.ts` and `memoryRepository.ts`

**Files:**
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/memoryRepository.ts`

**Interfaces:**
- Consumes: `ParkedThoughtRow`/`serializeParkedThought` from Task 3.
- Produces: `updateParkedThoughtNote(id: string, note: string): Promise<void>` in both repositories, for Task 7's `App.svelte` wiring to call. `insertParkedThought`'s existing signature (`(thought: ParkedThought) => Promise<void>`) is unchanged — only its internal handling of an absent `sessionId` changes.

- [ ] **Step 1: Implement `tauriRepository.ts`**

`insertParkedThought` already calls `serializeParkedThought(thought)` and binds `row.session_id` — since Task 3 already makes `serializeParkedThought` emit `null` for an absent `sessionId`, and `db.execute`'s parameter binding already accepts `null` as a bind value (same as every other nullable column already written this way elsewhere in this file, e.g. `focus_deadline_at`), **no change is needed to `insertParkedThought` itself** — verify this by reading its current body before assuming otherwise.

Add a new function immediately after `deleteParkedThoughtRow`:

```typescript
export async function updateParkedThoughtNote(id: string, note: string): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE parked_thoughts SET note = $1 WHERE id = $2', [note, id]);
}
```

- [ ] **Step 2: Implement `memoryRepository.ts`**

Add immediately after `deleteParkedThoughtRow`:

```typescript
export async function updateParkedThoughtNote(id: string, note: string): Promise<void> {
  parkedThoughts = parkedThoughts.map((thought) => (thought.id === id ? { ...thought, note } : thought));
}
```

- [ ] **Step 3: Verify both files type-check and existing tests still pass**

Run: `npm run check`
Expected: `0 ERRORS 0 WARNINGS`.

Run: `npx vitest run src/lib/persistence.test.ts src/lib/parkingLot.test.ts`
Expected: PASS (no regressions from Task 1/3's signature changes propagating here).

- [ ] **Step 4: Commit**

```bash
git add src/lib/tauriRepository.ts src/lib/memoryRepository.ts
git commit -m "feat: add updateParkedThoughtNote to both repositories"
```

---

### Task 5: Nav — `workspace.ts` and `WorkspaceNav.svelte`

**Files:**
- Modify: `src/lib/workspace.ts`
- Modify: `src/lib/WorkspaceNav.svelte`

**Interfaces:**
- Produces: `WorkspaceView = 'focus' | 'history' | 'revisions' | 'greenhouse'`, consumed by Task 7's `App.svelte`.

- [ ] **Step 1: Add the new view to the type**

In `src/lib/workspace.ts`, change:

```typescript
export type WorkspaceView = 'focus' | 'history' | 'revisions' | 'greenhouse';
```

- [ ] **Step 2: Add the nav item**

In `src/lib/WorkspaceNav.svelte`, add the import alongside the existing icon imports:

```svelte
import Sprout from 'lucide-svelte/icons/sprout';
```

Add a new always-visible button immediately after the History button (before the `{#if showRevisions}` block), matching the Focus/History buttons' exact structure:

```svelte
  <button
    type="button"
    class="nav-item"
    aria-current={current === 'greenhouse' ? 'page' : undefined}
    title="Greenhouse"
    onclick={() => onNavigate('greenhouse')}
  >
    <Sprout size={20} aria-hidden="true" />
    <span class="nav-label">Greenhouse</span>
  </button>
```

- [ ] **Step 3: Verify it type-checks**

Run: `npm run check`
Expected: `0 ERRORS 0 WARNINGS`. (This will surface any place `WorkspaceView`'s new member breaks an exhaustive `Record<WorkspaceView, ...>` or switch — note that for Task 7, since `App.svelte`'s `WORKSPACE_LABELS: Record<WorkspaceView, string>` will now fail to type-check until that task adds the `greenhouse` entry. If `npm run check` fails here specifically because of `WORKSPACE_LABELS`, that failure is expected and resolved by Task 7 — do not "fix" it by weakening the `Record` type.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/workspace.ts src/lib/WorkspaceNav.svelte
git commit -m "feat: add Greenhouse as an always-visible workspace nav item"
```

---

### Task 6: `Greenhouse.svelte`

**Files:**
- Create: `src/lib/Greenhouse.svelte`

**Interfaces:**
- Consumes: `ParkedThought` (Task 1), `NOTE_AUTOSAVE_DEBOUNCE_MS` value (600, inlined — this component doesn't import App.svelte's constant, it just uses the same literal debounce duration for its own local `setTimeout`, matching the value, not sharing the binding).
- Produces: `<Greenhouse thoughts disabled onPlant onStart onDelete onUpdateNote />`, consumed by Task 7's `App.svelte`.
  - `thoughts: ParkedThought[]`
  - `disabled: boolean` (mirrors `!thoughtsRecovered`, same as `ParkingLot`'s prop)
  - `onPlant: (text: string) => void`
  - `onStart: (id: string) => void`
  - `onDelete: (id: string) => void`
  - `onUpdateNote: (id: string, note: string) => void`

- [ ] **Step 1: Implement the component**

Create `src/lib/Greenhouse.svelte`:

```svelte
<script lang="ts">
  import type { ParkedThought } from './parkingLot';

  const NOTE_AUTOSAVE_DEBOUNCE_MS = 600;

  let {
    thoughts,
    disabled = false,
    onPlant,
    onStart,
    onDelete,
    onUpdateNote,
  }: {
    thoughts: ParkedThought[];
    disabled?: boolean;
    onPlant: (text: string) => void;
    onStart: (id: string) => void;
    onDelete: (id: string) => void;
    onUpdateNote: (id: string, note: string) => void;
  } = $props();

  let draft = $state('');
  let confirmingDeleteId = $state<string | null>(null);
  let expandedNoteId = $state<string | null>(null);
  let noteTimeout: ReturnType<typeof setTimeout> | null = null;

  function submit(event: Event) {
    event.preventDefault();
    if (disabled || !draft.trim()) return;
    onPlant(draft);
    draft = '';
  }

  function toggleNote(id: string) {
    expandedNoteId = expandedNoteId === id ? null : id;
  }

  function scheduleNoteUpdate(id: string, note: string) {
    if (noteTimeout) clearTimeout(noteTimeout);
    noteTimeout = setTimeout(() => {
      noteTimeout = null;
      onUpdateNote(id, note);
    }, NOTE_AUTOSAVE_DEBOUNCE_MS);
  }

  function handleNoteInput(id: string, event: Event) {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    scheduleNoteUpdate(id, value);
  }
</script>

<section class="greenhouse" aria-labelledby="greenhouse-heading">
  <h1 id="greenhouse-heading">Greenhouse</h1>

  <form onsubmit={submit}>
    <input
      type="text"
      placeholder="Plant a thought…"
      bind:value={draft}
      aria-label="Plant a thought"
      {disabled}
    />
    <button type="submit" disabled={disabled || !draft.trim()}>Plant</button>
  </form>

  {#if thoughts.length === 0}
    <p class="empty">Nothing planted yet.</p>
  {:else}
    <ul>
      {#each thoughts as thought (thought.id)}
        <li>
          <div class="row-top">
            <span class="text">{thought.text}</span>
            {#if confirmingDeleteId === thought.id}
              <div class="row-confirm">
                <span class="row-confirm-text">Delete this thought?</span>
                <button class="link" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
                <button
                  class="link danger"
                  onclick={() => {
                    onDelete(thought.id);
                    confirmingDeleteId = null;
                  }}
                >
                  Confirm
                </button>
              </div>
            {:else}
              <div class="row-actions">
                <button type="button" class="link" onclick={() => toggleNote(thought.id)}>
                  {thought.note ? 'Edit note' : 'Add note'}
                </button>
                <button
                  type="button"
                  aria-label={`Start focus: ${thought.text}`}
                  {disabled}
                  onclick={() => onStart(thought.id)}
                >
                  Start
                </button>
                <button class="link danger" onclick={() => (confirmingDeleteId = thought.id)}>
                  Delete
                </button>
              </div>
            {/if}
          </div>
          {#if expandedNoteId === thought.id}
            <textarea
              class="note"
              placeholder="Jot a note about this thought…"
              value={thought.note ?? ''}
              oninput={(event) => handleNoteInput(thought.id, event)}
            ></textarea>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .greenhouse {
    width: min(100%, 40rem);
    margin: 0 auto;
    padding: 1.5rem 1rem;
  }

  h1 {
    margin: 0 0 1rem;
    font-size: 1.3rem;
    color: var(--text);
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }

  input {
    flex: 1;
    padding: 0.6rem 0.85rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.95rem;
  }

  input:focus {
    outline: 2px solid var(--timer-accent);
    outline-offset: 1px;
  }

  form button {
    padding: 0.6rem 1rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-weight: 600;
    cursor: pointer;
  }

  form button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  li {
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .text {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text);
    font-size: 0.95rem;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }

  .row-actions button:not(.link) {
    min-height: 44px;
    padding: 0.5rem 0.8rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--timer-accent);
    color: var(--on-timer-accent);
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
  }

  .row-actions button:disabled {
    cursor: default;
    opacity: 0.5;
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

  .row-confirm {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .row-confirm-text {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .note {
    width: 100%;
    margin-top: 0.6rem;
    padding: 0.5rem 0.65rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
    resize: vertical;
    min-height: 3.5rem;
  }

  .note:focus {
    outline: 2px solid var(--timer-accent);
    outline-offset: 1px;
  }
</style>
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run check`
Expected: no new errors attributable to this file (unrelated `WORKSPACE_LABELS` failure from Task 5 may still be present until Task 7 — that's expected).

- [ ] **Step 3: Commit**

```bash
git add src/lib/Greenhouse.svelte
git commit -m "feat: add Greenhouse.svelte unified parked-thought view"
```

---

### Task 7: Wire into `App.svelte`

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**
- Consumes: `setParkedThoughtNote` (Task 1), `updateParkedThoughtNote` (Task 4), `Greenhouse` (Task 6), `'greenhouse'` as a `WorkspaceView` member (Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `src/App.test.ts`. First, read the existing top-of-file mocking setup (how `render(App)` is invoked, what `loadAllParkedThoughts`/`loadLatestSessionRow` mocks already exist, and the exact accessible names already used for the idle screen's task input and Start button — these are established elsewhere in this file, e.g. from the Task 7 auto-updater work) and match those exactly rather than guessing new selector strings.

```typescript
describe('Greenhouse workspace', () => {
  it('is reachable from the idle screen and shows sessionless-planted thoughts', async () => {
    render(App);
    await screen.findByRole('button', { name: /start focusing/i });

    await fireEvent.click(screen.getByRole('button', { name: 'Greenhouse' }));
    await screen.findByRole('heading', { name: 'Greenhouse' });

    await fireEvent.input(screen.getByLabelText('Plant a thought'), {
      target: { value: 'A thought with no session' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Plant' }));

    await screen.findByText('A thought with no session');
  });

  it('lets a planted thought be started into a new focus session', async () => {
    render(App);
    await screen.findByRole('button', { name: /start focusing/i });
    await fireEvent.click(screen.getByRole('button', { name: 'Greenhouse' }));
    await screen.findByRole('heading', { name: 'Greenhouse' });

    await fireEvent.input(screen.getByLabelText('Plant a thought'), {
      target: { value: 'Start me' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Plant' }));
    await screen.findByText('Start me');

    await fireEvent.click(screen.getByRole('button', { name: 'Start focus: Start me' }));
    await screen.findByText('Start me', { selector: 'h1' });
  });

  it('deletes a thought only after confirming', async () => {
    render(App);
    await screen.findByRole('button', { name: /start focusing/i });
    await fireEvent.click(screen.getByRole('button', { name: 'Greenhouse' }));
    await screen.findByRole('heading', { name: 'Greenhouse' });

    await fireEvent.input(screen.getByLabelText('Plant a thought'), {
      target: { value: 'Delete me' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Plant' }));
    await screen.findByText('Delete me');

    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete me')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByText('Delete me')).toBeNull());
  });
});
```

(These tests may need selector adjustment once you've read the file's real conventions per the instruction above — the behaviors under test are the fixed requirement, not the exact selector strings shown here.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/App.test.ts -t "Greenhouse workspace"`
Expected: FAIL — no Greenhouse nav item rendered, no `handlePlantFromGreenhouse` wiring yet.

- [ ] **Step 3: Wire `App.svelte`**

Add the import alongside the existing `ParkingLot`/`IdleParkedThoughts` imports:

```typescript
import Greenhouse from './lib/Greenhouse.svelte';
```

Add `updateParkedThoughtNote` to the existing repository import (alongside wherever `insertParkedThought`/`deleteParkedThoughtRow` are already imported — match that same import statement).

Add `setParkedThoughtNote` to the existing `parkingLot` import (alongside `addParkedThought`/`removeParkedThought`/`splitBySession`).

Update `WORKSPACE_LABELS`:

```typescript
  const WORKSPACE_LABELS: Record<WorkspaceView, string> = {
    focus: 'Focus',
    history: 'History',
    revisions: 'Revisions',
    greenhouse: 'Greenhouse',
  };
```

Add two new handlers near the existing `handlePark`/`handleDeleteThought` (after `handleDeleteThought`):

```typescript
  /** Unlike handlePark, never gated on an active session — planting from
   * the Greenhouse view works whether or not a session is running. A
   * thought planted while idle gets no sessionId at all (see
   * ParkedThought's own doc for why that's meaningful, not just absent
   * data). */
  function handlePlantFromGreenhouse(text: string) {
    if (!thoughtsRecovered) return; // defense in depth — Greenhouse's own disabled prop is the primary guard
    const sessionId = session.status === 'idle' ? undefined : session.sessionId;
    const next = addParkedThought(parkedThoughts, crypto.randomUUID(), text, Date.now(), sessionId);
    if (next === parkedThoughts) return; // blank/whitespace text; addParkedThought no-opped
    parkedThoughts = next;
    const added = next[next.length - 1];
    writeQueue.enqueue(() => insertParkedThought(added)).catch((err) => {
      console.error('Failed to persist parked thought:', err);
    });
  }

  function handleUpdateThoughtNote(id: string, note: string) {
    if (!thoughtsRecovered) return; // defense in depth — the pool isn't safely known yet
    parkedThoughts = setParkedThoughtNote(parkedThoughts, id, note);
    writeQueue.enqueue(() => updateParkedThoughtNote(id, note)).catch((err) => {
      console.error('Failed to persist parked thought note:', err);
    });
  }
```

Add the render branch. Find the existing `{#if workspaceView === 'history'}` ... `{:else if workspaceView === 'revisions' && revisionsSessionId}` ... `{:else if workspaceView === 'focus'}` chain and add a new branch immediately after the `history` branch:

```svelte
    {:else if workspaceView === 'greenhouse'}
      <Greenhouse
        thoughts={parkedThoughts}
        disabled={!thoughtsRecovered}
        onPlant={handlePlantFromGreenhouse}
        onStart={handleStartParkedThought}
        onDelete={handleDeleteThought}
        onUpdateNote={handleUpdateThoughtNote}
      />
```

(Insert this as a new `{:else if}` branch in the existing chain — do not duplicate the `{#if workspaceView === 'history'}` opening or restructure the chain beyond adding this one branch.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/App.test.ts -t "Greenhouse workspace"`
Expected: PASS.

Run: `npx vitest run src/App.test.ts`
Expected: all tests in the file pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte src/App.test.ts
git commit -m "feat: wire Greenhouse into App.svelte"
```

---

### Task 8: Final validation

**Files:** none (verification only).

- [ ] **Step 1: Type-check**

Run: `npm run check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 2: Full JS/TS test suite**

Run: `npm test -- --run`
Expected: all tests pass, including every test added in Tasks 1, 3, 7.

- [ ] **Step 3: Rust check and tests**

Run: `cd src-tauri && cargo check && cargo test`
Expected: both succeed, including the 2 new migration tests from Task 2.

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: succeeds, matching this repo's standard pre-release validation.

- [ ] **Step 5: Manual smoke check (documented, not automated)**

Since this touches a real SQLite migration and a new primary nav destination, do one manual pass in the actual Tauri app (`npm run tauri dev`) before considering this done:
1. Launch with an existing (pre-migration-8) local database if one exists, confirm it opens without error and old parked thoughts are still visible.
2. From the idle screen, navigate to Greenhouse, plant a thought with no session active, confirm it appears and persists across an app restart.
3. Start a focus session, plant a thought from the in-session `ParkingLot` panel, then navigate to Greenhouse and confirm that same thought appears there too (proving both entry points write to the same pool).
4. Add a note to a thought in Greenhouse, navigate away and back, confirm the note persisted.
5. Delete a thought via Greenhouse's confirm flow, confirm it's actually gone (both in the UI and after a restart).

- [ ] **Step 6: Commit if any of the above required fixes**

If any step above needed a fix, stage exactly the files that changed and commit:

```bash
git add -A
git commit -m "fix: address full-validation findings from the greenhouse expansion"
```

If nothing needed fixing, skip this step — there is nothing to commit.
