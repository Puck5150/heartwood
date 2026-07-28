// The real, SQLite-backed repository. Only used when running inside Tauri
// (see repository.ts, which picks this or memoryRepository.ts at runtime).

import Database from '@tauri-apps/plugin-sql';
import type { ParkedThought } from './parkingLot';
import type { SessionNoteRow } from './notes';
import {
  deserializeParkedThoughtRow,
  serializeParkedThought,
  serializeSessionState,
  type ParkedThoughtRow,
  type SessionRow,
} from './persistence';
import type { SessionState } from './session';

const DB_URL = 'sqlite:pomodoro.db';

let dbPromise: ReturnType<typeof Database.load> | null = null;

function getDb() {
  if (!dbPromise) dbPromise = Database.load(DB_URL);
  return dbPromise;
}

/**
 * Upserts the session row by id. No-op for 'idle' — nothing to persist yet.
 * The `WHERE excluded.updated_at > sessions.updated_at` guard makes this
 * safe to call with out-of-order writes: an older write can never clobber
 * a row that a newer write already landed (see App.svelte's save queue for
 * the complementary fix — this guard is the last line of defense).
 */
export async function saveSession(state: SessionState, updatedAt: number): Promise<void> {
  const row = serializeSessionState(state, updatedAt);
  if (!row) return;
  const db = await getDb();
  await db.execute(
    `INSERT INTO sessions (
      id, task, status, started_at, planned_duration_ms, accumulated_pause_ms,
      paused_at, focus_completed_at, flow_started_at, flow_accumulated_pause_ms,
      flow_paused_at, break_started_at, planned_focus_ms, actual_focus_ms,
      flow_ms, took_break, break_ms, total_elapsed_ms, completed_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
    ON CONFLICT(id) DO UPDATE SET
      task = excluded.task,
      status = excluded.status,
      started_at = excluded.started_at,
      planned_duration_ms = excluded.planned_duration_ms,
      accumulated_pause_ms = excluded.accumulated_pause_ms,
      paused_at = excluded.paused_at,
      focus_completed_at = excluded.focus_completed_at,
      flow_started_at = excluded.flow_started_at,
      flow_accumulated_pause_ms = excluded.flow_accumulated_pause_ms,
      flow_paused_at = excluded.flow_paused_at,
      break_started_at = excluded.break_started_at,
      planned_focus_ms = excluded.planned_focus_ms,
      actual_focus_ms = excluded.actual_focus_ms,
      flow_ms = excluded.flow_ms,
      took_break = excluded.took_break,
      break_ms = excluded.break_ms,
      total_elapsed_ms = excluded.total_elapsed_ms,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > sessions.updated_at`,
    [
      row.id,
      row.task,
      row.status,
      row.started_at,
      row.planned_duration_ms,
      row.accumulated_pause_ms,
      row.paused_at,
      row.focus_completed_at,
      row.flow_started_at,
      row.flow_accumulated_pause_ms,
      row.flow_paused_at,
      row.break_started_at,
      row.planned_focus_ms,
      row.actual_focus_ms,
      row.flow_ms,
      row.took_break,
      row.break_ms,
      row.total_elapsed_ms,
      row.completed_at,
      row.updated_at,
    ],
  );
}

/** The most recently updated session row, or null if none exists yet. */
export async function loadLatestSessionRow(): Promise<SessionRow | null> {
  const db = await getDb();
  const rows = await db.select<SessionRow[]>('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1');
  return rows[0] ?? null;
}

/** All completed sessions, most recently completed first. */
export async function loadCompletedSessions(): Promise<SessionRow[]> {
  const db = await getDb();
  return db.select<SessionRow[]>(
    "SELECT * FROM sessions WHERE status = 'complete' ORDER BY completed_at DESC",
  );
}

/** Deletes one session by id, and its note (a note has no life independent
 * of its session, unlike a parked thought), atomically — both deletes run
 * inside one BEGIN/COMMIT as a single multi-statement query, so a crash or
 * error between them can never leave an orphaned note or a session missing
 * its note's deletion. sqlx's SQLite driver splits a query string on `;`
 * and runs each piece against the same pooled connection in order, which is
 * what makes wrapping them in an explicit transaction here actually mean
 * something (separate db.execute() calls could each land on a different
 * pooled connection and wouldn't share a transaction at all). A `$1`-style
 * placeholder is a named parameter bound by its literal number against the
 * one shared argument array for the whole query string — not per-statement
 * — so both DELETEs below reuse the same `$1` to mean "the same id", and
 * only one value needs to be passed in. Does not touch parked_thoughts —
 * thoughts still tagged with this session's id remain in the active pool,
 * since removing a historical record is a separate action from discarding
 * live, unresolved parked thoughts. */
export async function deleteSessionRow(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `BEGIN;
     DELETE FROM sessions WHERE id = $1;
     DELETE FROM session_notes WHERE session_id = $1;
     COMMIT;`,
    [id],
  );
}

/** Wipes all sessions, all parked thoughts, and all notes in one atomic
 * transaction — see deleteSessionRow's comment for why a single
 * multi-statement query is what makes that atomic here. Deliberately
 * leaves `settings` untouched — a user preference like the selected alarm
 * tone isn't "data" in the sense this action means to clear. */
export async function deleteAllData(): Promise<void> {
  const db = await getDb();
  await db.execute(
    `BEGIN;
     DELETE FROM parked_thoughts;
     DELETE FROM sessions;
     DELETE FROM session_notes;
     COMMIT;`,
  );
}

/** A single string-valued setting, or null if it's never been set. */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string | null }[]>(
    'SELECT value FROM settings WHERE key = $1',
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO settings (key, value, type, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = excluded.type, updated_at = excluded.updated_at`,
    [key, value, 'string', Date.now()],
  );
}

/** Upserts the note for a session, keyed by session_id. The row's own id
 * and created_at are preserved across updates — a fresh random id passed
 * on an update is simply ignored, since `id` isn't in the SET clause. */
export async function saveNote(sessionId: string, content: string, now: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO session_notes (id, session_id, content, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT(session_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    [crypto.randomUUID(), sessionId, content, now],
  );
}

export async function loadNoteForSession(sessionId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ content: string }[]>(
    'SELECT content FROM session_notes WHERE session_id = $1',
    [sessionId],
  );
  return rows[0]?.content ?? null;
}

export async function loadAllSessionNotes(): Promise<SessionNoteRow[]> {
  const db = await getDb();
  return db.select<SessionNoteRow[]>('SELECT * FROM session_notes');
}

export async function deleteNoteForSession(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM session_notes WHERE session_id = $1', [sessionId]);
}

export async function insertParkedThought(thought: ParkedThought): Promise<void> {
  const db = await getDb();
  const row = serializeParkedThought(thought);
  await db.execute(
    'INSERT INTO parked_thoughts (id, session_id, text, created_at) VALUES ($1, $2, $3, $4)',
    [row.id, row.session_id, row.text, row.created_at],
  );
}

export async function deleteParkedThoughtRow(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM parked_thoughts WHERE id = $1', [id]);
}

export async function loadAllParkedThoughts(): Promise<ParkedThought[]> {
  const db = await getDb();
  const rows = await db.select<ParkedThoughtRow[]>('SELECT * FROM parked_thoughts ORDER BY created_at ASC');
  return rows.map(deserializeParkedThoughtRow);
}
