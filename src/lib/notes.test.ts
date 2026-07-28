import { describe, expect, it } from 'vitest';
import { getNoteContentForSession, hasNoteContent, type SessionNoteRow } from './notes';

describe('hasNoteContent', () => {
  it('is false for null, undefined, and empty string', () => {
    expect(hasNoteContent(null)).toBe(false);
    expect(hasNoteContent(undefined)).toBe(false);
    expect(hasNoteContent('')).toBe(false);
  });

  it('is false for whitespace-only content', () => {
    expect(hasNoteContent('   \n\t  ')).toBe(false);
  });

  it('is true for real content', () => {
    expect(hasNoteContent('Remembered to check the deploy logs.')).toBe(true);
  });
});

describe('getNoteContentForSession', () => {
  const notes: SessionNoteRow[] = [
    { id: 'n1', session_id: 's1', content: 'Some real notes', created_at: 1_000, updated_at: 1_000 },
    { id: 'n2', session_id: 's2', content: '   ', created_at: 1_000, updated_at: 1_000 },
  ];

  it('returns the content for a session with a real note', () => {
    expect(getNoteContentForSession(notes, 's1')).toBe('Some real notes');
  });

  it('returns null for a session whose note is empty/whitespace-only', () => {
    expect(getNoteContentForSession(notes, 's2')).toBeNull();
  });

  it('returns null for a session with no note row at all', () => {
    expect(getNoteContentForSession(notes, 'no-such-session')).toBeNull();
  });
});
