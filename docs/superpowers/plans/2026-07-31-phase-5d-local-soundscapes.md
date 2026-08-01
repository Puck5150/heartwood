# Phase 5D Local Soundscapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five original, fully local procedural focus soundscapes with explicit playback, persistent selection and volume, lifecycle-aware suppression, and one accessible music popover.

**Architecture:** A lazy `SoundscapeController` owns one Web Audio context, one master output, session-scoped play intent, crossfades, suppression, cleanup, and an observable UI snapshot. Data-only catalog and lifecycle mapping modules keep validation and timer integration pure; reusable synthesis primitives and five small preset factories sit behind an injected engine interface so controller tests do not require real Web Audio.

**Tech Stack:** Svelte 5 runes, TypeScript 6, native Web Audio, Vitest, Testing Library, existing SQLite-backed settings repository and shared FIFO task queue.

## Global Constraints

- Keep playback fully local and offline. Add no streaming, account, download, or music-framework dependency.
- Treat Greenred Productions only as a mood reference; copy no compositions, recordings, names, artwork, branding, or distinctive melodic material.
- Ship exactly Deep Focus, Quiet Piano, Organic Drift, Still Air, and Rain Room.
- Never start playback automatically for a new session or after relaunch.
- Keep timer pause and soundscape playback independent.
- Fade during intermissions and completion alarms; preserve same-session play intent only where the approved design requires it.
- Alarm and return-tone selection remain in Settings and are not duplicated in the soundscape popover.
- Use the application's existing shared settings controller and FIFO task queue for persistence.
- Create or resume an `AudioContext` only from an explicit Play or Resume audio gesture.
- Keep all controls usable at 360 by 640 and provide at least 44 by 44 pixel pointer targets.
- Favor shared synthesis primitives over duplicated preset implementations; do not code-golf.

---

### Task 1: Catalog And Persisted Settings

**Files:**
- Create: `src/lib/soundscapeCatalog.ts`
- Create: `src/lib/soundscapeCatalog.test.ts`
- Modify: `src/lib/appearance.ts`
- Modify: `src/lib/appearance.test.ts`
- Modify: `src/lib/settingsController.svelte.ts`
- Modify: `src/lib/settingsController.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**
- Produces: `SoundscapeId`, `SOUNDSCAPE_CATALOG`, `DEFAULT_SOUNDSCAPE_ID`, `DEFAULT_SOUNDSCAPE_VOLUME`, `parseSoundscapeId(value)`, `parseSoundscapeVolume(value)`, and `soundscapeVolumeToNumber(value)`.
- Extends: `AppSettings` with `selectedSoundscapeId: SoundscapeId` and `soundscapeVolume: string`.

- [ ] **Step 1: Write failing catalog and settings tests**

```ts
expect(SOUNDSCAPE_CATALOG.map(({ id }) => id)).toEqual([
  'deep-focus',
  'quiet-piano',
  'organic-drift',
  'still-air',
  'rain-room',
]);
expect(parseSoundscapeId('missing')).toBe('deep-focus');
expect(parseSoundscapeVolume('1.5')).toBe('1');
expect(parseSoundscapeVolume('-0.1')).toBe('0');
expect(parseSoundscapeVolume('bad')).toBe(DEFAULT_SOUNDSCAPE_VOLUME);
```

Add controller coverage proving the two new keys use the same optimistic per-key persistence and Retry behavior as existing settings. Add an app startup test proving both keys hydrate before the interactive shell renders without creating audio.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- --run src/lib/soundscapeCatalog.test.ts src/lib/appearance.test.ts src/lib/settingsController.test.ts src/App.test.ts`

Expected: FAIL because the catalog, parsers, and settings keys do not exist.

- [ ] **Step 3: Implement the data-only catalog and validation**

Use closed IDs and immutable metadata:

