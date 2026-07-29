# Phase 5A Responsive Experience Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the narrow card-heavy interface with a sleek responsive shell, seven validated theme families, Light/Dark/System appearance, five accessible timer accents, and an immediately persisted Settings drawer without changing timer behavior.

**Architecture:** `App.svelte` remains the session and workspace orchestrator and keeps its existing wall-clock effects and one shared `TaskQueue`. A typed appearance module and a small rune-based settings controller own validated preference state; `AppShell.svelte` and `SettingsDrawer.svelte` own responsive presentation and transient drawer behavior. Components consume semantic CSS tokens, while one responsive `WorkspaceNav.svelte` tree and one mounted pair of focus support panels adapt through CSS.

**Tech Stack:** Svelte 5 runes, TypeScript 6, Tauri 2, Vitest 4, Testing Library Svelte, Lucide Svelte, Web Audio API, CSS custom properties, SQLite-backed repository settings.

## Global Constraints

- Treat `docs/superpowers/specs/2026-07-29-phase-5a-responsive-experience-foundation-design.md` as authoritative.
- Start only after PR #10's remaining revision-coordination findings are fixed, verified, and merged. Rebase this branch onto that resulting `main`.
- Do not change the timer state machine, timer persistence records, SQLite schema, note/revision storage, alarm synthesis, or session transitions.
- Keep the 250 ms wall-clock effect and focus-deadline/alarm effect in `App.svelte`, independent of workspace and Settings visibility.
- Keep exactly one application `TaskQueue`; inject it into the settings controller and never create a settings-only queue.
- Keep `runStartup()` as the only readiness gate and apply validated settings before its existing `ready = true`.
- Persist `themeFamily`, `appearanceMode`, `timerAccent`, and the existing `selectedToneId` key. Never rename or rewrite a valid stored tone selection.
- Default invalid or absent values independently to Sunlit, System, Blue, and the existing default alarm tone. Do not persist a fallback merely because loading used it.
- Use seven theme families: Sunlit, Cozy, Quiet Natural, Coastal Air, Night Walk, Moon Garden, and Graphite.
- Use Light, Dark, and System modes for every theme.
- Use Blue, Green, Orange, Red, and Yellow timer accents. Author five Light values and five Dark values, not per-theme accent values.
- All component CSS consumes semantic tokens. Raw palette values belong only in `src/app.css`.
- Use one semantic `WorkspaceNav.svelte` tree. Rearrange it with CSS; do not render separate desktop and mobile nav trees.
- Keep Parking Lot and Session Notes mounted while their mobile tab changes so local drafts survive.
- Keep cards at 8 px radius or less and avoid cards around page sections.
- Use Lucide icons for icon controls, with stable hit areas, accessible names, and tooltips.
- Respect `prefers-reduced-motion`.
- Support a 360 by 640 CSS-pixel browser viewport without horizontal scrolling or clipped controls.
- Do not add Touch Grass behavior, pre-alarm warnings, soundscapes, new alarm assets, planner/calendar work, native notifications, tray controls, or a component library.
- Use TDD for each task and commit after every independently green task.

## File Structure

### New files

- `src/lib/appearance.ts`: closed setting unions, defaults, metadata, validators, setting keys, and system-mode resolution.
- `src/lib/appearance.test.ts`: validators, defaults, metadata, and mode-resolution tests.
- `src/lib/appearanceTokens.test.ts`: semantic-token completeness and contrast-matrix tests against `src/app.css`.
- `src/lib/settingsController.svelte.ts`: validated in-memory settings, queued writes, per-key errors/retry, request sequencing, and disposable system observer.
- `src/lib/settingsController.test.ts`: state, queue, failure, retry, stale-result, and observer-cleanup tests.
- `src/lib/SettingsDrawer.svelte`: accessible modal drawer and Appearance/Audio controls.
- `src/lib/SettingsDrawer.test.ts`: close paths, focus trap, labels, writes, retry, tone selection, and preview tests.
- `src/lib/AppShell.svelte`: responsive shell, Settings trigger/open state, scrim, and workspace placement.
- `src/lib/AppShell.test.ts`: root attributes, one navigation tree, drawer focus restoration, and shell-content persistence tests.
- `src/lib/FocusSupportPanels.svelte`: desktop side-by-side and mobile tabbed Parking Lot/Session Notes layout that keeps both mounted.
- `src/lib/FocusSupportPanels.test.ts`: mounted-panel, accessibility, and draft-preservation tests.
- `src/lib/Timer.test.ts`: clock stability, mode, controls, task wrapping, and progress-clamping tests.

### Modified files

- `src/App.svelte`: startup setting hydration, one settings controller, system-observer cleanup, shell composition, and focus support-panel reuse.
- `src/App.test.ts`: startup gate, timer independence, shared-queue, navigation, Settings, and workflow regression tests.
- `src/app.css`: base semantic tokens, 14 theme/mode token sets, 10 timer accent values, shell defaults, and reduced-motion rules.
- `src/lib/ToneSelector.svelte`: replace the vertical tone buttons with a labeled dropdown and adjacent preview icon.
- `src/lib/ToneSelector.test.ts`: stable tone IDs, selection, fallback display, and preview tests.
- `src/lib/WorkspaceNav.svelte`: icon-led rail/mobile bar presentation using one semantic tree.
- `src/lib/WorkspaceNav.test.ts`: visible labels/current destination and single-tree semantics.
- `src/lib/Timer.svelte`, `src/lib/ActiveTimerBar.svelte`: sleek unframed timer styling, stable digits, and semantic mode tokens.
- `src/lib/ParkingLot.svelte`, `src/lib/SessionNotes.svelte`, `src/lib/SessionReview.svelte`, `src/lib/DecisionScreen.svelte`, `src/lib/History.svelte`, `src/lib/RevisionHistory.svelte`, `src/lib/MarkdownPreview.svelte`, `src/lib/RevisionSaveNotice.svelte`: semantic-token migration and responsive polish only.
- `src-tauri/tauri.conf.json`: neutral native pre-paint background and verified desktop minimum size.
- `README.md`: appearance settings, responsive behavior, persistence keys, and Phase 5A boundaries.

