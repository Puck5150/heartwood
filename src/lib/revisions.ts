// Shared revision domain types, wire-value validation, and presentation
// helpers. Kept dependency-free of any repository/Tauri machinery (the
// `import type` of SessionNoteRow below is erased at compile time and
// never becomes a real runtime dependency) so this module can be used
// identically by both the browser-memory and Tauri repository adapters,
// the revision-operation controller, and the revision browser UI.

import type { SessionNoteRow } from './notes';

/** SHA-256 of `content`'s exact UTF-8 bytes, lowercase hex — identical to
 * what native Rust's `sha256_hex()` computes for the same string (no
 * normalization on either side). Used wherever a revision request's
 * `contentHash` needs to be derived directly from an in-memory string
 * rather than trusted from some other, possibly-since-changed source
 * (e.g. a shared `noteHashBySession` map another save could have
 * overwritten in the meantime) — see App.svelte's `snapshotSessionCompleted`/
 * `snapshotSessionStarted`. */
export async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type RevisionKind = 'automatic' | 'checkpoint' | 'safety';

export type RevisionReason =
  | 'session_started'
  | 'session_completed'
  | 'review_finalized'
  | 'manual'
  | 'before_clear'
  | 'before_restore'
  | 'before_external_overwrite'
  | 'before_external_reload';

export interface NoteRevision {
  id: string;
  sessionId: string;
  contentHash: string;
  kind: RevisionKind;
  reason: RevisionReason;
  label: string | null;
  createdAt: number;
}

export interface LoadedNoteRevision extends NoteRevision {
  content: string;
}

export interface CreateRevisionRequest {
  sessionId: string;
  content: string;
  contentHash: string;
  kind: RevisionKind;
  reason: RevisionReason;
  createdAt: number;
}

/** Result of restoring a revision as the current note. `note` always
 * reflects the restored content — restore never clears a note (blank
 * revisions are never created in the first place). `safetyRevision` is
 * the snapshot of whatever non-blank content restore displaced, or `null`
 * when there was nothing to displace (no prior note, or the fast idempotent
 * path when current content already matched the target). */
export interface RestoreRevisionResult {
  note: SessionNoteRow;
  safetyRevision: NoteRevision | null;
}

/** A fresh read of a session's current note content/hash, used to refresh
 * the revision browser's comparison after a stale-restore conflict without
 * touching which revision is selected. */
export interface CurrentNoteSnapshot {
  sessionId: string;
  content: string;
  contentHash: string | null;
}

/** Bounded diff/Markdown rendering above this many UTF-8 bytes falls back
 * to a capped, escaped plain-text excerpt instead — see revisionDiff.ts. */
export const MAX_DIFF_BYTES = 524_288;
/** Same bound, expressed in line count, for content that's mostly short
 * lines (byte count alone wouldn't catch a pathological many-line file). */
export const MAX_DIFF_LINES = 10_000;
/** Escaped fallback excerpts are capped at this many UTF-8 bytes so an
 * oversized file never causes unbounded DOM/parser work either. */
export const MAX_FALLBACK_BYTES = 32_768;

const MAX_LABEL_LENGTH = 80;

const validReasons: Record<RevisionKind, readonly RevisionReason[]> = {
  automatic: ['session_started', 'session_completed', 'review_finalized'],
  checkpoint: ['manual'],
  safety: ['before_clear', 'before_restore', 'before_external_overwrite', 'before_external_reload'],
};

/** Enforces the exact kind/reason pairing the SQLite CHECK constraint and
 * Rust enums also enforce — kept here too so the frontend never even
 * attempts to submit (or trust a normalized response for) a combination
 * native code would reject. */
export function validateRevisionPair(kind: RevisionKind, reason: RevisionReason): boolean {
  return validReasons[kind].includes(reason);
}

/** Trims a label and normalizes blank/whitespace-only input to `null`
 * (which restores the friendly default reason label). Counts Unicode
 * characters (via Array.from, which iterates code points) rather than
 * UTF-16 code units, so a label built from astral-plane characters (most
 * emoji) isn't penalized for using two code units per character. Throws
 * over the 80-character limit — Rust re-validates and is the final
 * authority, but the UI should never submit an already-invalid label. */
export function normalizeRevisionLabel(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (Array.from(trimmed).length > MAX_LABEL_LENGTH) {
    throw new Error(`Revision labels are limited to ${MAX_LABEL_LENGTH} characters.`);
  }
  return trimmed;
}

const defaultReasonLabel: Record<RevisionReason, string> = {
  session_started: 'Session started',
  session_completed: 'Session complete',
  review_finalized: 'Review finalized',
  manual: 'Checkpoint',
  before_clear: 'Before clear',
  before_restore: 'Before restore',
  before_external_overwrite: 'Before external overwrite',
  before_external_reload: 'Before external reload',
};

/** The label a revision timeline entry actually shows: the custom label
 * when one exists, otherwise the friendly default for its reason. */
export function revisionDisplayLabel(revision: Pick<NoteRevision, 'label' | 'reason'>): string {
  return revision.label ?? defaultReasonLabel[revision.reason];
}
