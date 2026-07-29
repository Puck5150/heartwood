import { describe, expect, it } from 'vitest';
import {
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  MAX_FALLBACK_BYTES,
  normalizeRevisionLabel,
  revisionDisplayLabel,
  validateRevisionPair,
  type NoteRevision,
  type RevisionKind,
  type RevisionReason,
} from './revisions';

function revision(overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    id: 'r1',
    sessionId: 's1',
    contentHash: 'hash',
    kind: 'automatic',
    reason: 'session_completed',
    label: null,
    createdAt: 1000,
    ...overrides,
  };
}

describe('validateRevisionPair', () => {
  const validPairs: [RevisionKind, RevisionReason][] = [
    ['automatic', 'session_started'],
    ['automatic', 'session_completed'],
    ['automatic', 'review_finalized'],
    ['checkpoint', 'manual'],
    ['safety', 'before_clear'],
    ['safety', 'before_restore'],
    ['safety', 'before_external_overwrite'],
    ['safety', 'before_external_reload'],
  ];

  it.each(validPairs)('accepts %s/%s', (kind, reason) => {
    expect(validateRevisionPair(kind, reason)).toBe(true);
  });

  const invalidPairs: [RevisionKind, RevisionReason][] = [
    ['checkpoint', 'before_restore'],
    ['automatic', 'manual'],
    ['safety', 'session_started'],
    ['checkpoint', 'session_completed'],
    ['automatic', 'before_clear'],
  ];

  it.each(invalidPairs)('rejects %s/%s', (kind, reason) => {
    expect(validateRevisionPair(kind, reason)).toBe(false);
  });
});

describe('normalizeRevisionLabel', () => {
  it('passes through a trimmed non-empty label', () => {
    expect(normalizeRevisionLabel('  Launch draft  ')).toBe('Launch draft');
  });

  it('normalizes null and whitespace-only to null', () => {
    expect(normalizeRevisionLabel(null)).toBeNull();
    expect(normalizeRevisionLabel('   ')).toBeNull();
    expect(normalizeRevisionLabel('')).toBeNull();
  });

  it('accepts exactly 80 Unicode characters', () => {
    const label = 'x'.repeat(80);
    expect(normalizeRevisionLabel(label)).toBe(label);
  });

  it('throws over the 80-character limit', () => {
    expect(() => normalizeRevisionLabel('x'.repeat(81))).toThrow();
  });

  it('counts Unicode characters, not UTF-16 code units', () => {
    // Each of these emoji is a surrogate pair (2 UTF-16 units) but 1
    // Unicode "character" for the purposes of the 80-character limit.
    const label = '😀'.repeat(80);
    expect(normalizeRevisionLabel(label)).toBe(label);
    expect(() => normalizeRevisionLabel('😀'.repeat(81))).toThrow();
  });
});

describe('revisionDisplayLabel', () => {
  it('prefers a custom label when present', () => {
    expect(revisionDisplayLabel(revision({ label: 'My checkpoint' }))).toBe('My checkpoint');
  });

  const defaultLabels: [RevisionReason, string][] = [
    ['session_started', 'Session started'],
    ['session_completed', 'Session complete'],
    ['review_finalized', 'Review finalized'],
    ['manual', 'Checkpoint'],
    ['before_clear', 'Before clear'],
    ['before_restore', 'Before restore'],
    ['before_external_overwrite', 'Before external overwrite'],
    ['before_external_reload', 'Before external reload'],
  ];

  it.each(defaultLabels)('falls back to the friendly reason for %s', (reason, expected) => {
    expect(revisionDisplayLabel(revision({ reason, label: null }))).toBe(expected);
  });
});

describe('thresholds', () => {
  it('matches the spec-defined bounds', () => {
    expect(MAX_DIFF_BYTES).toBe(524_288);
    expect(MAX_DIFF_LINES).toBe(10_000);
    expect(MAX_FALLBACK_BYTES).toBe(32_768);
  });
});
