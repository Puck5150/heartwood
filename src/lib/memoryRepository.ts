// Browser-safe fallback repository: used when running the plain Vite dev
// server (`npm run dev`) outside of Tauri, where @tauri-apps/plugin-sql has
// nothing to talk to. State lives only for the page's lifetime — a reload
// loses it, same as Phase 1's original in-memory-only behavior — which is
// exactly what makes `npm run dev` still useful for fast frontend iteration
// without needing the Rust toolchain or a Tauri build.
//
// Mirrors the same stale-write guard as tauriRepository.ts so behavior is
// consistent between the two backends, and so that guard is unit-testable
// here without needing a real SQLite connection.

import type { ParkedThought } from './parkingLot';
import type { SessionNoteRow } from './notes';
import { serializeSessionState, type SessionRow } from './persistence';
import type { SessionState } from './session';

const sessions = new Map<string, SessionRow>();
let parkedThoughts: ParkedThought[] = [];
const settings = new Map<string, string>();
const notes = new Map<string, SessionNoteRow>(); // keyed by session_id

/** Test-only: reset in-memory state between test cases. */
export function resetMemoryStore(): void {
  sessions.clear();
  parkedThoughts = [];
  settings.clear();
  notes.clear();
}

export async function saveSession(state: SessionState, updatedAt: number): Promise<void> {
  const row = serializeSessionState(state, updatedAt);
  if (!row) return;
  const existing = sessions.get(row.id);
  if (existing && existing.updated_at > row.updated_at) return; // stale write guard
  sessions.set(row.id, row);
}

export async function loadLatestSessionRow(): Promise<SessionRow | null> {
  let latest: SessionRow | null = null;
  for (const row of sessions.values()) {
    if (!latest || row.updated_at > latest.updated_at) latest = row;
  }
  return latest;
}

export async function loadCompletedSessions(): Promise<SessionRow[]> {
  return [...sessions.values()]
    .filter((row) => row.status === 'complete')
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
}

/** Deletes one session by id, and its note. Does not touch parked
 * thoughts — see tauriRepository.ts's deleteSessionRow for why. */
export async function deleteSessionRow(id: string): Promise<void> {
  sessions.delete(id);
  await deleteNoteForSession(id);
}

/** Wipes all sessions, all parked thoughts, and all notes. Deliberately
 * leaves settings untouched — see tauriRepository.ts's deleteAllData for
 * why. */
export async function deleteAllData(): Promise<void> {
  sessions.clear();
  parkedThoughts = [];
  notes.clear();
}

export async function getSetting(key: string): Promise<string | null> {
  return settings.get(key) ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  settings.set(key, value);
}

/** Upserts the note for a session, preserving the original id and
 * created_at across updates — matching tauriRepository.ts's upsert. */
export async function saveNote(sessionId: string, content: string, now: number): Promise<void> {
  const existing = notes.get(sessionId);
  notes.set(sessionId, {
    id: existing?.id ?? crypto.randomUUID(),
    session_id: sessionId,
    content,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
}

export async function loadNoteForSession(sessionId: string): Promise<string | null> {
  return notes.get(sessionId)?.content ?? null;
}

export async function loadAllSessionNotes(): Promise<SessionNoteRow[]> {
  return [...notes.values()];
}

export async function deleteNoteForSession(sessionId: string): Promise<void> {
  notes.delete(sessionId);
}

export async function insertParkedThought(thought: ParkedThought): Promise<void> {
  parkedThoughts = [...parkedThoughts, thought];
}

export async function deleteParkedThoughtRow(id: string): Promise<void> {
  parkedThoughts = parkedThoughts.filter((thought) => thought.id !== id);
}

export async function loadAllParkedThoughts(): Promise<ParkedThought[]> {
  return [...parkedThoughts];
}
