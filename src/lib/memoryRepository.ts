// Browser-safe fallback repository: used when running the plain Vite dev
// server (`npm run dev`) outside of Tauri, where @tauri-apps/plugin-sql has
// nothing to talk to. State lives only for the page's lifetime — a reload
// loses it, same as Phase 1's original in-memory-only behavior — which is
// exactly what makes `npm run dev` still useful for fast frontend iteration
// without needing the Rust toolchain or a Tauri build.
//
// Mirrors the same stale-write guard as tauriRepository.ts so behavior is
// consistent between the two backends, and so that guard is unit-testable
// here without needing a real SQLite connection. Notes mirror the
// file-backed contract's *semantics* (content-hash conflict detection,
// whitespace-clears-the-note) without an actual filesystem — every note
// gets a synthetic `memory/<session-id>.md` path so the shape matches what
// a real Tauri build would report.

import type { ParkedThought } from './parkingLot';
import type { DeleteOutcome, SaveNoteOptions, SaveNoteResult, SessionNoteRow } from './notes';
import { serializeSessionState, type SessionRow } from './persistence';
import type { SessionState } from './session';
import {
  normalizeRevisionLabel,
  validateRevisionPair,
  type CreateRevisionRequest,
  type LoadedNoteRevision,
  type NoteRevision,
} from './revisions';

const sessions = new Map<string, SessionRow>();
let parkedThoughts: ParkedThought[] = [];
const settings = new Map<string, string>();
const notes = new Map<string, SessionNoteRow>(); // keyed by session_id

interface StoredRevision {
  revision: NoteRevision;
  /** Monotonic insertion order — the in-memory equivalent of SQLite's
   * `rowid`, used the same way: breaking a tie between two revisions that
   * share a `createdAt` timestamp so listing order is stable and matches
   * the native `ORDER BY created_at DESC, rowid DESC`. */
  seq: number;
}

const revisionsById = new Map<string, StoredRevision>();
// Bodies are stored separately from metadata, content-addressed by
// (sessionId, contentHash) — mirrors the real store's immutable,
// session-scoped snapshot objects, and means renaming a revision's label
// can never touch its body.
const revisionContentByKey = new Map<string, string>();
let nextRevisionSeq = 0;

function objectKey(sessionId: string, contentHash: string): string {
  return `${sessionId}:${contentHash}`;
}

function findExistingRevision(sessionId: string, contentHash: string): StoredRevision | undefined {
  for (const stored of revisionsById.values()) {
    if (stored.revision.sessionId === sessionId && stored.revision.contentHash === contentHash) return stored;
  }
  return undefined;
}

