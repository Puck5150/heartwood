// The typed appearance/settings domain: closed unions for every persisted
// preference, their independent defaults, runtime validators for whatever
// string a persisted setting actually contains, System-mode resolution,
// and the Settings UI's option metadata. Kept dependency-free of any
// controller/repository machinery (the `import` of sound.ts below is a
// pure, dependency-free module too) so this module can be unit-tested in
// isolation and reused by both the settings controller and the Settings
// drawer.
//
// Every parser independently falls back to its own documented default
// rather than the whole settings object failing together — an unrelated
// bad value (e.g. a hand-edited settings row) must never take down a
// different, perfectly valid setting.

import {
  DEFAULT_RETURN_TONE_ID,
  DEFAULT_TONE_ID,
  isReturnToneId,
  isToneId,
} from './sound';
import {
  DEFAULT_SOUNDSCAPE_ID,
  DEFAULT_SOUNDSCAPE_VOLUME,
  type SoundscapeId,
} from './soundscapeCatalog';

export { parseSoundscapeId, parseSoundscapeVolume } from './soundscapeCatalog';
export { parseDismissedHints } from './hints';

export type ThemeFamily =
  | 'sunlit'
  | 'cozy'
  | 'quiet-natural'
  | 'coastal-air'
  | 'night-walk'
  | 'moon-garden'
  | 'graphite';

export type AppearanceMode = 'light' | 'dark' | 'system';
export type ResolvedAppearance = 'light' | 'dark';
export type TimerAccent = 'blue' | 'green' | 'orange' | 'red' | 'yellow';

/** How the focus countdown's progress is drawn: a semicircle arched above
 * the clock, a full ring around it, or a slim arc tucked close above the
 * digits. All three animate via stroke-dashoffset rather than a layout
 * property, so — unlike the linear bar this replaced — updating them
 * every tick never triggers a layout recalculation. */
export type TimerProgressStyle = 'crown' | 'ring' | 'cap';

/** Stored as a string (like every other setting) even though it's
 * fundamentally a number-or-off — keeps `SettingsController.persist(key,
 * value: string)` uniform across every setting rather than special-casing
 * one key's wire type. */
export type FocusWarningLeadMs = 'off' | '15000' | '30000';

/** Minutes of continuous focus since the last Touch Grass before
 * FocusCompletionPrompt starts suggesting one — stored as a string like
 * every other setting. */
export type TouchGrassReminderThresholdMs = 'off' | '1800000' | '2700000' | '3600000' | '5400000' | '7200000';

/** How many consecutive fully-completed focus sessions (planned duration
 * reached, not an early finish) since the last time this hit '3' and rolled
 * over — see App.svelte's completion funnel and FocusCompletionPrompt's
 * touchGrassSuggested. Never persists '4': the moment a completion would
 * make it four, it rolls back to '0' in the same write. */
export type PomodoroStreak = '0' | '1' | '2' | '3';

export interface AppSettings {
  themeFamily: ThemeFamily;
  appearanceMode: AppearanceMode;
  timerAccent: TimerAccent;
  selectedToneId: string;
  selectedReturnToneId: string;
  focusWarningLeadMs: FocusWarningLeadMs;
  touchGrassReminderThresholdMs: TouchGrassReminderThresholdMs;
  selectedSoundscapeId: SoundscapeId;
  soundscapeVolume: string;
  /** Comma-separated HintId list — see hints.ts. Which first-occurrence
   * explanations (Flow, Greenhouse, Touch Grass) have already been seen
   * and dismissed, so they never show again once acknowledged once. */
  dismissedHints: string;
  timerProgressStyle: TimerProgressStyle;
  pomodoroStreak: PomodoroStreak;
  /** Raw signed license-key string, '' = no license entered. Never a
   * derived boolean — see license.ts for why. */
  licenseKey: string;
}

export type AppSettingKey = keyof AppSettings;

/** The exact persisted setting keys — `selectedToneId` is the pre-existing
 * key from before Phase 5A and must never be renamed or rewritten; doing
 * so would silently discard an existing installation's alarm choice. */
