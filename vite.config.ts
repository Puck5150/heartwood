import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  // Component tests (MarkdownPreview.test.ts, SessionNotes.test.ts) render
  // real Svelte components via @testing-library/svelte under jsdom, which
  // needs Svelte's browser build rather than its default SSR build.
  ...(mode === 'test' ? { resolve: { conditions: ['browser'] } } : {}),
}))
