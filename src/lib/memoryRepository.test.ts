import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeSessionReview,
  createNoteRevision,
  deleteAllData,
  deleteNoteRevisionHistory,
  deleteParkedThoughtRow,
  deleteSessionRow,
  getSetting,
  insertImportedSession,
  insertParkedThought,
  insertParkedThoughtIfAbsent,
  keepAppNoteAfterConflict,
  loadAllParkedThoughts,
  loadAllSessionNotes,
  loadCompletedSessions,
  loadLatestSessionRow,
  loadNoteForSession,
  loadNoteRecordForSession,
  loadNoteRevision,
  loadNoteRevisionCounts,
  reloadExternalNoteAfterConflict,
  renameNoteRevision,
  resetMemoryStore,
  restoreNoteRevision,
  saveNote,
  saveSession,
  setSetting,
  listNoteRevisions,
  updateSessionProject,
} from './memoryRepository';
import type { CreateRevisionRequest } from './revisions';
import type { ParkedThought } from './parkingLot';
import {
  completeFocusIntoFlow,
  createIdleState,
  finishFlow,
  restartFocusCycle,
  startFocus,
  type SessionState,
} from './session';

function expectOk(result: { ok: boolean; state?: SessionState; error?: string }): SessionState {
  if (!result.ok) throw new Error(`Expected ok transition, got error: ${result.error}`);
  return result.state as SessionState;
}

const FOCUS_MS = 25 * 60 * 1000;
const SID = 'session-1';

async function saveCompleted(sessionId: string, task: string, completedAt: number) {
  let state = expectOk(startFocus(createIdleState(), task, FOCUS_MS, 1_000, sessionId));
  state = expectOk(completeFocusIntoFlow(state, 1_000 + FOCUS_MS));
  state = expectOk(finishFlow(state, completedAt));
  await saveSession(state, completedAt);
}

afterEach(() => {
  resetMemoryStore();
});

describe('memoryRepository stale-write guard', () => {
  it('keeps the newer row when a stale (older updated_at) write arrives after it', async () => {
    const state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, 1_000, SID));

    await saveSession(state, 2_000); // the "later" write lands first
    await saveSession(state, 1_000); // a stale write arrives after, out of order

    const row = await loadLatestSessionRow();
    expect(row?.updated_at).toBe(2_000); // stale write must not have overwritten it
  });

  it('still applies a genuinely newer write on top of an older one', async () => {
    const state = expectOk(startFocus(createIdleState(), 'Write the report', FOCUS_MS, 1_000, SID));

    await saveSession(state, 1_000);
    await saveSession(state, 2_000);

    const row = await loadLatestSessionRow();
    expect(row?.updated_at).toBe(2_000);
  });
});

describe('focus_deadline_at column (Phase 5B)', () => {
  it('persists a restarted focus cycle deadline and clears it once Flow begins', async () => {
    let state = expectOk(startFocus(createIdleState(), 'Deep work', FOCUS_MS, 1_000, SID));
    state = expectOk(restartFocusCycle(state, 1_000 + FOCUS_MS - 100));
    await saveSession(state, 1_000 + FOCUS_MS - 100);

    const focusingRow = await loadLatestSessionRow();
    expect(focusingRow?.focus_deadline_at).toBe(1_000 + FOCUS_MS - 100 + FOCUS_MS);

    const flow = expectOk(completeFocusIntoFlow(state, 1_000 + FOCUS_MS - 100 + FOCUS_MS));
    await saveSession(flow, 1_000 + FOCUS_MS - 100 + FOCUS_MS + 1);

    const flowRow = await loadLatestSessionRow();
    expect(flowRow?.focus_deadline_at).toBeNull();
  });

  it('round-trips parked thought insert/delete/list', async () => {
    const thought = { id: 't1', sessionId: SID, text: 'Check the deploy', createdAt: 1_000 };
    await insertParkedThought(thought);
    expect(await loadAllParkedThoughts()).toEqual([thought]);

    await deleteParkedThoughtRow('t1');
    expect(await loadAllParkedThoughts()).toEqual([]);
  });
});

