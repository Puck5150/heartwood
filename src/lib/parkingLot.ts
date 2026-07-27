// Pure operations on the list of parked thoughts. Ids are supplied by the
// caller (e.g. crypto.randomUUID() in the UI layer) so this module stays
// free of hidden global/mutable state.
//
// Ownership model (Phase 1): the parking lot is one global, app-lifetime
// list — not cleared between sessions — but each thought is tagged with the
// sessionId of the session that captured it. This lets "kept for later"
// thoughts (per product-direction.md's parking-lot lifecycle) genuinely
// carry forward across sessions, while the UI can still tell "captured just
// now" apart from "left over from an earlier session" and label them
// distinctly instead of silently mixing them:
//   - During a live session, only thoughts tagged with the current
//     sessionId are shown in the active parking-lot list.
//   - On the review screen, splitBySession() separates thoughts captured
//     during the session that just ended from everything else still
//     sitting in the pool, so older carry-forward items are always shown
//     under their own explicit heading, never blended in unlabeled.

export interface ParkedThought {
  id: string;
  text: string;
  createdAt: number;
  sessionId: string;
}

export function addParkedThought(
  thoughts: ParkedThought[],
  id: string,
  text: string,
  now: number,
  sessionId: string,
): ParkedThought[] {
  const trimmed = text.trim();
  if (!trimmed) return thoughts;
  return [...thoughts, { id, text: trimmed, createdAt: now, sessionId }];
}

export function removeParkedThought(thoughts: ParkedThought[], id: string): ParkedThought[] {
  return thoughts.filter((thought) => thought.id !== id);
}

export interface SessionThoughtSplit {
  current: ParkedThought[];
  carriedForward: ParkedThought[];
}

/** Splits thoughts into "captured during this session" vs. everything else
 * still parked from earlier sessions. */
export function splitBySession(thoughts: ParkedThought[], sessionId: string): SessionThoughtSplit {
  return {
    current: thoughts.filter((thought) => thought.sessionId === sessionId),
    carriedForward: thoughts.filter((thought) => thought.sessionId !== sessionId),
  };
}
