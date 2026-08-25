/** Params for Svelte's `scale` transition, respecting reduced motion.
 * app.css's global `prefers-reduced-motion` rule only catches plain CSS
 * `animation`/`transition` — Svelte's `in:`/`out:` directives run through
 * the Web Animations API and slip past it, so callers using them need this
 * instead. */
export function growInTransitionParams(reduced: boolean): { start: number; opacity: number; duration: number } {
  return reduced ? { start: 1, opacity: 1, duration: 0 } : { start: 1.06, opacity: 1, duration: 220 };
}