describe('memoryRepository loadCompletedSessions', () => {
  it('excludes sessions that are not yet complete', async () => {
    const active = expectOk(startFocus(createIdleState(), 'Still going', FOCUS_MS, 1_000, 'active'));
    await saveSession(active, 1_000);
    await saveCompleted('done', 'Finished', 5_000);

    const rows = await loadCompletedSessions();
    expect(rows.map((r) => r.id)).toEqual(['done']);
  });

  it('orders completed sessions most-recently-completed first', async () => {
    await saveCompleted('s1', 'First', 1_000);
    await saveCompleted('s2', 'Second', 3_000);
    await saveCompleted('s3', 'Third', 2_000);

    const rows = await loadCompletedSessions();
    expect(rows.map((r) => r.id)).toEqual(['s2', 's3', 's1']);
  });
});

describe('memoryRepository deletion', () => {
  it('deleteSessionRow removes only the targeted session', async () => {
    await saveCompleted('s1', 'Keep me', 1_000);
    await saveCompleted('s2', 'Delete me', 2_000);

    await deleteSessionRow('s2');

    const rows = await loadCompletedSessions();
    expect(rows.map((r) => r.id)).toEqual(['s1']);
  });

  it('deleteSessionRow does not touch parked thoughts tagged with that session', async () => {
    await saveCompleted('s1', 'Some task', 1_000);
    const thought = { id: 't1', sessionId: 's1', text: 'Still relevant', createdAt: 1_000 };
    await insertParkedThought(thought);

    await deleteSessionRow('s1');

    expect(await loadAllParkedThoughts()).toEqual([thought]);
  });

  it('deleteAllData clears both sessions and parked thoughts', async () => {
    await saveCompleted('s1', 'First', 1_000);
    await saveCompleted('s2', 'Second', 2_000);
    await insertParkedThought({ id: 't1', sessionId: 's1', text: 'A thought', createdAt: 1_000 });

    await deleteAllData();

    expect(await loadCompletedSessions()).toEqual([]);
    expect(await loadAllParkedThoughts()).toEqual([]);
  });

  it('deleteAllData leaves settings untouched', async () => {
    await setSetting('selectedToneId', 'soft-bell');
    await saveCompleted('s1', 'First', 1_000);

    await deleteAllData();

    expect(await getSetting('selectedToneId')).toBe('soft-bell');
  });

  it('deleteSessionRow also removes that session\'s revision history', async () => {
    await saveCompleted('s1', 'Task', 1_000);
    await createNoteRevision(await revisionRequest({ sessionId: 's1' }));

    await deleteSessionRow('s1');

    expect((await loadNoteRevisionCounts()).get('s1')).toBeUndefined();
  });

  it('deleteAllData also clears every session\'s revision history', async () => {
    await saveCompleted('s1', 'Task', 1_000);
    await saveCompleted('s2', 'Other task', 1_000);
    await createNoteRevision(await revisionRequest({ sessionId: 's1' }));
    await createNoteRevision(await revisionRequest({ sessionId: 's2' }));

    await deleteAllData();

    expect(await loadNoteRevisionCounts()).toEqual(new Map());
  });

  it('deleteNoteRevisionHistory removes only the revisions, leaving the session and note', async () => {
    await saveCompleted('s1', 'Task', 1_000);
    const created = await createNoteRevision(await revisionRequest({ sessionId: 's1' }));

    await deleteNoteRevisionHistory('s1');

    expect((await loadNoteRevisionCounts()).get('s1')).toBeUndefined();
    await expect(loadNoteRevision(created!.id)).rejects.toThrow();
    expect((await loadCompletedSessions()).map((r) => r.id)).toEqual(['s1']);
  });
});

