<script lang="ts">
  import type { SessionSummary } from './history';
  import type { ParkedThought } from './parkingLot';
  import { formatDateTime, formatDuration } from './format';
  import { buildExportData, formatExportAsCsv, formatExportAsMarkdown } from './export';
  import { isTauri } from '@tauri-apps/api/core';
  import { save } from '@tauri-apps/plugin-dialog';
  import { writeTextFile } from '@tauri-apps/plugin-fs';
  import MarkdownPreview from './MarkdownPreview.svelte';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import FileClock from 'lucide-svelte/icons/file-clock';
  import ProjectPicker from './ProjectPicker.svelte';
  import { CATEGORY_LABELS, type Project, type ProjectCategory } from './projects';
  import BreakdownChart from './BreakdownChart.svelte';
  import { filterSummariesByRange, groupByCategory, groupByProjectInCategory, type TimeRange } from './breakdown';

  let {
    summaries,
    parkedThoughts,
    onBack,
    onDeleteSession,
    onDeleteAll,
    onOpenNotesFolder,
    onViewRevisions,
    projects,
    onAssignProject,
    onCreateProject,
  }: {
    summaries: SessionSummary[];
    parkedThoughts: ParkedThought[];
    onBack: () => void;
    onDeleteSession: (id: string) => void;
    onDeleteAll: () => void;
    onOpenNotesFolder: () => Promise<void>;
    onViewRevisions: (sessionId: string, task: string, sessionDate: number) => void;
    projects: Project[];
    onAssignProject: (sessionId: string, projectId: string | null) => Promise<void>;
    onCreateProject: (name: string, category: ProjectCategory) => Promise<Project>;
  } = $props();

  let exportError = $state<string | null>(null);

  let assigningProjectId = $state<string | null>(null);

  function projectFor(summary: SessionSummary): Project | undefined {
    return projects.find((p) => p.id === summary.projectId);
  }

  let activeTab = $state<'list' | 'breakdown'>('list');
  let timeRange = $state<TimeRange>('all');
  let drilledCategory = $state<ProjectCategory | null>(null);

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));
  const rangedSummaries = $derived(filterSummariesByRange(summaries, timeRange, Date.now()));
  const categoryTotals = $derived(groupByCategory(rangedSummaries, projectsById));
  const projectTotalsInDrilledCategory = $derived(
    drilledCategory ? groupByProjectInCategory(rangedSummaries, projectsById, drilledCategory) : [],
  );

  const CATEGORY_KEYS: ProjectCategory[] = ['personal', 'work', 'study'];

  /** Ties each category to a stable identity color (see app.css's
   * --category-* tokens) instead of the single --timer-accent hue at
   * varying opacity — lets categories read apart from each other at a
   * glance. A project drill-down reuses its parent category's color for
   * every row, so the whole drill-down still reads as "this category";
   * opacity alone differentiates the projects within it. */
  const CATEGORY_COLORS: Record<ProjectCategory | 'untagged', string> = {
    personal: 'var(--category-personal)',
    work: 'var(--category-work)',
    study: 'var(--category-study)',
    untagged: 'var(--text-muted)',
  };

  function handleCategorySegmentClick(label: string) {
    const match = categoryTotals.find((c) => c.label === label);
    if (match && CATEGORY_KEYS.includes(match.key as ProjectCategory)) {
      drilledCategory = match.key as ProjectCategory;
    }
  }

  /** WAI-ARIA tabs pattern: ArrowLeft/ArrowRight move both the selection
   * and keyboard focus between the two tabs, wrapping at either end —
   * matches FocusSupportPanels.svelte's own two-tab implementation. */
  function handleTabKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = activeTab === 'list' ? 'breakdown' : 'list';
    activeTab = next;
    document.getElementById(next === 'list' ? 'history-tab-list' : 'history-tab-breakdown')?.focus();
  }

  async function handleOpenNotesFolder() {
    try {
      await onOpenNotesFolder();
      exportError = null;
    } catch (err) {
      console.error('Failed to open notes folder:', err);
      exportError = 'Failed to open the notes folder.';
    }
  }

  // Export is read-only: it only reads what's already loaded and never
  // touches the repository. A plain browser download (Blob + anchor
  // click) doesn't reliably work inside Tauri's WebView — navigation to a
  // blob: URL is silently blocked there, the same class of issue as
  // window.confirm() not working — so Tauri gets the officially-supported
  // native path instead: a save dialog, which auto-scopes the fs plugin
  // to exactly the path the user picked, then a write to that path.
  function downloadInBrowser(filename: string, content: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function exportFilename(extension: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return `heartwood-export-${date}.${extension}`;
  }

  async function saveExport(extension: 'md' | 'csv', filterName: string, content: string, mimeType: string) {
    const filename = exportFilename(extension);
    try {
      if (isTauri()) {
        const path = await save({
          defaultPath: filename,
          filters: [{ name: filterName, extensions: [extension] }],
        });
        if (!path) return; // user cancelled the dialog
        await writeTextFile(path, content);
      } else {
        downloadInBrowser(filename, content, mimeType);
      }
      exportError = null;
    } catch (err) {
      console.error('Failed to export data:', err);
      exportError = 'Failed to export data.';
    }
  }

  function exportMarkdown() {
    const data = buildExportData(summaries, parkedThoughts, Date.now(), projects);
    void saveExport('md', 'Markdown', formatExportAsMarkdown(data), 'text/markdown');
  }

  function exportCsv() {
    const data = buildExportData(summaries, parkedThoughts, Date.now(), projects);
    void saveExport('csv', 'CSV', formatExportAsCsv(data), 'text/csv');
  }

  // window.confirm() is not reliably supported across Tauri's WebView
  // backends (no dialog delegate wired up by default, so it can silently
  // return without ever showing anything) — an in-app confirmation step
  // is more reliable and fits the existing design better than a native
  // OS dialog would anyway. Both individual and bulk deletes use the same
  // pattern for consistency.
  let confirmingDeleteAll = $state(false);
  let confirmingDeleteId = $state<string | null>(null);

  function confirmDeleteAll() {
    confirmingDeleteAll = false;
    onDeleteAll();
  }

  function confirmDeleteSession(id: string) {
    confirmingDeleteId = null;
    onDeleteSession(id);
  }
</script>

<section class="history">
  <div class="header">
    <h1 class="eyebrow">Session history</h1>
    <button class="link" onclick={onBack}>Back</button>
  </div>

  <div class="tabs" role="tablist" aria-label="History view">
    <button
      type="button"
      role="tab"
      id="history-tab-list"
      aria-selected={activeTab === 'list'}
      aria-controls="history-panel-list"
      tabindex={activeTab === 'list' ? 0 : -1}
      onclick={() => (activeTab = 'list')}
      onkeydown={handleTabKeydown}
    >
      Sessions
    </button>
    <button
      type="button"
      role="tab"
      id="history-tab-breakdown"
      aria-selected={activeTab === 'breakdown'}
      aria-controls="history-panel-breakdown"
      tabindex={activeTab === 'breakdown' ? 0 : -1}
      onclick={() => (activeTab = 'breakdown')}
      onkeydown={handleTabKeydown}
    >
      Breakdown
    </button>
  </div>

  {#if activeTab === 'breakdown'}
    <div
      id="history-panel-breakdown"
      role="tabpanel"
      aria-labelledby="history-tab-breakdown"
      tabindex="0"
      class="breakdown-panel"
    >
      <div class="range-toggle" role="radiogroup" aria-label="Time range">
        {#each [['week', 'This week'], ['month', 'This month'], ['all', 'All time']] as [value, label] (value)}
          <label class="range-option" class:selected={timeRange === value}>
            <input
              type="radio"
              name="time-range"
              value={value}
              checked={timeRange === value}
              onchange={() => {
                timeRange = value as TimeRange;
                drilledCategory = null;
              }}
              class="range-input"
            />
            {label}
          </label>
        {/each}
      </div>

      {#if drilledCategory}
        {@const drilledCategoryColor = CATEGORY_COLORS[drilledCategory]}
        <button type="button" class="link" onclick={() => (drilledCategory = null)}>&larr; All categories</button>
        <BreakdownChart
          data={projectTotalsInDrilledCategory.map((p) => ({
            label: p.label,
            totalMs: p.totalMs,
            key: p.projectId ?? undefined,
            color: drilledCategoryColor,
          }))}
        />
      {:else}
        <BreakdownChart
          data={categoryTotals.map((c) => ({
            label: c.label,
            totalMs: c.totalMs,
            key: c.key,
            color: CATEGORY_COLORS[c.key],
          }))}
          onSegmentClick={handleCategorySegmentClick}
        />
      {/if}
    </div>
  {:else}
    <div id="history-panel-list" role="tabpanel" aria-labelledby="history-tab-list" tabindex="0">
    <div class="export-row">
      <span class="export-label">Export</span>
      <button class="link" onclick={exportMarkdown}>Markdown</button>
      <button class="link" onclick={exportCsv}>CSV</button>
      <button
        type="button"
        class="link folder-link"
        onclick={handleOpenNotesFolder}
        title="Open notes folder"
      >
        <FolderOpen size={14} aria-hidden="true" />
        Notes folder
      </button>
    </div>
    {#if exportError}
      <p class="export-error" role="alert">{exportError}</p>
    {/if}

    {#if summaries.length === 0}
      <p class="empty">No completed sessions yet.</p>
    {:else}
      <ul>
      {#each summaries as summary (summary.id)}
        <li>
          <div class="row-top">
            <div class="row-top-text">
              <span class="task">{summary.task}</span>
              <span class="when">{formatDateTime(summary.completedAt)}</span>
              {#if assigningProjectId === summary.id}
                <ProjectPicker
                  projects={projects}
                  selectedId={summary.projectId}
                  onSelect={async (id) => {
                    await onAssignProject(summary.id, id);
                    assigningProjectId = null;
                  }}
                  onCreate={onCreateProject}
                />
              {:else}
                <button type="button" class="project-tag" onclick={() => (assigningProjectId = summary.id)}>
                  {#if projectFor(summary)}
                    {projectFor(summary)?.name} · {CATEGORY_LABELS[projectFor(summary)!.category]}
                  {:else}
                    + Project
                  {/if}
                </button>
              {/if}
            </div>
            {#if confirmingDeleteId === summary.id}
              <div class="row-confirm">
                <span class="row-confirm-text">Delete this session, its current note, and its revision history?</span>
                <button class="link" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
                <button class="link danger" onclick={() => confirmDeleteSession(summary.id)}>
                  Confirm
                </button>
              </div>
            {:else}
              <div class="row-actions">
                {#if summary.noteContent || summary.revisionCount > 0}
                  <button
                    type="button"
                    class="icon-link"
                    title="View note revisions"
                    aria-label={`View revisions for ${summary.task}`}
                    onclick={() => onViewRevisions(summary.id, summary.task, summary.completedAt)}
                  >
                    <FileClock size={16} aria-hidden="true" />
                  </button>
                {/if}
                <button
                  class="link danger row-delete"
                  onclick={() => (confirmingDeleteId = summary.id)}
                >
                  Delete
                </button>
              </div>
            {/if}
          </div>
          <dl class="stats">
            <div>
              <dt>Focus</dt>
              <dd>{formatDuration(summary.actualFocusMs)}</dd>
            </div>
            {#if summary.actualFocusMs < summary.plannedFocusMs}
              <div>
                <dt>Planned</dt>
                <dd>{formatDuration(summary.plannedFocusMs)}</dd>
              </div>
            {/if}
            {#if summary.flowMs > 0}
              <div>
                <dt>Flow</dt>
                <dd>{formatDuration(summary.flowMs)}</dd>
              </div>
            {/if}
            {#if summary.tookBreak}
              <div>
                <dt>Break</dt>
                <dd>{formatDuration(summary.breakMs)}</dd>
              </div>
            {/if}
            {#if summary.breakIntermissionMs > 0}
              <div>
                <dt>Breaks</dt>
                <dd>{formatDuration(summary.breakIntermissionMs)}</dd>
              </div>
            {/if}
            {#if summary.touchGrassMs > 0}
              <div>
                <dt>Touch Grass</dt>
                <dd>{formatDuration(summary.touchGrassMs)}</dd>
              </div>
            {/if}
            <div>
              <dt>Total</dt>
              <dd>{formatDuration(summary.totalElapsedMs)}</dd>
            </div>
            <div>
              <dt>Planted</dt>
              <dd>{summary.parkedThoughtCount}</dd>
            </div>
          </dl>
          {#if summary.noteContent}
            <div class="note">
              <MarkdownPreview content={summary.noteContent} />
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    <div class="delete-all">
      {#if confirmingDeleteAll}
        <p class="confirm-text">
          Delete all sessions, planted thoughts, current notes, and revision history? This cannot be
          undone.
        </p>
        <div class="confirm-actions">
          <button class="link" onclick={() => (confirmingDeleteAll = false)}>Cancel</button>
          <button class="link danger" onclick={confirmDeleteAll}>Yes, delete everything</button>
        </div>
      {:else}
        <button class="link danger" onclick={() => (confirmingDeleteAll = true)}>
          Delete all data
        </button>
      {/if}
    </div>
    {/if}
    </div>
  {/if}
</section>

<style>
  .history {
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

  .export-row {
    display: flex;
    align-items: baseline;
    gap: 0.9rem;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .export-label {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .export-error {
    margin: -1rem 0 1.5rem;
    font-size: 0.8rem;
    color: var(--danger);
  }

  .eyebrow {
    margin: 0;
    font-size: 0.85rem;
    /* Was a <p>; now a real <h1> (see the a11y audit — this was the page's
       only title-equivalent element, so it's the heading, not a kicker
       above one). Reset weight/line-height so the visual stays identical
       to the old paragraph. */
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

  .link.danger {
    color: var(--danger);
  }

  .row-delete {
    flex-shrink: 0;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .icon-link {
    display: inline-flex;
    align-items: center;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  .row-confirm {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .row-confirm-text {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .delete-all {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
    text-align: center;
  }

  .confirm-text {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .confirm-actions {
    display: flex;
    justify-content: center;
    gap: 1.25rem;
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-height: 24rem;
    overflow-y: auto;
  }

  li {
    padding: 0.9rem 1rem;
    border-radius: 0.5rem;
    background: var(--surface-secondary);
  }

  .row-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }

  .row-top-text {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    min-width: 0;
  }

  .task {
    font-weight: 600;
    color: var(--text);
    font-size: 0.95rem;
  }

  .when {
    font-size: 0.78rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .project-tag {
    font-size: 0.78rem;
    padding: 0.15rem 0.5rem;
    /* >=999px, not 100px: appearanceTokens.test.ts's 8px card/frame radius
       contract only exempts pill/circular shapes at that threshold (see
       its radiiInPx doc comment) — a literal 100px would still be flagged
       as a "card" radius and fail that test. */
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin: 0;
  }

  dt {
    /* Matches SessionReview's own stat-label size — was 0.68rem
       (10.88px), under the 11px legibility floor. */
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.1rem;
  }

  dd {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .note {
    margin: 0.75rem 0 0;
    padding: 0.6rem 0.7rem;
    border-radius: 0.5rem;
    background: var(--surface);
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .folder-link {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .tabs {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    background: none;
    border: none;
    padding: 0.5rem 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }

  .tabs button[aria-selected='true'] {
    color: var(--text);
    border-bottom-color: var(--timer-accent);
  }

  .breakdown-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .range-toggle {
    display: flex;
    gap: 0.5rem;
  }

  .range-option {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 0.8rem;
    padding: 0.3rem 0.7rem;
    /* >=999px, not 100px: appearanceTokens.test.ts's 8px card/frame radius
       contract only exempts pill/circular shapes at that threshold (see
       .project-tag's own doc comment above) — a literal 100px would still
       be flagged as a "card" radius and fail that test. */
    border-radius: 999px;
    /* var(--text-muted), not var(--border): see BreakdownChart.svelte's
       .toggle-button for the full reasoning — --border only measures
       ~1.5-1.8:1 against --surface, under WCAG 1.4.11's 3:1 floor;
       --text-muted is already verified ≥4.75:1 against --surface. */
    border: 1px solid var(--text-muted);
    background: var(--surface-secondary);
    color: var(--text-muted);
    cursor: pointer;
  }

  .range-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .range-option:focus-within {
    outline: 2px solid var(--timer-accent);
    outline-offset: 2px;
  }

  .range-option.selected {
    background: var(--surface);
    color: var(--text);
    border-color: var(--timer-accent);
  }
</style>
