# Projects, Categories, and Time-Tracking Breakdown — Design Spec (Phase 1 of 2)

Date: 2026-08-14

## Product framing (read this first)

`docs/product-direction.md`'s "Explicit early boundaries" section lists
"Projects," "Due dates," "Priorities," and "Subtasks" as things not to
include early. `README.md` similarly states Heartwood "is not a task
manager or a project planner — there's no backlog or multi-project view,
on purpose."

The product owner has decided to cross that boundary deliberately, now
that the app is past MVP (alpha v0.1.0-alpha.8, with revisions,
intermissions, and Touch Grass already shipped), and wants real project
planning — task list, due dates, priority/ordering, and status per
project — standing beside the existing focus-session core loop:

> "I would like for this app to be a productivity tool to be used at the
> user's discretion. I would like to allow users to group sessions and
> notes into a category if they want to track it. I would like the
> features to be untied from one another — easy to use, not forcing you
> into a specific path." … "I'd like all of them" [task list, due dates,
> priority/ordering, status/progress tracking].

**This is Phase 1 of 2, scoped deliberately narrower than that full
ask.** Task list, due dates, priority, and status are real IA decisions
(list vs. board, what "status" states look like, how a task becomes a
focus session) that deserve their own design pass rather than being
bolted onto this spec. This phase ships:

- the Projects/Categories data model,
- optional session→project tagging,
- a real **Projects rail destination** (list + per-project detail page)
  sized so Phase 2 can extend the detail page with a task list rather
  than relocating anything,
- the time-tracking breakdown graph.

Phase 2 (a separate spec, to follow) adds tasks, due dates, priority, and
status on top of the Project entity this phase creates. Every feature in
both phases stays **optional and decoupled**: a session with no project,
and a project with no tasks, both work exactly like today's app — nothing
here becomes a required step in the core focus-session loop.

**Documentation follow-up (part of this feature, not optional):**
`README.md`'s "not a project planner" line and
`docs/product-direction.md`'s "early boundaries" list both need a
one-line update once Phase 1 ships, so they stop contradicting the
shipped feature — and again after Phase 2, once the boundary is fully
crossed. Small, but tracked here so it isn't dropped.

## Goal

Let a user optionally tag a focus session with a **Project**, which itself
has exactly one **Category** (Personal, Work, or Study), managed from a
new **Projects** rail destination. History gains a way to see, filter, and
re-tag past sessions by project, plus a time-tracking breakdown chart
(bar, donut, or pie — user's choice, remembered) showing focus time by
category and, drilled in, by project.

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

## Managing projects (new Projects rail destination)

A new item in `WorkspaceNav.svelte`, alongside Focus/History/Greenhouse —
**Projects** (a plain folder icon from `lucide-svelte`, matching the
existing icon-plus-label pattern; not a Kanban-suggesting icon, since this
phase has no board). Placed after Greenhouse, before the conditional
Revisions item.

**List view** (the destination's default): every active project as a row
— name, category dot, count of sessions tagged with it, total tracked
focus time. Archived projects are hidden by default behind a "Show
archived" toggle at the bottom, same visibility rule as the session-start
picker. A **"+ New project"** action (name + category) sits above the
list, using the same inline create form as the session-start picker's
"+ New project" option — one component, two entry points.

**Detail view** (clicking a project row): the project's name/category
header, **Rename** and **Archive**/**Unarchive** actions, and — for this
phase — a read-only list of every session tagged with this project
(reusing the session-row layout from `History.svelte`, filtered to this
`project_id`), so the project's history is visible in one place without
needing a task list yet. Phase 2 extends this same page with a task list
above or beside that session history; the page's route/identity
(`project/:id`) doesn't change between phases.

No hard-delete action in this iteration — archive is the only removal
path, per the data-model section above. If a true hard-delete (with
reassignment or cascade-untagging of its sessions) turns out to be wanted
later, treat it as a separate, more carefully-scoped follow-up.

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

## Cross-cutting / out of scope (this phase)

Deferred to the Phase 2 spec, not abandoned:

- Per-project task list, due dates, priority/ordering, status/progress.
- Turning a task into a focus session (the Phase 2 equivalent of today's
  parked-thought promotion).

Out of scope for both phases, per the "optional, decoupled" framing:

- No required project selection anywhere — every flow that touches
  `project_id` must work identically with it left null.
- No hard delete of a project (archive only, both phases).
- No changes to the timer, greenhouse, notes, or revisions behavior.
- List vs. board layout for Phase 2's task list is undecided — that's a
  Phase 2 brainstorming question, not answered by this spec.

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

## Documentation follow-up

After this phase ships, update `README.md`'s "not a task manager or a
project planner" paragraph and `docs/product-direction.md`'s "Explicit
early boundaries" list to reflect that Projects/Categories now exist,
framed as the optional, decoupled tag described above. Leave the
"no backlog," "no due dates," "no priorities" language otherwise
intact — those get revisited in the Phase 2 spec, when they actually
change, not preemptively here.