describe('memoryRepository notes', () => {
  it('returns null for a session with no note', async () => {
    expect(await loadNoteForSession('s1')).toBeNull();
  });

  it('saveNote creates a note retrievable by loadNoteForSession', async () => {
    await saveNote('s1', 'First draft of the note', 1_000);
    expect(await loadNoteForSession('s1')).toBe('First draft of the note');
  });

  it('saveNote called again updates content but preserves id and created_at', async () => {
    await saveNote('s1', 'First draft', 1_000);
    const [firstSave] = await loadAllSessionNotes();

    await saveNote('s1', 'Revised content', 2_000, { expectedHash: firstSave.content_hash });
    const [secondSave] = await loadAllSessionNotes();

    expect(secondSave.content).toBe('Revised content');
    expect(secondSave.id).toBe(firstSave.id);
    expect(secondSave.created_at).toBe(firstSave.created_at);
    expect(secondSave.updated_at).toBe(2_000);
  });

  it('carrying a note into a new session creates an independent row and leaves the original untouched', async () => {
    // Mirrors App.svelte's carry-forward: copy a completed session's
    // finalized note into a *new* session id, and confirm the original
    // session's own note (id, content, timestamps) is completely unaffected.
    await saveNote('completed-session', 'Follow up with Sam tomorrow', 1_000);
    const [originalBeforeCarry] = await loadAllSessionNotes();

    await saveNote('new-session', 'Follow up with Sam tomorrow', 2_000);

    const notes = await loadAllSessionNotes();
    expect(notes).toHaveLength(2);
    const original = notes.find((n) => n.session_id === 'completed-session')!;
    const carried = notes.find((n) => n.session_id === 'new-session')!;

    expect(original).toEqual(originalBeforeCarry); // untouched by the carry
    expect(carried.id).not.toBe(original.id); // independent row, not a shared reference
    expect(carried.content).toBe(original.content);
    expect(carried.created_at).toBe(2_000);
  });

  it('loadAllSessionNotes returns every stored note', async () => {
    await saveNote('s1', 'Note for s1', 1_000);
    await saveNote('s2', 'Note for s2', 1_000);

    const notes = await loadAllSessionNotes();
    expect(notes.map((n) => n.session_id).sort()).toEqual(['s1', 's2']);
  });

  it('whitespace content deletes the note instead of retaining an empty row', async () => {
    const first = await saveNote('s1', 'real note', 1_000);
    const result = await saveNote('s1', ' \n\t ', 2_000, { expectedHash: first.note!.content_hash });

    expect(result.note).toBeNull();
    expect(await loadNoteForSession('s1')).toBeNull();
    expect(await loadAllSessionNotes()).toEqual([]);
  });

  it('returns a new content hash after every distinct saved version', async () => {
    const first = await saveNote('s1', 'first', 1_000);
    const second = await saveNote('s1', 'second', 2_000, {
      expectedHash: first.note!.content_hash,
    });

    expect(second.note!.content_hash).not.toBe(first.note!.content_hash);
    expect((await loadNoteRecordForSession('s1'))!.content).toBe('second');
  });

  it('a stale expected hash is rejected as a conflict, returning the disk version', async () => {
    const first = await saveNote('s1', 'first', 1_000);
    await saveNote('s1', 'second', 2_000, { expectedHash: first.note!.content_hash });

    await expect(saveNote('s1', 'third', 3_000, { expectedHash: first.note!.content_hash })).rejects.toMatchObject({
      code: 'conflict',
      diskContent: 'second',
    });
  });

  it('force bypasses the expected-hash check and overwrites the current version', async () => {
    const first = await saveNote('s1', 'first', 1_000);
    await saveNote('s1', 'second', 2_000, { force: true });

    // A stale hash (from the very first save) would ordinarily conflict
    // against the current "second" content — force bypasses that.
    const forced = await saveNote('s1', 'third', 3_000, {
      expectedHash: first.note!.content_hash,
      force: true,
    });

    expect(forced.note!.content).toBe('third');
  });

  it('deleteSessionRow cascades to delete that session note', async () => {
    await saveCompleted('s1', 'Some task', 1_000);
    await saveNote('s1', 'Attached note', 1_000);

    await deleteSessionRow('s1');

    expect(await loadNoteForSession('s1')).toBeNull();
  });

  it('deleteAllData clears all notes', async () => {
    await saveNote('s1', 'Note one', 1_000);
    await saveNote('s2', 'Note two', 1_000);

    await deleteAllData();

    expect(await loadAllSessionNotes()).toEqual([]);
  });
});

