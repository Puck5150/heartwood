<script lang="ts">
  import MarkdownPreview from './MarkdownPreview.svelte';
  import { buildRevisionComparison, isBoundedForRichComparison, truncateToByteLimit } from './revisionDiff';
  import { MAX_FALLBACK_BYTES, revisionDisplayLabel, type LoadedNoteRevision, type NoteRevision } from './revisions';
  import { formatDateTime } from './format';

  let {
    task,
    sessionDate,
    currentContent,
    revisions,
    loadRevision,
    onRename,
    onBack,
  }: {
    sessionId: string;
    task: string;
    sessionDate: number;
    currentContent: string;
    currentHash: string | null;
    revisions: NoteRevision[];
    loadRevision: (id: string) => Promise<LoadedNoteRevision>;
    onRename: (id: string, label: string | null) => Promise<NoteRevision>;
    writesDisabled: boolean;
    onBack: () => void;
  } = $props();

  type ComparisonMode = 'changes' | 'preview';
  const MODE_ORDER: ComparisonMode[] = ['changes', 'preview'];

  // svelte-ignore state_referenced_locally
  let selectedId = $state<string | null>(revisions[0]?.id ?? null);
  let comparisonMode = $state<ComparisonMode>('changes');
  let loadedForId = $state<string | null>(null);
  let loadedContent = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');

  // Keeps a valid selection if the list changes underneath (e.g. a refresh
  // after rename) and the previously-selected id disappears.
  $effect(() => {
    if (selectedId !== null && !revisions.some((revision) => revision.id === selectedId)) {
      selectedId = revisions[0]?.id ?? null;
    }
  });

  const selectedRevision = $derived(revisions.find((revision) => revision.id === selectedId) ?? null);

  $effect(() => {
    const id = selectedId;
    if (!id) {
      loadedForId = null;
      loadedContent = null;
      loadError = null;
      return;
    }
    let cancelled = false;
    loadError = null;
    loadRevision(id).then(
      (loaded) => {
        if (cancelled) return;
        loadedForId = id;
        loadedContent = loaded.content;
      },
      (err) => {
        if (cancelled) return;
        console.error('Failed to load revision content:', err);
        loadedForId = id;
        loadedContent = null;
        loadError = "This revision's content is unavailable.";
      },
    );
    return () => {
      cancelled = true;
    };
  });

  const comparison = $derived.by(() => {
    if (loadedContent === null || loadedForId !== selectedId) return null;
    return buildRevisionComparison(loadedContent, currentContent);
  });

  const previewBounded = $derived(
    loadedContent !== null && loadedForId === selectedId && isBoundedForRichComparison(loadedContent),
  );

  const previewFallback = $derived.by(() => {
    if (loadedContent === null || loadedForId !== selectedId || previewBounded) return null;
    return truncateToByteLimit(loadedContent, MAX_FALLBACK_BYTES);
  });

  function selectRevision(id: string) {
    if (renamingId) return; // avoid discarding an in-progress rename
    selectedId = id;
    loadError = null;
  }

  function focusTab(next: ComparisonMode) {
    comparisonMode = next;
    document.getElementById(`revision-${next}-tab`)?.focus();
  }

  function handleModeTabsKeydown(event: KeyboardEvent) {
    const currentIndex = MODE_ORDER.indexOf(comparisonMode);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(MODE_ORDER[(currentIndex + 1) % MODE_ORDER.length]);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(MODE_ORDER[(currentIndex - 1 + MODE_ORDER.length) % MODE_ORDER.length]);
    }
  }

  function startRename() {
    if (!selectedRevision) return;
    renamingId = selectedRevision.id;
    renameDraft = selectedRevision.label ?? '';
  }

  function cancelRename() {
    renamingId = null;
  }

  async function commitRename() {
    if (!renamingId) return;
    const id = renamingId;
    const label = renameDraft.trim() === '' ? null : renameDraft;
    renamingId = null;
    try {
      await onRename(id, label);
    } catch (err) {
      console.error('Failed to rename revision:', err);
    }
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  }
</script>

