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
  parseLicenseKey,
  parsePomodoroStreak,
  parseReturnToneId,
  parseSoundscapeId,
  parseSoundscapeVolume,
  parseThemeFamily,
  parseTimerAccent,
  parseToneId,
  parseTouchGrassReminderThresholdMs,
  resolveAppearance,
  THEME_OPTIONS,
  TIMER_ACCENT_OPTIONS,
  TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS,
  touchGrassReminderThresholdToMs,
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

  it('exposes exactly the thirteen persisted keys', () => {
    expect(Object.keys(APP_SETTING_KEYS).sort()).toEqual(
      [
        'appearanceMode',
        'dismissedHints',
        'focusWarningLeadMs',
        'licenseKey',
        'pomodoroStreak',
        'selectedReturnToneId',
        'selectedSoundscapeId',
        'selectedToneId',
        'soundscapeVolume',
        'themeFamily',
        'timerAccent',
        'timerProgressStyle',
        'touchGrassReminderThresholdMs',
      ].sort(),
    );
  });
});

describe('parseFocusWarningLeadMs', () => {
  it.each([
    ['off', 'off'],
    ['15000', '15000'],
    ['30000', '30000'],
    [30000, '30000'],
    ['60000', '30000'],
    ['120000', '30000'],
    ['300000', '30000'],
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
  it('converts the stored presets to milliseconds, and Off to null', () => {
    expect(focusWarningLeadToMs('off')).toBeNull();
    expect(focusWarningLeadToMs('15000')).toBe(15_000);
    expect(focusWarningLeadToMs('30000')).toBe(30_000);
  });
});

describe('FOCUS_WARNING_OPTIONS', () => {
  it('lists exactly Off, 15 seconds, and 30 seconds with labels', () => {
    expect(FOCUS_WARNING_OPTIONS).toEqual([
      { value: 'off', label: 'Off' },
      { value: '15000', label: '15 seconds' },
      { value: '30000', label: '30 seconds' },
    ]);
  });
});

describe('parseTouchGrassReminderThresholdMs', () => {
  it.each([
    ['off', 'off'],
    ['1800000', '1800000'],
    ['2700000', '2700000'],
    ['3600000', '3600000'],
    ['5400000', '5400000'],
    ['7200000', '7200000'],
    [3600000, '3600000'],
    ['60000', '3600000'],
    ['not-a-value', '3600000'],
    [null, '3600000'],
    [undefined, '3600000'],
    [{}, '3600000'],
  ])('parses touch grass reminder threshold %p as %s', (input, expected) => {
    expect(parseTouchGrassReminderThresholdMs(input)).toBe(expected);
  });

  it('defaults to 60 minutes, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.touchGrassReminderThresholdMs).toBe('3600000');
  });
});

describe('touchGrassReminderThresholdToMs', () => {
  it('converts the stored presets to milliseconds, and Off to null', () => {
    expect(touchGrassReminderThresholdToMs('off')).toBeNull();
    expect(touchGrassReminderThresholdToMs('1800000')).toBe(1_800_000);
    expect(touchGrassReminderThresholdToMs('3600000')).toBe(3_600_000);
  });
});

describe('parsePomodoroStreak', () => {
  it.each([
    ['0', '0'],
    ['1', '1'],
    ['2', '2'],
    ['3', '3'],
    [0, '0'],
    ['4', '0'],
    ['-1', '0'],
    ['not-a-value', '0'],
    [null, '0'],
    [undefined, '0'],
    [{}, '0'],
  ])('parses pomodoro streak %p as %s', (input, expected) => {
    expect(parsePomodoroStreak(input)).toBe(expected);
  });

  it('defaults to 0, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.pomodoroStreak).toBe('0');
  });
});

describe('parseLicenseKey', () => {
  it.each([
    ['some-key-string', 'some-key-string'],
    ['', ''],
    [null, ''],
    [undefined, ''],
    [42, ''],
  ])('parses %p as %p', (input, expected) => {
    expect(parseLicenseKey(input)).toBe(expected);
  });

  it('defaults to an empty string, matching DEFAULT_APP_SETTINGS', () => {
    expect(DEFAULT_APP_SETTINGS.licenseKey).toBe('');
  });
});

describe('TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS', () => {
  it('lists exactly Off, 30/45/60/90/120 minutes with labels', () => {
    expect(TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS).toEqual([
      { value: 'off', label: 'Off' },
      { value: '1800000', label: '30 minutes' },
      { value: '2700000', label: '45 minutes' },
      { value: '3600000', label: '60 minutes' },
      { value: '5400000', label: '90 minutes' },
      { value: '7200000', label: '120 minutes' },
    ]);
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

  it('uses the approved local soundscape defaults', () => {
    expect(DEFAULT_APP_SETTINGS.selectedSoundscapeId).toBe('deep-focus');
    expect(DEFAULT_APP_SETTINGS.soundscapeVolume).toBe('0.35');
  });
});

describe('soundscape setting parsers', () => {
  it('validates selection and volume independently', () => {
    expect(parseSoundscapeId('still-air')).toBe('still-air');
    expect(parseSoundscapeId('unknown')).toBe('deep-focus');
    expect(parseSoundscapeVolume('0.8')).toBe('0.8');
    expect(parseSoundscapeVolume('not-a-number')).toBe('0.35');
  });
});