---

### Task 1: Typed Appearance Domain

**Files:**
- Create: `src/lib/appearance.ts`
- Create: `src/lib/appearance.test.ts`
- Modify: `src/lib/sound.ts`
- Modify: `src/lib/sound.test.ts`

**Interfaces:**
- Consumes: `TONE_CATALOG` and `DEFAULT_TONE_ID` from `src/lib/sound.ts`.
- Produces:

```ts
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

export interface AppSettings {
  themeFamily: ThemeFamily;
  appearanceMode: AppearanceMode;
  timerAccent: TimerAccent;
  selectedToneId: string;
}

export type AppSettingKey = keyof AppSettings;

export const APP_SETTING_KEYS = {
  themeFamily: 'themeFamily',
  appearanceMode: 'appearanceMode',
  timerAccent: 'timerAccent',
  selectedToneId: 'selectedToneId',
} as const;

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings>;
export const THEME_OPTIONS: ReadonlyArray<{ value: ThemeFamily; label: string }>;
export const APPEARANCE_OPTIONS: ReadonlyArray<{ value: AppearanceMode; label: string }>;
export const TIMER_ACCENT_OPTIONS: ReadonlyArray<{ value: TimerAccent; label: string }>;

export function parseThemeFamily(value: unknown): ThemeFamily;
export function parseAppearanceMode(value: unknown): AppearanceMode;
export function parseTimerAccent(value: unknown): TimerAccent;
export function parseToneId(value: unknown): string;
export function resolveAppearance(mode: AppearanceMode, systemPrefersDark: boolean): ResolvedAppearance;
```

- [ ] **Step 1: Write failing validator and metadata tests**

Create table-driven tests for every accepted union member, malformed strings, `null`, and `undefined`. Assert independent defaults and exact user-facing labels.

```ts
it.each([
  ['sunlit', 'sunlit'],
  ['moon-garden', 'moon-garden'],
  ['graphite', 'graphite'],
  ['unknown', 'sunlit'],
  [null, 'sunlit'],
])('parses theme %p as %s', (input, expected) => {
  expect(parseThemeFamily(input)).toBe(expected);
});

it('resolves only System through the media preference', () => {
  expect(resolveAppearance('system', false)).toBe('light');
  expect(resolveAppearance('system', true)).toBe('dark');
  expect(resolveAppearance('light', true)).toBe('light');
  expect(resolveAppearance('dark', false)).toBe('dark');
});

it('keeps the existing tone catalog and falls back independently', () => {
  expect(parseToneId('soft-bell')).toBe('soft-bell');
  expect(parseToneId('removed-tone')).toBe(DEFAULT_TONE_ID);
  expect(APP_SETTING_KEYS.selectedToneId).toBe('selectedToneId');
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run src/lib/appearance.test.ts src/lib/sound.test.ts
```

Expected: FAIL because `appearance.ts` and the tone-ID predicate do not exist.

- [ ] **Step 3: Add the tone predicate and appearance implementation**

Add a catalog-backed predicate without changing catalog IDs, schedules, or playback:

```ts
export function isToneId(value: unknown): value is string {
  return typeof value === 'string' && TONE_CATALOG.some((tone) => tone.id === value);
}
```

Implement each parser with a closed readonly set and its documented fallback. Keep metadata in the same order shown in Settings:

```ts
const THEME_VALUES = new Set<ThemeFamily>([
  'sunlit',
  'cozy',
  'quiet-natural',
  'coastal-air',
  'night-walk',
  'moon-garden',
  'graphite',
]);

export const DEFAULT_APP_SETTINGS = Object.freeze({
  themeFamily: 'sunlit',
  appearanceMode: 'system',
  timerAccent: 'blue',
  selectedToneId: DEFAULT_TONE_ID,
}) satisfies Readonly<AppSettings>;

export function parseThemeFamily(value: unknown): ThemeFamily {
  return typeof value === 'string' && THEME_VALUES.has(value as ThemeFamily)
    ? (value as ThemeFamily)
    : DEFAULT_APP_SETTINGS.themeFamily;
}

export function parseToneId(value: unknown): string {
  return isToneId(value) ? value : DEFAULT_APP_SETTINGS.selectedToneId;
}

export function resolveAppearance(
  mode: AppearanceMode,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  return mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode;
}
```

- [ ] **Step 4: Verify the domain**

Run:

```bash
npx vitest run src/lib/appearance.test.ts src/lib/sound.test.ts
npm run check
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/appearance.ts src/lib/appearance.test.ts src/lib/sound.ts src/lib/sound.test.ts
git commit -m "feat: define validated appearance settings"
```

---

### Task 2: Shared-Queue Settings Controller

**Files:**
- Create: `src/lib/settingsController.svelte.ts`
- Create: `src/lib/settingsController.test.ts`
- Modify: `src/lib/taskQueue.test.ts`

**Interfaces:**
- Consumes: `AppSettings`, `AppSettingKey`, `ResolvedAppearance`, `resolveAppearance`, and the existing `TaskQueue`.
- Produces:

```ts
export interface MatchMediaSource {
  (query: string): Pick<
    MediaQueryList,
    'matches' | 'addEventListener' | 'removeEventListener'
  >;
}

export interface SettingsController {
  readonly current: AppSettings;
  readonly resolvedAppearance: ResolvedAppearance;
  readonly errors: Partial<Record<AppSettingKey, string>>;
  set<K extends AppSettingKey>(key: K, value: AppSettings[K]): void;
  retry(key: AppSettingKey): void;
  subscribeToSystemAppearance(matchMedia: MatchMediaSource): () => void;
}

export function createSettingsController(options: {
  initial: AppSettings;
  writeQueue: TaskQueue;
  persist: (key: AppSettingKey, value: string) => Promise<void>;
  onPersistenceError?: (key: AppSettingKey, error: unknown) => void;
}): SettingsController;
```

- [ ] **Step 1: Write failing controller tests**