<section class="revision-history">
  <div class="header">
    <div class="header-text">
      <p class="eyebrow">Revisions</p>
      <h1>{task}</h1>
      <p class="session-date">{formatDateTime(sessionDate)}</p>
    </div>
    <button type="button" class="link" onclick={onBack}>Back</button>
  </div>

  {#if revisions.length === 0}
    <p class="empty">No revisions yet. Checkpoints and automatic snapshots will appear here.</p>
  {:else}
    <div class="revision-layout">
      <ol class="revision-timeline" aria-label="Note revisions">
        {#each revisions as revision (revision.id)}
          <li>
            <button
              type="button"
              class="timeline-entry"
              aria-pressed={selectedId === revision.id}
              onclick={() => selectRevision(revision.id)}
            >
              <strong>{revisionDisplayLabel(revision)}</strong>
              <span class="timeline-meta">{formatDateTime(revision.createdAt)} · {revision.kind}</span>
            </button>
          </li>
        {/each}
      </ol>

      <section class="revision-comparison" aria-label="Revision comparison">
        {#if selectedRevision}
          <div class="comparison-header">
            {#if renamingId === selectedRevision.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                type="text"
                class="rename-input"
                aria-label="Revision label"
                bind:value={renameDraft}
                onkeydown={handleRenameKeydown}
                onblur={commitRename}
                autofocus
              />
            {:else}
              <span class="comparison-label">{revisionDisplayLabel(selectedRevision)}</span>
              <button type="button" class="link" onclick={startRename}>Rename</button>
            {/if}
          </div>

          <div
            class="mode-tabs"
            role="tablist"
            aria-label="Comparison view"
            tabindex="-1"
            onkeydown={handleModeTabsKeydown}
          >
            <button
              id="revision-changes-tab"
              type="button"
              class="mode-tab"
              role="tab"
              aria-selected={comparisonMode === 'changes'}
              aria-controls="revision-changes-panel"
              tabindex={comparisonMode === 'changes' ? 0 : -1}
              onclick={() => (comparisonMode = 'changes')}
            >
              Changes
            </button>
            <button
              id="revision-preview-tab"
              type="button"
              class="mode-tab"
              role="tab"
              aria-selected={comparisonMode === 'preview'}
              aria-controls="revision-preview-panel"
              tabindex={comparisonMode === 'preview' ? 0 : -1}
              onclick={() => (comparisonMode = 'preview')}
            >
              Preview
            </button>
          </div>

          {#if loadError}
            <p class="load-error" role="alert">{loadError}</p>
          {:else if comparisonMode === 'changes'}
            <div id="revision-changes-panel" role="tabpanel" aria-labelledby="revision-changes-tab">
              {#if comparison}
                <p class="line-ending-summary">
                  Revision: {comparison.fromLineEndings} · Current: {comparison.toLineEndings}
                </p>
                {#if comparison.oversized}
                  <p class="oversized-status" role="status">
                    This revision is too large to compare in full; showing a truncated excerpt.
                  </p>
                {/if}
                <div class="diff" role="table" aria-label="Changes since revision">
                  {#each comparison.lines as line, index (index)}
                    <div
                      class="diff-row"
                      class:added={line.kind === 'added'}
                      class:removed={line.kind === 'removed'}
                      class:marker={line.kind === 'marker'}
                      role="row"
                    >
                      <span class="diff-marker">{line.marker}</span>
                      <span class="diff-text">{line.text}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <div id="revision-preview-panel" role="tabpanel" aria-labelledby="revision-preview-tab">
              {#if previewFallback}
                <p class="oversized-status" role="status">
                  This revision is too large to render in full; showing a truncated excerpt.
                </p>
                <pre class="fallback-text">{previewFallback.text}</pre>
              {:else if loadedContent !== null}
                <MarkdownPreview content={loadedContent} />
              {/if}
            </div>
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</section>

<style>
  .revision-history {
    padding: 2.5rem 2rem;
    border-radius: 1.25rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .header-text {
    min-width: 0;
  }

  .eyebrow {
    margin: 0 0 0.3rem;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  h1 {
    margin: 0 0 0.2rem;
    font-size: 1.2rem;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .session-date {
    margin: 0;
    font-size: 0.82rem;
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
    flex-shrink: 0;
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .revision-layout {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
  }

  .revision-timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 12rem;
    flex-shrink: 0;
    max-height: 24rem;
    overflow-y: auto;
  }

  .timeline-entry {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    border-radius: 0.5rem;
    border: 1px solid transparent;
    background: var(--surface-secondary);
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .timeline-entry[aria-pressed='true'] {
    border-color: var(--accent);
  }

  .timeline-meta {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .revision-comparison {
    flex: 1;
    min-width: 0;
  }

  .comparison-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .comparison-label {
    font-weight: 600;
    color: var(--text);
    font-size: 0.9rem;
  }

  .rename-input {
    flex: 1;
    padding: 0.35rem 0.5rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface-secondary);
    color: var(--text);
    font-size: 0.9rem;
  }

  .mode-tabs {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }

  .mode-tab {
    padding: 0;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    cursor: pointer;
  }

  .mode-tab[aria-selected='true'] {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .load-error {
    font-size: 0.85rem;
    color: #b42318;
  }

  .line-ending-summary {
    margin: 0 0 0.5rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .oversized-status {
    margin: 0 0 0.5rem;
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .diff {
    max-height: 24rem;
    overflow-y: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.82rem;
  }

  .diff-row {
    display: flex;
    gap: 0.5rem;
    padding: 0.05rem 0.3rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .diff-row.added {
    background: color-mix(in srgb, green 12%, transparent);
  }

  .diff-row.removed {
    background: color-mix(in srgb, red 10%, transparent);
  }

  .diff-row.marker {
    color: var(--text-muted);
    font-style: italic;
  }

  .diff-marker {
    flex-shrink: 0;
    width: 1rem;
    text-align: center;
    font-weight: 700;
  }

  .diff-text {
    min-width: 0;
  }

  .fallback-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: ui-monospace, monospace;
    font-size: 0.82rem;
    max-height: 24rem;
    overflow-y: auto;
  }

  @media (max-width: 30rem) {
    .revision-layout {
      flex-direction: column;
    }

    .revision-timeline {
      width: 100%;
      max-height: 12rem;
    }
  }
</style>
