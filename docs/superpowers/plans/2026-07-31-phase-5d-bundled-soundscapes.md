# Phase 5D Bundled Soundscapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rejected procedural oscillator soundscapes with seven approved, licensed, local musical loops while preserving the existing timer-independent playback UI and lifecycle behavior.

**Architecture:** Keep the current `SoundscapeController`, settings integration, and music popover, but replace synchronous procedural preset creation with an asynchronous bundled-track engine. The engine lazily fetches one local asset, decodes it through Web Audio, loops authored boundaries, records playback offset during temporary suppression, and retains at most two decoded buffers during a crossfade.

**Tech Stack:** Svelte 5, TypeScript 6, Vite 8 public assets, native Web Audio, Vitest, Tauri 2, 16-bit/44.1 kHz PCM WAV audio.

## Global Constraints

- Ship exactly Deep Focus, Lo-Fi Hip Hop, Quiet Piano, Organic Drift, Still Air, Rain Room, and Slow Pulse.
- Use finished, licensed, instrumental 60-150 second seamless loops; do not retain procedural synthesis as a fallback.
- Slow Pulse uses a muted tick around 50-60 BPM with a warm musical undertone.
- Lo-Fi Hip Hop uses mellow 60-80 BPM boom-bap, warm keys, restrained bass, no vocals, and only original or explicitly sample-cleared material.
- Rain Room uses diffuse forest rain on foliage and soft ground, heard from shelter through an open window, with gentle wind and occasional soft droplets as the lead texture. Its piano sits approximately 5-7 dB behind the weather and uses restrained, dark cave reverb with enough pre-delay to keep individual notes clear. Reject streams, gutters, runoff, continuous flowing water, close-miked splashing, sharp rain impacts, harsh high-frequency rain, low-frequency wind rumble, obvious short repetition, muddy piano tails, and exaggerated cavern effects.
- Every license must allow application redistribution, commercial use, offline storage, and the modifications used to prepare the asset.
- Attribution is allowed and must be recorded with source URL, license version, download date, and preparation notes.
- No streaming, accounts, YouTube ripping, user imports, downloadable packs, vocals, health claims, or more than seven built-in tracks.
- Playback requires explicit Play once per focus session and never resumes automatically after relaunch.
- Timer Pause does not pause music.
- In-session Break, Touch Grass, and completion alarms preserve exact loop offset and resume only for the same eligible focus session.
- Post-focus Break, Review, End session, active-session deletion, and application disposal stop playback.
- Keep at most two decoded buffers during a crossfade; never preload the full library.
- Preserve the previous working track when a replacement fails to load or start.
- No audio asset enters the repository before the user approves it by ear.

---

### Task 1: Curate, Approve, And Prepare The Seven Audio Assets

**Files:**
- Create: `public/audio/soundscapes/deep-focus.wav`
- Create: `public/audio/soundscapes/lofi-hip-hop.wav`
- Create: `public/audio/soundscapes/quiet-piano.wav`
- Create: `public/audio/soundscapes/organic-drift.wav`
- Create: `public/audio/soundscapes/still-air.wav`
- Create: `public/audio/soundscapes/rain-room.wav`
- Create: `public/audio/soundscapes/slow-pulse.wav`
- Create: `docs/licenses/soundscapes.md`
- Create or modify: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: the seven mood slots and licensing requirements in the approved redesign specification.
- Produces: seven user-approved canonical WAV files plus complete redistribution evidence used by the catalog in Task 2.

- [x] **Step 1: Create an external candidate workspace**

Run outside the repository so rejected media never enters Git history:

```bash
mkdir -p /private/tmp/pomodoro-soundscape-candidates
```

- [ ] **Step 2: Shortlist licensed candidates one slot at a time**

For each slot, verify the license on the original publisher page. Save the original file and a text capture of the source URL, creator, license name/version, download date, required attribution, redistribution clause, commercial-use clause, and derivative-work clause under `/private/tmp/pomodoro-soundscape-candidates/`.

