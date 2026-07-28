<script lang="ts">
  import MarkdownPreview from './MarkdownPreview.svelte';

  let {
    content,
    onChange,
    onBlur,
    disabled = false,
  }: {
    content: string;
    onChange: (content: string) => void;
    /** Called when the textarea loses focus, so a debounced autosave still
     * in flight can be flushed immediately rather than waiting out its
     * delay — e.g. right before the user clicks a button that moves them
     * off this screen entirely. */
    onBlur?: () => void;
    /** True when this session's note file is missing or unreadable —
     * editing is disabled outright rather than letting the user keep
     * typing into a draft that has nowhere safe to land. Never used to
     * paper over a conflict (that keeps editing enabled; see
     * App.svelte's noteStorageIssue handling). */
    disabled?: boolean;
  } = $props();

  type Mode = 'edit' | 'preview';
  const TAB_ORDER: Mode[] = ['edit', 'preview'];

  // Local to this component instance — Edit is always the default, and
  // switching sessions remounts this component fresh (App.svelte keys its
  // lifecycle to the current session), so there's no stale mode to reset.
  let mode = $state<Mode>('edit');

  function focusTab(next: Mode) {
    mode = next;
    document.getElementById(`note-${next}-tab`)?.focus();
  }

  /** Standard ARIA tabs keyboard behavior: Left/Right cycle, Home/End jump
   * to the ends. Only two tabs exist today, but this reads correctly if a
   * third is ever added. */
  function handleTabsKeydown(event: KeyboardEvent) {
    const currentIndex = TAB_ORDER.indexOf(mode);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(TAB_ORDER[(currentIndex + 1) % TAB_ORDER.length]);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(TAB_ORDER[(currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length]);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusTab(TAB_ORDER[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusTab(TAB_ORDER[TAB_ORDER.length - 1]);
    }
  }
</script>

<div class="session-notes">
  <div class="mode-tabs" role="tablist" aria-label="Note view" tabindex="-1" onkeydown={handleTabsKeydown}>
    <button
      id="note-edit-tab"
      type="button"
      class="mode-tab"
      role="tab"
      aria-selected={mode === 'edit'}
      aria-controls="note-edit-panel"
      tabindex={mode === 'edit' ? 0 : -1}
      onclick={() => (mode = 'edit')}
    >
      Edit
    </button>
    <button
      id="note-preview-tab"
      type="button"
      class="mode-tab"
      role="tab"
      aria-selected={mode === 'preview'}
      aria-controls="note-preview-panel"
      tabindex={mode === 'preview' ? 0 : -1}
      onclick={() => (mode = 'preview')}
    >
      Preview
    </button>
  </div>

  <div class="note-body">
    {#if mode === 'edit'}
      <div id="note-edit-panel" role="tabpanel" aria-labelledby="note-edit-tab">
        <textarea
          aria-label="Notes"
          value={content}
          oninput={(event) => onChange(event.currentTarget.value)}
          onblur={() => onBlur?.()}
          placeholder="Jot down anything about this session…"
          rows="4"
          {disabled}
        ></textarea>
      </div>
    {:else}
      <div id="note-preview-panel" class="preview-panel" role="tabpanel" aria-labelledby="note-preview-tab">
        <MarkdownPreview {content} />
      </div>
    {/if}
  </div>
</div>

<style>
  .session-notes {
    margin-top: 1.5rem;
    padding: 1.25rem;
    border-radius: 1rem;
    background: var(--surface-secondary);
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

  .mode-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Shared dimensions so switching tabs never shifts the timer, parking
   * lot, or review controls around it. */
  .note-body {
    min-height: 5.75rem;
    max-height: 12rem;
    overflow-y: auto;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.6rem 0.75rem;
    border-radius: 0.6rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
    resize: vertical;
    min-height: 5rem;
  }

  textarea:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .preview-panel {
    padding: 0.6rem 0.75rem;
    border-radius: 0.6rem;
    border: 1px solid var(--border);
    background: var(--surface);
    min-height: 5rem;
    box-sizing: border-box;
  }
</style>
