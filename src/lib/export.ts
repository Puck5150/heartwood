// Pure export builders: no DOM, no Tauri, no repository access. Takes
// whatever the History view already has loaded (session summaries + the
// full parked-thought pool) and turns it into a structured, versioned
// payload plus two text renderings of it. Triggering the actual file
// download is a DOM concern that lives in History.svelte, not here.

import type { ParkedThought } from './parkingLot';
import type { SessionSummary } from './history';
import { formatDate, formatDateTime, formatDuration } from './format';
import { CATEGORY_LABELS, type Project } from './projects';
import { PRIORITY_LABELS, STATUS_LABELS, TASK_STATUSES, type Task, type TaskPriority, type TaskStatus } from './tasks';

export const EXPORT_FORMAT_VERSION = 5;

export interface SessionExportEntry {
  id: string;
  task: string;
  completedAt: number;
  plannedFocusMs: number;
  actualFocusMs: number;
  flowMs: number;
  breakMs: number;
  breakIntermissionMs?: number;
  touchGrassMs?: number;
  totalElapsedMs: number;
  parkedThoughtCount: number;
  /** Text of thoughts still parked and tagged with this session's id —
   * see parkingLot.ts's carry-forward model for why this can be fewer
   * than parkedThoughtCount ever captured historically. */
  parkedThoughts: string[];
  /** The session's note content, or null if it has none (or an empty one). */
  noteContent: string | null;
  /** Null when untagged. Resolved from SessionSummary.projectId at export
   * time (not stored redundantly on SessionSummary itself) — see
   * buildExportData's new `projects` parameter below. */
  projectName: string | null;
  categoryLabel: string | null;
}

export interface ParkedThoughtExportEntry {
  id: string;
  sessionId?: string;
  text: string;
  createdAt: number;
}

export interface TaskExportEntry {
  id: string;
  /** Unlike a session's optional project tag, a task's projectId is
   * mandatory (see tasks.ts) — both fields here are always present. */
  projectName: string;
  categoryLabel: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: number | null;
  position: number;
  createdAt: number;
  updatedAt: number;
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
  tasks: TaskExportEntry[];
}

/** Builds the full export payload. Read-only: never mutates its inputs
 * and never touches the repository. Note content flows straight through
 * from SessionSummary — history.ts already joined it in by session id,
 * so there's no separate notes parameter or join needed here. */
