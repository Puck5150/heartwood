// Pure derivation of the read-only session-history list shown in
// History.svelte. No database access here — takes whatever rows/thoughts
// the repository layer loaded and turns them into a typed, ordered summary.

import type { ParkedThought } from './parkingLot';
import { getNoteContentForSession, type SessionNoteRow } from './notes';
import type { SessionRow } from './persistence';

export interface SessionSummary {
  id: string;
  task: string;
  completedAt: number;
  plannedFocusMs: number;
  actualFocusMs: number;
  flowMs: number;
  tookBreak: boolean;
  breakMs: number;
  breakIntermissionMs: number;
  touchGrassMs: number;
  totalElapsedMs: number;
  /**
   * Thoughts still sitting in the parking-lot pool tagged with this
   * session's id — i.e. ones that were parked here and neither promoted
   * nor deleted since. Not a historical "total ever parked" count: once a
   * thought is promoted or deleted its row is gone, by design (see
   * parkingLot.ts's carry-forward model), so this number can only reflect
   * what's still there today, not what happened at the time.
   */
  parkedThoughtCount: number;
  /** The session's note content, or null if it has none (or an empty one). */
  noteContent: string | null;
  /** How many revisions exist for this session's note — loaded as metadata
   * counts only (see loadNoteRevisionCounts), never by reading every
   * revision body. A completed session with no current note but a
   * non-zero count still exposes the "view revisions" action; see
   * History.svelte. */
  revisionCount: number;
}

/** Derives a display summary from a session row. Returns null for any row
 * that isn't 'complete' — history only shows finished sessions, and only
 * complete rows have these stat columns populated. */
export function toSessionSummary(
  row: SessionRow,
  parkedThoughtCount: number,
  noteContent: string | null,
  revisionCount: number,
): SessionSummary | null {
  if (row.status !== 'complete') return null;
  return {
    id: row.id,
    task: row.task,
    completedAt: row.completed_at!,
    plannedFocusMs: row.planned_focus_ms!,
    actualFocusMs: row.actual_focus_ms!,
    flowMs: row.flow_ms!,
    tookBreak: row.took_break === 1,
    breakMs: row.break_ms!,
    breakIntermissionMs: row.break_intermission_ms ?? 0,
    touchGrassMs: row.touch_grass_ms ?? 0,
    totalElapsedMs: row.total_elapsed_ms!,
    parkedThoughtCount,
    noteContent,
    revisionCount,
  };
}

/** Builds the ordered history list: completed sessions only, most recently
 * completed first. The sort happens here rather than being trusted from
 * SQL's ORDER BY, so the ordering guarantee holds regardless of what order
 * rows are loaded in. `revisionCounts` defaults to empty so existing
 * callers mid-migration don't need to pass one; a session absent from the
 * map simply has zero revisions. */
export function buildSessionHistory(
  rows: SessionRow[],
  parkedThoughts: ParkedThought[],
  notes: SessionNoteRow[],
  revisionCounts: Map<string, number> = new Map(),
): SessionSummary[] {
  const countBySessionId = new Map<string, number>();
  for (const thought of parkedThoughts) {
    if (!thought.sessionId) continue;
    countBySessionId.set(thought.sessionId, (countBySessionId.get(thought.sessionId) ?? 0) + 1);
  }

  return rows
    .map((row) =>
      toSessionSummary(
        row,
        countBySessionId.get(row.id) ?? 0,
        getNoteContentForSession(notes, row.id),
        revisionCounts.get(row.id) ?? 0,
      ),
    )
    .filter((summary): summary is SessionSummary => summary !== null)
    .sort((a, b) => b.completedAt - a.completedAt);
}
