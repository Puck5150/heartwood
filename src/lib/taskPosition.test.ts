import { describe, expect, it } from 'vitest';
import { positionBetween } from './taskPosition';

describe('positionBetween', () => {
  it('returns 0 for an empty column (no neighbors)', () => {
    expect(positionBetween(null, null)).toBe(0);
  });

  it('returns one less than the first item when inserting at the top', () => {
    expect(positionBetween(null, 5)).toBe(4);
  });

  it('returns one more than the last item when inserting at the bottom', () => {
    expect(positionBetween(5, null)).toBe(6);
  });

  it('returns the midpoint when inserting between two items', () => {
    expect(positionBetween(2, 4)).toBe(3);
    expect(positionBetween(1, 2)).toBe(1.5);
  });
});
