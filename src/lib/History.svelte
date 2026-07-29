<script lang="ts">
  import type { SessionSummary } from './history';
  import type { ParkedThought } from './parkingLot';
  import { formatDateTime, formatDuration } from './format';
  import { buildExportData, formatExportAsJson, formatExportAsMarkdown } from './export';
  import { isTauri } from '@tauri-apps/api/core';
  import { save } from '@tauri-apps/plugin-dialog';
  import { writeTextFile } from '@tauri-apps/plugin-fs';
  import MarkdownPreview from './MarkdownPreview.svelte';
  import FolderOpen from 'lucide-svelte/icons/folder-open';

  let {
    summaries,
    parkedThoughts,
    onBack,
    onDeleteSession,
    onDeleteAll,
    onOpenNotesFolder,
  }: {
    summaries: SessionSummary[];
    parkedThoughts: ParkedThought[];
    onBack: () => void;
    onDeleteSession: (id: string) => void;
    onDeleteAll: () => void;
    onOpenNotesFolder: () => Promise<void>;
  } = $props();

  let exportError = $state<string | null>(null);

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
    return `pomodoro-parking-lot-export-${date}.${extension}`;
  }

  async function saveExport(extension: 'md' | 'json', filterName: string, content: string, mimeType: string) {
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
    const data = buildExportData(summaries, parkedThoughts, Date.now());
    void saveExport('md', 'Markdown', formatExportAsMarkdown(data), 'text/markdown');
  }

  function exportJson() {
    const data = buildExportData(summaries, parkedThoughts, Date.now());
    void saveExport('json', 'JSON', formatExportAsJson(data), 'application/json');
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
    <p class="eyebrow">Session history</p>
    <button class="link" onclick={onBack}>Back</button>
  </div>

  <div class="export-row">
    <span class="export-label">Export</span>
    <button class="link" onclick={exportMarkdown}>Markdown</button>
    <button class="link" onclick={exportJson}>JSON</button>
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
            </div>
            {#if confirmingDeleteId === summary.id}
              <div class="row-confirm">
                <button class="link" onclick={() => (confirmingDeleteId = null)}>Cancel</button>
                <button class="link danger" onclick={() => confirmDeleteSession(summary.id)}>
                  Confirm
                </button>
              </div>
            {:else}
              <button
                class="link danger row-delete"
                onclick={() => (confirmingDeleteId = summary.id)}
              >
                Delete
              </button>
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
            <div>
              <dt>Total</dt>
              <dd>{formatDuration(summary.totalElapsedMs)}</dd>
            </div>
            <div>
              <dt>Parked</dt>
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
          Delete all session history <strong>and all parked thoughts</strong>? This cannot be
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
</section>

<style>
  .history {
    padding: 2.5rem 2rem;
    border-radius: 1.25rem;
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
    color: #b42318;
  }

  .eyebrow {
    margin: 0;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .link {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .link.danger {
    color: var(--text-muted);
  }

  .row-delete {
    flex-shrink: 0;
  }

  .row-confirm {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-shrink: 0;
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
    border-radius: 0.7rem;
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

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin: 0;
  }

  dt {
    font-size: 0.68rem;
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
</style>
