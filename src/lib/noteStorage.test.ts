import { describe, expect, it } from 'vitest';
import { NoteStorageError, normalizeNoteStorageError } from './noteStorage';

describe('normalizeNoteStorageError', () => {
  it('normalizes a native conflict without dropping the disk version', () => {
    const error = normalizeNoteStorageError({
      code: 'conflict',
      diskContent: 'external version',
      diskHash: 'abc123',
    });

    expect(error.kind).toBe('conflict');
    expect(error.diskContent).toBe('external version');
    expect(error.diskHash).toBe('abc123');
  });

  it('normalizes a native missing-file error, keeping its relative path', () => {
    const error = normalizeNoteStorageError({ code: 'missing', relativePath: 'notes/s1.md' });
    expect(error.kind).toBe('missing');
    expect(error.relativePath).toBe('notes/s1.md');
  });

  it('normalizes a native unreadable-file error, keeping its relative path', () => {
    const error = normalizeNoteStorageError({ code: 'unreadable', relativePath: 'notes/s1.md' });
    expect(error.kind).toBe('unreadable');
    expect(error.relativePath).toBe('notes/s1.md');
  });

  it('maps unknown failures to transient without exposing note content', () => {
    const error = normalizeNoteStorageError(new Error('disk unavailable'));
    expect(error.kind).toBe('transient');
    expect(error.diskContent).toBeNull();
  });

  it('passes an already-normalized error through unchanged', () => {
    const original = new NoteStorageError('conflict', { diskContent: 'x', diskHash: 'y' });
    expect(normalizeNoteStorageError(original)).toBe(original);
  });

  it('maps a native transient error code to transient', () => {
    const error = normalizeNoteStorageError({ code: 'transient', message: 'disk full' });
    expect(error.kind).toBe('transient');
  });
});