Cover initial state, immediate in-memory application, persistence through the injected queue, a retained failed choice, retrying the current value, stale-result suppression, and explicit observer cleanup.

```ts
it('applies immediately but persists behind work already in the shared queue', async () => {
  const queue = createTaskQueue();
  const release = deferred<void>();
  const order: string[] = [];
  void queue.enqueue(async () => {
    await release.promise;
    order.push('session');
  });
  const controller = createSettingsController({
    initial: DEFAULT_APP_SETTINGS,
    writeQueue: queue,
    persist: async (key, value) => {
      order.push(`${key}:${value}`);
    },
  });

  controller.set('themeFamily', 'cozy');
  expect(controller.current.themeFamily).toBe('cozy');
  expect(order).toEqual([]);

  release.resolve();
  await queue.drain();
  expect(order).toEqual(['session', 'themeFamily:cozy']);
});

it('keeps the current value and retries that value after failure', async () => {
  const persist = vi.fn()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce(undefined);
  const controller = createSettingsController({
    initial: DEFAULT_APP_SETTINGS,
    writeQueue: createTaskQueue(),
    persist,
  });

  controller.set('timerAccent', 'green');
  await flushPromises();
  expect(controller.current.timerAccent).toBe('green');
  expect(controller.errors.timerAccent).toBeTruthy();

  controller.retry('timerAccent');
  await flushPromises();
  expect(persist).toHaveBeenLastCalledWith('timerAccent', 'green');
  expect(controller.errors.timerAccent).toBeUndefined();
});
```

Define the microtask helper used by these tests:

```ts
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
```

Use this deliberately reorderable `TaskQueue` test double for the request-sequence test, run request 2 to success before request 1 rejects, and assert request 1 cannot restore an error:

```ts
function createReorderableQueue() {
  const pending: Array<() => Promise<void>> = [];
  const queue: TaskQueue = {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = deferred<T>();
      pending.push(async () => {
        try {
          result.resolve(await operation());
        } catch (error) {
          result.reject(error);
        }
      });
      return result.promise;
    },
    async drain() {
      await Promise.allSettled(pending.map((run) => run()));
    },
  };
  return { queue, run: (index: number) => pending[index]() };
}
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run src/lib/settingsController.test.ts src/lib/taskQueue.test.ts
```

Expected: FAIL because `createSettingsController` does not exist.

- [ ] **Step 3: Implement minimal rune state and request sequencing**

Keep the current selection on failure. Sequence only the displayed result for the affected key:

```ts
const current = $state<AppSettings>({ ...options.initial });
const errors = $state<Partial<Record<AppSettingKey, string>>>({});
const requestSequence: Record<AppSettingKey, number> = {
  themeFamily: 0,
  appearanceMode: 0,
  timerAccent: 0,
  selectedToneId: 0,
};
let systemPrefersDark = $state(false);

function persistCurrent(key: AppSettingKey): void {
  const sequence = ++requestSequence[key];
  const value = current[key];
  void options.writeQueue.enqueue(() => options.persist(key, value)).then(
    () => {
      if (requestSequence[key] === sequence) delete errors[key];
    },
    (error) => {
      if (requestSequence[key] !== sequence) return;
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
```

The observer must be attached only by the caller and return exact cleanup:

```ts
function subscribeToSystemAppearance(matchMedia: MatchMediaSource): () => void {
  const media = matchMedia('(prefers-color-scheme: dark)');
  systemPrefersDark = media.matches;
  const handleChange = (event: MediaQueryListEvent) => {
    systemPrefersDark = event.matches;
  };
  media.addEventListener('change', handleChange);
  return () => media.removeEventListener('change', handleChange);
}
```

- [ ] **Step 4: Add the real shared-queue integration assertion**

Extend `taskQueue.test.ts` with a test that enqueues a gated note-style mutation, calls `controller.set()`, captures one `drain()`, releases the first operation, and proves the drain observes both in FIFO order. Import the real controller and real `createTaskQueue`; do not mock either.

```ts
const drain = queue.drain();
release.resolve();
await drain;
expect(order).toEqual(['note mutation', 'setting themeFamily:graphite']);
```

- [ ] **Step 5: Verify the controller**

Run:

```bash
npx vitest run src/lib/settingsController.test.ts src/lib/taskQueue.test.ts
npm run check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settingsController.svelte.ts src/lib/settingsController.test.ts src/lib/taskQueue.test.ts
git commit -m "feat: persist settings through shared queue"
```

---

### Task 3: Single-Gate Startup Hydration

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_APP_SETTINGS`, four parsers, `APP_SETTING_KEYS`, `createSettingsController`, `writeQueue`, repository `getSetting`/`setSetting`.
- Produces: one `SettingsController` per mounted `App`, initialized by `runStartup()` before `ready = true`.

- [ ] **Step 1: Add failing startup tests**

Extend the repository mock so `getSetting` returns values by key. Assert all four keys are requested in the same startup pass and the themed app does not render before all settings settle.

```ts
const settingsGate = deferred<string | null>();
mocks.getSetting.mockImplementation((key: string) => {
  if (key === 'themeFamily') return settingsGate.promise;
  return Promise.resolve({
    appearanceMode: 'dark',
    timerAccent: 'green',
    selectedToneId: 'soft-bell',
  }[key] ?? null);
});

render(App);
expect(screen.getByText('Loading…')).toBeTruthy();
expect(screen.queryByRole('textbox', { name: 'Focus task' })).toBeNull();

settingsGate.resolve('graphite');
const task = await screen.findByRole('textbox', { name: 'Focus task' });
expect(task.closest('[data-theme]')?.getAttribute('data-theme')).toBe('graphite');
```

Add a malformed-value test that resolves each key independently to its documented default and asserts `setSetting` was not called during hydration.

- [ ] **Step 2: Run the App tests and verify failure**

Run:

```bash
npx vitest run src/App.test.ts
```

Expected: FAIL because startup reads only `selectedToneId` and no settings controller/root attributes exist.

- [ ] **Step 3: Hydrate and create the controller inside `runStartup()`**

Replace `selectedToneId` component state and `handleSelectTone` with a nullable controller created once from validated startup results:

```ts
let settingsController = $state<SettingsController | null>(null);