export const APP_SETTING_KEYS = {
  themeFamily: 'themeFamily',
  appearanceMode: 'appearanceMode',
  timerAccent: 'timerAccent',
  selectedToneId: 'selectedToneId',
  selectedReturnToneId: 'selectedReturnToneId',
  focusWarningLeadMs: 'focusWarningLeadMs',
  touchGrassReminderThresholdMs: 'touchGrassReminderThresholdMs',
  selectedSoundscapeId: 'selectedSoundscapeId',
  soundscapeVolume: 'soundscapeVolume',
  dismissedHints: 'dismissedHints',
  timerProgressStyle: 'timerProgressStyle',
  pomodoroStreak: 'pomodoroStreak',
  licenseKey: 'licenseKey',
} as const satisfies Record<AppSettingKey, string>;

export const DEFAULT_APP_SETTINGS = Object.freeze({
  themeFamily: 'sunlit',
  appearanceMode: 'system',
  timerAccent: 'blue',
  selectedToneId: DEFAULT_TONE_ID,
  selectedReturnToneId: DEFAULT_RETURN_TONE_ID,
  focusWarningLeadMs: '30000',
  touchGrassReminderThresholdMs: '3600000',
  selectedSoundscapeId: DEFAULT_SOUNDSCAPE_ID,
  soundscapeVolume: DEFAULT_SOUNDSCAPE_VOLUME,
  dismissedHints: '',
  timerProgressStyle: 'crown',
  pomodoroStreak: '0',
  licenseKey: '',
}) satisfies Readonly<AppSettings>;

const THEME_VALUES = new Set<ThemeFamily>([
  'sunlit',
  'cozy',
  'quiet-natural',
  'coastal-air',
  'night-walk',
  'moon-garden',
  'graphite',
]);

const APPEARANCE_VALUES = new Set<AppearanceMode>(['light', 'dark', 'system']);

const TIMER_ACCENT_VALUES = new Set<TimerAccent>(['blue', 'green', 'orange', 'red', 'yellow']);

const TIMER_PROGRESS_STYLE_VALUES = new Set<TimerProgressStyle>(['crown', 'ring', 'cap']);

const FOCUS_WARNING_VALUES = new Set<FocusWarningLeadMs>([
  'off',
  '15000',
  '30000',
]);

const POMODORO_STREAK_VALUES = new Set<PomodoroStreak>(['0', '1', '2', '3']);

const TOUCH_GRASS_REMINDER_THRESHOLD_VALUES = new Set<TouchGrassReminderThresholdMs>([
  'off',
  '1800000',
  '2700000',
  '3600000',
  '5400000',
  '7200000',
]);

/** Displayed in this exact order everywhere Settings lists theme choices. */
export const THEME_OPTIONS: ReadonlyArray<{ value: ThemeFamily; label: string }> = [
  { value: 'sunlit', label: 'Sunlit' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'quiet-natural', label: 'Quiet Natural' },
  { value: 'coastal-air', label: 'Coastal Air' },
  { value: 'night-walk', label: 'Night Walk' },
  { value: 'moon-garden', label: 'Moon Garden' },
  { value: 'graphite', label: 'Graphite' },
];

export const APPEARANCE_OPTIONS: ReadonlyArray<{ value: AppearanceMode; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export const TIMER_ACCENT_OPTIONS: ReadonlyArray<{ value: TimerAccent; label: string }> = [
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'orange', label: 'Orange' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' },
];

export const FOCUS_WARNING_OPTIONS: ReadonlyArray<{ value: FocusWarningLeadMs; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: '15000', label: '15 seconds' },
  { value: '30000', label: '30 seconds' },
];

export const TOUCH_GRASS_REMINDER_THRESHOLD_OPTIONS: ReadonlyArray<{ value: TouchGrassReminderThresholdMs; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: '1800000', label: '30 minutes' },
  { value: '2700000', label: '45 minutes' },
  { value: '3600000', label: '60 minutes' },
  { value: '5400000', label: '90 minutes' },
  { value: '7200000', label: '120 minutes' },
];