Reject any candidate that lacks explicit application redistribution rights, is only described as "royalty-free," contains vocals, exceeds the approved musical intensity, or is not available as a musically seamless 60-150 second loop. For Lo-Fi Hip Hop, also reject unclear sample provenance, unresolved Content ID disputes, or stock-loop terms that do not plainly permit application redistribution.

Rain Room may combine separately licensed weather and piano sources when both permit derivative works and application redistribution. Prefer a longer natural weather recording over a heavily repeated short effect. Preserve the source and processing provenance for every layer. The audition mix must make diffuse rain and wind clearly audible but soft, position piano 5-7 dB behind the weather, remove harsh weather highs and wind rumble, and place only the piano in a restrained dark cave reverb. Reject a candidate when its dominant character resembles flowing water, runoff, a gutter, a stream, close splashing, or rain striking a hard nearby surface.

- [ ] **Step 3: Present candidates for listening approval**

Audition no more than three candidates per slot. Record the user's explicit approval before processing a file. Deep Focus, Lo-Fi Hip Hop, Quiet Piano, Organic Drift, Still Air, Rain Room, and Slow Pulse each require a separate approval.

Expected: exactly seven approved source files; no rejected file exists under `public/`.

- [x] **Step 4: Install the local preparation tool only with approval**

The workstation initially had no `ffmpeg` or `ffprobe`. The user approved installing the Homebrew package during Rain Room curation:

```bash
brew install ffmpeg
```

Verify:

```bash
ffmpeg -version
ffprobe -version
```

Expected: both commands exit 0.

- [ ] **Step 5: Normalize and encode the approved files**

Rename the seven approved downloads to the exact source paths below before running the commands. Use the official seamless-loop version of each source; do not manufacture a loop from a non-looping composition.

```bash
mkdir -p public/audio/soundscapes
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/deep-focus-source -af loudnorm=I=-23:LRA=7:TP=-2 -codec:a pcm_s16le -ar 44100 public/audio/soundscapes/deep-focus.wav
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/lofi-hip-hop-source -af loudnorm=I=-23:LRA=7:TP=-2 -codec:a pcm_s16le -ar 44100 public/audio/soundscapes/lofi-hip-hop.wav
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/quiet-piano-source -af loudnorm=I=-23:LRA=7:TP=-2 -codec:a pcm_s16le -ar 44100 public/audio/soundscapes/quiet-piano.wav
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/organic-drift-source -af loudnorm=I=-23:LRA=7:TP=-2 -codec:a pcm_s16le -ar 44100 public/audio/soundscapes/organic-drift.wav
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/still-air-source -af loudnorm=I=-23:LRA=7:TP=-2 -codec:a pcm_s16le -ar 44100 public/audio/soundscapes/still-air.wav
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/rain-room-source -af loudnorm=I=-23:LRA=7:TP=-2 -codec:a pcm_s16le -ar 44100 public/audio/soundscapes/rain-room.wav
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/slow-pulse-source -af loudnorm=I=-23:LRA=7:TP=-2 -codec:a pcm_s16le -ar 44100 public/audio/soundscapes/slow-pulse.wav
```

Expected: seven mono-or-stereo WAV files using 16-bit PCM at 44.1 kHz, each between 60 and 150 seconds, with integrated loudness near -23 LUFS and true peak no higher than -2 dB.

- [ ] **Step 6: Capture measured asset metadata**

Run:

```bash
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration,bit_rate -of json public/audio/soundscapes/deep-focus.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration,bit_rate -of json public/audio/soundscapes/lofi-hip-hop.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration,bit_rate -of json public/audio/soundscapes/quiet-piano.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration,bit_rate -of json public/audio/soundscapes/organic-drift.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration,bit_rate -of json public/audio/soundscapes/still-air.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration,bit_rate -of json public/audio/soundscapes/rain-room.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration,bit_rate -of json public/audio/soundscapes/slow-pulse.wav
```

