// Orchestrates merging a parsed ExportData into the live repository:
// skip-existing by id, auto-create missing projects, write notes only for
// newly-inserted sessions. Talks to ./repository directly (like App.svelte
// itself does) rather than taking dependencies by injection, so its own
// test file mocks ./repository the same way BreakdownChart.test.ts does.
// The caller (App.svelte) is responsible for wrapping the whole call in
// writeQueue.enqueue(...), matching every other repository mutation in
// this app — this module has no queue of its own.

import type { ExportData } from './export';
import {
  insertImportedSession,
  insertImportedTask,
  insertParkedThoughtIfAbsent,
  insertProject,
  saveNote,
  updateSessionProject,
} from './repository';
import { CATEGORY_LABELS, type Project, type ProjectCategory } from './projects';

export interface ImportSummary {
  sessionsImported: number;
  sessionsSkipped: number;
  /** Entries whose writes threw and were skipped over. A single bad row
   * must not cost the user the rest of the import — see the per-entry
   * try/catch in applyImportedData. */
  sessionsFailed: number;
  thoughtsImported: number;
  thoughtsSkipped: number;
  thoughtsFailed: number;
  tasksImported: number;
  tasksSkipped: number;
  /** Includes a task whose project couldn't be resolved (unlike a
   * session's optional tag, a task with no project is invalid — see
   * tasks.ts's mandatory projectId). */
  tasksFailed: number;
  projectsCreated: number;
}

function categoryFromLabel(label: string): ProjectCategory | null {
  const match = (Object.entries(CATEGORY_LABELS) as [ProjectCategory, string][]).find(([, l]) => l === label);
  return match ? match[0] : null;
}

/** Resolves an entry's project tag to a live project id, auto-creating the
 * project (by name+category) if it doesn't already exist. Structural over
 * the entry type so both SessionExportEntry (optional tag) and
 * TaskExportEntry (mandatory tag) can share this — a task simply never
 * hits the null-tag branch. */
async function resolveProject(
  entry: { projectName: string | null; categoryLabel: string | null },
  projects: Project[],
  now: number,
  summary: ImportSummary,
): Promise<string | null> {
  if (!entry.projectName || !entry.categoryLabel) return null;
  const category = categoryFromLabel(entry.categoryLabel);
  if (!category) return null;

  const existing = projects.find((p) => p.name === entry.projectName && p.category === category);
  if (existing) return existing.id;

  const created: Project = {
    id: crypto.randomUUID(),
    name: entry.projectName,
    category,
    archivedAt: null,
    createdAt: now,
  };
  await insertProject(created);
  projects.push(created);
  summary.projectsCreated += 1;
  return created.id;
}

export async function applyImportedData(data: ExportData, existingProjects: Project[], now: number): Promise<ImportSummary> {
  const summary: ImportSummary = {
    sessionsImported: 0,
    sessionsSkipped: 0,
    sessionsFailed: 0,
    thoughtsImported: 0,
    thoughtsSkipped: 0,
    thoughtsFailed: 0,
    tasksImported: 0,
    tasksSkipped: 0,
    tasksFailed: 0,
    projectsCreated: 0,
  };
  const projects = [...existingProjects];

  for (const entry of data.sessions) {
    // Each entry's writes are contained: one failing row (a transient DB
    // error, a note write that can't land) must not abort every session
    // after it — and must not skip the parked-thought loop below entirely,
    // which is what an uncaught throw here would do.
    try {
      const outcome = await insertImportedSession(
        {
          id: entry.id,
          task: entry.task,
          completedAt: entry.completedAt,
          plannedFocusMs: entry.plannedFocusMs,
          actualFocusMs: entry.actualFocusMs,
          flowMs: entry.flowMs,
          breakMs: entry.breakMs,
          breakIntermissionMs: entry.breakIntermissionMs ?? 0,
          touchGrassMs: entry.touchGrassMs ?? 0,
          totalElapsedMs: entry.totalElapsedMs,
        },
        now,
      );

      if (outcome === 'skipped') {
        summary.sessionsSkipped += 1;
        continue;
      }

      if (entry.noteContent) await saveNote(entry.id, entry.noteContent, now);

      const projectId = await resolveProject(entry, projects, now, summary);
      if (projectId) await updateSessionProject(entry.id, projectId);

      // Counted last, not right after the insert, so imported + skipped +
      // failed always sums to the number of entries in the file. A session
      // whose row landed but whose note or project tag didn't is reported
      // as failed rather than as a clean import.
      summary.sessionsImported += 1;
    } catch (err) {
      console.error(`Failed to import session "${entry.id}":`, err);
      summary.sessionsFailed += 1;
    }
  }

  for (const t of data.tasks) {
    try {
      const projectId = await resolveProject(t, projects, now, summary);
      if (!projectId) {
        // Unlike a session's optional tag, a task with no resolvable
        // project has nowhere to live (tasks.ts's projectId is mandatory)
        // — this is a failure, not a silent drop.
        throw new Error(`No resolvable project for task "${t.id}" ("${t.projectName}" / "${t.categoryLabel}").`);
      }
      const outcome = await insertImportedTask({
        id: t.id,
        projectId,
        title: t.title,
        notes: t.notes,
        status: t.status,
        priority: t.priority,
        dueAt: t.dueAt,
        position: t.position,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
      if (outcome === 'inserted') summary.tasksImported += 1;
      else summary.tasksSkipped += 1;
    } catch (err) {
      console.error(`Failed to import task "${t.id}":`, err);
      summary.tasksFailed += 1;
    }
  }

  for (const thought of data.parkedThoughts) {
    try {
      const outcome = await insertParkedThoughtIfAbsent({
        id: thought.id,
        sessionId: thought.sessionId,
        text: thought.text,
        createdAt: thought.createdAt,
      });
      if (outcome === 'inserted') summary.thoughtsImported += 1;
      else summary.thoughtsSkipped += 1;
    } catch (err) {
      console.error(`Failed to import parked thought "${thought.id}":`, err);
      summary.thoughtsFailed += 1;
    }
  }

  return summary;
}
