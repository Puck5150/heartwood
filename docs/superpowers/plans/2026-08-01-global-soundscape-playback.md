# Global Soundscape Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the music-note player available before, during, and after a timer session while preserving explicit user control and the existing alarm/intermission suppression behavior.

**Architecture:** Treat soundscape playback intent as app-runtime state owned solely by `soundscapeController`, independent of timer session IDs and ordinary session phases. `App.svelte` keeps one `SoundscapePopover` mounted whenever settings and audio orchestration are ready. Timer lifecycle snapshots continue to reach the controller, but they only suppress output for alarms and timed intermissions; they never create, clear, or rebind playback intent.

**Tech Stack:** Svelte 5, TypeScript 6, Vitest, Testing Library, Web Audio, Tauri 2.

## Global Constraints

- Keep the bundled catalog, audio assets, audio engine, loop offsets, crossfade duration, settings keys, and persistence behavior unchanged.
- Do not autoplay. A full app launch starts with no playback intent and creates no audio engine until the user presses Play.
- Selection and volume remain persistent. Play/pause state remains runtime-only.
- Manual Pause is authoritative across all later timer lifecycle changes.
- Starting, pausing, resuming, finishing, reviewing, or replacing a focus session must not restart, stop, reload, or dispose the active soundscape.
- Timed Break and Touch Grass intermissions and completion/overtime alarms must continue to suppress the active track, preserve its offset, and resume it only when playback intent remains active.
- Preserve cancellation guards for stale asynchronous track loads, platform audio suspension reporting, preset-switch rollback, and controller disposal.
- Add no dependencies and make no unrelated layout, catalog, or timer behavior changes.

---

### Task 1: Decouple Playback Intent From Timer Sessions

**Files:**
- Modify: `src/lib/soundscapeController.svelte.ts`
- Modify: `src/lib/soundscapeController.test.ts`

**Interfaces:**
- Change `SoundscapeController.play(sessionId: string): Promise<void>` to `SoundscapeController.play(): Promise<void>`.
- Replace internal `playIntentSessionId: string | null` with `playIntent: boolean`.
- Keep `SoundscapeLifecycle` unchanged because its phase and alarm fields still supply temporary suppression context.
- Keep `SoundscapePlaybackSnapshot` unchanged.

- [ ] **Step 1: Write failing tests for idle playback and lifecycle independence**

Update existing calls from `controller.play('s1')` to `controller.play()`, then add these focused cases before changing production code:

```ts
it('plays on the idle start screen without a timer session', async () => {
  const { engine, handles } = fakeEngine();
  const controller = createSoundscapeController({
    initialPresetId: 'deep-focus',
    initialVolume: 0.35,
    createEngine: () => engine,
  });

  controller.syncLifecycle({ sessionId: null, phase: 'inactive', alarmActive: false });
  await controller.play();

  expect(engine.createTrack).toHaveBeenCalledWith('deep-focus');
  expect(handles[0].resume).not.toHaveBeenCalled();
  expect(controller.snapshot.status).toBe('playing');
});

it('keeps one playing track from idle through focus and review', async () => {
  const { engine, handles } = fakeEngine();
  const controller = createSoundscapeController({
    initialPresetId: 'deep-focus',
    initialVolume: 0.35,
    createEngine: () => engine,
  });

  await controller.play();
  controller.syncLifecycle({ sessionId: 's1', phase: 'focus', alarmActive: false });
  controller.syncLifecycle({ sessionId: 's1', phase: 'complete', alarmActive: false });

  expect(engine.createTrack).toHaveBeenCalledTimes(1);
  expect(handles[0].dispose).not.toHaveBeenCalled();
  expect(controller.snapshot.status).toBe('playing');
});

it('does not reverse manual Pause during later timer transitions', async () => {
  const { engine, handles } = fakeEngine();
  const controller = createSoundscapeController({
    initialPresetId: 'deep-focus',
    initialVolume: 0.35,
    createEngine: () => engine,
  });

  await controller.play();
  controller.pause();
  controller.syncLifecycle({ sessionId: 's1', phase: 'focus', alarmActive: false });
  controller.syncLifecycle({ sessionId: 's1', phase: 'complete', alarmActive: false });

  expect(handles[0].resume).not.toHaveBeenCalled();
  expect(controller.snapshot.status).toBe('paused');
});
```

Adapt fixture names to the existing test helpers rather than introducing a parallel fake-engine abstraction. Rewrite the old terminal-lifecycle test so `complete` and `postFocusBreak` preserve playback, and assert that only `controller.dispose()` disposes the track and engine. Retain the existing alarm/intermission, preset replacement, async cancellation, and failure tests.

- [ ] **Step 2: Run the controller test and verify the intended failures**

Run:

```bash
npx vitest run src/lib/soundscapeController.test.ts
```

