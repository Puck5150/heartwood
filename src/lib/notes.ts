// Pure note-related helpers shared across the notes editor, history
// display, and export. The SQL row shape is used directly as the
// in-memory shape too — unlike SessionState there's no tagged union to
// bridge, so a separate camelCase type would just be ceremony.

export interface SessionNoteRow {
  id: string;
  session_id: string;
  content: string;
  created_at: number;
  updated_at: number;
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