```ts
export type SoundscapeId =
  | 'deep-focus'
  | 'quiet-piano'
  | 'organic-drift'
  | 'still-air'
  | 'rain-room';

export interface SoundscapeDefinition {
  id: SoundscapeId;
  name: string;
  description: string;
}

export const DEFAULT_SOUNDSCAPE_ID: SoundscapeId = 'deep-focus';
export const DEFAULT_SOUNDSCAPE_VOLUME = '0.35';
```

Normalize finite volume values to a clamped decimal string in `[0, 1]`. Add both keys to `APP_SETTING_KEYS`, `DEFAULT_APP_SETTINGS`, `requestSequence`, startup `getSetting` hydration, and the existing settings tests. Hydration must remain data-only.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run src/lib/soundscapeCatalog.test.ts src/lib/appearance.test.ts src/lib/settingsController.test.ts src/App.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/soundscapeCatalog.ts src/lib/soundscapeCatalog.test.ts src/lib/appearance.ts src/lib/appearance.test.ts src/lib/settingsController.svelte.ts src/lib/settingsController.test.ts src/App.svelte src/App.test.ts
git commit -m "feat: persist local soundscape preferences"
```

### Task 2: Procedural Engine And Five Presets

**Files:**
- Create: `src/lib/soundscapeEngine.ts`
- Create: `src/lib/soundscapeEngine.test.ts`
- Create: `src/lib/soundscapePresets.ts`
- Create: `src/lib/soundscapePresets.test.ts`

**Interfaces:**
- Consumes: `SoundscapeId`.
- Produces: `SoundscapeEngine`, `SoundscapeEngineHandle`, `SoundscapeEngineFactory`, `createWebAudioSoundscapeEngine()`, `createSeededRandom(seed)`, and `createSoundscapePreset(id, environment)`.

- [ ] **Step 1: Write failing deterministic resource tests**

Define narrow injected seams:

```ts
export interface SoundscapeEngineHandle {
  setGain(value: number, rampSeconds: number): void;
  stop(rampSeconds: number): Promise<void>;
  dispose(): void;
}

export interface SoundscapeEngine {
  readonly state: AudioContextState;
  resume(): Promise<void>;
  createPreset(id: SoundscapeId, seed: number): SoundscapeEngineHandle;
  dispose(): Promise<void>;
}
```

Test deterministic seeded sequences, bounded scheduled event counts, valid frequencies/gains/durations, and idempotent disposal that clears every scheduler handle and disconnects every tracked node.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- --run src/lib/soundscapeEngine.test.ts src/lib/soundscapePresets.test.ts`

Expected: FAIL because engine and presets do not exist.

- [ ] **Step 3: Implement reusable synthesis primitives**

Build a small scheduler with a fixed look-ahead window and one interval, plus reusable pad, soft-note, pulse, filtered-noise, and bell-like voice helpers. Every preset factory must return one composite handle that owns all nodes and scheduled timers it creates. Use short gain envelopes, capped polyphony, and no animation-frame loop.

Preset character:

```text
Deep Focus    warm pad + subtle low pulse
Quiet Piano   sparse soft struck notes + long space
Organic Drift rounded bell/handpan-like tones + restrained noise
Still Air     two slowly moving filtered pads
Rain Room     filtered noise droplets + quiet room bed
```

Use deterministic random input for scheduling and a fresh seed per actual playback session.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run src/lib/soundscapeEngine.test.ts src/lib/soundscapePresets.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/soundscapeEngine.ts src/lib/soundscapeEngine.test.ts src/lib/soundscapePresets.ts src/lib/soundscapePresets.test.ts
git commit -m "feat: add procedural soundscape engine"
```

### Task 3: Session-Scoped Soundscape Controller

**Files:**
- Create: `src/lib/soundscapeController.svelte.ts`
- Create: `src/lib/soundscapeController.test.ts`

**Interfaces:**
- Consumes: `SoundscapeEngineFactory`, `SoundscapeId`, and lifecycle snapshots.
- Produces:

```ts
export type SoundscapePhase =
  | 'inactive'
  | 'focus'
  | 'flow'
  | 'intermission'
  | 'postFocusBreak'
  | 'complete';