Expected: FAIL because `play` still requires a session ID, inactive/complete phases clear playback, and session transitions dispose the track.

- [ ] **Step 3: Implement session-independent playback intent**

In `src/lib/soundscapeController.svelte.ts`:

1. Change the public interface and implementation to `play(): Promise<void>`.
2. Replace `playIntentSessionId` with `let playIntent = false`.
3. Remove `PLAYABLE_PHASES` and `TERMINAL_PHASES`.
4. Replace null/session-ID intent checks with `!playIntent` checks.
5. Remove all lifecycle session-ID validation from `play()` and `updateOutput()`.
6. Keep `shouldSuppressOutput()` limited to explicit alarm suppression, lifecycle alarm state, and `phase === 'intermission'`.
7. Make `updateOutput()` play or resume whenever `playIntent` is true and output is not suppressed, regardless of ordinary timer phase.
8. Set `playIntent = true` only after the selected track has loaded successfully and survived existing generation/disposal checks.
9. Make `pause()` set `playIntent = false`, fade/suspend the current track, and leave it available for a later explicit Play.
10. Make `syncLifecycle()` assign the new lifecycle and call `updateOutput()` without clearing intent or tracks.
11. Keep `clearIntentAndTrack()` as teardown behavior used by `dispose()`; it must set `playIntent = false` and retain all current generation and resource cleanup.

The central output logic should have this shape:

```ts
function updateOutput(): void {
  snapshot.temporarilySuppressed = shouldSuppressOutput();
  if (!engine || !activeTrack || !playIntent) return;

  if (shouldSuppressOutput()) {
    void suppressOutput();
    return;
  }

  if (outputSuppressed) {
    outputSuppressed = false;
    if (trackSuspended) {
      activeTrack.resume(FADE_SECONDS);
      trackSuspended = false;
    }
  }
  engine.setMasterGain(volume, FADE_SECONDS);
  snapshot.status = engine.state === 'running' ? 'playing' : 'suspended';
}
```

Preserve the current rule that Play is ignored while `shouldSuppressOutput()` is true. The UI already explains and disables that action during alarms and intermissions.

- [ ] **Step 4: Run the focused controller test**

Run:

```bash
npx vitest run src/lib/soundscapeController.test.ts
```

Expected: PASS. Verify specifically that idle Play is lazy, lifecycle transitions reuse one handle, manual Pause remains paused, suppression resumes the same handle, and disposal still invalidates in-flight work.

- [ ] **Step 5: Commit the controller change**

```bash
git add src/lib/soundscapeController.svelte.ts src/lib/soundscapeController.test.ts
git commit -m "feat: make soundscape playback timer independent"
```

---

### Task 2: Keep The Music Player Available Globally

