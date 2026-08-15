<script lang="ts">
  import ProjectPicker from './ProjectPicker.svelte';
  import { CATEGORY_LABELS, isSelectable, type Project, type ProjectCategory } from './projects';
  import type { SessionSummary } from './history';
  import { formatDateTime, formatDuration } from './format';

  let {
    projects,
    summaries,
    onBack,
    onCreateProject,
    onRenameProject,
    onArchiveProject,
  }: {
    projects: Project[];
    summaries: SessionSummary[];
    onBack: () => void;
    onCreateProject: (name: string, category: ProjectCategory) => Promise<Project>;
    onRenameProject: (id: string, name: string) => Promise<void>;
    onArchiveProject: (id: string, archived: boolean) => Promise<void>;
  } = $props();

  let selectedProjectId = $state<string | null>(null);
  let showArchived = $state(false);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');

  const visibleProjects = $derived(
    showArchived ? projects : projects.filter(isSelectable),
  );

  function sessionCount(projectId: string): number {
    return summaries.filter((s) => s.projectId === projectId).length;
  }

  function totalFocusMs(projectId: string): number {
    return summaries
      .filter((s) => s.projectId === projectId)
      .reduce((sum, s) => sum + s.actualFocusMs, 0);
  }

  function selectedProject(): Project | undefined {
    return projects.find((p) => p.id === selectedProjectId);
  }

  function sessionsForSelected(): SessionSummary[] {
    return summaries
      .filter((s) => s.projectId === selectedProjectId)
      .sort((a, b) => b.completedAt - a.completedAt);
  }

  function startRename(project: Project) {
    renamingId = project.id;
    renameDraft = project.name;
  }

  async function submitRename() {
    if (!renamingId) return;
    const trimmed = renameDraft.trim();
    if (trimmed) await onRenameProject(renamingId, trimmed);
    renamingId = null;
  }

  // "+ New Project" reuses ProjectPicker's own create form (via
  // initiallyCreating) rather than a second name+category implementation.
  // Hidden behind a click rather than always-rendered, so the list view
  // doesn't open with a bare, nothing-to-select dropdown.
  let showingNewProjectForm = $state(false);
</script>

<section class="projects">
  <div class="header">
    <h1 class="eyebrow">Projects</h1>
    <button class="link" onclick={onBack}>Back</button>
  </div>

  {#if selectedProjectId && selectedProject()}
    {@const project = selectedProject()!}
    <div class="detail">
      <button class="link" onclick={() => (selectedProjectId = null)}>&larr; All projects</button>
      <div class="detail-header">
        {#if renamingId === project.id}
          <input type="text" bind:value={renameDraft} aria-label="Rename project" />
          <button class="link" onclick={submitRename}>Save</button>
          <button class="link" onclick={() => (renamingId = null)}>Cancel</button>
        {:else}
          <h2>{project.name}</h2>
          <span class="pill">{CATEGORY_LABELS[project.category]}</span>
          <button class="link" onclick={() => startRename(project)}>Rename</button>
          <button
            class="link"
            onclick={() => onArchiveProject(project.id, project.archivedAt === null)}
          >
            {project.archivedAt === null ? 'Archive' : 'Unarchive'}
          </button>
        {/if}
      </div>

      <p class="stat-line">
        {sessionCount(project.id)} session{sessionCount(project.id) === 1 ? '' : 's'} ·
        {formatDuration(totalFocusMs(project.id))} focused
      </p>

      {#if sessionsForSelected().length === 0}
        <p class="empty">No sessions tagged with this project yet.</p>
      {:else}
        <ul>
          {#each sessionsForSelected() as summary (summary.id)}
            <li>
              <span class="task">{summary.task}</span>
              <span class="when">{formatDateTime(summary.completedAt)}</span>
              <span class="focus">{formatDuration(summary.actualFocusMs)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <div class="new-project">
      {#if showingNewProjectForm}
        <ProjectPicker
          projects={[]}
          selectedId={null}
          onSelect={() => (showingNewProjectForm = false)}
          onCreate={onCreateProject}
          initiallyCreating={true}
        />
      {:else}
        <button type="button" class="link" onclick={() => (showingNewProjectForm = true)}>+ New Project</button>
      {/if}
    </div>

    {#if visibleProjects.length === 0}
      <p class="empty">No projects yet.</p>
    {:else}
      <ul>
        {#each visibleProjects as project (project.id)}
          <li>
            <button type="button" class="project-row" onclick={() => (selectedProjectId = project.id)}>
              <span class="name">{project.name}</span>
              <span class="pill">{CATEGORY_LABELS[project.category]}</span>
              <span class="count">{sessionCount(project.id)} session{sessionCount(project.id) === 1 ? '' : 's'}</span>
              {#if project.archivedAt !== null}
                <span class="pill archived-pill">Archived</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <label class="show-archived">
      <input type="checkbox" bind:checked={showArchived} />
      Show archived
    </label>
  {/if}
</section>

<style>
  .projects {
    padding: 2.5rem 2rem;
    border-radius: 0.5rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .eyebrow {
    margin: 0;
    font-size: 0.85rem;
    /* Was a <p>; now a real <h1> (see the a11y audit — this was the
       page's only title-equivalent element, so it's the heading, not a
       kicker above one). Reset weight/line-height so the visual stays
       identical to the old paragraph. */
    font-weight: 400;
    line-height: 1.5;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .link {
    background: none;
    border: none;
    color: var(--timer-accent);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .new-project {
    margin-bottom: 1.5rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .project-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    border: none;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }

  .name {
    font-weight: 600;
    flex: 1;
  }

  .pill {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-muted);
  }

  .archived-pill {
    color: var(--danger);
  }

  .count {
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .show-archived {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0.75rem 0;
  }

  .detail-header h2 {
    margin: 0;
    font-size: 1.2rem;
  }

  .stat-line {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin: 0 0 1rem;
  }

  .detail li {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .detail .task {
    font-weight: 600;
    flex: 1;
  }

  .detail .when,
  .detail .focus {
    font-size: 0.78rem;
    color: var(--text-muted);
  }
</style>
