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

/** Stored as a string (like every other setting) even though it's
 * fundamentally a number-or-off — keeps `SettingsController.persist(key,
 * value: string)` uniform across every setting rather than special-casing
 * one key's wire type. */
export type FocusWarningLeadMs = 'off' | '15000' | '30000';

export interface AppSettings {
  themeFamily: ThemeFamily;
  appearanceMode: AppearanceMode;
  timerAccent: TimerAccent;
  selectedToneId: string;
  selectedReturnToneId: string;
  focusWarningLeadMs: FocusWarningLeadMs;
  selectedSoundscapeId: SoundscapeId;
  soundscapeVolume: string;
  /** Comma-separated HintId list — see hints.ts. Which first-occurrence
   * explanations (Flow, Greenhouse, Touch Grass) have already been seen
   * and dismissed, so they never show again once acknowledged once. */
  dismissedHints: string;
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
  selectedSoundscapeId: 'selectedSoundscapeId',
  soundscapeVolume: 'soundscapeVolume',
  dismissedHints: 'dismissedHints',
} as const satisfies Record<AppSettingKey, string>;

export const DEFAULT_APP_SETTINGS = Object.freeze({
  themeFamily: 'sunlit',
  appearanceMode: 'system',
  timerAccent: 'blue',
  selectedToneId: DEFAULT_TONE_ID,
  selectedReturnToneId: DEFAULT_RETURN_TONE_ID,
  focusWarningLeadMs: '30000',
  selectedSoundscapeId: DEFAULT_SOUNDSCAPE_ID,
  soundscapeVolume: DEFAULT_SOUNDSCAPE_VOLUME,
  dismissedHints: '',
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

const FOCUS_WARNING_VALUES = new Set<FocusWarningLeadMs>([
  'off',
  '15000',
  '30000',
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

export function parseToneId(value: unknown): string {
  return isToneId(value) ? value : DEFAULT_APP_SETTINGS.selectedToneId;
}

export function parseReturnToneId(value: unknown): string {
  return isReturnToneId(value) ? value : DEFAULT_APP_SETTINGS.selectedReturnToneId;
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

export function focusWarningLeadToMs(value: FocusWarningLeadMs): number | null {
  return value === 'off' ? null : Number(value);
}

/** Resolves System through the caller-supplied OS preference; an explicit
 * Light/Dark choice ignores it entirely. */
export function resolveAppearance(mode: AppearanceMode, systemPrefersDark: boolean): ResolvedAppearance {
  return mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode;
}
