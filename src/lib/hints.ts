// Pure first-occurrence-hint dismissal tracking. Persisted as one
// comma-separated settings string (matching every other setting's
// string-only wire type) rather than one settings key per hint, so a
// future hint never needs its own migration or key.

export type HintId = 'flow' | 'greenhouse' | 'touchGrass';

const HINT_IDS: readonly HintId[] = ['flow', 'greenhouse', 'touchGrass'];

export const HINT_TEXT: Record<HintId, string> = {
  flow: "This is Flow — quiet overtime that keeps counting instead of ending abruptly. Stay as long as it's useful, or step away when you're ready.",
  greenhouse:
    "The Greenhouse is where distracting thoughts go so they don't derail you — plant one now, deal with it later.",
  touchGrass:
    'Break and Touch Grass pause the clock without ending your session — come back anytime and pick up exactly where you left off.',
};

export function parseDismissedHints(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id): id is HintId => (HINT_IDS as string[]).includes(id));
  return [...new Set(ids)].join(',');
}

export function isHintDismissed(dismissedHints: string, id: HintId): boolean {
  return parseDismissedHints(dismissedHints).split(',').includes(id);
}

export function withHintDismissed(dismissedHints: string, id: HintId): string {
  if (isHintDismissed(dismissedHints, id)) return dismissedHints;
  const current = parseDismissedHints(dismissedHints);
  return current ? `${current},${id}` : id;
}
