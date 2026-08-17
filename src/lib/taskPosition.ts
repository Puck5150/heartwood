// Pure fractional/midpoint-indexing math for ordering tasks within a
// kanban column without ever renumbering the rest of the column on a
// single move — the classic Trello-style scheme. `before`/`after` are
// the positions of the two tasks the moved/created task will sit
// between; null means "no neighbor on that side" (top or bottom of the
// column, or the column is empty).

// ponytail: repeated midpoint insertion between the same two neighbors
// halves the gap each time; after enough moves the doubles collapse to
// equality and positionBetween(x, x) === x, freezing reordering for that
// pair. The `ORDER BY position ASC, created_at ASC` tie-break keeps
// *display* order deterministic even then, so this degrades to "reorder
// silently stops working" rather than visible corruption — acceptable for
// a local single-user app. Upgrade path if it matters: periodic
// renumbering of a column, or switch to string-key (LexoRank-style)
// ordering, which never runs out of room between two neighbors.
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return after! - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

/** Position for a task landing at the end of a column — used by every
 * "goes to the bottom" placement (new task, cross-column drop/move,
 * "Move to..."). Takes the column's tasks directly rather than assuming
 * the caller already sorted them, so this is safe to call with any
 * order — see the App.svelte/TaskBoard.svelte duplication this replaced,
 * where one side trusted array order and the other computed Math.max. */
export function positionAtEndOf(columnTasks: { position: number }[]): number {
  const last = columnTasks.length > 0 ? Math.max(...columnTasks.map((t) => t.position)) : null;
  return positionBetween(last, null);
}
