// Owns current validated appearance/tone settings, their in-flight write
// status, and system-appearance observation — but deliberately not a
// rollback/optimistic-write framework. Preferences aren't precious user
// content the way notes/revisions are (see noteSaveController.ts and
// revisionSaveCoordinator.svelte.ts): a failed setting write just needs to
// keep the user's in-memory choice visible with a quiet Retry, not
// generation-tracked rollback to some earlier value.
//
// runStartup() owns hydration (reading getSetting() for every key) and
// passes the already-validated result in as `initial` — this module never
// reads or validates a persisted string itself. It also never constructs
// its own TaskQueue: `options.writeQueue` must be the app's one shared
// queue, so a settings write is ordered exactly like every other
// session/note/revision/deletion mutation (see taskQueue.test.ts's
// cross-system ordering test for what this actually guards against — a
// settings-only queue would still pass every other test here while
// silently breaking that guarantee).
//
// The system-appearance observer is never attached at module load or
// hidden inside this factory's own lifetime — subscribeToSystemAppearance()
// must be called (and its returned cleanup respected) from a component
// effect, exactly like the app's existing window-close listener pattern.

import type { AppSettingKey, AppSettings, ResolvedAppearance } from './appearance';
import { resolveAppearance } from './appearance';
import type { TaskQueue } from './taskQueue';

/** The subset of `MediaQueryList` this module actually needs — narrow on
 * purpose so a test can supply a minimal fake instead of a real one. */
export interface MatchMediaSource {
  (query: string): Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
}

export interface SettingsController {
  /** The current, live in-memory value for every setting — always the
   * most recently requested value, whether or not it has finished (or
   * ever succeeds at) persisting. */
  readonly current: AppSettings;
  /** `appearanceMode` resolved against the last-observed system
   * preference (see subscribeToSystemAppearance()). */
  readonly resolvedAppearance: ResolvedAppearance;
  /** A quiet, per-key "not saved" marker — present only for a key whose
   * newest requested write has failed and not yet been retried
   * successfully (or superseded by a newer request that succeeded). */
  readonly errors: Partial<Record<AppSettingKey, string>>;
  /** Applies `value` immediately (for live preview) and enqueues its
   * persistence through the shared write queue. */
  set<K extends AppSettingKey>(key: K, value: AppSettings[K]): void;
  /** Re-persists `key`'s *current* in-memory value — not some earlier
   * value — clearing its error on success. */
  retry(key: AppSettingKey): void;
  /** Attaches the system-color-scheme observer and returns its exact
   * cleanup. Must be called from a component effect; disposing it is the
   * caller's responsibility (this module holds no lifecycle of its own). */
  subscribeToSystemAppearance(matchMedia: MatchMediaSource): () => void;
}

export function createSettingsController(options: {
  initial: AppSettings;
  writeQueue: TaskQueue;
  persist: (key: AppSettingKey, value: string) => Promise<void>;
  onPersistenceError?: (key: AppSettingKey, error: unknown) => void;
  /** The system color-scheme preference at the moment of construction —
   * read synchronously by the caller (e.g. from `matchMedia(...).matches`
   * during startup) so a `system` appearance mode resolves correctly on
   * the very first render, before subscribeToSystemAppearance()'s own
   * component effect has had a chance to run. Defaults to `false` (light)
   * for callers that can't determine it up front. */
  initialSystemPrefersDark?: boolean;
}): SettingsController {
  const current = $state<AppSettings>({ ...options.initial });
  const errors = $state<Partial<Record<AppSettingKey, string>>>({});
  let systemPrefersDark = $state(options.initialSystemPrefersDark ?? false);

  // Bumped by every set()/retry() call for a key — never by anything
  // else — so a write's own completion (success or failure) can tell
  // whether it's still the newest thing requested for that key before
  // touching `errors`. This is the *entire* staleness mechanism: there is
  // no stored "last persisted value" and nothing is ever rolled back.
  const requestSequence: Record<AppSettingKey, number> = {
    themeFamily: 0,
    appearanceMode: 0,
    timerAccent: 0,
    selectedToneId: 0,
    selectedReturnToneId: 0,
    focusWarningLeadMs: 0,
    touchGrassReminderThresholdMs: 0,
    selectedSoundscapeId: 0,
    soundscapeVolume: 0,
    dismissedHints: 0,
    timerProgressStyle: 0,
  };

  function persistCurrent(key: AppSettingKey): void {
    const sequence = ++requestSequence[key];
    const value = current[key];
    void options.writeQueue.enqueue(() => options.persist(key, value)).then(
      () => {
        if (requestSequence[key] === sequence) delete errors[key];
      },
      (error) => {
        if (requestSequence[key] !== sequence) return; // superseded — never surface a stale error
        errors[key] = 'Not saved';
        options.onPersistenceError?.(key, error);
      },
    );
  }

  function set<K extends AppSettingKey>(key: K, value: AppSettings[K]): void {
    current[key] = value;
    delete errors[key];
    persistCurrent(key);
  }

  function retry(key: AppSettingKey): void {
    delete errors[key];
    persistCurrent(key);
  }

  function subscribeToSystemAppearance(matchMedia: MatchMediaSource): () => void {
    const media = matchMedia('(prefers-color-scheme: dark)');
    systemPrefersDark = media.matches;
    const handleChange = (event: MediaQueryListEvent) => {
      systemPrefersDark = event.matches;
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }

  return {
    get current() {
      return current;
    },
    get resolvedAppearance() {
      return resolveAppearance(current.appearanceMode, systemPrefersDark);
    },
    get errors() {
      return errors;
    },
    set,
    retry,
    subscribeToSystemAppearance,
  };
}