export function buildExportData(
  summaries: SessionSummary[],
  parkedThoughts: ParkedThought[],
  exportedAt: number,
  projects: Project[] = [],
  tasks: Task[] = [],
): ExportData {
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const sessions: SessionExportEntry[] = summaries.map((summary) => {
    const project = summary.projectId ? projectsById.get(summary.projectId) : undefined;
    return {
      id: summary.id,
      task: summary.task,
      completedAt: summary.completedAt,
      plannedFocusMs: summary.plannedFocusMs,
      actualFocusMs: summary.actualFocusMs,
      flowMs: summary.flowMs,
      breakMs: summary.breakMs,
      ...(summary.breakIntermissionMs > 0
        ? { breakIntermissionMs: summary.breakIntermissionMs }
        : {}),
      ...(summary.touchGrassMs > 0 ? { touchGrassMs: summary.touchGrassMs } : {}),
      totalElapsedMs: summary.totalElapsedMs,
      parkedThoughtCount: summary.parkedThoughtCount,
      parkedThoughts: parkedThoughts
        .filter((thought) => thought.sessionId === summary.id)
        .map((thought) => thought.text),
      noteContent: summary.noteContent,
      projectName: project?.name ?? null,
      categoryLabel: project ? CATEGORY_LABELS[project.category] : null,
    };
  });

  // A task's projectId is a real FK with no delete path for projects (only
  // archive) — the lookup should never miss. If it somehow did (data
  // tampering), skip that task rather than export a task with no project,
  // which import.ts's validation would reject on re-import anyway.
  const taskEntries: TaskExportEntry[] = [];
  for (const t of tasks) {
    const project = projectsById.get(t.projectId);
    if (!project) continue;
    taskEntries.push({
      id: t.id,
      projectName: project.name,
      categoryLabel: CATEGORY_LABELS[project.category],
      title: t.title,
      notes: t.notes,
      status: t.status,
      priority: t.priority,
      dueAt: t.dueAt,
      position: t.position,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }

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
    tasks: taskEntries,
  };
}

function csvField(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function csvRow(fields: (string | number)[]): string {
  return fields.map(csvField).join(',');
}

/** UTF-8-safe base64 encode. Plain `btoa` throws on non-ASCII input (e.g.
 * a task title with an emoji or accented character), and a raw JSON string
 * embedded directly in an HTML comment risks a literal "-->" inside task
 * text or a note prematurely closing the comment. Base64's alphabet
 * (A-Za-z0-9+/=) can never contain "-->" or "<!--", so this sidesteps both
 * problems at once rather than escaping either one. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function formatExportAsCsv(data: ExportData): string {
  const lines: string[] = [];

  // Only version stamp anywhere in the CSV's own visible output — without
  // it, import.ts's parseImportedCsv would have no way to distinguish an
  // old (pre-import-support) file from a new one; ExportData.version alone
  // is never printed to CSV.
  lines.push(`Heartwood Export,${EXPORT_FORMAT_VERSION},${new Date(data.exportedAt).toISOString()}`);
  lines.push('');

  lines.push('Sessions');
  lines.push(
    csvRow([
      'id',
      'task',
      'completedAt',
      'plannedFocusMs',
      'actualFocusMs',
      'flowMs',
      'breakMs',
      'breakIntermissionMs',
      'touchGrassMs',
      'totalElapsedMs',
      'parkedThoughtCount',
      'parkedThoughts',
      'noteContent',
      'project',
      'category',
    ]),
  );
  for (const session of data.sessions) {
    lines.push(
      csvRow([
        session.id,
        session.task,
        new Date(session.completedAt).toISOString(),
        session.plannedFocusMs,
        session.actualFocusMs,
        session.flowMs,
        session.breakMs,
        session.breakIntermissionMs ?? 0,
        session.touchGrassMs ?? 0,
        session.totalElapsedMs,
        session.parkedThoughtCount,
        session.parkedThoughts.join('; '),
        session.noteContent ?? '',
        session.projectName ?? '',
        session.categoryLabel ?? '',
      ]),
    );
  }

  lines.push('');
  lines.push('Tasks');
  lines.push(
    csvRow(['id', 'project', 'category', 'title', 'notes', 'status', 'priority', 'dueAt', 'position', 'createdAt', 'updatedAt']),
  );
  for (const t of data.tasks) {
    lines.push(
      csvRow([
        t.id,
        t.projectName,
        t.categoryLabel,
        t.title,
        t.notes ?? '',
        t.status,
        t.priority,
        t.dueAt !== null ? new Date(t.dueAt).toISOString() : '',
        t.position,
        new Date(t.createdAt).toISOString(),
        new Date(t.updatedAt).toISOString(),
      ]),
    );
  }

  lines.push('');
  lines.push('Currently Parked Thoughts');
  lines.push(csvRow(['id', 'sessionId', 'text', 'createdAt']));
  for (const thought of data.parkedThoughts) {
    lines.push(csvRow([thought.id, thought.sessionId ?? '', thought.text, new Date(thought.createdAt).toISOString()]));
  }

  return lines.join('\n');
}

export function formatExportAsMarkdown(data: ExportData): string {
  const lines: string[] = [];

  // Invisible in every markdown renderer (it's an HTML comment) — carries
  // the exact ExportData JSON so import.ts's parseImportedMarkdown can
  // restore with full fidelity, without needing to parse or annotate the
  // human-readable prose below at all. See import.ts's matching decoder.
  lines.push(`<!-- heartwood-export-data:${encodeBase64(JSON.stringify(data))} -->`);
  lines.push('');

  lines.push('# Heartwood Export');
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
      lines.push(`- Project: ${session.projectName ? `${session.projectName} (${session.categoryLabel})` : '—'}`);
      lines.push(
        session.actualFocusMs < session.plannedFocusMs
          ? `- Focus: ${formatDuration(session.actualFocusMs)} (planned ${formatDuration(session.plannedFocusMs)})`
          : `- Focus: ${formatDuration(session.actualFocusMs)}`,
      );
      if (session.flowMs > 0) lines.push(`- Flow: ${formatDuration(session.flowMs)}`);
      if (session.breakMs > 0) lines.push(`- Break: ${formatDuration(session.breakMs)}`);
      if (session.breakIntermissionMs) {
        lines.push(`- Breaks: ${formatDuration(session.breakIntermissionMs)}`);
      }
      if (session.touchGrassMs) {
        lines.push(`- Touch Grass: ${formatDuration(session.touchGrassMs)}`);
      }
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

  lines.push('## Tasks');
  lines.push('');
  if (data.tasks.length === 0) {
    lines.push('_No tasks._');
    lines.push('');
  } else {
    // data.tasks's order is position ASC within (project_id, status) only
    // (see tasks.ts's doc comment on Task.position) — sorted globally that
    // interleaves unrelated projects/statuses arbitrarily. Sort a local
    // copy for this human-readable rendering only; data.tasks itself must
    // stay untouched (formatExportAsCsv and the round-trip tests depend on
    // its original order).
    const sortedTasks = [...data.tasks].sort((a, b) => {
      if (a.projectName !== b.projectName) return a.projectName.localeCompare(b.projectName);
      if (a.status !== b.status) return TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
      return a.position - b.position;
    });
    for (const t of sortedTasks) {
      lines.push(`### ${t.title}`);
      lines.push('');
      lines.push(`- Project: ${t.projectName} (${t.categoryLabel})`);
      lines.push(`- Status: ${STATUS_LABELS[t.status]}`);
      lines.push(`- Priority: ${PRIORITY_LABELS[t.priority]}`);
      lines.push(`- Due: ${t.dueAt !== null ? formatDate(t.dueAt) : '—'}`);
      if (t.notes) {
        lines.push('- Notes:');
        for (const noteLine of t.notes.split('\n')) {
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