const [row, thoughts, toneId, themeFamily, appearanceMode, timerAccent] =
  await Promise.all([
    loadLatestSessionRow(),
    loadAllParkedThoughts(),
    getSetting(APP_SETTING_KEYS.selectedToneId),
    getSetting(APP_SETTING_KEYS.themeFamily),
    getSetting(APP_SETTING_KEYS.appearanceMode),
    getSetting(APP_SETTING_KEYS.timerAccent),
  ]);

const initialSettings: AppSettings = {
  themeFamily: parseThemeFamily(themeFamily),
  appearanceMode: parseAppearanceMode(appearanceMode),
  timerAccent: parseTimerAccent(timerAccent),
  selectedToneId: parseToneId(toneId),
};

settingsController ??= createSettingsController({
  initial: initialSettings,
  writeQueue,
  persist: setSetting,
  onPersistenceError: (key, err) =>
    console.error(`Failed to persist setting ${key}:`, err),
});
```

Keep `ready = true` after session, thoughts, notes, and settings are applied. Update focus-completion playback to read:

```ts
playTone(settingsController?.current.selectedToneId ?? DEFAULT_TONE_ID);
```

Attach and dispose the media listener from a component effect:

```ts
$effect(() => {
  const controller = settingsController;
  if (!controller || typeof window.matchMedia !== 'function') return;
  return controller.subscribeToSystemAppearance(window.matchMedia.bind(window));
});
```

- [ ] **Step 4: Verify startup and timer regressions**

Run:

```bash
npx vitest run src/App.test.ts src/lib/settingsController.test.ts
npm run check
```

Expected: all pass, including existing focus-expiration tests.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte src/App.test.ts
git commit -m "feat: hydrate appearance behind startup gate"
```

---

### Task 4: Semantic Tokens And Complete Theme Matrix

**Files:**
- Create: `src/lib/appearanceTokens.test.ts`
- Modify: `src/app.css`
- Modify: `src/App.svelte`
- Modify: `src/lib/ActiveTimerBar.svelte`
- Modify: `src/lib/DecisionScreen.svelte`
- Modify: `src/lib/History.svelte`
- Modify: `src/lib/MarkdownPreview.svelte`
- Modify: `src/lib/ParkingLot.svelte`
- Modify: `src/lib/RevisionHistory.svelte`
- Modify: `src/lib/RevisionSaveNotice.svelte`
- Modify: `src/lib/SessionNotes.svelte`
- Modify: `src/lib/SessionReview.svelte`
- Modify: `src/lib/Timer.svelte`
- Modify: `src/lib/ToneSelector.svelte`
- Modify: `src/lib/WorkspaceNav.svelte`

**Interfaces:**
- Consumes: root `data-theme`, resolved `data-appearance`, and `data-timer-accent`.
- Produces these required semantic tokens for every rendered combination:

```ts
const REQUIRED_THEME_TOKENS = [
  '--app-background',
  '--surface',
  '--surface-secondary',
  '--text',
  '--text-muted',
  '--border',
  '--focus-ring',
  '--shadow',
  '--timer-track',
  '--flow-accent',
  '--flow-surface',
  '--break-accent',
  '--break-surface',
  '--danger',
  '--on-danger',
] as const;
```

Each resolved mode also supplies `--timer-accent` and `--on-timer-accent` for all five accent selectors.

- [ ] **Step 1: Write failing token-contract and contrast tests**

Read `src/app.css` as text. Extract each exact selector block for all 14 theme/mode pairs and 10 appearance/accent pairs. Fail when a required token or selector is absent. Use a narrowly scoped helper for the authored CSS format:

```ts
function declarationsFor(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match) throw new Error(`Missing selector: ${selector}`);
  return new Map(
    [...match[1].matchAll(/(--[a-z-]+)\\s*:\\s*([^;]+);/g)]
      .map((entry) => [entry[1], entry[2].trim()]),
  );
}
```

Implement WCAG relative luminance and assert:

```ts
expect(contrast(text, appBackground)).toBeGreaterThanOrEqual(4.5);
expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
expect(contrast(textMuted, appBackground)).toBeGreaterThanOrEqual(4.5);
expect(contrast(focusRing, appBackground)).toBeGreaterThanOrEqual(3);
expect(contrast(timerAccent, appBackground)).toBeGreaterThanOrEqual(4.5);
expect(contrast(onTimerAccent, timerAccent)).toBeGreaterThanOrEqual(4.5);
expect(contrast(onDanger, danger)).toBeGreaterThanOrEqual(4.5);
```

Loop over all `7 x 2 x 5 = 70` timer/background combinations. Also assert no old token references remain outside the negative assertions in this test:

```ts
const componentCss = collectFiles('src', (path) => path.endsWith('.svelte'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
expect(componentCss).not.toMatch(/var\(--(?:bg|accent|accent-contrast|track|surface-flow|surface-break)\)/);
```

Define the recursive file collector in the test; do not shell out:

```ts
function collectFiles(
  directory: string,
  include: (path: string) => boolean,
): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path, include);
    return include(path) ? [path] : [];
  });
}
```

- [ ] **Step 2: Run the token tests and verify failure**

Run:

```bash
npx vitest run src/lib/appearanceTokens.test.ts
```

Expected: FAIL because the semantic matrix is not defined.

- [ ] **Step 3: Replace the global token layer with exact theme values**

Use these values in `src/app.css`. Each row is:
`background / surface / secondary / text / muted / border / focus / track / flow / flow-surface / break / break-surface / danger / on-danger`.