/** Test-only: reset in-memory state between test cases. */
export function resetMemoryStore(): void {
  sessions.clear();
  parkedThoughts = [];
  settings.clear();
  notes.clear();
  revisionsById.clear();
  revisionContentByKey.clear();
  nextRevisionSeq = 0;
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
export async function deleteSessionRow(id: string): Promise<DeleteOutcome> {
  sessions.delete(id);
  notes.delete(id);
  return { cleanupPending: false };
}

/** Wipes all sessions, all parked thoughts, and all notes. Deliberately
 * leaves settings untouched — see tauriRepository.ts's deleteAllData for
 * why. */
export async function deleteAllData(): Promise<DeleteOutcome> {
  sessions.clear();
  parkedThoughts = [];
  notes.clear();
  return { cleanupPending: false };
}

export async function getSetting(key: string): Promise<string | null> {
  return settings.get(key) ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  settings.set(key, value);
}

/** No filesystem to prepare in memory mode; kept only for interface parity
 * with the Tauri backend so App.svelte can call it unconditionally. */
export async function initializeNoteStorage(): Promise<void> {}

async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Upserts (or, for whitespace-only content, clears) the note for a
 * session, preserving the original id/created_at across updates and
 * applying the same expected-hash/force conflict guard the real file store
 * enforces — mirroring the exact wire shape a Tauri conflict/missing error
 * would have (`{ code, diskContent, diskHash }` / `{ code, relativePath }`)
 * so noteStorage.ts's normalization handles both backends identically. */
export async function saveNote(
  sessionId: string,
  content: string,
  now: number,
  options: SaveNoteOptions = {},
): Promise<SaveNoteResult> {
  const { expectedHash = null, force = false } = options;
  const existing = notes.get(sessionId) ?? null;

  if (content.trim() === '') {
    if (!existing) return { note: null, cleanupPending: false };
    const expectedMatches = expectedHash !== null && expectedHash === existing.content_hash;
    if (!force && !expectedMatches) {
      throw { code: 'conflict', diskContent: existing.content, diskHash: existing.content_hash };
    }
    notes.delete(sessionId);
    return { note: null, cleanupPending: false };
  }

  const desiredHash = await sha256Hex(content);
  if (existing) {
    const expectedMatches = expectedHash !== null && expectedHash === existing.content_hash;
    const desiredAlreadyLanded = desiredHash === existing.content_hash;
    if (!force && !expectedMatches && !desiredAlreadyLanded) {
      throw { code: 'conflict', diskContent: existing.content, diskHash: existing.content_hash };
    }
    if (desiredAlreadyLanded) {
      return { note: existing, cleanupPending: false };
    }
  } else if (expectedHash !== null && !force) {
    throw { code: 'missing', relativePath: `memory/${sessionId}.md` };
  }

  const note: SessionNoteRow = {
    id: existing?.id ?? crypto.randomUUID(),
    session_id: sessionId,
    content,
    file_path: `memory/${sessionId}.md`,
    content_hash: desiredHash,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  notes.set(sessionId, note);
  return { note, cleanupPending: false };
}

export async function loadNoteRecordForSession(sessionId: string): Promise<SessionNoteRow | null> {
  return notes.get(sessionId) ?? null;
}

export async function loadNoteForSession(sessionId: string): Promise<string | null> {
  return (await loadNoteRecordForSession(sessionId))?.content ?? null;
}

export async function loadAllSessionNotes(): Promise<SessionNoteRow[]> {
  return [...notes.values()];
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

/** No real filesystem or OS file manager in browser dev mode; kept only
 * for interface parity with the Tauri backend. */
export async function openNotesFolder(): Promise<void> {}

/** Mirrors create_note_revision_core's contract: rejects an invalid
 * kind/reason pairing or a content hash that doesn't match the content,
 * returns `null` for blank/whitespace-only content without creating
 * anything, requires the owning session to already exist, and reuses
 * (rather than duplicates) an existing revision for the same
 * (sessionId, contentHash). */
export async function createNoteRevision(request: CreateRevisionRequest): Promise<NoteRevision | null> {
  if (!validateRevisionPair(request.kind, request.reason)) {
    throw new Error('invalid revision kind/reason pairing');
  }
  if (request.content.trim() === '') return null;
  if (!sessions.has(request.sessionId)) {
    throw new Error('owning session does not exist');
  }
  const actualHash = await sha256Hex(request.content);
  if (actualHash !== request.contentHash) {
    throw new Error('revision content does not match its expected hash');
  }

  const key = objectKey(request.sessionId, request.contentHash);
  const existing = findExistingRevision(request.sessionId, request.contentHash);
  if (existing) {
    if (!revisionContentByKey.has(key)) revisionContentByKey.set(key, request.content);
    return { ...existing.revision };
  }

  revisionContentByKey.set(key, request.content);
  nextRevisionSeq += 1;
  const revision: NoteRevision = {
    id: crypto.randomUUID(),
    sessionId: request.sessionId,
    contentHash: request.contentHash,
    kind: request.kind,
    reason: request.reason,
    label: null,
    createdAt: request.createdAt,
  };
  revisionsById.set(revision.id, { revision, seq: nextRevisionSeq });
  return { ...revision };
}

/** Newest first, with insertion order breaking a tie between equal
 * timestamps — mirrors `ORDER BY created_at DESC, rowid DESC`. Metadata
 * only; never touches revisionContentByKey. */
export async function listNoteRevisions(sessionId: string): Promise<NoteRevision[]> {
  return [...revisionsById.values()]
    .filter((stored) => stored.revision.sessionId === sessionId)
    .sort((a, b) => b.revision.createdAt - a.revision.createdAt || b.seq - a.seq)
    .map((stored) => ({ ...stored.revision }));
}

export async function loadNoteRevision(revisionId: string): Promise<LoadedNoteRevision> {
  const stored = revisionsById.get(revisionId);
  if (!stored) throw new Error('revision not found');
  const content = revisionContentByKey.get(objectKey(stored.revision.sessionId, stored.revision.contentHash));
  if (content === undefined) throw new Error('revision content is unavailable');
  return { ...stored.revision, content };
}

/** Changes only the label — never touches the stored body. */
export async function renameNoteRevision(revisionId: string, label: string | null): Promise<NoteRevision> {
  const stored = revisionsById.get(revisionId);
  if (!stored) throw new Error('revision not found');
  stored.revision = { ...stored.revision, label: normalizeRevisionLabel(label) };
  return { ...stored.revision };
}

/** One entry per session with at least one revision — never reads a body. */
export async function loadNoteRevisionCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const { revision } of revisionsById.values()) {
    counts.set(revision.sessionId, (counts.get(revision.sessionId) ?? 0) + 1);
  }
  return counts;
}