Record the measured duration for Task 2. Loop start is `0`; loop end is the musical source duration after Web Audio decoding, adjusted only when the ten-loop audition identifies encoder padding.

- [ ] **Step 7: Write complete license records**

In `docs/licenses/soundscapes.md`, create one section per canonical asset with creator, original title, source URL, license/version, download date, attribution text, redistribution evidence, derivative-work evidence, and the exact normalization/encoding command used. Add each required attribution and license notice to `THIRD_PARTY_NOTICES.md`.

- [ ] **Step 8: Run the asset acceptance gate**

For each prepared file, listen through ten consecutive loops before continuing. Reject any file with an audible gap, click, rhythmic stumble, distracting repetition, harsh transient, or inconsistent loudness.

- [ ] **Step 9: Commit only approved assets and notices**

```bash
git add public/audio/soundscapes docs/licenses/soundscapes.md THIRD_PARTY_NOTICES.md
git commit -m "assets: add licensed focus music library"
```

---

### Task 2: Define And Validate The Bundled Track Catalog

**Files:**
- Modify: `src/lib/soundscapeCatalog.ts`
- Modify: `src/lib/soundscapeCatalog.test.ts`
- Create: `src/lib/soundscapeAssets.test.ts`
- Modify: `src/lib/SoundscapePopover.test.ts`

**Interfaces:**
- Consumes: canonical asset paths and measured durations from Task 1.
- Produces: `SoundscapeId`, `SoundscapeDefinition`, `SOUNDSCAPE_CATALOG`, `getSoundscapeDefinition(id)`, and `validateSoundscapeCatalog(catalog)`.

- [ ] **Step 1: Write failing catalog tests**

Add assertions that the catalog has exactly these IDs in order:

```ts
expect(SOUNDSCAPE_CATALOG.map(({ id }) => id)).toEqual([
  'deep-focus',
  'lofi-hip-hop',
  'quiet-piano',
  'organic-drift',
  'still-air',
  'rain-room',
  'slow-pulse',
]);
```

Add tests requiring every entry to use `/audio/soundscapes/{id}.wav`, have `durationSeconds` between 60 and 150, satisfy `0 <= loopStartSeconds < loopEndSeconds <= durationSeconds`, and include non-empty creator, source URL, license ID, and attribution fields. Add a failure-table test for duplicate IDs, mismatched paths, invalid loop ranges, and missing license data.

In `soundscapeAssets.test.ts`, resolve each catalog path beneath `public/`, assert
that it is a regular non-empty file, and assert that the resolved path remains
inside `public/audio/soundscapes`.

Update `SoundscapePopover.test.ts` to assert that the radiogroup includes Lo-Fi Hip Hop and Slow Pulse and forwards their IDs when selected.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- --run src/lib/soundscapeCatalog.test.ts src/lib/soundscapeAssets.test.ts src/lib/SoundscapePopover.test.ts
```

Expected: FAIL because `lofi-hip-hop`, `slow-pulse`, and track metadata are absent.

- [ ] **Step 3: Extend the catalog contract**

Use this shape:

```ts
export type SoundscapeId =
  | 'deep-focus'
  | 'lofi-hip-hop'
  | 'quiet-piano'
  | 'organic-drift'
  | 'still-air'
  | 'rain-room'
  | 'slow-pulse';

export interface SoundscapeDefinition {
  id: SoundscapeId;
  name: string;
  description: string;
  assetPath: string;
  durationSeconds: number;
  loopStartSeconds: number;
  loopEndSeconds: number;
  creator: string;
  sourceUrl: string;
  licenseId: string;
  attribution: string;
}
```

Populate all seven entries with the exact measured and licensed data from Task 1. Add:

```ts
export function getSoundscapeDefinition(id: SoundscapeId): SoundscapeDefinition {
  return SOUNDSCAPE_CATALOG.find((entry) => entry.id === id)!;
}