```text
sunlit light: #edf3e6 / #ffffff / #f5f8f1 / #20301f / #596754 / #c8d2c1 / #245d85 / #d8e2d2 / #8a531f / #f7eee3 / #2f6b4a / #e3f0e7 / #a83232 / #ffffff
sunlit dark: #172019 / #202b22 / #28352a / #eef5eb / #b0bdae / #435247 / #79b8e8 / #36443a / #e9a467 / #332d24 / #73c991 / #23372d / #ff9b9b / #241516
cozy light: #f5eeea / #fffdfb / #f8f2ee / #342821 / #6c5d54 / #d8c9c0 / #8a4b19 / #e7d9d0 / #8a4b19 / #f7e7da / #356345 / #e7f0e8 / #a23b3b / #ffffff
cozy dark: #211a17 / #2b221e / #352a25 / #f7eee9 / #c2b2a8 / #53443d / #e9a467 / #463832 / #e9a467 / #3a2b21 / #73c991 / #27382d / #f08a8a / #271517
quiet-natural light: #edf1ed / #fbfdfb / #f3f6f2 / #243029 / #5e6b63 / #cbd4cd / #25633f / #d8dfd9 / #826018 / #f4eddc / #25633f / #e1eee6 / #a23b3b / #ffffff
quiet-natural dark: #17201b / #202a24 / #29342d / #eef4f0 / #b2beb6 / #435148 / #73c991 / #36423a / #e8d26b / #343123 / #73c991 / #23372d / #f08a8a / #271517
coastal-air light: #eaf3f5 / #fbfeff / #f2f8f9 / #1f3036 / #586b72 / #c3d4d8 / #245d85 / #d3e1e4 / #8a4b19 / #f4eadf / #25633f / #e1efea / #a23b3b / #ffffff
coastal-air dark: #142126 / #1d2b31 / #26363d / #edf6f8 / #adc0c6 / #40535b / #79b8e8 / #33464d / #e9a467 / #332d25 / #73c991 / #21372f / #f08a8a / #271517
night-walk light: #edf0f4 / #fcfdff / #f3f5f8 / #252d38 / #606b78 / #cbd2dc / #245d85 / #d9dee6 / #8a4b19 / #f5eadf / #25633f / #e3eee7 / #a23b3b / #ffffff
night-walk dark: #141922 / #1d2430 / #262e3b / #f0f3f8 / #b2bbc8 / #414b5b / #79b8e8 / #343d4b / #e9a467 / #342b24 / #73c991 / #22342e / #f08a8a / #271517
moon-garden light: #f0eef4 / #fefcff / #f6f3f8 / #302a38 / #6b6274 / #d4ccdb / #5b4f85 / #dfd9e5 / #7a5220 / #f4e9dd / #2f6448 / #e3eee8 / #a23b3b / #ffffff
moon-garden dark: #1b1822 / #25212d / #2f2a39 / #f5f0f8 / #bdb3c7 / #4b4357 / #b9a7e8 / #3d3748 / #e9a467 / #382d26 / #73c991 / #27372f / #f08a8a / #271517
graphite light: #eff0f1 / #ffffff / #f5f6f7 / #272a2d / #62676c / #ced1d4 / #3f596f / #dcdfe1 / #80531f / #f3e9df / #306247 / #e2ede7 / #a23b3b / #ffffff
graphite dark: #181a1c / #222528 / #2b2f33 / #f1f3f4 / #b6bbc0 / #474c51 / #9bb9d0 / #393e43 / #e9a467 / #362d25 / #73c991 / #24362e / #f08a8a / #271517
```

Use these shared mode-specific accent values:

```css
[data-appearance='light'][data-timer-accent='blue']   { --timer-accent: #245d85; --on-timer-accent: #ffffff; }
[data-appearance='light'][data-timer-accent='green']  { --timer-accent: #25633f; --on-timer-accent: #ffffff; }
[data-appearance='light'][data-timer-accent='orange'] { --timer-accent: #8a4b19; --on-timer-accent: #ffffff; }
[data-appearance='light'][data-timer-accent='red']    { --timer-accent: #a23b3b; --on-timer-accent: #ffffff; }
[data-appearance='light'][data-timer-accent='yellow'] { --timer-accent: #735c00; --on-timer-accent: #ffffff; }
[data-appearance='dark'][data-timer-accent='blue']    { --timer-accent: #79b8e8; --on-timer-accent: #13202a; }
[data-appearance='dark'][data-timer-accent='green']   { --timer-accent: #73c991; --on-timer-accent: #132219; }
[data-appearance='dark'][data-timer-accent='orange']  { --timer-accent: #e9a467; --on-timer-accent: #2a1b10; }
[data-appearance='dark'][data-timer-accent='red']     { --timer-accent: #f08a8a; --on-timer-accent: #2b1515; }
[data-appearance='dark'][data-timer-accent='yellow']  { --timer-accent: #e8d26b; --on-timer-accent: #24200c; }
```

- [ ] **Step 4: Migrate every component to semantic names**

Perform exact replacements, then choose `--flow-surface`, `--break-surface`, `--danger`, or `--timer-accent` by meaning:

```text
--bg -> --app-background
--accent -> --timer-accent
--accent-contrast -> --on-timer-accent
--track -> --timer-track
--surface-flow -> --flow-surface
--surface-break -> --break-surface
```

Replace literal component `red`/`orange` error colors with `--danger` and token-based `color-mix()`. Add `select`, `textarea`, and `[tabindex]` to the global focus-visible rule. Set `color-scheme` from resolved selectors instead of advertising both schemes simultaneously.

- [ ] **Step 5: Verify token completeness and regressions**

Run:

```bash
npx vitest run src/lib/appearanceTokens.test.ts
rg "var\\(--(bg|accent|accent-contrast|track|surface-flow|surface-break)\\)" src
npm run check
npm test
```

Expected: token tests and suite pass; `rg` prints no component matches.

- [ ] **Step 6: Commit**

```bash
git add src/app.css src/lib/appearanceTokens.test.ts src/App.svelte src/lib/*.svelte
git commit -m "feat: add semantic theme token matrix"
```

---

### Task 5: Accessible Settings Drawer And Alarm Dropdown

**Files:**
- Create: `src/lib/SettingsDrawer.svelte`
- Create: `src/lib/SettingsDrawer.test.ts`
- Create: `src/lib/ToneSelector.test.ts`
- Modify: `src/lib/ToneSelector.svelte`

