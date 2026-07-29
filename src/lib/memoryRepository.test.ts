import { afterEach, describe, expect, it } from 'vitest';
import {
  createNoteRevision,
  deleteAllData,
  deleteParkedThoughtRow,
  deleteSessionRow,
  getSetting,
  insertParkedThought,
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
  saveNote,
  saveSession,
  setSetting,
  listNoteRevisions,
} from './memoryRepository';
import type { CreateRevisionRequest } from './revisions';
import {
  chooseFinish,
  completeFocus,
  createIdleState,
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
  state = expectOk(completeFocus(state, 1_000 + FOCUS_MS));
  state = expectOk(chooseFinish(state, completedAt));
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
