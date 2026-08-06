// The real, SQLite-backed repository. Only used when running inside Tauri
// (see repository.ts, which picks this or memoryRepository.ts at runtime).

import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import type { ParkedThought } from './parkingLot';
import type { ConflictResolutionResult, DeleteOutcome, SaveNoteOptions, SaveNoteResult, SessionNoteRow } from './notes';
import {
  deserializeParkedThoughtRow,
  serializeParkedThought,
  serializeSessionState,
  type ParkedThoughtRow,
  type SessionRow,
} from './persistence';
import type { SessionState } from './session';
import type { CreateRevisionRequest, LoadedNoteRevision, NoteRevision, RestoreRevisionResult } from './revisions';

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
      flow_ms, took_break, break_ms, total_elapsed_ms, completed_at, focus_deadline_at,
      review_acknowledged_at, intermission_kind, intermission_started_at,
      intermission_deadline_at, intermission_return_status, break_intermission_ms,
      touch_grass_ms, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
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
      focus_deadline_at = excluded.focus_deadline_at,
      review_acknowledged_at = excluded.review_acknowledged_at,
      intermission_kind = excluded.intermission_kind,
      intermission_started_at = excluded.intermission_started_at,
      intermission_deadline_at = excluded.intermission_deadline_at,
      intermission_return_status = excluded.intermission_return_status,
      break_intermission_ms = excluded.break_intermission_ms,
      touch_grass_ms = excluded.touch_grass_ms,
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
      row.focus_deadline_at,
      row.review_acknowledged_at,
      row.intermission_kind,
      row.intermission_started_at,
      row.intermission_deadline_at,
      row.intermission_return_status,
      row.break_intermission_ms,
      row.touch_grass_ms,
      row.updated_at,
    ],
  );
}

/** Marks a completed session's review as acknowledged ("Back to start"),
 * so a later launch's recovery opens idle instead of restoring Review —
 * see recoverSessionState. Never touches the session's own history, note,
 * revisions, or parked thoughts; scoped to `status = 'complete'`
 * defensively, since only the currently-showing review's session should
 * ever be acknowledged. Bumps `updated_at` like any other write to this
 * row, but that's harmless here — this is always already the latest row
 * by construction (nothing else can start a newer session while its own
 * review is still showing), and once a new session actually starts, its
 * own save naturally becomes the latest row again.
 *
 * Throws if the row doesn't exist or isn't `status = 'complete'`, rather
 * than silently affecting zero rows — the caller (App.svelte's
 * handleBackToStart) must never leave the review screen believing this
 * persisted when it didn't. */