**Interfaces:**
- Consumes: one `SettingsController`, theme/mode/accent metadata, `TONE_CATALOG`, and `onPreviewTone(id)`.
- Produces:

```ts
export interface SettingsDrawerProps {
  controller: SettingsController;
  onClose: () => void;
  onPreviewTone: (id: string) => void;
}

export interface ToneSelectorProps {
  selectedToneId: string;
  onSelect: (id: string) => void;
  onPreview: (id: string) => void;
}
```

- [ ] **Step 1: Write failing ToneSelector tests**

Assert one labeled combobox contains the same three stable values, selecting emits the selected ID, preview emits the current ID, and an invalid selected ID displays the existing default.

```ts
expect(screen.getByRole('option', { name: 'Gentle Chime' }).getAttribute('value'))
  .toBe('gentle-chime');
await fireEvent.change(screen.getByRole('combobox', { name: 'Alarm tone' }), {
  target: { value: 'soft-bell' },
});
expect(onSelect).toHaveBeenCalledWith('soft-bell');
await fireEvent.click(screen.getByRole('button', { name: 'Preview alarm tone' }));
expect(onPreview).toHaveBeenCalledWith('soft-bell');
```

- [ ] **Step 2: Replace the vertical list with dropdown plus preview icon**

Use `Volume2` from Lucide. Normalize display through `getToneDefinition(selectedToneId).id`:

```svelte
<label for="alarm-tone">Alarm tone</label>
<div class="tone-control">
  <select
    id="alarm-tone"
    value={getToneDefinition(selectedToneId).id}
    onchange={(event) => onSelect(event.currentTarget.value)}
  >
    {#each TONE_CATALOG as tone (tone.id)}
      <option value={tone.id}>{tone.name}</option>
    {/each}
  </select>
  <button
    type="button"
    class="icon-button"
    aria-label="Preview alarm tone"
    title="Preview alarm tone"
    onclick={() => onPreview(getToneDefinition(selectedToneId).id)}
  >
    <Volume2 size={18} aria-hidden="true" />
  </button>
</div>
```

- [ ] **Step 3: Write failing Settings drawer tests**

Render the drawer with a real controller. Assert `role="dialog"`, `aria-modal="true"`, title, explicit labels, all seven themes, all modes, all accents, current selections, immediate controller changes, per-key Retry, preview, close button, scrim close, `Escape`, and Tab/Shift+Tab focus wrapping.

```ts
expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
await fireEvent.click(screen.getByRole('radio', { name: 'Graphite' }));
expect(controller.current.themeFamily).toBe('graphite');
await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
expect(onClose).toHaveBeenCalledOnce();
```

- [ ] **Step 4: Implement the drawer and focus trap**

Use fieldsets for theme/mode/accent choices and section dividers rather than cards. Query only enabled focusable elements inside the panel:

```ts
const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key !== 'Tab' || !panel) return;
  const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0];
  const last = items.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
```

Focus the close button after mount with `tick()`. The outer scrim closes only when `event.target === event.currentTarget`. Render `Retry` adjacent to the control whose key appears in `controller.errors`.

- [ ] **Step 5: Verify drawer behavior**

Run:

```bash
npx vitest run src/lib/ToneSelector.test.ts src/lib/SettingsDrawer.test.ts
npm run check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ToneSelector.svelte src/lib/ToneSelector.test.ts src/lib/SettingsDrawer.svelte src/lib/SettingsDrawer.test.ts
git commit -m "feat: add accessible appearance settings drawer"
```

---

### Task 6: Responsive App Shell And One Workspace Navigation Tree

**Files:**
- Create: `src/lib/AppShell.svelte`
- Create: `src/lib/AppShell.test.ts`
- Modify: `src/lib/WorkspaceNav.svelte`
- Modify: `src/lib/WorkspaceNav.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**
- Consumes: `WorkspaceView`, `SettingsController`, `SettingsDrawer`, and a Svelte `Snippet` for app content.
- Produces:

```ts
export interface AppShellProps {
  currentWorkspace: WorkspaceView;
  showRevisions: boolean;
  onNavigate: (view: WorkspaceView) => void;
  settings: SettingsController;
  onPreviewTone: (id: string) => void;
  children: Snippet;
}
```

- [ ] **Step 1: Add failing shell and navigation tests**

Assert the shell has exactly one `nav[aria-label="Workspace"]`, exposes root theme attributes, opens Settings from a gear icon, returns focus after all close paths, and leaves the rendered child input mounted while the drawer opens/closes.

```ts
expect(document.querySelectorAll('nav[aria-label="Workspace"]')).toHaveLength(1);
expect(shell.getAttribute('data-theme')).toBe('sunlit');
expect(shell.getAttribute('data-appearance')).toBe('light');
expect(shell.getAttribute('data-timer-accent')).toBe('blue');

const trigger = screen.getByRole('button', { name: 'Open settings' });
await fireEvent.click(trigger);
await fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
await waitFor(() => expect(document.activeElement).toBe(trigger));
```

Extend `WorkspaceNav.test.ts` to prove Focus/History are always present, Revisions remains contextual, `aria-current` is correct, and one click emits one navigation.

- [ ] **Step 2: Implement `AppShell.svelte`**

Own only transient drawer state and trigger focus:

```ts
let settingsOpen = $state(false);
let settingsTrigger: HTMLButtonElement;

async function closeSettings() {
  settingsOpen = false;
  await tick();
  settingsTrigger.focus();
}
```

Render one shell tree:

```svelte
<div
  class="app-shell"
  data-theme={settings.current.themeFamily}
  data-appearance={settings.resolvedAppearance}
  data-timer-accent={settings.current.timerAccent}
