// Pure domain module for Projects: the type, its fixed Category enum, and
// row<->domain mapping. No database access here, matching persistence.ts's
// own separation of concerns. Project assignment on a session is handled
// entirely outside SessionState (see repository.ts's updateSessionProject)
// — this module only ever describes the Project entity itself.

export type ProjectCategory = 'personal' | 'work' | 'study';

export const PROJECT_CATEGORIES: readonly ProjectCategory[] = ['personal', 'work', 'study'];

export const CATEGORY_LABELS: Record<ProjectCategory, string> = {
  personal: 'Personal',
  work: 'Work',
  study: 'Study',
};

export interface Project {
  id: string;
  name: string;
  category: ProjectCategory;
  /** Null while active. Archived projects are hidden from picker lists but
   * keep displaying on sessions/exports/the breakdown graph that already
   * reference them — see the plan's Global Constraints. */
  archivedAt: number | null;
  createdAt: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  category: string;
  archived_at: number | null;
  created_at: number;
}

function isProjectCategory(value: string): value is ProjectCategory {
  return (PROJECT_CATEGORIES as string[]).includes(value);
}

/** Throws on an unknown category rather than silently defaulting — a row
 * with a bad category value indicates real data corruption (the CHECK
 * constraint should have prevented it at the SQL layer), and hiding that
 * behind a fallback would make it invisible to the user and to tests. */
export function toProject(row: ProjectRow): Project {
  if (!isProjectCategory(row.category)) {
    throw new Error(`Malformed project row "${row.id}": unknown category "${row.category}".`);
  }
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

export function serializeProject(project: Project): ProjectRow {
  return {
    id: project.id,
    name: project.name,
    category: project.category,
    archived_at: project.archivedAt,
    created_at: project.createdAt,
  };
}

/** True when a project should appear in a "pick a project" list — i.e.
 * not archived. Named for the picker's use case rather than just negating
 * archivedAt, so call sites read as intent. */
export function isSelectable(project: Project): boolean {
  return project.archivedAt === null;
}
