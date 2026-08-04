import { describe, expect, it } from 'vitest';
import { isHintDismissed, parseDismissedHints, withHintDismissed } from './hints';

describe('parseDismissedHints', () => {
  it('falls back to empty for a non-string or empty value', () => {
    expect(parseDismissedHints(undefined)).toBe('');
    expect(parseDismissedHints(null)).toBe('');
    expect(parseDismissedHints(42)).toBe('');
    expect(parseDismissedHints('')).toBe('');
  });

  it('keeps only known hint ids and drops unknown ones', () => {
    expect(parseDismissedHints('flow,bogus,greenhouse')).toBe('flow,greenhouse');
  });

  it('deduplicates repeated ids', () => {
    expect(parseDismissedHints('flow,flow,greenhouse')).toBe('flow,greenhouse');
  });

  it('trims whitespace around ids', () => {
    expect(parseDismissedHints(' flow , greenhouse ')).toBe('flow,greenhouse');
  });
});

describe('isHintDismissed', () => {
  it('is false for an id not present', () => {
    expect(isHintDismissed('flow', 'greenhouse')).toBe(false);
    expect(isHintDismissed('', 'flow')).toBe(false);
  });

  it('is true once the id is present', () => {
    expect(isHintDismissed('flow,greenhouse', 'greenhouse')).toBe(true);
  });
});

describe('withHintDismissed', () => {
  it('appends a new id to an existing list', () => {
    expect(withHintDismissed('flow', 'greenhouse')).toBe('flow,greenhouse');
  });

  it('starts a fresh list from empty', () => {
    expect(withHintDismissed('', 'touchGrass')).toBe('touchGrass');
  });

  it('is a no-op if the id is already dismissed', () => {
    expect(withHintDismissed('flow,greenhouse', 'flow')).toBe('flow,greenhouse');
  });
});
