# Greenhouse Expansion Design

**Status:** Approved design
**Date:** 2026-08-06

## Purpose

The Greenhouse (parked thoughts) currently has no dedicated view — thoughts
only appear as fragments embedded in whichever screen already shows them
(the idle front page via `IdleParkedThoughts.svelte`, or the in-session
`ParkingLot.svelte` panel). Planting a new thought requires an active focus
or flow session; there is no way to remove a thought except during a
session review, and no way to attach any note to one at all.

This expands the Greenhouse into a real, standalone feature: reachable from
anywhere in the app regardless of session state, with the ability to plant,
remove, and annotate thoughts independent of whether a session is running.

## Access Pattern

Greenhouse becomes a 4th `WorkspaceView` (`'focus' | 'history' | 'revisions'
| 'greenhouse'`), added as an always-visible nav-rail item next to Focus and
History — not conditionally shown like Revisions, since Greenhouse is meant
to be a primary, always-reachable destination. This matches the existing
`WorkspaceView` architecture exactly: History and Revisions are already
"independent of session/timer state" (per `App.svelte`'s own module doc),
and Greenhouse follows that same model rather than introducing a new
overlay/popover pattern.

## Data Model

`ParkedThought` (`src/lib/parkingLot.ts`) changes:

```ts
export interface ParkedThought {
  id: string;
  text: string;
  createdAt: number;
  sessionId?: string;   // was required; undefined = planted with no active session
  note?: string;        // new, plain text
}
```

`splitBySession()` requires no code change: a thought with `sessionId ===
undefined` already lands in `carriedForward` for any session being
reviewed, which is the correct bucket — an idle-planted thought was never
"from" the session under review.

New pure function:

```ts
export function setParkedThoughtNote(thoughts: ParkedThought[], id: string, note: string): ParkedThought[]
```

Same immutable-array shape as `addParkedThought`/`removeParkedThought`.

### Migration 8

SQLite cannot drop a column's `NOT NULL` constraint via `ALTER TABLE` — this
is the first recreate-table migration in this codebase (every migration
1-7 was purely additive: `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`).

```sql
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
```

`src/lib/persistence.ts`'s `serializeParkedThought`/
`deserializeParkedThoughtRow` and `ParkedThoughtRow` handle `session_id`/
`note` as nullable. `src/lib/tauriRepository.ts` and
`src/lib/memoryRepository.ts`: `insertParkedThought` passes `null` for
`session_id` when the thought has none; new function
`updateParkedThoughtNote(id: string, note: string): Promise<void>`.

## Components

- **`Greenhouse.svelte`** (new): plant-input at top, reusing
  `ParkingLot.svelte`'s form markup/behavior but never session-gated (only
  disabled while the thought pool isn't yet recovered). Below it, the full,
  unified list of every parked thought — no "current session" framing,
  since this view isn't tied to reviewing one particular session. Each row:
  the thought's text, an inline expandable note field (click to reveal a
  textarea; autosaves on the same 600ms debounce this app already uses for
  session notes, `NOTE_AUTOSAVE_DEBOUNCE_MS`), a Start button (same
  `onStart` contract `IdleParkedThoughts.svelte` already uses), and a
  Delete button using the existing inline confirm-before-delete pattern
  (`History.svelte`'s `.row-confirm`/`.row-confirm-text` convention — click
  Delete, the row swaps to "Delete this thought? Confirm / Cancel," never
  an instant destructive action).
- **`WorkspaceNav.svelte`**: new always-visible nav item, icon consistent
  with the existing Greenhouse/Plant branding (exact `lucide-svelte` icon
  name to be confirmed against the installed package during
  implementation — no sprout/leaf icon is in use anywhere in this codebase
  yet to copy from).
- **`IdleParkedThoughts.svelte` / `ParkingLot.svelte`**: unchanged in
  behavior. They remain the lightweight "thoughts relevant right here"
  fragments; Greenhouse is the separate, complete management surface. No
  add/delete is added to these two — that would duplicate Greenhouse's job
  in two more places for no real benefit.

## Data Flow / Wiring (`App.svelte`)

- `handlePlantFromGreenhouse(text: string)`: like the existing `handlePark`,
  but passes `sessionId: session.status === 'idle' ? undefined :
  session.sessionId` — planting from Greenhouse during an active session
  still tags the thought normally; planting while idle leaves it untagged.
- `handleUpdateThoughtNote(id: string, note: string)`: local state update
  via `setParkedThoughtNote`, enqueued through the existing `writeQueue`
  alongside every other mutation, calling `updateParkedThoughtNote`.
- `handleDeleteThought` and `handleStartParkedThought` are reused as-is —
  both already work identically regardless of whether a thought has a
  `sessionId`.

## Error Handling

Matches this app's existing convention for parked thoughts exactly: local
state updates optimistically; a persistence failure is caught and logged
via `console.error` (not surfaced as a blocking error), the same as
`handlePark`/`handleDeleteThought` today. Parked thoughts already treat
in-memory state as the source of truth for the current session, with the
write queue providing ordering/retry rather than the stricter
save-coordinator machinery session notes use — this expansion doesn't
change that trust model.

## Testing

- `parkingLot.test.ts`: `setParkedThoughtNote`, and `splitBySession`/
  `addParkedThought` behavior with `sessionId: undefined`.
- `Greenhouse.test.ts` (new) and/or `App.test.ts` integration coverage:
  planting with and without an active session, note autosave, the delete
  confirm/cancel flow, and Start.
- `migrations.rs`: a migrated-pool test asserting the recreated table's
  nullable `session_id`, new `note` column, and surviving index, matching
  this file's existing per-migration test pattern.
- `App.test.ts`: the Greenhouse nav item is present and reachable at every
  session state; `handlePlantFromGreenhouse`'s idle-vs-active-session
  branching.

## Acceptance Criteria

1. A Greenhouse nav-rail item is always visible and reachable regardless of
   session state.
2. A new thought can be planted from the Greenhouse view whether or not a
   focus/flow session is currently active.
3. Every parked thought — regardless of originating session, or planted
   with none — appears in the unified Greenhouse list.
4. Each thought can be annotated with a plain-text note that autosaves.
5. Each thought can be deleted from the Greenhouse view via the existing
   confirm-before-delete pattern.
6. Each thought can still be started into a new focus session from the
   Greenhouse view.
7. `IdleParkedThoughts.svelte` and `ParkingLot.svelte` remain unchanged in
   behavior and scope.
