<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { isSafeExternalUrl, renderMarkdown } from './markdown';

  async function defaultOpenExternal(url: string) {
    if (isTauri()) await openUrl(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  let {
    content,
    openExternal = defaultOpenExternal,
  }: {
    content: string;
    /** Overridable for tests; defaults to the real system-browser opener. */
    openExternal?: (url: string) => Promise<void>;
  } = $props();

  // The rendered HTML is already sanitized by renderMarkdown() (no raw
  // HTML, no images, only allowlisted-scheme links) — this handler exists
  // so an activated link never navigates the app's own window away, and so
  // the safety check is re-applied here rather than trusted a second time
  // from the generated markup alone.
  async function handleClick(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    if (!isSafeExternalUrl(anchor.href)) return;
    await openExternal(anchor.href);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="markdown-preview" onclick={handleClick}>
  {@html renderMarkdown(content)}
</div>

<style>
  .markdown-preview {
    font-size: 0.9rem;
    color: var(--text);
    line-height: 1.5;
  }

  .markdown-preview :global(h1),
  .markdown-preview :global(h2),
  .markdown-preview :global(h3) {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
  }

  .markdown-preview :global(p) {
    margin: 0 0 0.6rem;
  }

  .markdown-preview :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown-preview :global(ul),
  .markdown-preview :global(ol) {
    margin: 0 0 0.6rem;
    padding-left: 1.25rem;
  }

  .markdown-preview :global(blockquote) {
    margin: 0 0 0.6rem;
    padding: 0.3rem 0.75rem;
    border-left: 3px solid var(--border);
    color: var(--text-muted);
  }

  .markdown-preview :global(code) {
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    background: var(--surface);
    border-radius: 0.3rem;
    padding: 0.1rem 0.3rem;
  }

  .markdown-preview :global(pre) {
    margin: 0 0 0.6rem;
    padding: 0.6rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--surface);
    overflow-x: auto;
  }

  .markdown-preview :global(pre code) {
    background: none;
    padding: 0;
  }

  .markdown-preview :global(a) {
    color: var(--accent);
  }
</style>
