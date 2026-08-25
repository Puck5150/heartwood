import { describe, expect, it } from 'vitest';
import { growInTransitionParams } from './motion';

describe('growInTransitionParams', () => {
  it('animates a subtle scale-settle when motion is not reduced', () => {
    expect(growInTransitionParams(false)).toEqual({ start: 1.06, opacity: 1, duration: 220 });
  });

  it('is instant (no scale, zero duration) when motion is reduced', () => {
    expect(growInTransitionParams(true)).toEqual({ start: 1, opacity: 1, duration: 0 });
  });
});
