// Pure export builders: no DOM, no Tauri, no repository access. Takes
// whatever the History view already has loaded (session summaries + the
// full parked-thought pool) and turns it into a structured, versioned
// payload plus two text renderings of it. Triggering the actual file
// download is a DOM concern that lives in History.svelte, not here.

import type { ParkedThought } from './parkingLot';
import type { SessionSummary } from './history';
import { formatDateTime, formatDuration } from './format';

export const EXPORT_FORMAT_VERSION = 1;

export interface SessionExportEntry {
  id: string;
  task: string;
  completedAt: number;
  plannedFocusMs: number;
  actualFocusMs: number;
  flowMs: number;
  breakMs: number;
  totalElapsedMs: number;
  parkedThoughtCount: number;
  /** Text of thoughts still parked and tagged with this session's id —
   * see parkingLot.ts's carry-forward model for why this can be fewer
   * than parkedThoughtCount ever captured historically. */
  parkedThoughts: string[];
  /** The session's note content, or null if it has none (or an empty one). */
  noteContent: string | null;
}

export interface ParkedThoughtExportEntry {
  id: string;
  sessionId: string;
  text: string;
  createdAt: number;
}

export interface ExportData {
  version: number;
  exportedAt: number;
  sessions: SessionExportEntry[];
  /** Every currently parked thought, independent of whether its session
   * appears above — covers thoughts parked during a still-active session
   * and thoughts whose original session was since deleted, so nothing
   * gets lost just because it isn't tied to visible history. */
  parkedThoughts: ParkedThoughtExportEntry[];
}

/** Builds the full export payload. Read-only: never mutates its inputs
 * and never touches the repository. Note content flows straight through
 * from SessionSummary — history.ts already joined it in by session id,
 * so there's no separate notes parameter or join needed here. */
export function buildExportData(
  summaries: SessionSummary[],
  parkedThoughts: ParkedThought[],
  exportedAt: number,
): ExportData {
  const sessions: SessionExportEntry[] = summaries.map((summary) => ({
    id: summary.id,
    task: summary.task,
    completedAt: summary.completedAt,
    plannedFocusMs: summary.plannedFocusMs,
    actualFocusMs: summary.actualFocusMs,
    flowMs: summary.flowMs,
    breakMs: summary.breakMs,
    totalElapsedMs: summary.totalElapsedMs,
    parkedThoughtCount: summary.parkedThoughtCount,
    parkedThoughts: parkedThoughts
      .filter((thought) => thought.sessionId === summary.id)
      .map((thought) => thought.text),
    noteContent: summary.noteContent,
  }));

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

export function formatExportAsJson(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}

export function formatExportAsMarkdown(data: ExportData): string {
  const lines: string[] = [];

  lines.push('# Pomodoro Parking Lot Export');
  lines.push('');
  lines.push(`Exported: ${formatDateTime(data.exportedAt)}`);
  lines.push('');
  lines.push('## Session History');
  lines.push('');

  if (data.sessions.length === 0) {
    lines.push('_No completed sessions._');
    lines.push('');
  } else {
    for (const session of data.sessions) {
      lines.push(`### ${session.task}`);
      lines.push('');
      lines.push(`- Completed: ${formatDateTime(session.completedAt)}`);
      lines.push(
        session.actualFocusMs < session.plannedFocusMs
          ? `- Focus: ${formatDuration(session.actualFocusMs)} (planned ${formatDuration(session.plannedFocusMs)})`
          : `- Focus: ${formatDuration(session.actualFocusMs)}`,
      );
      if (session.flowMs > 0) lines.push(`- Flow: ${formatDuration(session.flowMs)}`);
      if (session.breakMs > 0) lines.push(`- Break: ${formatDuration(session.breakMs)}`);
      lines.push(`- Total elapsed: ${formatDuration(session.totalElapsedMs)}`);
      if (session.parkedThoughts.length > 0) {
        lines.push(`- Parked thoughts (${session.parkedThoughtCount}):`);
        for (const thought of session.parkedThoughts) {
          lines.push(`  - ${thought}`);
        }
      } else {
        lines.push('- Parked thoughts: none currently');
      }
      if (session.noteContent) {
        lines.push('- Note:');
        for (const noteLine of session.noteContent.split('\n')) {
          lines.push(`  > ${noteLine}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Currently Parked Thoughts');
  lines.push('');
  if (data.parkedThoughts.length === 0) {
    lines.push('_Nothing currently parked._');
  } else {
    for (const thought of data.parkedThoughts) {
      lines.push(`- ${thought.text} (parked ${formatDateTime(thought.createdAt)})`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
