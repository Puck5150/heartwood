// Pure translation between in-memory session/parking-lot shapes and the
// flat SQL row shapes stored in SQLite. No database access here — this
// module is deterministic and unit-testable without Tauri, matching
// architecture-review.md's recommendation: keep the wide nullable-column
// table for storage, but define the in-memory representation as a tagged
// union and have exactly one (de)serialization function bridge the two.

import { completeFocus, createIdleState, isFocusDue, type SessionState } from './session';
import type { ParkedThought } from './parkingLot';

export interface SessionRow {
  id: string;
  task: string;
  status: string;
  started_at: number | null;
  planned_duration_ms: number | null;
  accumulated_pause_ms: number | null;
  paused_at: number | null;
  focus_completed_at: number | null;
  flow_started_at: number | null;
  flow_accumulated_pause_ms: number | null;
  flow_paused_at: number | null;
  break_started_at: number | null;
  planned_focus_ms: number | null;
  actual_focus_ms: number | null;
  flow_ms: number | null;
  took_break: number | null;
  break_ms: number | null;
  total_elapsed_ms: number | null;
  completed_at: number | null;
  updated_at: number;
}

const EMPTY_ROW_FIELDS = {
  started_at: null,
  planned_duration_ms: null,
  accumulated_pause_ms: null,
  paused_at: null,
  focus_completed_at: null,
  flow_started_at: null,
  flow_accumulated_pause_ms: null,
  flow_paused_at: null,
  break_started_at: null,
  planned_focus_ms: null,
  actual_focus_ms: null,
  flow_ms: null,
  took_break: null,
  break_ms: null,
  total_elapsed_ms: null,
  completed_at: null,
} as const;

/** Returns null for 'idle' — there is nothing to persist until a session starts. */
export function serializeSessionState(state: SessionState, updatedAt: number): SessionRow | null {
  if (state.status === 'idle') return null;

  const base = {
    id: state.sessionId,
    task: state.task,
    status: state.status,
    updated_at: updatedAt,
    ...EMPTY_ROW_FIELDS,
  };

  switch (state.status) {
    case 'focusing':
      return {
        ...base,
        started_at: state.startedAt,
        planned_duration_ms: state.plannedDurationMs,
        accumulated_pause_ms: state.accumulatedPauseMs,
      };
    case 'paused':
      return {
        ...base,
        started_at: state.startedAt,
        planned_duration_ms: state.plannedDurationMs,
        accumulated_pause_ms: state.accumulatedPauseMs,
        paused_at: state.pausedAt,
      };
    case 'awaitingDecision':
      return {
        ...base,
        started_at: state.startedAt,
        planned_duration_ms: state.plannedDurationMs,
        accumulated_pause_ms: state.accumulatedPauseMs,
        focus_completed_at: state.focusCompletedAt,
      };
    case 'flow':
      return {
        ...base,
        started_at: state.startedAt,
        planned_duration_ms: state.plannedDurationMs,
        accumulated_pause_ms: state.accumulatedPauseMs,
        focus_completed_at: state.focusCompletedAt,
        flow_started_at: state.flowStartedAt,
        flow_accumulated_pause_ms: state.flowAccumulatedPauseMs,
      };
    case 'flowPaused':
      return {
        ...base,
        started_at: state.startedAt,
        planned_duration_ms: state.plannedDurationMs,
        accumulated_pause_ms: state.accumulatedPauseMs,
        focus_completed_at: state.focusCompletedAt,
        flow_started_at: state.flowStartedAt,
        flow_accumulated_pause_ms: state.flowAccumulatedPauseMs,
        flow_paused_at: state.flowPausedAt,
      };
    case 'break':
      return {
        ...base,
        started_at: state.startedAt,
        planned_duration_ms: state.plannedDurationMs,
        accumulated_pause_ms: state.accumulatedPauseMs,
        focus_completed_at: state.focusCompletedAt,
        break_started_at: state.breakStartedAt,
      };
    case 'complete':
      return {
        ...base,
        planned_focus_ms: state.plannedFocusMs,
        actual_focus_ms: state.actualFocusMs,
        flow_ms: state.flowMs,
        took_break: state.tookBreak ? 1 : 0,
        break_ms: state.breakMs,
        total_elapsed_ms: state.totalElapsedMs,
        completed_at: state.completedAt,
      };
  }
}