export function validateSoundscapeCatalog(
  catalog: readonly SoundscapeDefinition[],
): readonly string[] {
  // Return one stable human-readable error per invalid field or duplicate ID.
}
```

Call `validateSoundscapeCatalog(SOUNDSCAPE_CATALOG)` at module initialization and throw one joined error when validation fails. Keep persisted ID and volume parsing behavior unchanged.

- [ ] **Step 4: Run focused tests**

```bash
npm test -- --run src/lib/soundscapeCatalog.test.ts src/lib/soundscapeAssets.test.ts src/lib/SoundscapePopover.test.ts src/lib/appearance.test.ts src/lib/settingsController.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/soundscapeCatalog.ts src/lib/soundscapeCatalog.test.ts src/lib/soundscapeAssets.test.ts src/lib/SoundscapePopover.test.ts
git commit -m "feat: define bundled soundscape catalog"
```

---

### Task 3: Add The Lazy Local Track Loader

**Files:**
- Create: `src/lib/soundscapeTrackLoader.ts`
- Create: `src/lib/soundscapeTrackLoader.test.ts`

**Interfaces:**
- Consumes: `SoundscapeDefinition` from Task 2 and a Web Audio context.
- Produces: `SoundscapeTrackLoader` and `createBundledTrackLoader(fetchAudio)`.

- [ ] **Step 1: Write failing loader tests**

Define the public seam in the test:

```ts
export type SoundscapeTrackLoader = (
  context: Pick<AudioContext, 'decodeAudioData'>,
  definition: SoundscapeDefinition,
) => Promise<AudioBuffer>;
```

Test that the loader fetches `definition.assetPath` once, rejects a non-OK response, rejects a decode failure, and rejects a decoded duration shorter than `loopEndSeconds`. Verify that it passes a copied `ArrayBuffer` to `decodeAudioData` so a decoder that detaches its input cannot corrupt retry state.

- [ ] **Step 2: Run tests to verify failure**

```bash
npm test -- --run src/lib/soundscapeTrackLoader.test.ts
```

Expected: FAIL because the loader module does not exist.

- [ ] **Step 3: Implement the loader**

Use this factory:

```ts
export function createBundledTrackLoader(
  fetchAudio: typeof fetch = fetch,
): SoundscapeTrackLoader {
  return async (context, definition) => {
    const response = await fetchAudio(definition.assetPath);
    if (!response.ok) throw new Error(`Could not load ${definition.id}.`);
    const encoded = await response.arrayBuffer();
    const decoded = await context.decodeAudioData(encoded.slice(0));
    if (decoded.duration + 0.01 < definition.loopEndSeconds) {
      throw new Error(`Decoded ${definition.id} is shorter than its loop range.`);
    }
    return decoded;
  };
}
```

- [ ] **Step 4: Run focused tests**

```bash
npm test -- --run src/lib/soundscapeTrackLoader.test.ts src/lib/soundscapeCatalog.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/soundscapeTrackLoader.ts src/lib/soundscapeTrackLoader.test.ts
git commit -m "feat: load bundled soundscape tracks"
```

---

### Task 4: Replace The Procedural Engine With A Looping Track Engine

**Files:**
- Modify: `src/lib/soundscapeEngine.ts`
- Rewrite: `src/lib/soundscapeEngine.test.ts`
- Delete: `src/lib/soundscapePresets.ts`
- Delete: `src/lib/soundscapePresets.test.ts`

**Interfaces:**
- Consumes: `SoundscapeTrackLoader`, `getSoundscapeDefinition(id)`, and Web Audio node factories.
- Produces: asynchronous `SoundscapeEngine.createTrack(id)` and resumable `SoundscapeEngineHandle` instances.

- [ ] **Step 1: Write failing engine contract tests**

Change the interfaces to:

```ts
export interface SoundscapeEngineHandle {
  setGain(value: number, rampSeconds: number): void;
  suspend(rampSeconds: number): Promise<void>;
  resume(rampSeconds: number): void;
  stop(rampSeconds: number): Promise<void>;
  dispose(): void;
}

