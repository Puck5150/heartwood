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
import { serializeSessionState, type SessionRow } from './persistence';
import type { SessionState } from './session';

const sessions = new Map<string, SessionRow>();
let parkedThoughts: ParkedThought[] = [];

/** Test-only: reset in-memory state between test cases. */
export function resetMemoryStore(): void {
  sessions.clear();
  parkedThoughts = [];
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

export async function insertParkedThought(thought: ParkedThought): Promise<void> {
  parkedThoughts = [...parkedThoughts, thought];
}

export async function deleteParkedThoughtRow(id: string): Promise<void> {
  parkedThoughts = parkedThoughts.filter((thought) => thought.id !== id);
}

export async function loadAllParkedThoughts(): Promise<ParkedThought[]> {
  return [...parkedThoughts];
}
