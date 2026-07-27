import { describe, expect, it } from 'vitest';
import { addParkedThought, removeParkedThought, splitBySession } from './parkingLot';

describe('parking lot', () => {
  it('tags each thought with the session that captured it', () => {
    const thoughts = addParkedThought([], 't1', 'Check the deploy', 1_000, 'session-1');
    expect(thoughts).toEqual([
      { id: 't1', text: 'Check the deploy', createdAt: 1_000, sessionId: 'session-1' },
    ]);
  });

  it('ignores blank or whitespace-only thoughts', () => {
    expect(addParkedThought([], 't1', '   ', 1_000, 'session-1')).toEqual([]);
  });

  it('removes a thought by id regardless of which session it belongs to', () => {
    let thoughts = addParkedThought([], 't1', 'From session 1', 1_000, 'session-1');
    thoughts = addParkedThought(thoughts, 't2', 'From session 2', 2_000, 'session-2');

    thoughts = removeParkedThought(thoughts, 't1');
    expect(thoughts.map((t) => t.id)).toEqual(['t2']);
  });

  it('splits thoughts into this-session vs. carried-forward from earlier sessions', () => {
    let thoughts = addParkedThought([], 't1', 'From an earlier session', 1_000, 'session-1');
    thoughts = addParkedThought(thoughts, 't2', 'From this session', 2_000, 'session-2');
    thoughts = addParkedThought(thoughts, 't3', 'Also from this session', 3_000, 'session-2');

    const split = splitBySession(thoughts, 'session-2');
    expect(split.current.map((t) => t.id)).toEqual(['t2', 't3']);
    expect(split.carriedForward.map((t) => t.id)).toEqual(['t1']);
  });

  it('does not leak thoughts from a previous session into a new session with no carry-forward', () => {
    // Simulates: session-1 parks a thought and is promoted/deleted away, then
    // session-2 starts clean with nothing left in the pool.
    let thoughts = addParkedThought([], 't1', 'Old thought', 1_000, 'session-1');
    thoughts = removeParkedThought(thoughts, 't1');

    const split = splitBySession(thoughts, 'session-2');
    expect(split.current).toEqual([]);
    expect(split.carriedForward).toEqual([]);
  });
});