export interface SoundscapeEngine {
  readonly state: AudioContextState;
  resume(): Promise<void>;
  subscribeToStateChange(listener: () => void): () => void;
  setMasterGain(value: number, rampSeconds: number): void;
  createTrack(id: SoundscapeId): Promise<SoundscapeEngineHandle>;
  dispose(): Promise<void>;
}
```

Use an injected fake context and loader. Test:

- the loader is not called until `createTrack`;
- a source has `loop = true`, authored `loopStart`, and authored `loopEnd`;
- `source.start(0, offset)` receives zero for first play;
- suspend fades, captures `(priorOffset + elapsed) % loopDuration`, and stops the source;
- resume creates a new one-shot source at the captured offset;
- repeated suspend/resume calls are idempotent;
- a two-entry cache evicts only unreferenced buffers before loading a third;
- a disposed handle releases its reference and all nodes/timers once;
- engine disposal closes the context and prevents stale loads from creating nodes.

- [ ] **Step 2: Run tests to verify failure**

```bash
npm test -- --run src/lib/soundscapeEngine.test.ts
```

Expected: FAIL because `createTrack`, `suspend`, and `resume` do not exist.

- [ ] **Step 3: Implement the buffer cache and source lifecycle**

Keep `smoothGain` and `createDisposableRegistry`. Replace oscillator scheduling with:

```ts
interface CachedTrack {
  buffer: AudioBuffer;
  references: number;
  lastUsed: number;
}

function loopOffset(
  definition: SoundscapeDefinition,
  offset: number,
): number {
  const length = definition.loopEndSeconds - definition.loopStartSeconds;
  return definition.loopStartSeconds + ((offset - definition.loopStartSeconds) % length + length) % length;
}
```

`createTrack(id)` awaits the injected loader, creates one gain bus, and starts one `AudioBufferSourceNode`. Each handle owns its source, bus, saved offset, start time, suppression generation, and disposal flag. A suspend operation fades first, then captures the offset and stops the source; a resume operation recreates the source at that exact offset.

Keep the production factory explicit and injectable:

```ts
export function createWebAudioSoundscapeEngine(options: {
  loadTrack: SoundscapeTrackLoader;
  createContext?: () => AudioContext;
  wait?: (milliseconds: number) => Promise<void>;
}): SoundscapeEngine;
```

Before loading an uncached third track, evict the least-recently-used cache entry whose `references` is zero. If both cached entries are referenced, reject the third load without allocating a third decoded buffer. Never evict a referenced track and never hold more than two decoded buffers.

- [ ] **Step 4: Run focused engine tests**

```bash
npm test -- --run src/lib/soundscapeEngine.test.ts src/lib/soundscapeTrackLoader.test.ts src/lib/soundscapeCatalog.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify procedural code is gone**

```bash
rg -n "createPresetProgram|createSeededRandom|MAX_EVENTS_PER_WINDOW|OscillatorNode|createOscillator" src/lib src/App.svelte
```

Expected: no soundscape-engine matches. The separate short alarm-tone implementation in `src/lib/sound.ts` remains.

- [ ] **Step 6: Commit**

```bash
git add src/lib/soundscapeEngine.ts src/lib/soundscapeEngine.test.ts src/lib/soundscapeTrackLoader.ts src/lib/soundscapeTrackLoader.test.ts src/lib/soundscapePresets.ts src/lib/soundscapePresets.test.ts
git commit -m "feat: replace procedural soundscapes with bundled tracks"
```

---

### Task 5: Adapt The Controller To Async Tracks And Exact Resume

**Files:**
- Modify: `src/lib/soundscapeController.svelte.ts`
- Modify: `src/lib/soundscapeController.test.ts`

