// Pure operations on the list of parked thoughts. Ids are supplied by the
// caller (e.g. crypto.randomUUID() in the UI layer) so this module stays
// free of hidden global/mutable state.

export interface ParkedThought {
  id: string;
  text: string;
  createdAt: number;
}

export function addParkedThought(
  thoughts: ParkedThought[],
  id: string,
  text: string,
  now: number,
): ParkedThought[] {
  const trimmed = text.trim();
  if (!trimmed) return thoughts;
  return [...thoughts, { id, text: trimmed, createdAt: now }];
}

export function removeParkedThought(thoughts: ParkedThought[], id: string): ParkedThought[] {
  return thoughts.filter((thought) => thought.id !== id);
}
