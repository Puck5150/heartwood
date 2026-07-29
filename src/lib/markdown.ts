// Configured Markdown renderer and safe-URL policy for the note preview.
// Deliberately restrictive: raw HTML, images, and unsafe URL schemes are
// disabled at the renderer level (not just hidden with CSS), so a rendering
// bug can't accidentally leak executable content into the preview.

import MarkdownIt from 'markdown-it';

/** Only these schemes may ever appear in a rendered link's `href` — every
 * other scheme (including no scheme, i.e. a relative path) is rejected.
 * `new URL()` throwing (a malformed or scheme-less URL) is treated the
 * same as an unsafe scheme, not as "safe by default". */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function renderPlainTextFallback(content: string): string {
  const escaped = content
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  return `<pre>${escaped}</pre>`;
}

const markdown = new MarkdownIt({
  html: false, // never pass through raw HTML written in the note
  linkify: false, // only explicit [text](url) links, not bare-URL autolinking
  typographer: false,
  breaks: false,
});

// Images are disabled outright — no automatic remote media loads, ever.
markdown.disable('image');
// Applied both to reject an unsafe href outright (markdown-it skips
// rendering the link as a link, falling back to plain text) and reused
// directly by MarkdownPreview.svelte before honoring a click.
markdown.validateLink = isSafeExternalUrl;

// Defense in depth: even though every rendered link already passed
// validateLink, add rel="noopener noreferrer" (not target, which
// MarkdownPreview.svelte's own click interception handles) so a link
// image_open`token can never end up wired to `window.opener`.
const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** Renders sanitized HTML for the note preview. Never throws — a rendering
 * failure falls back to escaped plain text rather than blank or unsafe
 * output, per Phase 4B's error-handling contract for Markdown rendering. */
export function renderMarkdown(content: string): string {
  try {
    return markdown.render(content);
  } catch {
    return renderPlainTextFallback(content);
  }
}