export async function acknowledgeSessionReview(sessionId: string, now: number): Promise<void> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE sessions SET review_acknowledged_at = $1, updated_at = $2 WHERE id = $3 AND status = 'complete'`,
    [now, now, sessionId],
  );
  if (result.rowsAffected !== 1) {
    throw new Error(
      `Failed to acknowledge session review: expected exactly one completed row for id "${sessionId}", affected ${result.rowsAffected}.`,
    );
  }
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

/** Deletes only a session's revision history — its current note and the
 * session itself are left completely untouched. Same staged/finalize-or-
 * restore pattern as `deleteSessionRow`/`deleteAllData`. */
export async function deleteNoteRevisionHistory(sessionId: string): Promise<DeleteOutcome> {
  await getDb();
  return fromNativeDeleteOutcome(
    await invoke<NativeDeleteOutcome>('delete_note_revision_history', { sessionId }),
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

interface NativeConflictResolutionResponse {
  note: NativeSessionNote | null;
  safetyRevision: NoteRevision | null;
}

function fromNativeConflictResolution(response: NativeConflictResolutionResponse): ConflictResolutionResult {
  return { note: response.note ? fromNativeNote(response.note) : null, safetyRevision: response.safetyRevision };
}

/** "Keep my version": re-verifies the disk file is still exactly
 * `conflictHash` before doing anything — a native command, not a plain
 * `force`d save, because the safety snapshot of the external content and
 * the compare-and-write against that exact hash must happen atomically.
 * A second external change since the conflict was reported comes back as
 * a rejected promise carrying a fresh `Conflict`, exactly like `saveNote`. */
export async function keepAppNoteAfterConflict(
  sessionId: string,
  draft: string,
  conflictHash: string,
  now: number,
): Promise<ConflictResolutionResult> {
  await getDb();
  const response = await invoke<NativeConflictResolutionResponse>('resolve_external_conflict_keep', {
    sessionId,
    draft,
    conflictHash,
    now,
  });
  return fromNativeConflictResolution(response);
}

/** "Reload file": snapshots the non-blank in-memory draft as a safety
 * revision, then returns the verified disk content — the caller replaces
 * its draft with `result.note.content`. A second external change since the
 * conflict was reported comes back as a rejected promise carrying a fresh
 * `Conflict` rather than discarding the draft against stale information. */
export async function reloadExternalNoteAfterConflict(
  sessionId: string,
  draft: string,
  conflictHash: string,
  now: number,
): Promise<ConflictResolutionResult> {
  await getDb();
  const response = await invoke<NativeConflictResolutionResponse>('resolve_external_conflict_reload', {
    sessionId,
    draft,
    conflictHash,
    now,
  });
  return fromNativeConflictResolution(response);
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

export async function updateParkedThoughtNote(id: string, note: string): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE parked_thoughts SET note = $1 WHERE id = $2', [note, id]);
}

export async function loadAllParkedThoughts(): Promise<ParkedThought[]> {
  const db = await getDb();
  const rows = await db.select<ParkedThoughtRow[]>('SELECT * FROM parked_thoughts ORDER BY created_at ASC');
  return rows.map(deserializeParkedThoughtRow);
}

/** Opens the canonical app-managed notes directory with the OS file
 * manager. The native command accepts no path from the frontend — it only
 * ever opens its own `store.notes_dir()`. */
export async function openNotesFolder(): Promise<void> {
  await invoke('open_notes_folder');
}

// Revision commands' wire shape already matches the domain types in
// revisions.ts exactly (camelCase field names, and RevisionKind/
// RevisionReason's snake_case wire values match the Rust enums'
// `#[serde(rename_all = "snake_case")]`), so these need no per-field
// conversion the way SessionNoteRow's snake_case fields do.

export async function createNoteRevision(request: CreateRevisionRequest): Promise<NoteRevision | null> {
  await getDb();
  return invoke<NoteRevision | null>('create_note_revision', { request });
}

export async function listNoteRevisions(sessionId: string): Promise<NoteRevision[]> {
  await getDb();
  return invoke<NoteRevision[]>('list_note_revisions', { sessionId });
}

export async function loadNoteRevision(revisionId: string): Promise<LoadedNoteRevision> {
  await getDb();
  return invoke<LoadedNoteRevision>('load_note_revision', { revisionId });
}

export async function renameNoteRevision(revisionId: string, label: string | null): Promise<NoteRevision> {
  await getDb();
  return invoke<NoteRevision>('rename_note_revision', { revisionId, label });
}

export async function loadNoteRevisionCounts(): Promise<Map<string, number>> {
  await getDb();
  const counts = await invoke<{ sessionId: string; count: number }[]>('load_note_revision_counts');
  return new Map(counts.map((entry) => [entry.sessionId, entry.count]));
}

interface NativeRestoreRevisionResponse {
  note: NativeSessionNote;
  safetyRevision: NoteRevision | null;
}

/** Restores a revision as the session's current note — one crash-safe
 * native operation (see revision_files.rs's restore manifest and
 * note_commands.rs's restore_note_revision_core). `expectedCurrentHash`
 * guards against restoring over a newer external/in-app change the caller
 * hasn't observed yet; a stale value rejects with the same `{code:
 * 'conflict', diskContent, diskHash}` shape any other note conflict uses. */
export async function restoreNoteRevision(
  revisionId: string,
  expectedCurrentHash: string | null,
  now: number,
): Promise<RestoreRevisionResult> {
  await getDb();
  const response = await invoke<NativeRestoreRevisionResponse>('restore_note_revision', {
    revisionId,
    expectedCurrentHash,
    now,
  });
  return { note: fromNativeNote(response.note), safetyRevision: response.safetyRevision };
}
