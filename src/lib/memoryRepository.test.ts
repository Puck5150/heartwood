import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteParkedThoughtRow,
  insertParkedThought,
  loadAllParkedThoughts,
  loadLatestSessionRow,
  resetMemoryStore,
  saveSession,
} from './memoryRepository';
import { createIdleState, startFocus, type SessionState } from './session';

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