**Interfaces:**
- Consumes: `SoundscapeEngine.createTrack(id)` and handle `suspend`/`resume` from Task 4.
- Produces: the unchanged public `SoundscapeController` API used by App and the popover.

- [ ] **Step 1: Extend fake handles and write failing controller tests**

Change `fakeHandle()` to include:

```ts
suspend: vi.fn(async () => {}),
resume: vi.fn(),
```

Change the fake engine to expose `createTrack: vi.fn(async () => handle)`.

Add tests proving:

- initial Play awaits the selected track before exposing `playing`;
- Break, Touch Grass, and alarm suppression call `handle.suspend(FADE_SECONDS)` once;
- same-session eligibility calls `handle.resume(FADE_SECONDS)`;
- timer Pause lifecycle does neither;
- manual music Pause suspends and explicit Play resumes the same handle;
- selecting a different track while manually paused causes the next Play to load the new ID instead of resuming the old handle;
- an in-flight switch keeps the old handle audible until the new promise resolves;
- a rejected switch keeps the prior handle and error copy;
- a stale load resolving after session termination is disposed and cannot become active.

- [ ] **Step 2: Run tests to verify failure**

```bash
npm test -- --run src/lib/soundscapeController.test.ts
```

Expected: FAIL because the controller still uses synchronous `createPreset` and master-gain-only suppression.

- [ ] **Step 3: Implement async track orchestration**

Remove the seed option and track both `activeTrack` and `activeTrackId`.

In `play(sessionId)`, await `engine.createTrack(selectedPresetId)` when no handle exists or the paused handle ID differs from selection. After every await, verify `disposed`, generation, lifecycle session ID, and selected ID before assigning the handle.

In lifecycle suppression, keep same-session play intent, fade the master to zero, and call `void activeTrack.suspend(FADE_SECONDS)`. Track whether output is already suppressed so repeated reactive synchronization does not restart the fade or offset capture. On eligible resume, call `activeTrack.resume(FADE_SECONDS)` before restoring master gain. Manual Pause clears play intent and suspends the handle; terminal lifecycle disposes it.

In `selectPreset(id)`, load the replacement while the old handle remains audible. Crossfade only after replacement creation succeeds and the request is still current.

- [ ] **Step 4: Run controller and lifecycle tests**

```bash
npm test -- --run src/lib/soundscapeController.test.ts src/lib/soundscapeLifecycle.test.ts src/lib/alarmSequence.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/soundscapeController.svelte.ts src/lib/soundscapeController.test.ts
git commit -m "feat: resume bundled music across intermissions"
```

---

### Task 6: Integrate Bundled Playback Through The App And Popover

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`
- Modify: `src/lib/SoundscapePopover.svelte`
- Modify: `src/lib/SoundscapePopover.test.ts`
- Modify: `src/lib/SettingsDrawer.svelte`
- Modify: `src/lib/SettingsDrawer.test.ts`

**Interfaces:**
- Consumes: catalog and controller contracts from Tasks 2 and 5.
- Produces: one lazy bundled-track controller across Focus, History, and Revisions with seven selectable tracks.

- [ ] **Step 1: Update app mocks and write failing integration assertions**

Update the hoisted mock handle with `suspend` and `resume`. Replace `createPreset` with async `createTrack` and assert:

```ts
expect(soundscapeMocks.engine.createTrack).toHaveBeenCalledWith('deep-focus');
```

Update the Break test to expect `handle.suspend`, then `handle.resume` after `I'm back`. Add selection tests for Lo-Fi Hip Hop and Slow Pulse and expect their IDs to reach `createTrack` while the prior handle is retained until the replacement resolves.

Add a Settings drawer test that expands **Music credits** under Audio and finds all
seven creator/title attributions. Assert that Settings still contains no soundscape
selection, playback, or volume controls.