export interface SoundscapeLifecycle {
  sessionId: string | null;
  phase: SoundscapePhase;
  alarmActive: boolean;
}

export interface SoundscapePlaybackSnapshot {
  status: 'idle' | 'playing' | 'paused' | 'suppressed' | 'suspended' | 'error';
  error: string | null;
}

export interface SoundscapeController {
  readonly snapshot: SoundscapePlaybackSnapshot;
  selectPreset(id: SoundscapeId): Promise<void>;
  setVolume(value: number): void;
  play(sessionId: string): Promise<void>;
  pause(): void;
  syncLifecycle(value: SoundscapeLifecycle): void;
  dispose(): Promise<void>;
}
```

- [ ] **Step 1: Write failing controller tests**

Cover explicit Play per session, no context creation during construction/hydration, crossfade ordering, timer-pause independence, intermission suppression and same-session resume, alarm suppression and quiet-overtime resume, no resume for a different session, complete/break cleanup, stale async invalidation, suspended context status, initial Play errors, and failed preset switches retaining the prior preset.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- --run src/lib/soundscapeController.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement the controller**

Use one monotonically increasing generation for context creation, preset switches, and delayed stops. Keep these concepts separate:

```text
playIntentSessionId  session that explicitly requested playback
manuallyPaused       user paused music
suppressed           lifecycle temporarily mutes music
activePreset         currently audible/retained engine handle
generation           rejects stale async completions
```

Crossfade with a new handle at gain zero, ramp new up and old down, then dispose old. Intermission and alarm suppression ramp only the master output so same-session audio can return smoothly. `postFocusBreak`, `complete`, `inactive`, session changes, and `dispose()` clear intent and invalidate callbacks.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run src/lib/soundscapeController.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/soundscapeController.svelte.ts src/lib/soundscapeController.test.ts
git commit -m "feat: coordinate soundscape playback lifecycle"
```

### Task 4: Completion Alarm Activity And Lifecycle Mapping

**Files:**
- Create: `src/lib/soundscapeLifecycle.ts`
- Create: `src/lib/soundscapeLifecycle.test.ts`
- Modify: `src/lib/alarmSequence.ts`
- Modify: `src/lib/alarmSequence.test.ts`

**Interfaces:**
- Consumes: `SessionState`.
- Produces: `soundscapeLifecycleFor(session, alarmActive)`.
- Extends: `createAlarmSequence()` options with `onActiveChange?: (active: boolean) => void`.

- [ ] **Step 1: Write failing lifecycle and alarm-state tests**

Assert mapping for idle, focusing/paused, flow/flowPaused, intermission, break, and complete. Assert alarm activity becomes true before the first tone, false after the final tone duration, false on cancel, and never receives duplicate transitions from stale callbacks.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- --run src/lib/soundscapeLifecycle.test.ts src/lib/alarmSequence.test.ts`

Expected: FAIL because mapping and activity callbacks do not exist.

- [ ] **Step 3: Implement pure mapping and transactional alarm state**

The alarm sequence must call `onActiveChange(true)` exactly once per start and `onActiveChange(false)` exactly once when the final tone finishes, on cancel, or when a newer start supersedes it. Use the existing generation to reject stale timeout callbacks.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run src/lib/soundscapeLifecycle.test.ts src/lib/alarmSequence.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/soundscapeLifecycle.ts src/lib/soundscapeLifecycle.test.ts src/lib/alarmSequence.ts src/lib/alarmSequence.test.ts
git commit -m "feat: expose alarm lifecycle to soundscapes"
```

### Task 5: Accessible Flow-State Music Popover

**Files:**
- Create: `src/lib/SoundscapePopover.svelte`
- Create: `src/lib/SoundscapePopover.test.ts`

**Interfaces:**
- Consumes: `SoundscapeController`, `SoundscapeId`, current volume, persistence callbacks, per-key errors, `sessionId`, and `disabled`.
- Produces: one music-note trigger and compact popover.

- [ ] **Step 1: Write failing component tests**

Test:

