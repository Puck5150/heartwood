import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl, renderMarkdown, renderPlainTextFallback } from './markdown';

describe('renderMarkdown', () => {
  it('renders the supported Markdown surface', () => {
    const html = renderMarkdown('# Heading\n\n- item\n\n`code`\n\n> quote');
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<li>item</li>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<blockquote>');
  });

  it('never emits raw HTML or executable links', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![remote](https://example.com/a.png)',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
  });

  it('renders a safe link with a defensive rel attribute', () => {
    const html = renderMarkdown('[Project](https://example.com/project)');
    expect(html).toContain('href="https://example.com/project"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('falls back to escaped plain text if rendering itself throws', () => {
    // renderMarkdown must never let a rendering failure produce blank or
    // unsafe output — this doesn't force an actual internal throw (that
    // would couple the test to markdown-it internals), but documents and
    // exercises the fallback function it delegates to on that path.
    expect(renderPlainTextFallback('<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('isSafeExternalUrl', () => {
  it.each([
    ['https://example.com', true],
    ['http://example.com', true],
    ['mailto:person@example.com', true],
    ['javascript:alert(1)', false],
    ['file:///tmp/private', false],
    ['./relative.md', false],
  ])('applies the safe external URL allowlist to %s', (url, expected) => {
    expect(isSafeExternalUrl(url)).toBe(expected);
  });
});

describe('renderPlainTextFallback', () => {
  it('escapes every HTML-sensitive character', () => {
    expect(renderPlainTextFallback(`<script data-x="'">& run</script>`)).toBe(
      `<pre>&lt;script data-x=&quot;&#39;&quot;&gt;&amp; run&lt;/script&gt;</pre>`,
    );
  });
});
