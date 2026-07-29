// Typed frontend failures for note storage, and normalization of whatever
// shape a repository backend actually throws (a native Tauri command's
// serialized `NoteCommandError`, or memoryRepository's plain mirror of that
// same wire shape — see memoryRepository.ts's saveNote) into one consistent
// error type the rest of the app can branch on.

export type NoteFailureKind = 'transient' | 'conflict' | 'missing' | 'unreadable';

export class NoteStorageError extends Error {
  readonly kind: NoteFailureKind;
  readonly diskContent: string | null;
  readonly diskHash: string | null;
  readonly relativePath: string | null;

  constructor(
    kind: NoteFailureKind,
    details: {
      message?: string;
      diskContent?: string | null;
      diskHash?: string | null;
      relativePath?: string | null;
    } = {},
  ) {
    super(details.message ?? `Note storage ${kind}`);
    this.name = 'NoteStorageError';
    this.kind = kind;
    this.diskContent = details.diskContent ?? null;
    this.diskHash = details.diskHash ?? null;
    this.relativePath = details.relativePath ?? null;
  }
}

/** Normalizes any thrown value into a `NoteStorageError`, reading only the
 * fields the Rust `NoteCommandError` enum (and memoryRepository's mirror of
 * its wire shape) intentionally exposes for each kind. Anything
 * unrecognized — a plain `Error`, a network hiccup, `undefined` — maps to
 * `transient` rather than guessing at disk content that isn't there. */
export function normalizeNoteStorageError(error: unknown): NoteStorageError {
  if (error instanceof NoteStorageError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = error as Record<string, unknown>;
    if (value.code === 'conflict') {
      return new NoteStorageError('conflict', {
        diskContent: typeof value.diskContent === 'string' ? value.diskContent : null,
        diskHash: typeof value.diskHash === 'string' ? value.diskHash : null,
      });
    }
    if (value.code === 'missing' || value.code === 'unreadable') {
      return new NoteStorageError(value.code, {
        relativePath: typeof value.relativePath === 'string' ? value.relativePath : null,
      });
    }
  }
  return new NoteStorageError('transient');
}
