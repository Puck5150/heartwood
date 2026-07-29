// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownPreview from './MarkdownPreview.svelte';

afterEach(cleanup);

describe('MarkdownPreview', () => {
  it('opens a clicked safe link only through the injected external opener', async () => {
    const openExternal = vi.fn(async () => {});
    render(MarkdownPreview, {
      content: '[Project](https://example.com/project)',
      openExternal,
    });

    await fireEvent.click(screen.getByRole('link', { name: 'Project' }));

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/project');
  });

  it('does not call the opener when the click is outside any link', async () => {
    const openExternal = vi.fn(async () => {});
    render(MarkdownPreview, {
      content: 'Just plain text, no links here.',
      openExternal,
    });

    await fireEvent.click(screen.getByText('Just plain text, no links here.'));

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('renders supported Markdown content', () => {
    render(MarkdownPreview, { content: '# Title\n\nSome body text.', openExternal: vi.fn() });
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByText('Some body text.')).toBeTruthy();
  });
});