describe('memoryRepository external conflict resolution', () => {
  it('keep snapshots the external content and writes the draft', async () => {
    const saved = await saveNote('s1', 'external edit', 1_000);
    const conflictHash = saved.note!.content_hash!;

    const result = await keepAppNoteAfterConflict('s1', 'my draft', conflictHash, 2_000);

    expect(result.note!.content).toBe('my draft');
    expect(result.safetyRevision).not.toBeNull();
    const loaded = await loadNoteRevision(result.safetyRevision!.id);
    expect(loaded.content).toBe('external edit');
    expect(loaded.reason).toBe('before_external_overwrite');
  });

  it('keep returns a fresh conflict when the stored content changed again', async () => {
    const saved = await saveNote('s1', 'first external edit', 1_000);
    const staleHash = saved.note!.content_hash!;
    await saveNote('s1', 'second external edit', 1_500, { force: true });

    await expect(keepAppNoteAfterConflict('s1', 'my draft', staleHash, 2_000)).rejects.toMatchObject({
      code: 'conflict',
      diskContent: 'second external edit',
    });
    expect(await loadNoteForSession('s1')).toBe('second external edit');
  });

  it('keep repairs metadata without a new snapshot when the draft already landed', async () => {
    const saved = await saveNote('s1', 'my draft', 1_000);
    const conflictHash = saved.note!.content_hash!;

    const result = await keepAppNoteAfterConflict('s1', 'my draft', conflictHash, 2_000);

    expect(result.note!.content).toBe('my draft');
    expect(result.safetyRevision).toBeNull();
    expect(await loadNoteRevisionCounts()).toEqual(new Map());
  });

  it('keep with a blank draft clears the note and snapshots the external content', async () => {
    const saved = await saveNote('s1', 'external edit', 1_000);
    const conflictHash = saved.note!.content_hash!;

    const result = await keepAppNoteAfterConflict('s1', '  \n ', conflictHash, 2_000);

    expect(result.note).toBeNull();
    expect(await loadNoteForSession('s1')).toBeNull();
    expect(result.safetyRevision).not.toBeNull();
    const loaded = await loadNoteRevision(result.safetyRevision!.id);
    expect(loaded.content).toBe('external edit');
  });

  it('reload snapshots the discarded draft and returns the verified stored content', async () => {
    const saved = await saveNote('s1', 'external edit', 1_000);
    const conflictHash = saved.note!.content_hash!;

    const result = await reloadExternalNoteAfterConflict('s1', 'my discarded draft', conflictHash, 2_000);

    expect(result.note!.content).toBe('external edit');
    expect(result.safetyRevision).not.toBeNull();
    const loaded = await loadNoteRevision(result.safetyRevision!.id);
    expect(loaded.content).toBe('my discarded draft');
    expect(loaded.reason).toBe('before_external_reload');
  });

  it('reload returns a fresh conflict when the stored content changed again', async () => {
    const saved = await saveNote('s1', 'first external edit', 1_000);
    const staleHash = saved.note!.content_hash!;
    await saveNote('s1', 'second external edit', 1_500, { force: true });

    await expect(
      reloadExternalNoteAfterConflict('s1', 'my discarded draft', staleHash, 2_000),
    ).rejects.toMatchObject({ code: 'conflict', diskContent: 'second external edit' });
    expect(await loadNoteRevisionCounts()).toEqual(new Map());
  });

  it('reload with a blank draft creates no safety revision', async () => {
    const saved = await saveNote('s1', 'external edit', 1_000);
    const conflictHash = saved.note!.content_hash!;

    const result = await reloadExternalNoteAfterConflict('s1', '  \n ', conflictHash, 2_000);

    expect(result.note!.content).toBe('external edit');
    expect(result.safetyRevision).toBeNull();
    expect(await loadNoteRevisionCounts()).toEqual(new Map());
  });
});

describe('memoryRepository settings', () => {
  it('returns null for a setting that has never been set', async () => {
    expect(await getSetting('selectedToneId')).toBeNull();
  });

  it('round-trips a stored value', async () => {
    await setSetting('selectedToneId', 'rising-arpeggio');
    expect(await getSetting('selectedToneId')).toBe('rising-arpeggio');
  });

  it('overwrites an existing value for the same key', async () => {
    await setSetting('selectedToneId', 'gentle-chime');
    await setSetting('selectedToneId', 'soft-bell');
    expect(await getSetting('selectedToneId')).toBe('soft-bell');
  });

  it('keeps different keys independent', async () => {
    await setSetting('selectedToneId', 'gentle-chime');
    await setSetting('someOtherSetting', 'value');
    expect(await getSetting('selectedToneId')).toBe('gentle-chime');
    expect(await getSetting('someOtherSetting')).toBe('value');
  });
});