- [ ] **Step 2: Run tests to verify failure**

```bash
npm test -- --run src/App.test.ts src/lib/SoundscapePopover.test.ts src/lib/SettingsDrawer.test.ts
```

Expected: FAIL on the old engine contract and five-track list.

- [ ] **Step 3: Wire the bundled loader and revised engine**

In `App.svelte`, create the engine lazily with the production loader:

```ts
createEngine: () => createWebAudioSoundscapeEngine({
  loadTrack: createBundledTrackLoader(),
}),
```

Keep the music control unavailable during intermission and terminal states. Do not add track controls to Settings. Add one compact native `details`/`summary` Music credits disclosure beneath the existing Audio controls, sourced from `SOUNDSCAPE_CATALOG`, and list only the title, creator, and required attribution. Update catalog descriptions in the popover to the approved musical copy without changing its disclosure semantics or responsive layout.

- [ ] **Step 4: Run app, component, settings, and accessibility tests**

```bash
npm test -- --run src/App.test.ts src/lib/SoundscapePopover.test.ts src/lib/SettingsDrawer.test.ts src/lib/appearance.test.ts src/lib/settingsController.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte src/App.test.ts src/lib/SoundscapePopover.svelte src/lib/SoundscapePopover.test.ts src/lib/SettingsDrawer.svelte src/lib/SettingsDrawer.test.ts
git commit -m "feat: expose licensed flow-state music"
```

---

### Task 7: Validate Native Assets, Licensing, And Release Behavior

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-30-phase-5d-local-soundscapes-design.md`
- Modify: `docs/superpowers/specs/2026-07-31-phase-5d-bundled-soundscape-redesign-design.md`

**Interfaces:**
- Consumes: the complete bundled-track implementation and approved media.
- Produces: release documentation and fresh automated/native/manual evidence.

- [ ] **Step 1: Update user and development documentation**

Change Phase 5D language from "local procedural soundscapes" to "local bundled soundscapes." Link the original Phase 5D design to the approved redesign and mark its procedural engine section superseded. Document Music credits and the location of third-party notices. Keep README focused on installation and use; keep implementation history in CHANGELOG and design documents.

- [ ] **Step 2: Verify production asset packaging**

```bash
npm run build
find dist/audio/soundscapes -type f -name '*.wav' -print | sort
```

Expected: build exits 0 and lists exactly seven canonical files.

- [ ] **Step 3: Run the complete automated suite**

```bash
npm run check
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: all commands exit 0 with no warnings introduced by this phase.

- [ ] **Step 4: Run native Tauri smoke tests**

```bash
npm run tauri:dev
```

Verify all seven tracks load locally with networking disabled. Exercise Play/Pause, volume, track switching, timer Pause independence, Break, Touch Grass, completion alarm suppression, quiet-overtime resume, navigation, End session, and app shutdown. Confirm no console errors and no playback survives a terminal state.

- [ ] **Step 5: Run subjective acceptance**

For each track:

- listen through ten consecutive loops;
- compare loudness against all other tracks;
- confirm the music is complete, warm, and non-fatiguing rather than oscillator-like;
- confirm Slow Pulse has a slow muted tick with a musical undertone;
- confirm Lo-Fi Hip Hop has mellow boom-bap movement without vocals, harsh transients, or uncleared samples;
- complete one continuous 60-minute endurance session before release.

Record results in the PR body. Any failed track returns to Task 1; do not tune it with procedural oscillator overlays.

- [ ] **Step 6: Commit documentation and final corrections**

```bash
git add CHANGELOG.md README.md docs/superpowers/specs docs/licenses THIRD_PARTY_NOTICES.md
git commit -m "docs: describe bundled focus music"
```

- [ ] **Step 7: Push and request independent review**

```bash
git push
```

Ask the reviewer to check licensing traceability, stale async loads, the two-buffer bound, exact offset resume, terminal cleanup, production asset packaging, and the complete validation evidence.
