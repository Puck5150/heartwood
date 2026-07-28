// Pure note-related helpers and shared types for the file-backed note
// contract (Phase 4B). The SQL/DTO row shape is used directly as the
// in-memory shape too — unlike SessionState there's no tagged union to
// bridge, so a separate camelCase type would just be ceremony.

export interface SessionNoteRow {
  id: string;
  session_id: string;
  /** For a file-backed row (`file_path` non-null) this is always `''` —
   * the file is the content's sole home. A still-legacy row (`file_path`
   * null) carries its real Phase 4A content here until migrated. */
  content: string;
  file_path: string | null;
  content_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface SaveNoteOptions {
  /** The content hash the caller last observed for this session, used for
   * optimistic conflict detection against whatever's actually on disk. */
  expectedHash?: string | null;
  /** Bypasses the expected-hash conflict check, writing over whatever is
   * currently on disk regardless. Used for explicit "keep my version"
   * conflict resolution and for a carried-forward note's first write. */
  force?: boolean;
}

export interface SaveNoteResult {
  /** `null` means the note was cleared (whitespace-only content) rather
   * than saved. */
  note: SessionNoteRow | null;
  /** True when the save (or clear) itself succeeded but a secondary file
   * cleanup step failed and will retry at next startup — the operation the
   * user asked for still completed. */
  cleanupPending: boolean;
}

export interface DeleteOutcome {
  cleanupPending: boolean;
}

/** Whether a note has any real content worth showing. Empty or
 * whitespace-only notes shouldn't clutter history, review, or export. */
export function hasNoteContent(content: string | null | undefined): boolean {
  return !!content && content.trim().length > 0;
}

/** The note content for a session, or null if it has none — or has one
 * that's empty/whitespace-only, which should display the same as having
 * none at all. */
export function getNoteContentForSession(notes: SessionNoteRow[], sessionId: string): string | null {
  const note = notes.find((n) => n.session_id === sessionId);
  if (!note || !hasNoteContent(note.content)) return null;
  return note.content;
}