>
  <aside class="workspace-rail">
    <WorkspaceNav current={currentWorkspace} {showRevisions} {onNavigate} />
    <button
      bind:this={settingsTrigger}
      aria-label="Open settings"
      title="Settings"
      onclick={() => (settingsOpen = true)}
    >
      <Settings size={20} aria-hidden="true" />
    </button>
  </aside>
  <main class="workspace-content">{@render children()}</main>
  {#if settingsOpen}
    <SettingsDrawer controller={settings} onClose={closeSettings} {onPreviewTone} />
  {/if}
</div>
```

CSS keeps this one nav vertical and icon-led at desktop widths, then places the same nav at the viewport bottom with short visible labels below `640px`. Reserve bottom padding so the bar never overlays inputs.

- [ ] **Step 3: Compose `App.svelte` inside the shell**

After `ready`, require the controller and wrap the existing notices, compact timer, and workspace branches in `AppShell`. Remove `ToneSelector` from idle setup and remove direct Settings presentation from `App`.

Do not move these effects or handlers:

```ts
$effect(() => setInterval(/* existing wall-clock update */));
$effect(() => {
  if (session.status === 'focusing' && isFocusDue(session, now)) {
    // existing completion and alarm path
  }
});
```

Keep `workspaceView` in `App.svelte`; `AppShell` only calls `onNavigate`.

- [ ] **Step 4: Add timer-independence integration tests**

Start a short focus, open Settings, choose a theme, advance fake time past the deadline, and assert the completion decision and one alarm occur while the dialog remains open. Repeat the existing History and Revisions expiration cases.

```ts
await fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
vi.advanceTimersByTime(61_000);
await waitFor(() => expect(screen.getByRole('status', { name: 'Focus complete' })).toBeTruthy());
expect(mocks.playTone).toHaveBeenCalledTimes(1);
expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
```

- [ ] **Step 5: Verify the shell slice**

Run:

```bash
npx vitest run src/lib/AppShell.test.ts src/lib/WorkspaceNav.test.ts src/App.test.ts
npm run check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/AppShell.svelte src/lib/AppShell.test.ts src/lib/WorkspaceNav.svelte src/lib/WorkspaceNav.test.ts src/App.svelte src/App.test.ts
git commit -m "feat: add responsive application shell"
```

---

### Task 7: Sleek Timer And Draft-Preserving Focus Layout

**Files:**
- Create: `src/lib/FocusSupportPanels.svelte`
- Create: `src/lib/FocusSupportPanels.test.ts`
- Create: `src/lib/Timer.test.ts`
- Modify: `src/lib/Timer.svelte`
- Modify: `src/lib/ActiveTimerBar.svelte`
- Modify: `src/lib/ParkingLot.svelte`
- Modify: `src/lib/SessionNotes.svelte`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**
- Consumes: rendered `parking` and `notes` snippets so existing feature components retain their own APIs.
- Produces:

```ts
export interface FocusSupportPanelsProps {
  parking: Snippet;
  notes: Snippet;
}
```

- [ ] **Step 1: Write failing mounted-panel tests**

Render stateful inputs through both snippets. Switch the mobile tab and assert both elements retain identity/value, the inactive region has `hidden` and `aria-hidden="true"`, and arrow keys move the selected tab.

```ts
const parkingInput = screen.getByRole('textbox', { name: 'Park a thought' });
await fireEvent.input(parkingInput, { target: { value: 'Remember this' } });
await fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
expect(parkingInput.isConnected).toBe(true);
expect((parkingInput as HTMLInputElement).value).toBe('Remember this');
expect(parkingInput.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
```

- [ ] **Step 2: Implement one mounted pair with responsive presentation**

Render both snippets unconditionally:

```svelte
<div class="support-tabs" role="tablist" aria-label="Focus support">
  <button role="tab" aria-selected={active === 'parking'} onclick={() => (active = 'parking')}>
    Parking Lot
  </button>
  <button role="tab" aria-selected={active === 'notes'} onclick={() => (active = 'notes')}>
    Notes
  </button>
</div>
<div class="support-grid">
  <section role="tabpanel" hidden={mobile && active !== 'parking'} aria-hidden={mobile && active !== 'parking'}>
    {@render parking()}
  </section>
  <section role="tabpanel" hidden={mobile && active !== 'notes'} aria-hidden={mobile && active !== 'notes'}>
    {@render notes()}
  </section>
</div>
```

Do not infer `mobile` from JavaScript viewport width. Use a CSS media query plus the HTML `hidden` contract controlled by a shared `matchMedia('(max-width: 639px)')` listener with explicit cleanup, so assistive-technology visibility matches the visual state. Desktop ignores the active tab and displays both regions.

```ts
let mobile = $state(false);

$effect(() => {
  const media = window.matchMedia('(max-width: 639px)');
  mobile = media.matches;
  const handleChange = (event: MediaQueryListEvent) => {
    mobile = event.matches;
  };
  media.addEventListener('change', handleChange);
  return () => media.removeEventListener('change', handleChange);
});
```

- [ ] **Step 3: Remove duplicated focus/flow support markup from App**

Create one local snippet for Parking Lot and one for Session Notes, then render `FocusSupportPanels` in both focusing/paused and flow/flowPaused branches. Keep callback identity, note autosave, checkpoint, and revision access unchanged.

```svelte
{#snippet parkingPanel(sessionId: string)}
  <ParkingLot thoughts={parkedThoughts.filter((t) => t.sessionId === sessionId)} onPark={handlePark} />
{/snippet}

{#snippet notesPanel()}
  <SessionNotes
    content={noteContent}
    onChange={handleNoteChange}
    onBlur={flushPendingNoteSave}
    disabled={noteEditingDisabled}
    writesDisabled={notesWritesDisabled}
    onCheckpoint={handleCheckpoint}
    {checkpointStatus}
    onViewRevisions={handleViewCurrentRevisions}
  />
{/snippet}
```

- [ ] **Step 4: Restyle timer and support surfaces**

Make the timer unframed on the continuous app surface, use `--timer-accent` for digits/progress, keep cards at `8px`, and use stable responsive constraints:

```css
.clock {
  inline-size: min(100%, 7ch);
  margin-inline: auto;
  font-size: 5.5rem;
  font-variant-numeric: tabular-nums;
  color: var(--timer-accent);
}

.timer {
  container-type: inline-size;
  min-inline-size: 0;
  background: transparent;
  box-shadow: none;
}

@media (max-width: 639px) {
  .clock {
    font-size: 4rem;
  }
}
```

Do not scale body or panel typography with viewport width. Long task text uses `overflow-wrap: anywhere`; controls use stable minimum `44px` hit areas. Restyle `ActiveTimerBar` to a restrained full-width band, not a floating card.

- [ ] **Step 5: Add focus/flow integration regressions**

Start focus, type an unsaved parked thought, switch to Notes and back, pause/resume, move to History and return, and assert the thought draft and note content remain. Repeat the support-panel availability assertion in flow.

- [ ] **Step 6: Verify the focus layout**

Run:

```bash
npx vitest run src/lib/FocusSupportPanels.test.ts src/lib/Timer.test.ts src/App.test.ts
npm run check
npm test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/FocusSupportPanels.svelte src/lib/FocusSupportPanels.test.ts src/lib/Timer.svelte src/lib/Timer.test.ts src/lib/ActiveTimerBar.svelte src/lib/ParkingLot.svelte src/lib/SessionNotes.svelte src/App.svelte src/App.test.ts
git commit -m "feat: refine responsive focus workspace"
```

---

### Task 8: Native Window, Documentation, And Full Validation

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: the complete Phase 5A shell.
- Produces: a verified desktop minimum window, neutral pre-paint, documented settings, and release evidence.

- [ ] **Step 1: Add the neutral native pre-paint and verified minimum**

Set:

```json
{
  "title": "Pomodoro Parking Lot",
  "width": 960,
  "height": 720,
  "minWidth": 720,
  "minHeight": 560,
  "backgroundColor": "#202428",
  "resizable": true,
  "fullscreen": false
}
```

Confirm these keys against the installed Tauri config schema before committing. If `720 x 560` clips a real desktop control during manual verification, raise only the failing dimension to the smallest 8-pixel increment that clears it and record the final value in README.

- [ ] **Step 2: Document the shipped boundary**

Add a concise README section covering:

```text
- Theme families: Sunlit, Cozy, Quiet Natural, Coastal Air, Night Walk, Moon Garden, Graphite
- Appearance modes: Light, Dark, System
- Timer accents: Blue, Green, Orange, Red, Yellow
- Persisted keys: themeFamily, appearanceMode, timerAccent, selectedToneId
- Settings apply immediately and Delete All Data does not remove preferences
- Browser minimum design viewport: 360 x 640
- Phase 5A does not yet include Touch Grass prompts or Flowstate soundscapes
```

- [ ] **Step 3: Run complete automated validation**

Run:

```bash
npm run check
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: all commands exit 0 with the full existing frontend and Rust suites green.

- [ ] **Step 4: Perform browser-safe responsive verification**

Run `npm run dev` and inspect these viewports:

```text
360 x 640
390 x 844
768 x 1024
1280 x 800
1440 x 900
```

At every viewport inspect idle, focus, paused focus, flow, break, awaiting decision, History with compact timer, Revisions, and Settings. Use a deliberately long task, long parked thought, long note, empty histories, storage error, and unsaved-setting error. Verify:

```text
- no horizontal overflow or overlapping text/controls
- timer digits remain stable between 11:11 and 00:00
- bottom navigation does not cover focused inputs or Settings close
- both mobile support-panel drafts survive tab switches
- one navigation tree exists in the DOM
- reduced motion removes drawer and progress transitions
- keyboard focus remains visible in every representative theme
```

Capture all seven themes in Light and Dark, System under both OS preferences, all five accents in Sunlit Light, and all five accents in Graphite Dark. Compare the result to the approved sleek mockup, using it as visual direction rather than a source of unshipped controls.

- [ ] **Step 5: Perform real Tauri verification**

Run:

```bash
npm run tauri:dev
```

Verify:

```text
1. Resize down to the configured minimum and traverse Focus, History, Revisions, and Settings.
2. Choose Graphite/Dark/Green and Soft Bell, quit, relaunch, and confirm all four settings persist before the shell appears.
3. Return to System, change the OS appearance while running, and confirm the resolved theme updates live.
4. Select explicit Light, change the OS appearance, and confirm the app remains Light.
5. Start a one-minute focus and let it expire while Settings is open; confirm one tone and the decision UI.
6. Repeat expiry while History and Revisions are open.
7. Park a thought and edit notes while the timer runs; navigate away and back without losing either draft.
8. Confirm tone Preview remains nonblocking and does not alter timer state.
9. Confirm the native pre-paint is neutral rather than a white flash.
```

- [ ] **Step 6: Re-run automated checks after manual fixes**

Run the complete command block from Step 3 again. Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.conf.json README.md
git commit -m "docs: verify Phase 5A responsive experience"
```

---

## Final Review Gate

Before opening the implementation PR:

- [ ] Confirm PR #10's fixes are present in the branch history.
- [ ] Confirm no task changed session transitions, timer persistence, note/revision storage, or alarm synthesis.
- [ ] Confirm `App.svelte` contains one `TaskQueue`, one `runStartup()` readiness path, one settings controller instance, and unconditional timer effects.
- [ ] Confirm `ToneSelector.svelte` is absent from the idle screen and present only in Settings.
- [ ] Confirm no music-note button, soundscape picker, Touch Grass prompt, planner, or calendar placeholder was added.
- [ ] Confirm all Settings writes use the injected shared queue and failed values remain selected with per-key Retry.
- [ ] Confirm one `WorkspaceNav` DOM tree adapts between desktop and mobile.
- [ ] Confirm both focus support panels remain mounted through mobile tab changes.
- [ ] Confirm no component card or framed tool uses a radius greater than 8 px.
- [ ] Confirm all 14 theme token sets and all 70 accent/background combinations pass automated contrast tests.
- [ ] Confirm the five required viewports and real Tauri scenarios were inspected.
- [ ] Confirm `npm run check`, `npm test`, `npm run build`, `cargo test`, `cargo check`, and `git diff --check` are freshly green.