/**
 * Reconstructs a SessionState from a stored row. Assumes the row was
 * produced by serializeSessionState() for the same status, so the fields
 * required by that status are never null — that invariant is this
 * function's only contract with its caller.
 */
export function deserializeSessionRow(row: SessionRow): SessionState {
  switch (row.status) {
    case 'focusing':
      return {
        status: 'focusing',
        sessionId: row.id,
        task: row.task,
        startedAt: row.started_at!,
        plannedDurationMs: row.planned_duration_ms!,
        accumulatedPauseMs: row.accumulated_pause_ms!,
      };
    case 'paused':
      return {
        status: 'paused',
        sessionId: row.id,
        task: row.task,
        startedAt: row.started_at!,
        plannedDurationMs: row.planned_duration_ms!,
        accumulatedPauseMs: row.accumulated_pause_ms!,
        pausedAt: row.paused_at!,
      };
    case 'awaitingDecision':
      return {
        status: 'awaitingDecision',
        sessionId: row.id,
        task: row.task,
        startedAt: row.started_at!,
        plannedDurationMs: row.planned_duration_ms!,
        accumulatedPauseMs: row.accumulated_pause_ms!,
        focusCompletedAt: row.focus_completed_at!,
      };
    case 'flow':
      return {
        status: 'flow',
        sessionId: row.id,
        task: row.task,
        startedAt: row.started_at!,
        plannedDurationMs: row.planned_duration_ms!,
        accumulatedPauseMs: row.accumulated_pause_ms!,
        focusCompletedAt: row.focus_completed_at!,
        flowStartedAt: row.flow_started_at!,
        flowAccumulatedPauseMs: row.flow_accumulated_pause_ms!,
      };
    case 'flowPaused':
      return {
        status: 'flowPaused',
        sessionId: row.id,
        task: row.task,
        startedAt: row.started_at!,
        plannedDurationMs: row.planned_duration_ms!,
        accumulatedPauseMs: row.accumulated_pause_ms!,
        focusCompletedAt: row.focus_completed_at!,
        flowStartedAt: row.flow_started_at!,
        flowAccumulatedPauseMs: row.flow_accumulated_pause_ms!,
        flowPausedAt: row.flow_paused_at!,
      };
    case 'break':
      return {
        status: 'break',
        sessionId: row.id,
        task: row.task,
        startedAt: row.started_at!,
        plannedDurationMs: row.planned_duration_ms!,
        accumulatedPauseMs: row.accumulated_pause_ms!,
        focusCompletedAt: row.focus_completed_at!,
        breakStartedAt: row.break_started_at!,
      };
    case 'complete':
      return {
        status: 'complete',
        sessionId: row.id,
        task: row.task,
        plannedFocusMs: row.planned_focus_ms!,
        actualFocusMs: row.actual_focus_ms!,
        flowMs: row.flow_ms!,
        tookBreak: row.took_break === 1,
        breakMs: row.break_ms!,
        totalElapsedMs: row.total_elapsed_ms!,
        completedAt: row.completed_at!,
      };
    default:
      throw new Error(`Unknown session status in row: "${row.status}"`);
  }
}

/**
 * Recovers the session to resume on app launch from the most recently
 * updated row (or null if none exists yet). Timer state is always
 * recomputed from stored timestamps, never from a saved countdown value.
 *
 * Documented choice for a completed session: it is not resumed into the
 * review screen. A completed session is history, not a "current" session —
 * resurrecting review on every launch would be a confusing stale flash long
 * after the fact. Recovery starts fresh at idle instead; the completed
 * row and its parked thoughts are untouched in the database, so the next
 * review's carry-forward list still sees them.
 */
export function recoverSessionState(row: SessionRow | null, now: number): SessionState {
  if (!row) return createIdleState();
  if (row.status === 'complete') return createIdleState();

  const restored = deserializeSessionRow(row);
  if (restored.status === 'focusing' && isFocusDue(restored, now)) {
    const result = completeFocus(restored, now);
    return result.ok ? result.state : restored;
  }
  return restored;
}

export interface ParkedThoughtRow {
  id: string;
  session_id: string;
  text: string;
  created_at: number;
}

export function serializeParkedThought(thought: ParkedThought): ParkedThoughtRow {
  return {
    id: thought.id,
    session_id: thought.sessionId,
    text: thought.text,
    created_at: thought.createdAt,
  };
}

export function deserializeParkedThoughtRow(row: ParkedThoughtRow): ParkedThought {
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    createdAt: row.created_at,
  };
}