async function hashOf(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function revisionRequest(overrides: Partial<CreateRevisionRequest> = {}): Promise<CreateRevisionRequest> {
  const content = overrides.content ?? 'content';
  return {
    sessionId: SID,
    content,
    contentHash: await hashOf(content),
    kind: 'checkpoint',
    reason: 'manual',
    createdAt: 1000,
    ...overrides,
  };
}

describe('memoryRepository note revisions', () => {
  it('creates a revision for an existing session', async () => {
    await saveCompleted(SID, 'Write report', 2000);

    const created = await createNoteRevision(await revisionRequest());

    expect(created?.sessionId).toBe(SID);
    expect(created?.kind).toBe('checkpoint');
    expect(created?.reason).toBe('manual');
    expect(created?.label).toBeNull();
  });

  it('rejects a revision for a session that does not exist', async () => {
    await expect(createNoteRevision(await revisionRequest({ sessionId: 'missing' }))).rejects.toThrow();
  });

  it('returns null for blank content without creating a revision', async () => {
    await saveCompleted(SID, 'Write report', 2000);

    const result = await createNoteRevision(await revisionRequest({ content: '   \n\t ', contentHash: await hashOf('   \n\t ') }));

    expect(result).toBeNull();
    expect(await listNoteRevisions(SID)).toHaveLength(0);
  });

  it('rejects content that does not match its declared hash', async () => {
    await saveCompleted(SID, 'Write report', 2000);

    await expect(
      createNoteRevision(await revisionRequest({ contentHash: await hashOf('something else') })),
    ).rejects.toThrow();
  });

  it('dedupes exact session/hash content into one revision', async () => {
    await saveCompleted(SID, 'Write report', 2000);

    const first = await createNoteRevision(await revisionRequest());
    const second = await createNoteRevision(await revisionRequest());

    expect(first?.id).toBe(second?.id);
    expect(await listNoteRevisions(SID)).toHaveLength(1);
  });

  it('lists revisions newest first, breaking a timestamp tie by insertion order', async () => {
    await saveCompleted(SID, 'Write report', 2000);

    const first = await createNoteRevision(await revisionRequest({ content: 'one', contentHash: await hashOf('one'), createdAt: 1000 }));
    const second = await createNoteRevision(
      await revisionRequest({ content: 'two', contentHash: await hashOf('two'), createdAt: 1000 }),
    );
    const third = await createNoteRevision(
      await revisionRequest({ content: 'three', contentHash: await hashOf('three'), createdAt: 500 }),
    );

    const listed = await listNoteRevisions(SID);
    expect(listed.map((r) => r.id)).toEqual([second!.id, first!.id, third!.id]);
  });

  it('loads a revision body without affecting its metadata', async () => {
    await saveCompleted(SID, 'Write report', 2000);
    const created = await createNoteRevision(await revisionRequest({ content: 'hello world' }));

    const loaded = await loadNoteRevision(created!.id);

    expect(loaded.content).toBe('hello world');
    expect(loaded.id).toBe(created!.id);
    expect(loaded.sessionId).toBe(SID);
  });

  it('renames trim, normalize blank to null, and never touch the stored body', async () => {
    await saveCompleted(SID, 'Write report', 2000);
    const created = await createNoteRevision(await revisionRequest({ content: 'hello world' }));

    const renamed = await renameNoteRevision(created!.id, '  Launch draft  ');
    expect(renamed.label).toBe('Launch draft');

    const cleared = await renameNoteRevision(created!.id, '   ');
    expect(cleared.label).toBeNull();

    const loaded = await loadNoteRevision(created!.id);
    expect(loaded.content).toBe('hello world');
  });

  it('counts revisions per session without exposing bodies', async () => {
    await saveCompleted(SID, 'Write report', 2000);
    await saveCompleted('other-session', 'Other task', 2000);
    await createNoteRevision(await revisionRequest({ content: 'one', contentHash: await hashOf('one') }));
    await createNoteRevision(await revisionRequest({ content: 'two', contentHash: await hashOf('two') }));
    await createNoteRevision(
      await revisionRequest({ sessionId: 'other-session', content: 'three', contentHash: await hashOf('three') }),
    );

    const counts = await loadNoteRevisionCounts();

    expect(counts.get(SID)).toBe(2);
    expect(counts.get('other-session')).toBe(1);
  });
});

describe('memoryRepository restore', () => {
  it('is an idempotent success with no safety revision when current content already matches the target', async () => {
    await saveCompleted(SID, 'Write report', 2000);
    const target = await createNoteRevision(await revisionRequest({ content: 'same content' }));
    await saveNote(SID, 'same content', 2500);

    const result = await restoreNoteRevision(target!.id, 'not-the-real-hash', 3000);

    expect(result.note.content).toBe('same content');
    expect(result.safetyRevision).toBeNull();
  });

  it('rejects a stale expected current hash as a conflict without changing anything', async () => {
    await saveCompleted(SID, 'Write report', 2000);
    const target = await createNoteRevision(await revisionRequest({ content: 'target content' }));
    await saveNote(SID, 'current content', 2500);

    await expect(restoreNoteRevision(target!.id, 'stale-hash', 3000)).rejects.toMatchObject({
      code: 'conflict',
      diskContent: 'current content',
    });
    expect(await loadNoteForSession(SID)).toBe('current content');
  });

  it('snapshots non-blank displaced content as before_restore before replacing it', async () => {
    await saveCompleted(SID, 'Write report', 2000);
    const target = await createNoteRevision(await revisionRequest({ content: 'target content' }));
    const current = await saveNote(SID, 'current content', 2500);

    const result = await restoreNoteRevision(target!.id, current.note!.content_hash, 3000);

    expect(result.note.content).toBe('target content');
    expect(result.safetyRevision?.reason).toBe('before_restore');
    const loaded = await loadNoteRevision(result.safetyRevision!.id);
    expect(loaded.content).toBe('current content');
  });

  it('creates a current note when none exists yet', async () => {
    await saveCompleted(SID, 'Write report', 2000);
    const target = await createNoteRevision(await revisionRequest({ content: 'revived content' }));

    const result = await restoreNoteRevision(target!.id, null, 3000);

    expect(result.note.content).toBe('revived content');
    expect(result.safetyRevision).toBeNull();
    expect(await loadNoteForSession(SID)).toBe('revived content');
  });
});

describe('acknowledgeSessionReview (PR #14 review fix)', () => {
  it('affects exactly one completed row: sets review_acknowledged_at, and bumps updated_at', async () => {
    await saveCompleted(SID, 'Write the report', 5_000);

    await acknowledgeSessionReview(SID, 9_000);

    const row = await loadLatestSessionRow();
    expect(row?.review_acknowledged_at).toBe(9_000);
    expect(row?.updated_at).toBe(9_000);
  });

  it('rejects for a session id that does not exist', async () => {
    await expect(acknowledgeSessionReview('no-such-session', 1_000)).rejects.toThrow();
    expect(await loadLatestSessionRow()).toBeNull();
  });

  it('rejects for a session that is not complete, and leaves it untouched', async () => {
    const state = expectOk(startFocus(createIdleState(), 'Still focusing', FOCUS_MS, 1_000, SID));
    await saveSession(state, 1_000);

    await expect(acknowledgeSessionReview(SID, 2_000)).rejects.toThrow();

    const row = await loadLatestSessionRow();
    expect(row?.review_acknowledged_at).toBeNull();
    expect(row?.updated_at).toBe(1_000); // untouched — the rejected write never landed
  });

  it('deleting a session removes its acknowledgement state along with everything else', async () => {
    await saveCompleted(SID, 'Write the report', 5_000);
    await acknowledgeSessionReview(SID, 9_000);

    await deleteSessionRow(SID);

    expect(await loadLatestSessionRow()).toBeNull();
    expect(await loadCompletedSessions()).toEqual([]);
  });

  it('Delete All Data removes every session\'s acknowledgement state along with everything else', async () => {
    await saveCompleted(SID, 'Write the report', 5_000);
    await acknowledgeSessionReview(SID, 9_000);

    await deleteAllData();

    expect(await loadLatestSessionRow()).toBeNull();
    expect(await loadCompletedSessions()).toEqual([]);
  });
});

describe('project_id preservation across saveSession (regression test for Task 3 bug)', () => {
  it('preserves project_id when saveSession is called again after updateSessionProject', async () => {
    // This tests the fix for: saveSession was doing a full replace of the session row object,
    // which wiped out project_id (set separately via updateSessionProject) on every save.
    // The fix merges instead of replaces, preserving fields not in serializeSessionState's output.

    // Create and save a completed session, capturing the state so we can re-save it later
    let state = expectOk(startFocus(createIdleState(), 'Tagged task', FOCUS_MS, 1_000, SID));
    state = expectOk(completeFocusIntoFlow(state, 1_000 + FOCUS_MS));
    state = expectOk(finishFlow(state, 1_000));
    await saveSession(state, 1_000);

    let row = await loadLatestSessionRow();
    expect(row?.project_id).toBeUndefined(); // initially no project
    expect(row?.status).toBe('complete'); // verify it's complete

    // Tag it with a project
    const projectId = 'project-123';
    await updateSessionProject(SID, projectId);
    row = await loadLatestSessionRow();
    expect(row?.project_id).toBe(projectId); // project is now set

    // Simulate a subsequent re-save of the same session state (e.g., during recovery or
    // a heartbeat persist). This saveSession call should NOT wipe out the project_id.
    await saveSession(state, 2_000); // newer updatedAt, same state

    // Verify project_id is still there
    row = await loadLatestSessionRow();
    expect(row?.project_id).toBe(projectId);
    expect(row?.updated_at).toBe(2_000); // verify the newer timestamp was saved

    // Also verify loadCompletedSessions still shows the project
    const completed = await loadCompletedSessions();
    const foundRow = completed.find((r) => r.id === SID);
    expect(foundRow?.project_id).toBe(projectId);
  });
});

describe('insertImportedSession', () => {
  const fields = {
    id: 's1',
    task: 'Imported task',
    completedAt: 1_700_000_000_000,
    plannedFocusMs: 25 * 60_000,
    actualFocusMs: 20 * 60_000,
    flowMs: 0,
    breakMs: 5 * 60_000,
    breakIntermissionMs: 60_000,
    touchGrassMs: 0,
    totalElapsedMs: 25 * 60_000,
  };

  it('inserts a new completed session row and returns "inserted"', async () => {
    const outcome = await insertImportedSession(fields, 1_700_000_100_000);
    expect(outcome).toBe('inserted');

    const rows = await loadCompletedSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 's1',
      task: 'Imported task',
      status: 'complete',
      completed_at: 1_700_000_000_000,
      planned_focus_ms: 25 * 60_000,
      actual_focus_ms: 20 * 60_000,
      break_ms: 5 * 60_000,
      break_intermission_ms: 60_000,
      total_elapsed_ms: 25 * 60_000,
    });
    // Set immediately so this row can never surface as a live review
    // screen if it ever becomes the most-recently-updated row.
    expect(rows[0].review_acknowledged_at).not.toBeNull();
  });

  it('skips and leaves the existing row untouched when the id already exists', async () => {
    await insertImportedSession(fields, 1_700_000_100_000);
    const outcome = await insertImportedSession({ ...fields, task: 'Different task' }, 1_700_000_200_000);
    expect(outcome).toBe('skipped');

    const rows = await loadCompletedSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].task).toBe('Imported task');
  });
});

describe('insertParkedThoughtIfAbsent', () => {
  const thought: ParkedThought = { id: 't1', sessionId: 's1', text: 'Imported thought', createdAt: 1_700_000_000_000 };

  it('inserts a new thought and returns "inserted"', async () => {
    const outcome = await insertParkedThoughtIfAbsent(thought);
    expect(outcome).toBe('inserted');
    expect(await loadAllParkedThoughts()).toEqual([thought]);
  });

  it('skips and leaves the existing thought untouched when the id already exists', async () => {
    await insertParkedThoughtIfAbsent(thought);
    const outcome = await insertParkedThoughtIfAbsent({ ...thought, text: 'Different text' });
    expect(outcome).toBe('skipped');

    const thoughts = await loadAllParkedThoughts();
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe('Imported thought');
  });
});