**Files:**
- Modify: `src/lib/SoundscapePopover.svelte`
- Modify: `src/lib/SoundscapePopover.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**
- Remove `sessionId: string | null` from `SoundscapePopover` props.
- Keep `disabledReason: 'intermission' | 'alarm' | null` so the popover can explain temporary suppression.
- Keep one popover instance in `App.svelte`; do not create state-specific copies.

- [ ] **Step 1: Write failing component tests for session-free Play**

In `src/lib/SoundscapePopover.test.ts`, remove `sessionId` from `PopoverProps` and the default fixture. Update the playback-state table so every non-playing action expects:

```ts
expect(controller.play).toHaveBeenCalledWith();
```

Add a dedicated test that renders the popover with an idle controller, opens the music-note control, clicks `Play soundscape`, and asserts `play()` was called once with no arguments. Keep the intermission and alarm tests proving the disabled action does not call `play()`.

- [ ] **Step 2: Write a failing app integration test for the idle start screen**

In the existing `Local soundscape integration (Phase 5D)` block in `src/App.test.ts`, replace the active-session-only startup test with this behavior:

```ts
it('offers explicit soundscape playback before a timer starts', async () => {
  render(App);
  await screen.findByRole('textbox', { name: 'Focus task' });

  expect(soundscapeMocks.createWebAudioSoundscapeEngine).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('button', { name: 'Flow-state music' }));
  expect(soundscapeMocks.createWebAudioSoundscapeEngine).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('button', { name: 'Play soundscape' }));

  expect(soundscapeMocks.createWebAudioSoundscapeEngine).toHaveBeenCalledTimes(1);
  expect(soundscapeMocks.engine.createTrack).toHaveBeenCalledWith('deep-focus');
});
```

Add a second integration test that starts music while idle, starts focus, finishes early into review, and asserts the music control remains mounted, `createTrack` is called once, and the active handle is not disposed. Update the existing Break test so it still proves suppression and resumption but now expects finishing focus to preserve, rather than dispose, the track.

- [ ] **Step 3: Run the component and app tests and verify the intended failures**

Run:

```bash
npx vitest run src/lib/SoundscapePopover.test.ts src/App.test.ts
```

Expected: FAIL because the popover still requires `sessionId`, idle `App` does not render the music control, and focus completion currently tears playback down.

- [ ] **Step 4: Remove the session requirement from the popover**

In `src/lib/SoundscapePopover.svelte`:

1. Remove the `sessionId` prop and its type.
2. Change the action handler to return only when `disabledReason` is non-null.
3. Keep Pause behavior unchanged when `snapshot.status === 'playing'`.
4. Call `void controller.play()` for idle, paused, suspended, and retry states.
5. Disable the playback button only when `disabledReason !== null`.

Do not alter the popover's focus restoration, ARIA labels, preset controls, volume slider, or persistence retries.

- [ ] **Step 5: Render one popover in every app state**

In the `railActions` snippet in `src/App.svelte`, reduce the render condition to:

```svelte
{#if settingsController && soundscapeController}
```

Remove `sessionId={session.sessionId}` from `SoundscapePopover`. Preserve the current disabled-reason precedence:

```ts
session.status === 'intermission'
  ? 'intermission'
  : soundscapeController.snapshot.temporarilySuppressed
    ? 'alarm'
    : null
```

Do not tie visibility to `idle`, `awaitingDecision`, `break`, `complete`, navigation destination, or timer pause state.

- [ ] **Step 6: Run the focused UI tests**

Run:

```bash
npx vitest run src/lib/SoundscapePopover.test.ts src/App.test.ts
```

Expected: PASS with one globally mounted music control, lazy idle playback, uninterrupted idle-to-focus-to-review playback, and unchanged disabled suppression labels.

- [ ] **Step 7: Commit the global player UI**

```bash
git add src/lib/SoundscapePopover.svelte src/lib/SoundscapePopover.test.ts src/App.svelte src/App.test.ts
git commit -m "feat: expose soundscapes before focus starts"
```

---

### Task 3: Align User-Facing Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Document behavior only; do not add implementation notes that duplicate source code.

- [ ] **Step 1: Correct the README playback workflow**

Replace the current active-session-only language in `README.md` under `Play flow-state music` with wording that states:

- the music-note menu is available before, during, and after focus;
- explicit Play is still required;
- starting or ending a timer does not interrupt playback;
- alarms and timed intermissions temporarily suppress and then resume user-requested music;
- a full app restart begins silent.

Also update the architecture summary for `soundscapeController.svelte.ts` to describe lifecycle suppression and controller teardown, not terminal-session cleanup.

- [ ] **Step 2: Record the behavior in the Phase 5D changelog**

Add a concise Phase 5D bullet to `CHANGELOG.md` stating that the music-note player is globally available and soundscape playback is independent of timer sessions. Correct any existing same-session-only or terminal-cleanup wording in that section.

- [ ] **Step 3: Check documentation consistency**

Run:

```bash
rg -n "same session|same-session|Starting a new session|terminal cleanup|active focus session" README.md CHANGELOG.md
```

Expected: no stale claim that playback requires an active session, stops at review, or must be restarted for a new timer.

- [ ] **Step 4: Commit the documentation update**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document global soundscape playback"
```

---

### Task 4: Run Regression And Native Verification

**Files:**
- Verify only; modify production or test files only when a failure reveals a defect within this feature's scope.

**Interfaces:**
- Validate the complete Svelte/TypeScript suite and the existing Rust shell without changing app identity or persisted user data.

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
npm run check
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Svelte/TypeScript checks pass, all Vitest tests pass, the production frontend builds, and the Tauri Rust shell checks cleanly.

- [ ] **Step 2: Run a native Tauri smoke test with isolated app data**

Launch Tauri with a temporary development identifier so the verification does not alter the user's regular app data. Verify this sequence by sight and ear:

1. On the idle start screen, the music-note control is visible.
2. Opening the popover and changing selection or volume creates no playback until Play is pressed.
3. Press Play, then start a one-minute focus session; the same soundscape continues without a restart, second fade-in, or loop-position jump.
4. Pause and resume the timer; music remains independently controlled.
5. Press Break or Touch Grass; music fades/suspends, the popover explains the intermission suppression, and `I'm back` resumes at the preserved position.
6. Let the focus warning and alarm sequence occur; music is suppressed before the first tone and resumes after the sequence.
7. Press manual Pause, then transition through focus completion and Session Review; music stays paused.
8. Explicitly Play from Session Review; music starts without requiring a new timer.
9. Quit and relaunch the isolated app; selection and volume remain, but playback starts silent.

- [ ] **Step 3: Inspect the final diff and repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -6
```

Expected: no whitespace errors, no temporary native-test artifacts, and only the planned controller, popover, app, test, and documentation commits beyond the approved design/plan documentation.

- [ ] **Step 4: Report readiness for review**

Summarize the exact automated results and native scenarios. Push the branch and request Claude review only after all checks pass and the user approves the manual behavior.
