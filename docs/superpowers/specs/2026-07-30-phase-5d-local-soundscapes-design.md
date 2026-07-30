# Phase 5D: Local Procedural Soundscapes Design

**Status:** Approved design
**Date:** 2026-07-30
**Depends on:** Phase 5C resumable intermissions

## Objective

Add optional, fully local flow-state music that supports focus without
becoming another source of interruption or coupling audio playback to
timer rendering.

The first release uses original procedural Web Audio soundscapes. It
does not stream, connect to an account, download media, or require a
network connection.

## Mood Direction

Greenred Productions is a mood reference only:

- calm, immersive background music for focus and study;
- instrumental and free of vocals;
- warm ambient layers;
- restrained piano-like notes;
- soft electronic pulses;
- organic, handpan-like textures;
- slow development and low dynamic range;
- no abrupt transitions.

Do not copy compositions, recordings, names, artwork, branding, or
distinctive melodic material. Do not make therapeutic, neurological,
frequency, ADHD, sleep, or health claims.

## Built-In Library

Ship five original procedural presets:

1. **Deep Focus** — warm synthesis with a subtle pulse.
2. **Quiet Piano** — sparse, soft piano-like notes with generous space.
3. **Organic Drift** — handpan-like tones and restrained natural texture.
4. **Still Air** — slowly evolving pads and near-musical atmosphere.
5. **Rain Room** — rain and room tone with minimal tonal content.

Each preset is data-driven and implements the same small engine
interface. Presets run continuously rather than looping a fixed
recording, avoiding loop seams and large media assets.

The sound should remain useful across sessions from five minutes through
an hour. Random variation is seeded per playback session so tests can be
deterministic while actual listening remains gently varied.

## User Experience

A music-note icon opens one compact **Flow-state music** popover.

The popover contains:

- the selected preset;
- Play/Pause;
- the five-preset list;
- one volume slider;
- a small local/offline label;
- a concise playback error when needed.

Alarm-tone and return-tone selection remain in Settings. The soundscape
popover does not duplicate them.

The control follows the active timer across Focus, History, and
Revisions. There is one controller and one popover state, not a separate
audio instance per timer presentation.

On mobile, the popover uses the available width without becoming a
full-screen settings surface. It must not cover the timer's essential
controls or overflow at 360 by 640.

## Playback Decisions

- The selected preset and volume persist.
- Playback never starts automatically for a new session.
- The user must press Play once during each new session.
- Starting a new session clears the previous session's play intent.
- Switching presets while playing crossfades.
- Changing volume applies immediately and persists through the existing
  Settings path.
- Playback continues when the app is backgrounded.
- Relaunch never resumes playback automatically.
- Ending or deleting the active session stops playback.
- Timer Pause does not pause the soundscape; timer and music remain
  independently controllable.

## Intermission And Alarm Behavior

The controller receives session lifecycle state rather than reading the
DOM or owning timer calculations.

During Phase 5C Break or Touch Grass:

- fade the soundscape out;
- preserve same-session play intent;
- prevent manual playback while the intermission is active;
- resume after **I'm back** only when that same session previously had
  active play intent.

At focus completion:

- fade down before the three-tone completion alarm;
- remain suppressed during the alarm sequence;
- return smoothly during quiet overtime when same-session play intent
  remains active.

The focus warning does not alter soundscape playback.

Post-focus Break and Review stop playback because the focus/Flow portion
has ended.

## Controller Boundary

Create one lazy `SoundscapeController` with a narrow public surface:

```text
selectPreset(id)
setVolume(value)
play(sessionId)
pause()
syncLifecycle({ sessionId, phase, alarmActive })
dispose()
```

`phase` is an application-owned value such as:

```text
inactive | focus | flow | intermission | postFocusBreak | complete
```

The controller owns:

- the one lazily-created `AudioContext`;
- the active preset engine;
- the master gain node;
- crossfades;
- session-scoped play intent;
- temporary lifecycle suppression;
- cleanup and stale-callback protection;
- a small observable playback snapshot for the UI.

The controller does not own:

- timer state;
- wall-clock calculations;
- session persistence;
- navigation;
- Settings persistence;
- alarm synthesis;
- notifications.

