import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteParkedThoughtRow,
  insertParkedThought,
  loadAllParkedThoughts,
  loadCompletedSessions,
  loadLatestSessionRow,
  resetMemoryStore,
  saveSession,
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
  async function saveCompleted(sessionId: string, task: string, completedAt: number) {
    let state = expectOk(startFocus(createIdleState(), task, FOCUS_MS, 1_000, sessionId));
    state = expectOk(completeFocus(state, 1_000 + FOCUS_MS));
    state = expectOk(chooseFinish(state, completedAt));
    await saveSession(state, completedAt);
  }

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
