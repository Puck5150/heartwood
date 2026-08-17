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
