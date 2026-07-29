<script lang="ts">
  import MarkdownPreview from './MarkdownPreview.svelte';
  import { buildRevisionComparison, isBoundedForRichComparison, truncateToByteLimit } from './revisionDiff';
  import { hasNoteContent } from './notes';
  import {
    MAX_FALLBACK_BYTES,
    revisionDisplayLabel,
    type CurrentNoteSnapshot,
    type LoadedNoteRevision,
    type NoteRevision,
    type RestoreRevisionResult,
  } from './revisions';
  import { formatDateTime } from './format';

  let {
    task,
    sessionDate,
    currentContent,
    currentHash,
    revisions,
    loadRevision,
    onRename,
    onRestore,
    onReloadComparison,
    writesDisabled,
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
    onRestore: (revisionId: string, expectedCurrentHash: string | null) => Promise<RestoreRevisionResult>;
    onReloadComparison: () => Promise<CurrentNoteSnapshot>;
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
  let confirmingRestore = $state(false);
  let restoring = $state(false);
  let restoreStatus = $state<string | null>(null);
  /** Set when a restore/reload attempt reports the current note changed
   * since it was last observed — the plain "Confirm restore" flow is
   * withheld until the user explicitly reloads the comparison. */
  let staleRestore = $state(false);
  // Local, independently-overridable mirror of the current-note props:
  // synced from them whenever the caller's own state changes (e.g.
  // navigating to a different session), but also updated directly after a
  // successful restore/reload so this component doesn't have to wait for
  // a prop round-trip to reflect what it already knows just happened.
  // svelte-ignore state_referenced_locally
  let effectiveCurrentContent = $state(currentContent);
  // svelte-ignore state_referenced_locally
  let effectiveCurrentHash = $state(currentHash);

  $effect(() => {
    effectiveCurrentContent = currentContent;
    effectiveCurrentHash = currentHash;
  });

  // Keeps a valid selection if the list changes underneath: the previously
  // selected id disappeared (e.g. a refresh after rename), or there was no
  // selection yet because the list was still empty when this component
  // first mounted (the real Revisions view always mounts before its async
  // listNoteRevisions() load resolves) — either way, fall back to the
  // newest entry once one exists.
  $effect(() => {
    if (selectedId === null || !revisions.some((revision) => revision.id === selectedId)) {
      selectedId = revisions[0]?.id ?? null;
    }
  });

  const selectedRevision = $derived(revisions.find((revision) => revision.id === selectedId) ?? null);
  const selectedMatchesCurrent = $derived(
    selectedRevision !== null && selectedRevision.contentHash === effectiveCurrentHash,
  );
  const restoreConfirmationDetail = $derived.by(() => {
    if (!selectedRevision) return '';
    const label = revisionDisplayLabel(selectedRevision);
    return hasNoteContent(effectiveCurrentContent)
      ? `Replace the current note with "${label}"? The current note will be saved as a new revision first.`
      : `Restore "${label}" as the current note?`;
  });

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
    return buildRevisionComparison(loadedContent, effectiveCurrentContent);
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
    confirmingRestore = false;
    restoreStatus = null;
    staleRestore = false;
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

  function requestRestore() {
    if (renamingId || writesDisabled || selectedMatchesCurrent || !selectedRevision) return;
    confirmingRestore = true;
    restoreStatus = null;
    staleRestore = false;
  }

  function cancelRestore() {
    confirmingRestore = false;
  }

  /** Confirms the restore. A stale-conflict response never reuses the
   * active editor's Keep/Reload prompt — it withholds a fresh
   * confirmation behind an explicit, non-destructive Reload comparison
   * step instead, so a second confirm always reflects what's actually on
   * disk right now, never what this component last happened to render. */
  async function confirmRestore() {
    if (!selectedRevision) return;
    confirmingRestore = false;
    restoring = true;
    restoreStatus = null;
    try {
      const result = await onRestore(selectedRevision.id, effectiveCurrentHash);
      effectiveCurrentContent = result.note.content;
      effectiveCurrentHash = result.note.content_hash;
      restoreStatus = 'Restored.';
    } catch (err) {
      const normalized = err as { code?: string } | null;
      if (normalized && typeof normalized === 'object' && normalized.code === 'conflict') {
        staleRestore = true;
      } else {
        console.error('Failed to restore revision:', err);
        restoreStatus = 'Failed to restore this revision.';
      }
    } finally {
      restoring = false;
    }
  }

  async function handleReloadComparison() {
    try {
      const snapshot = await onReloadComparison();
      effectiveCurrentContent = snapshot.content;
      effectiveCurrentHash = snapshot.contentHash;
      staleRestore = false;
    } catch (err) {
      console.error('Failed to reload the current note for comparison:', err);
    }
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

          <div class="restore-controls">
            {#if staleRestore}
              <p class="restore-alert" role="alert">
                The current note changed since this comparison was loaded.
              </p>
              <button type="button" class="link" onclick={handleReloadComparison}>Reload comparison</button>
            {:else if confirmingRestore}
              <div class="restore-confirmation" role="alert">
                <p>{restoreConfirmationDetail}</p>
                <button type="button" class="link" onclick={cancelRestore}>Cancel</button>
                <button type="button" class="link danger" onclick={confirmRestore}>Confirm restore</button>
              </div>
            {:else}
              <button
                type="button"
                class="link"
                disabled={writesDisabled || selectedMatchesCurrent || restoring}
                onclick={requestRestore}
              >
                Restore this revision
              </button>
            {/if}
            {#if restoreStatus}
              <p class="restore-status" role="status">{restoreStatus}</p>
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

  .link.danger {
    color: var(--text-muted);
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

  .restore-controls {
    margin-bottom: 0.9rem;
  }

  .restore-controls .link:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .restore-confirmation {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  .restore-confirmation p {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text);
  }

  .restore-alert {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
    color: #b42318;
  }

  .restore-status {
    margin: 0.4rem 0 0;
    font-size: 0.82rem;
    color: var(--text-muted);
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
