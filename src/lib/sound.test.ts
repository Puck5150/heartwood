import { describe, expect, it } from 'vitest';
import { buildFocusCompleteChimeSchedule } from './sound';

describe('buildFocusCompleteChimeSchedule', () => {
  it('plays two ascending notes', () => {
    const schedule = buildFocusCompleteChimeSchedule();
    expect(schedule).toHaveLength(2);
    expect(schedule[1].frequencyHz).toBeGreaterThan(schedule[0].frequencyHz);
  });

  it('gives every step a positive duration', () => {
    for (const step of buildFocusCompleteChimeSchedule()) {
      expect(step.durationS).toBeGreaterThan(0);
    }
  });

  it('schedules notes back-to-back without overlapping', () => {
    const schedule = buildFocusCompleteChimeSchedule();
    for (let i = 1; i < schedule.length; i++) {
      const previousEnd = schedule[i - 1].startOffsetS + schedule[i - 1].durationS;
      expect(schedule[i].startOffsetS).toBeGreaterThanOrEqual(previousEnd);
    }
  });

  it('starts the first note immediately', () => {
    const schedule = buildFocusCompleteChimeSchedule();
    expect(schedule[0].startOffsetS).toBe(0);
  });
});
