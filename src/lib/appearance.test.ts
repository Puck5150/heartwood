import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_TONE_ID, DEFAULT_TONE_ID } from './sound';
import {
  APP_SETTING_KEYS,
  APPEARANCE_OPTIONS,
  DEFAULT_APP_SETTINGS,
  focusWarningLeadToMs,
  FOCUS_WARNING_OPTIONS,
  parseAppearanceMode,
  parseFocusWarningLeadMs,
  parseReturnToneId,
  parseThemeFamily,
  parseTimerAccent,
  parseToneId,
  resolveAppearance,
  THEME_OPTIONS,
  TIMER_ACCENT_OPTIONS,
} from './appearance';

describe('parseThemeFamily', () => {
  it.each([
    ['sunlit', 'sunlit'],
    ['cozy', 'cozy'],
    ['quiet-natural', 'quiet-natural'],
    ['coastal-air', 'coastal-air'],
    ['night-walk', 'night-walk'],
    ['moon-garden', 'moon-garden'],
    ['graphite', 'graphite'],
    ['unknown', 'sunlit'],
    ['', 'sunlit'],
    [null, 'sunlit'],
    [undefined, 'sunlit'],
    [42, 'sunlit'],
  ])('parses theme %p as %s', (input, expected) => {
    expect(parseThemeFamily(input)).toBe(expected);
  });

  it('defaults to Sunlit, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.themeFamily).toBe('sunlit');
  });
});

describe('parseAppearanceMode', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    ['unknown', 'system'],
    [null, 'system'],
    [undefined, 'system'],
    [7, 'system'],
  ])('parses appearance mode %p as %s', (input, expected) => {
    expect(parseAppearanceMode(input)).toBe(expected);
  });

  it('defaults to System, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.appearanceMode).toBe('system');
  });
});

describe('parseTimerAccent', () => {
  it.each([
    ['blue', 'blue'],
    ['green', 'green'],
    ['orange', 'orange'],
    ['red', 'red'],
    ['yellow', 'yellow'],
    ['purple', 'blue'],
    [null, 'blue'],
    [undefined, 'blue'],
    [{}, 'blue'],
  ])('parses timer accent %p as %s', (input, expected) => {
    expect(parseTimerAccent(input)).toBe(expected);
  });

  it('defaults to Blue, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.timerAccent).toBe('blue');
  });
});

describe('parseToneId', () => {
  it('keeps the existing tone catalog and falls back independently', () => {
    expect(parseToneId('soft-bell')).toBe('soft-bell');
    expect(parseToneId('rising-arpeggio')).toBe('rising-arpeggio');
    expect(parseToneId('removed-tone')).toBe(DEFAULT_TONE_ID);
    expect(parseToneId(null)).toBe(DEFAULT_TONE_ID);
    expect(parseToneId(undefined)).toBe(DEFAULT_TONE_ID);
  });

  it('defaults to the existing DEFAULT_TONE_ID, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.selectedToneId).toBe(DEFAULT_TONE_ID);
  });
});

describe('parseReturnToneId', () => {
  it('accepts only the independent return-tone catalog and falls back calmly', () => {
    expect(parseReturnToneId('sad-trombone')).toBe('sad-trombone');
    expect(parseReturnToneId('calm-return')).toBe('calm-return');
    expect(parseReturnToneId(DEFAULT_TONE_ID)).toBe(DEFAULT_RETURN_TONE_ID);
    expect(parseReturnToneId(null)).toBe(DEFAULT_RETURN_TONE_ID);
  });
});

describe('resolveAppearance', () => {
  it('resolves only System through the media preference', () => {
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('light', true)).toBe('light');
    expect(resolveAppearance('light', false)).toBe('light');
    expect(resolveAppearance('dark', false)).toBe('dark');
    expect(resolveAppearance('dark', true)).toBe('dark');
  });
});

describe('APP_SETTING_KEYS', () => {
  it('preserves the exact existing selectedToneId key', () => {
    expect(APP_SETTING_KEYS.selectedToneId).toBe('selectedToneId');
  });

  it('exposes exactly the six persisted keys', () => {
    expect(Object.keys(APP_SETTING_KEYS).sort()).toEqual(
      [
        'appearanceMode',
        'focusWarningLeadMs',
        'selectedReturnToneId',
        'selectedToneId',
        'themeFamily',
        'timerAccent',
      ].sort(),
    );
  });
});

describe('parseFocusWarningLeadMs', () => {
  it.each([
    ['off', 'off'],
    ['30000', '30000'],
    ['60000', '60000'],
    ['120000', '120000'],
    ['300000', '300000'],
    [30000, '30000'],
    ['15', '30000'],
    ['not-a-value', '30000'],
    [null, '30000'],
    [undefined, '30000'],
    [{}, '30000'],
  ])('parses focus warning lead %p as %s', (input, expected) => {
    expect(parseFocusWarningLeadMs(input)).toBe(expected);
  });

  it('defaults to 30 seconds, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.focusWarningLeadMs).toBe('30000');
  });
});

describe('focusWarningLeadToMs', () => {
  it('converts every stored preset to milliseconds, and Off to null', () => {
    expect(focusWarningLeadToMs('off')).toBeNull();
    expect(focusWarningLeadToMs('30000')).toBe(30_000);
    expect(focusWarningLeadToMs('60000')).toBe(60_000);
    expect(focusWarningLeadToMs('120000')).toBe(120_000);
    expect(focusWarningLeadToMs('300000')).toBe(300_000);
  });
});

describe('FOCUS_WARNING_OPTIONS', () => {
  it('lists exactly Off, 30 seconds, 1 minute, 2 minutes, and 5 minutes with labels', () => {
    expect(FOCUS_WARNING_OPTIONS.map((option) => option.value)).toEqual([
      'off',
      '30000',
      '60000',
      '120000',
      '300000',
    ]);
    for (const option of FOCUS_WARNING_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });
});

describe('metadata option lists', () => {
  it('lists exactly the seven required theme families with labels', () => {
    expect(THEME_OPTIONS.map((option) => option.value)).toEqual([
      'sunlit',
      'cozy',
      'quiet-natural',
      'coastal-air',
      'night-walk',
      'moon-garden',
      'graphite',
    ]);
    for (const option of THEME_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('lists exactly Light, Dark, and System with labels', () => {
    expect(APPEARANCE_OPTIONS.map((option) => option.value)).toEqual(['light', 'dark', 'system']);
    for (const option of APPEARANCE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('lists exactly the five required timer accents with labels', () => {
    expect(TIMER_ACCENT_OPTIONS.map((option) => option.value)).toEqual([
      'blue',
      'green',
      'orange',
      'red',
      'yellow',
    ]);
    for (const option of TIMER_ACCENT_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });
});

describe('DEFAULT_APP_SETTINGS', () => {
  it('is frozen so a caller cannot mutate the shared default object', () => {
    expect(Object.isFrozen(DEFAULT_APP_SETTINGS)).toBe(true);
  });
});
