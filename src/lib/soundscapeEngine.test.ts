import { describe, expect, it, vi } from 'vitest';
import { createDisposableRegistry, smoothGain } from './soundscapeEngine';

describe('soundscape engine helpers', () => {
  it('disposes every registered resource once and rejects late additions', () => {
    const registry = createDisposableRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.add(first);
    registry.add(second);

    registry.dispose();
    registry.dispose();
    const late = vi.fn();
    registry.add(late);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('uses a short ramp and falls back to an immediate value when ramping fails', () => {
    const parameter = {
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(() => {
        throw new Error('ramp unavailable');
      }),
      value: 0,
    };

    smoothGain(parameter, 0.6, 10, 0.25);

    expect(parameter.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(parameter.value).toBe(0.6);
  });
});