```text
trigger accessible name and tooltip
one selected preset with announced checked state
Play/Pause action label
Resume audio and Retry states
volume range label/value and immediate callback
local/offline label
disabled playback during intermission
Escape/outside close and trigger focus restoration
per-key Not saved and Retry actions
```

- [ ] **Step 2: Run the component test and verify it fails**

Run: `npm test -- --run src/lib/SoundscapePopover.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement compact presentation**

Use `lucide-svelte/icons/music-2` for the trigger and `play`, `pause`, and `rotate-ccw` icons where applicable. Use native radio buttons for preset selection and a native range input for volume. Keep the panel at `min(22rem, calc(100vw - 1rem))`, position it clear of the timer controls, and avoid nested cards.

- [ ] **Step 4: Run the component test**

Run: `npm test -- --run src/lib/SoundscapePopover.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/SoundscapePopover.svelte src/lib/SoundscapePopover.test.ts
git commit -m "feat: add flow-state music popover"
```

### Task 6: Shell And Application Integration

**Files:**
- Modify: `src/lib/AppShell.svelte`
- Modify: `src/lib/AppShellHarness.test.svelte`
- Modify: `src/lib/AppShell.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: one persistent soundscape controller and one popover instance across Focus, History, and Revisions.

- [ ] **Step 1: Write failing integration tests**

Add shell tests proving a single supplied music-control snippet stays mounted while Settings opens and closes. Add app tests proving:

```text
no AudioContext or playback on startup
new sessions require a fresh Play
workspace navigation preserves one controller
timer Pause does not pause music
intermission suppresses and I'm back resumes same-session intent
completion alarm suppresses until the third tone ends
Delete All and End Session stop playback
Settings contains alarm/return tones but no soundscape duplicate
```

- [ ] **Step 2: Run integration tests and verify they fail**

Run: `npm test -- --run src/lib/AppShell.test.ts src/App.test.ts`

Expected: FAIL because shell and app wiring do not exist.

- [ ] **Step 3: Integrate without moving timer ownership**

Create the controller once after validated settings hydration, but keep engine creation lazy until Play. Add one unconditional lifecycle effect:

```ts
$effect(() => {
  soundscapeController?.syncLifecycle(
    soundscapeLifecycleFor(session, completionAlarmActive),
  );
});
```

Add one disposal effect. Render a single popover through an `AppShell` `railActions` snippet so navigation never remounts it. Persist selection and volume through `settingsController.set()`, and route Retry to the existing per-key retry method. Do not add soundscape controls to `SettingsDrawer`.

- [ ] **Step 4: Run focused integration tests**

Run: `npm test -- --run src/lib/AppShell.test.ts src/App.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/AppShell.svelte src/lib/AppShellHarness.test.svelte src/lib/AppShell.test.ts src/App.svelte src/App.test.ts
git commit -m "feat: integrate soundscapes with active sessions"
```

### Task 7: Documentation And Full Verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` only if user-facing operation needs clarification.

- [ ] **Step 1: Document Phase 5D**

Add a concise changelog entry covering local procedural presets, explicit playback, independent timer/music controls, lifecycle fades, and persisted selection/volume. Do not add development-phase narration to `README.md`.

- [ ] **Step 2: Run the complete automated suite**

Run:

```bash
npm run check
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: all commands pass with zero test failures and zero Svelte diagnostics.

- [ ] **Step 3: Perform visual and interaction QA**

Verify desktop and 360 by 640 layouts in the browser for every theme and both resolved appearances. Confirm no horizontal overflow, collisions, obscured timer controls, or sub-44-pixel controls. Exercise Focus, History, Revisions, Settings, intermission, warning, Flow, and quiet overtime while the one popover remains stable.

- [ ] **Step 4: Perform real Tauri audio QA**

Listen to all five presets. Confirm clean start/stop, volume changes, crossfades, alarm ducking, intermission suppression/resume, background playback, and no automatic playback after a new session or relaunch. Run at least one continuous 60-minute playback per preset while observing CPU/memory stability and detached-node cleanup.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: describe local flow-state soundscapes"
```