This boundary allows a later recorded-track engine to implement the same
preset interface without changing timer components.

## Procedural Engine

Use native Web Audio and the existing repository's audio patterns. Do
not add a music framework.

Each preset factory receives an audio context, destination, volume
envelope, deterministic random source, and scheduler. It returns one
handle that can stop and dispose every node and timer it created.

Engineering constraints:

- one master graph;
- bounded oscillator, buffer, and timer counts;
- no unbounded recursive scheduling;
- no detached nodes after stop or preset switch;
- short gain ramps for start, stop, crossfade, and suppression;
- no clicks at envelope boundaries;
- no main-thread work tied to animation frames;
- no visualizer dependency.

The implementation should favor a few reusable synthesis primitives over
five separate piles of nearly identical audio code. Compactness must
come from shared musical building blocks, not dense code-golf.

## Persistence

Add settings keys:

```text
selectedSoundscapeId
soundscapeVolume
```

Validation:

- unknown preset IDs use **Deep Focus**;
- malformed volume uses the approved default;
- volume is clamped to the supported range;
- hydration applies selection and volume without creating an
  `AudioContext` or starting sound.

Writes use the existing settings controller and the application's one
shared FIFO task queue. Failed writes keep the in-memory choice visible
with the existing per-key Retry behavior.

Session play intent is deliberately not persisted.

## Audio Context And Platform Behavior

Create or resume the Web Audio context only from an explicit user Play
gesture. If the platform suspends the context later, show a quiet
**Resume audio** action rather than repeatedly retrying in the
background.

Browser development mode and Tauri use the same public controller
contract. Platform differences must not leak into timer components.

Audio context creation, preset creation, scheduling, and gain failures
are nonblocking. They update only the soundscape playback status.

## Accessibility

- Use the project's icon library for the music-note control.
- The icon button has a stable accessible name and tooltip.
- Play/Pause exposes its current action.
- Preset selection uses a single-selection control with an announced
  selected state.
- The volume slider has an accessible label and numeric value.
- Keyboard interaction follows normal button, radio/listbox, and range
  behavior.
- No sound starts because focus merely moved into the popover.
- Any decorative level indicator is hidden from assistive technology and
  static when reduced motion is requested.

## Error Handling

- A failed preset switch keeps or restores the previous working preset
  when possible.
- A failed initial Play leaves the timer untouched and exposes Retry.
- A failed fade immediately applies the safe target gain if possible.
- A stale asynchronous callback from a previous preset or session cannot
  restart sound.
- Ending a session invalidates every outstanding audio callback.
- Settings failures and audio failures remain independent.

## Testing

Keep most tests outside the real Web Audio implementation by injecting a
small audio-engine seam.

Controller tests cover:

- explicit Play requirement per new session;
- persisted selection/volume hydration without playback;
- crossfade ordering;
- timer Pause independence;
- intermission suppression and same-session resume;
- completion-alarm suppression and quiet-overtime resume;
- no resume for a different session;
- end-session cleanup;
- stale callback invalidation;
- error snapshot behavior.

Preset tests cover:

- deterministic scheduling under a seeded random source;
- bounded resource creation;
- complete stop/dispose cleanup;
- valid envelope and volume ranges.

Component and application tests cover:

- one music control across full and compact timer presentations;
- preset, Play/Pause, and volume wiring;
- Settings does not duplicate soundscape controls;
- navigation does not interrupt or duplicate playback;
- intermission and alarm lifecycle integration;
- accessible names and keyboard operation.

Manual verification covers:

- listening quality for all five presets;
- clean starts, stops, crossfades, and alarm ducking;
- at least one continuous 60-minute playback per preset;
- background playback;
- CPU and memory stability;
- desktop and 360 by 640 layouts;
- every theme and reduced-motion mode;
- no unexpected playback after a new session or relaunch.

## Deferred

- YouTube account connection or playback;
- Spotify, Apple Music, or other network providers;
- user-imported audio;
- downloaded sound packs;
- commissioned recorded tracks;
- soundscape sharing;
- per-preset equalizers;
- binaural or therapeutic claims;
- sleep or meditation modes;
- calendar or planner integration.

