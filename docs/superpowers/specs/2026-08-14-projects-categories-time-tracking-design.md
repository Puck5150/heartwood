# Projects, Categories, and Time-Tracking Breakdown — Design Spec

Date: 2026-08-14

## Product framing (read this first)

`docs/product-direction.md`'s "Explicit early boundaries" section lists
"Projects" and "Labels" as things not to include early. `README.md`
similarly states Heartwood "is not a task manager or a project planner —
there's no backlog or multi-project view, on purpose."

This feature intentionally crosses that boundary, now that the app is past
MVP (alpha v0.1.0-alpha.8, with revisions, intermissions, and Touch Grass
already shipped). It does so narrowly, on the product owner's explicit
direction:

> "I would like for this app to be a productivity tool to be used at the
> user's discretion. I would like to allow users to group sessions and
> notes into a category if they want to track it. I would like the
> features to be untied from one another — easy to use, not forcing you
> into a specific path."

Concretely, this means Projects/Categories are an **optional tag on a
session**, not a project-planner rebuild: no backlog, no per-project task
list, no project dashboard, no required step in starting a session. A
session with no project behaves exactly as it does today. This spec and
its implementation plan must both preserve that — any addition that starts
to look like a backlog, a Kanban view, or a mandatory project-selection
step is out of scope and should be flagged, not built.

**Documentation follow-up (part of this feature, not optional):**
`README.md`'s "not a project planner" line and
`docs/product-direction.md`'s "early boundaries" list both need a
one-line update once this ships, so they stop contradicting the shipped
feature. Small, but tracked here so it isn't dropped.

## Goal

Let a user optionally tag a focus session with a **Project**, which itself
has exactly one **Category** (Personal, Work, or Study). History gains a
way to see, filter, and re-tag past sessions by project, plus a time-
tracking breakdown chart (bar, donut, or pie — user's choice, remembered)
showing focus time by category and, drilled in, by project.

## Data model

New migration (version 10, following the existing pattern in
`src-tauri/src/migrations.rs`):

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('personal', 'work', 'study')),
    archived_at INTEGER,
    created_at INTEGER NOT NULL
);

