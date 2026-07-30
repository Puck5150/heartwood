// Pure translation between in-memory session/parking-lot shapes and the
// flat SQL row shapes stored in SQLite. No database access here — this
// module is deterministic and unit-testable without Tauri, matching
// architecture-review.md's recommendation: keep the wide nullable-column
// table for storage, but define the in-memory representation as a tagged
// union and have exactly one (de)serialization function bridge the two.

import { completeFocusIntoFlow, createIdleState, isFocusDue, type SessionState } from './session';
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
  /** The current focus cycle's deadline — set only for focusing/paused,
   * null everywhere else (the deadline has no owner once focus completes).
   * Null on a row written before this column existed; deserialization
   * derives it in that case (see deserializeSessionRow). */
  focus_deadline_at: number | null;
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
  focus_deadline_at: null,
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
        focus_deadline_at: state.focusDeadlineAt,
      };
    case 'paused':
      return {
        ...base,
        started_at: state.startedAt,
        planned_duration_ms: state.plannedDurationMs,
        accumulated_pause_ms: state.accumulatedPauseMs,
        focus_deadline_at: state.focusDeadlineAt,
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
        // Reuses the existing actual_focus_ms/flow_ms columns rather than
        // adding dedicated ones — a Break row was never distinguishable
        // from Complete's own use of these columns anyway.
        actual_focus_ms: state.actualFocusMs,
        flow_ms: state.flowMsBeforeBreak,
      };
    case 'complete':
      return {
        ...base,
        started_at: state.startedAt,
        planned_duration_ms: state.plannedDurationMs,
        accumulated_pause_ms: state.accumulatedPauseMs,
        focus_completed_at: state.focusCompletedAt,
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
        // A row written before this column existed (or otherwise missing
        // it) derives the single-cycle deadline it always implicitly had —
        // no restart could have happened without the column to record it.
        focusDeadlineAt:
          row.focus_deadline_at ?? row.started_at! + row.planned_duration_ms! + row.accumulated_pause_ms!,
      };
    case 'paused':
      return {
        status: 'paused',
        sessionId: row.id,
        task: row.task,
        startedAt: row.started_at!,
        plannedDurationMs: row.planned_duration_ms!,
        accumulatedPauseMs: row.accumulated_pause_ms!,
        focusDeadlineAt:
          row.focus_deadline_at ?? row.started_at! + row.planned_duration_ms! + row.accumulated_pause_ms!,
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
        // A row written before Break used these columns falls back to the
        // only value it could have meant: a break taken after a
        // fully-completed focus interval with no Flow beforehand.
        actualFocusMs: row.actual_focus_ms ?? row.planned_duration_ms!,
        flowMsBeforeBreak: row.flow_ms ?? 0,
      };
    case 'complete':
      return {
        status: 'complete',
        sessionId: row.id,
        task: row.task,
        startedAt: row.started_at!,
        plannedDurationMs: row.planned_duration_ms!,
        accumulatedPauseMs: row.accumulated_pause_ms!,
        focusCompletedAt: row.focus_completed_at!,
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
 * A completed session is restored to the review screen, not coerced to
 * idle. Once the review screen became an actual editable surface (Phase
 * 4A's session notes, with in-place editing and carry-forward), silently
 * dropping the user back to idle on relaunch would mean a note edit made
 * right before quitting — or the review itself — could only be found again
 * via History, not where the user left it. Since `loadLatestSessionRow()`
 * only ever returns the single most-recently-updated row, this only comes
 * up for the session the user hasn't acted on yet: starting a new one, or
 * anything else, immediately makes that newer row the latest instead.
 */
export function recoverSessionState(row: SessionRow | null, now: number): SessionState {
  if (!row) return createIdleState();

  const restored = deserializeSessionRow(row);

  if (restored.status === 'focusing' && isFocusDue(restored, now)) {
    // Recovers straight into quiet Flow overtime — never through the
    // legacy awaitingDecision detour — at the exact deadline, not the
    // reopen instant: a session that expired 10 minutes (or 10 hours)
    // before relaunch must not have that dead time counted as Flow.
    // Playing the completion alarm only ever happens for a *live* expiry
    // (App.svelte's own effect); recovery never touches audio.
    const result = completeFocusIntoFlow(restored, restored.focusDeadlineAt);
    return result.ok ? result.state : restored;
  }

  if (restored.status === 'awaitingDecision') {
    // A genuinely legacy row, predating Phase 5B (no live transition
    // creates this status anymore) — normalizes into the same quiet
    // Flow treatment, starting at the exact moment focus actually
    // completed (flowStartedAt === focusCompletedAt is what marks quiet
    // overtime — see App.svelte's own isQuietOvertime derivation).
    return {
      status: 'flow',
      sessionId: restored.sessionId,
      task: restored.task,
      startedAt: restored.startedAt,
      plannedDurationMs: restored.plannedDurationMs,
      accumulatedPauseMs: restored.accumulatedPauseMs,
      focusCompletedAt: restored.focusCompletedAt,
      flowStartedAt: restored.focusCompletedAt,
      flowAccumulatedPauseMs: 0,
    };
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
