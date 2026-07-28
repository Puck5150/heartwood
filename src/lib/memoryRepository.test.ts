import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteAllData,
  deleteNoteForSession,
  deleteParkedThoughtRow,
  deleteSessionRow,
  getSetting,
  insertParkedThought,
  loadAllParkedThoughts,
  loadAllSessionNotes,
  loadCompletedSessions,
  loadLatestSessionRow,
  loadNoteForSession,
  resetMemoryStore,
  saveNote,
  saveSession,
  setSetting,
} from './memoryRepository';
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

    await saveNote('s1', 'Revised content', 2_000);
    const [secondSave] = await loadAllSessionNotes();

    expect(secondSave.content).toBe('Revised content');
    expect(secondSave.id).toBe(firstSave.id);
    expect(secondSave.created_at).toBe(firstSave.created_at);
    expect(secondSave.updated_at).toBe(2_000);
  });

  it('loadAllSessionNotes returns every stored note', async () => {
    await saveNote('s1', 'Note for s1', 1_000);
    await saveNote('s2', 'Note for s2', 1_000);

    const notes = await loadAllSessionNotes();
    expect(notes.map((n) => n.session_id).sort()).toEqual(['s1', 's2']);
  });

  it('deleteNoteForSession removes just that session note', async () => {
    await saveNote('s1', 'Keep me... actually delete me', 1_000);
    await saveNote('s2', 'Leave me alone', 1_000);

    await deleteNoteForSession('s1');

    expect(await loadNoteForSession('s1')).toBeNull();
    expect(await loadNoteForSession('s2')).toBe('Leave me alone');
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