export const TIMER_PROGRESS_STYLE_OPTIONS: ReadonlyArray<{ value: TimerProgressStyle; label: string }> = [
  { value: 'crown', label: 'Crown arc' },
  { value: 'ring', label: 'Full ring' },
  { value: 'cap', label: 'Slim cap' },
];

export function parseThemeFamily(value: unknown): ThemeFamily {
  return typeof value === 'string' && THEME_VALUES.has(value as ThemeFamily)
    ? (value as ThemeFamily)
    : DEFAULT_APP_SETTINGS.themeFamily;
}

export function parseAppearanceMode(value: unknown): AppearanceMode {
  return typeof value === 'string' && APPEARANCE_VALUES.has(value as AppearanceMode)
    ? (value as AppearanceMode)
    : DEFAULT_APP_SETTINGS.appearanceMode;
}

export function parseTimerAccent(value: unknown): TimerAccent {
  return typeof value === 'string' && TIMER_ACCENT_VALUES.has(value as TimerAccent)
    ? (value as TimerAccent)
    : DEFAULT_APP_SETTINGS.timerAccent;
}

export function parseTimerProgressStyle(value: unknown): TimerProgressStyle {
  return typeof value === 'string' && TIMER_PROGRESS_STYLE_VALUES.has(value as TimerProgressStyle)
    ? (value as TimerProgressStyle)
    : DEFAULT_APP_SETTINGS.timerProgressStyle;
}

export function parseToneId(value: unknown): string {
  return isToneId(value) ? value : DEFAULT_APP_SETTINGS.selectedToneId;
}

export function parseReturnToneId(value: unknown): string {
  return isReturnToneId(value) ? value : DEFAULT_APP_SETTINGS.selectedReturnToneId;
}

export function parseLicenseKey(value: unknown): string {
  return typeof value === 'string' ? value : DEFAULT_APP_SETTINGS.licenseKey;
}

/** Accepts a raw number too (not just its stored string form) — a
 * persisted row is always a string, but callers occasionally have the
 * numeric lead value on hand and validating it directly is one less
 * `String(...)` at every call site. */
export function parseFocusWarningLeadMs(value: unknown): FocusWarningLeadMs {
  const candidate = typeof value === 'number' ? String(value) : value;
  return typeof candidate === 'string' && FOCUS_WARNING_VALUES.has(candidate as FocusWarningLeadMs)
    ? (candidate as FocusWarningLeadMs)
    : DEFAULT_APP_SETTINGS.focusWarningLeadMs;
}

/** '4' (or anything else out of range) never round-trips — see
 * PomodoroStreak's own doc for why the value that would advance it to a
 * fourth is never the one actually persisted. */
export function parsePomodoroStreak(value: unknown): PomodoroStreak {
  const candidate = typeof value === 'number' ? String(value) : value;
  return typeof candidate === 'string' && POMODORO_STREAK_VALUES.has(candidate as PomodoroStreak)
    ? (candidate as PomodoroStreak)
    : DEFAULT_APP_SETTINGS.pomodoroStreak;
}

export function focusWarningLeadToMs(value: FocusWarningLeadMs): number | null {
  return value === 'off' ? null : Number(value);
}

export function parseTouchGrassReminderThresholdMs(value: unknown): TouchGrassReminderThresholdMs {
  const candidate = typeof value === 'number' ? String(value) : value;
  return typeof candidate === 'string' && TOUCH_GRASS_REMINDER_THRESHOLD_VALUES.has(candidate as TouchGrassReminderThresholdMs)
    ? (candidate as TouchGrassReminderThresholdMs)
    : DEFAULT_APP_SETTINGS.touchGrassReminderThresholdMs;
}

export function touchGrassReminderThresholdToMs(value: TouchGrassReminderThresholdMs): number | null {
  return value === 'off' ? null : Number(value);
}

/** Resolves System through the caller-supplied OS preference; an explicit
 * Light/Dark choice ignores it entirely. */
export function resolveAppearance(mode: AppearanceMode, systemPrefersDark: boolean): ResolvedAppearance {
  return mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode;
}
