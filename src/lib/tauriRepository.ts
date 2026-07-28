// The real, SQLite-backed repository. Only used when running inside Tauri
// (see repository.ts, which picks this or memoryRepository.ts at runtime).

import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import type { ParkedThought } from './parkingLot';
import type { DeleteOutcome, SaveNoteOptions, SaveNoteResult, SessionNoteRow } from './notes';
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

/** Native camelCase shape for `DeleteOutcome`, as serialized by
 * db_commands.rs. */
interface NativeDeleteOutcome {
  cleanupPending: boolean;
}

function fromNativeDeleteOutcome(outcome: NativeDeleteOutcome): DeleteOutcome {
  return { cleanupPending: outcome.cleanupPending };
}

/** Deletes one session by id, and its note — both the SQLite row and its
 * Markdown file — atomically for the database side, with the note file
 * staged before the transaction and finalized/restored after, per
 * db_commands.rs's `delete_session_with_note_core`. This runs as a native
 * Rust command using a real sqlx::Transaction, not a
 * `BEGIN; ...; COMMIT;` string through db.execute(): the JS plugin's
 * execute() only guarantees one connection for a single call, but has no
 * way to guarantee a follow-up ROLLBACK after a mid-batch failure reaches
 * that *same* connection instead of a different one from the pool — a
 * sqlx::Transaction fixes this at the type level (see db_commands.rs).
 * getDb() is still called first here to guarantee the database has been
 * loaded at least once — the native command looks up the same pool by URL
 * and needs it to already be registered. Does not touch parked_thoughts —
 * thoughts still tagged with this session's id remain in the active pool,
 * since removing a historical record is a separate action from discarding
 * live, unresolved parked thoughts. */
export async function deleteSessionRow(id: string): Promise<DeleteOutcome> {
  await getDb();
  return fromNativeDeleteOutcome(await invoke<NativeDeleteOutcome>('delete_session_with_note', { id }));
}

/** Wipes all sessions, all parked thoughts, and all notes (rows and files)
 * in one atomic transaction for the database side — see deleteSessionRow's
 * comment for why this is a native command rather than a db.execute()
 * batch. Deliberately leaves `settings` untouched — a user preference like
 * the selected alarm tone isn't "data" in the sense this action means to
 * clear. */
export async function deleteAllData(): Promise<DeleteOutcome> {
  await getDb();
  return fromNativeDeleteOutcome(await invoke<NativeDeleteOutcome>('delete_all_data'));
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

/** Native camelCase shape for `SessionNoteDto`/`SaveNoteResponse`, as
 * serialized by note_commands.rs. */
interface NativeSessionNote {
  id: string;
  sessionId: string;
  content: string;
  filePath: string | null;
  contentHash: string | null;
  createdAt: number;
  updatedAt: number;
}

interface NativeSaveNoteResponse {
  note: NativeSessionNote | null;
  cleanupPending: boolean;
}

function fromNativeNote(note: NativeSessionNote): SessionNoteRow {
  return {
    id: note.id,
    session_id: note.sessionId,
    content: note.content,
    file_path: note.filePath,
    content_hash: note.contentHash,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
  };
}

/** Runs staged-deletion recovery and legacy Phase 4A migration. Must be
 * awaited once at startup, before any note load/save — recovery decides
 * whether an interrupted delete/clear should finish or roll back, and
 * migration is what gives a legacy row its `file_path` in the first place. */
export async function initializeNoteStorage(): Promise<void> {
  await getDb();
  await invoke('initialize_note_storage');
}

/** Upserts (or, for whitespace-only content, clears) the note for a
 * session, keyed by session_id. `options.expectedHash` is compared against
 * the file's current on-disk hash for optimistic conflict detection;
 * `options.force` bypasses that check (explicit "keep my version" and a
 * carried-forward note's first write both need this). The row's own id
 * and created_at are preserved across updates by note_commands.rs. */
export async function saveNote(
  sessionId: string,
  content: string,
  now: number,
  options: SaveNoteOptions = {},
): Promise<SaveNoteResult> {
  await getDb();
  const response = await invoke<NativeSaveNoteResponse>('save_session_note', {
    sessionId,
    content,
    expectedHash: options.expectedHash ?? null,
    now,
    force: options.force ?? false,
  });
  return {
    note: response.note ? fromNativeNote(response.note) : null,
    cleanupPending: response.cleanupPending,
  };
}

export async function loadNoteRecordForSession(sessionId: string): Promise<SessionNoteRow | null> {
  await getDb();
  const note = await invoke<NativeSessionNote | null>('load_session_note', { sessionId });
  return note ? fromNativeNote(note) : null;
}

export async function loadNoteForSession(sessionId: string): Promise<string | null> {
  return (await loadNoteRecordForSession(sessionId))?.content ?? null;
}

export async function loadAllSessionNotes(): Promise<SessionNoteRow[]> {
  await getDb();
  const notes = await invoke<NativeSessionNote[]>('load_all_session_notes');
  return notes.map(fromNativeNote);
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