ALTER TABLE sessions ADD COLUMN project_id TEXT;
```

- No `FOREIGN KEY` constraint on `sessions.project_id` — this schema uses
  no FK constraints anywhere (see `parked_thoughts.session_id`); deletion
  and integrity are handled explicitly in the repository layer, same
  pattern as everywhere else.
- `project_id` is nullable. Untagged is the default and permanent option,
  not a migration artifact.
- **Projects are archived, never hard-deleted**, via `archived_at`. A
  project used by historical sessions can never be orphaned or vanish from
  past exports/the breakdown graph. Archived projects:
  - disappear from the "pick a project" list when starting a new session
    or re-tagging one,
  - still display their name/category on sessions already tagged with
    them,
  - still count in the breakdown graph for any time range that includes
    those sessions.
- Category is a fixed 3-value enum (`personal`, `work`, `study`), not
  user-extensible. It exists to give the breakdown graph a stable
  top-level grouping; Projects are the free-form layer under it.
- Renaming a project is pure metadata (`UPDATE projects SET name = ...`)
  and never touches `sessions` rows, since sessions reference `project_id`
  not a copied name — renames apply retroactively to history for free.

## Starting a session

The existing start form (task + duration, inline in `src/App.svelte`
around the `taskDraft`/`durationMinutes` bindings — not a separate
component today) gains one more optional field:

- **Project picker**, defaulting to **"No project"**. Ignoring it
  reproduces today's exact flow — zero added friction.
- The dropdown lists active (non-archived) projects, each shown with its
  category as a small colored dot (reuse the existing timer-accent color
  system's palette rather than inventing new colors).
- **"+ New project"** at the bottom of the list opens an inline
  create-a-project mini-form right there (name + category radio) — no
  navigation away from starting the session. The newly created project is
  immediately selected.
- The selection is carried onto the session row as `project_id` when the
  session saves. No other behavior — timer, greenhouse, notes — changes
  based on whether a project is set.

## Reassigning a project after the fact

In `History.svelte`'s session list, each row gets a small project tag
(name + category dot) next to the task name, adjacent to the existing
`when`/stat display. Clicking it opens the same picker/inline-create used
at session start, scoped to that one completed session
(`UPDATE sessions SET project_id = ...`). This is how sessions from before
this feature existed — and any session the user didn't tag at start-time —
get tagged.

## Managing projects (Settings)

A new "Projects" section inside the existing `SettingsDrawer.svelte` — not
a new workspace-rail destination, matching the "untied, no forced path"
principle by keeping this a lightweight, secondary surface.

Each row shows: name, category dot, count of sessions tagged with it, and
two actions:

- **Rename** — inline edit, metadata-only as described above.
- **Archive** / **Unarchive** — toggles `archived_at`.

No hard-delete action in this iteration — archive is the only removal
path, per the data-model section above. If a true hard-delete (with
reassignment or cascade-untagging of its sessions) turns out to be wanted
later, treat it as a separate, more carefully-scoped follow-up, not part
of this feature.

## Time-tracking breakdown graph

A second tab in `History.svelte`, alongside the existing session list —
labeled **"Breakdown"**.

- **Time range**: This week / This month / All time. Filters the same
  completed-session data `History.svelte` already loads; no new queries
  beyond what's already fetched for the session list.
- **Primary grouping**: total actual focus time (`actual_focus_ms`, same
  field the session list already shows as "Focus") by **Category**
  (Personal, Work, Study, and Untagged as a fourth segment for sessions
  with no project). Untagged is always shown, never hidden, so the totals
  visibly account for all time in range.
- **Drill-down**: selecting a category segment (click or legend toggle)
  switches the same chart to that category's Projects for the same time
  range, one level down. A "back to categories" control returns to the
  top level.
- **Chart type**: a small three-way icon toggle — **Bar**, **Donut**,
  **Pie** — all rendered from the same grouped-totals data, just laid out
  differently. Defaults to **Bar** on first run; the user's last choice is
  remembered via the existing `settings` table (`getSetting`/`setSetting`,
  same mechanism already used for theme/appearance/alarm-tone
  preferences) under a new key, e.g. `breakdown_chart_type`.
- **No new npm dependency.** Hand-roll a small SVG component for all three
  render modes, using the app's existing CSS custom properties for color
  (the theme's accent/surface tokens) rather than a new palette. This
  matches both the app's minimal-dependency footprint and the marketing
  site's own "restraint over polish" ethos.

## Export

`export.ts`'s CSV and Markdown builders gain two more fields per session:
**Project** and **Category**. Untagged sessions show blank (CSV) / an
em-dash or similar (Markdown) — never a fabricated "None" project row that
could be mistaken for a real one.

## Cross-cutting / out of scope

Explicitly **not** part of this feature (consistent with the "optional
tag, not a planner" framing):

- No per-project task list, backlog, or Kanban view.
- No project-level settings beyond name/category (no per-project color
  picker, icon, due date, etc., in this iteration).
- No required project selection anywhere — every flow that touches
  `project_id` must work identically with it left null.
- No hard delete of a project in this iteration (see above).
- No changes to the timer, greenhouse, notes, or revisions behavior.

## Testing approach

Following the codebase's existing patterns (see `migrations.rs`'s
`#[tokio::test]` migration tests, and the `.test.ts`/`.test.svelte`
pairing convention throughout `src/lib`):

- Rust: a migration test asserting `projects` exists with the right
  columns/CHECK constraint, and that `sessions.project_id` is nullable
  and defaults to `NULL` for a legacy-style insert (mirroring the existing
  `version_five_adds_a_nullable_focus_deadline_column`-style tests).
- TypeScript: pure-function tests for the category/project grouping logic
  (feeding it a fixed set of `SessionSummary`-like rows and asserting the
  grouped totals), matching `history.test.ts`'s existing style of testing
  derivation functions directly rather than through the UI.
- Svelte component tests for the new project picker (default "No
  project", inline create, selection carries through) and the Breakdown
  tab (chart-type toggle persists, time-range filter changes the totals,
  drill-down/back works), matching the existing `.test.svelte` harness
  pattern used by `History.svelte`'s neighbors.

## Out-of-scope documentation follow-up

Update `README.md`'s "not a task manager or a project planner" paragraph
and `docs/product-direction.md`'s "Explicit early boundaries" list to
reflect that Projects/Categories now exist, framed as the optional,
decoupled tag described above — not a reversal of the no-backlog,
no-Kanban stance, which still holds.
