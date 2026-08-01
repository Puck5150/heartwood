# Phase 5D: Bundled Soundscape Redesign

**Status:** Approved design
**Date:** 2026-07-31
**Depends on:** Phase 5D local soundscape controller and lifecycle integration
**Supersedes:** The built-in library and procedural-engine sections of
`2026-07-30-phase-5d-local-soundscapes-design.md`

**Loop-boundary refinement:** [Phase 5D seamless loop boundaries](2026-07-31-phase-5d-seamless-loop-boundaries-design.md)

## Objective

Replace the first procedural soundscape implementation with a small library of
finished, licensed musical loops. Preserve the existing local/offline product
model, timer independence, music popover, persisted selection and volume, and
session lifecycle behavior.

The procedural implementation demonstrated that isolated oscillator notes over
noise textures do not meet the product's listening-quality bar. The replacement
must feel like complete instrumental music suitable for repeated focus sessions,
not a generative synthesis demo.

## Scope

Ship exactly seven bundled instrumental tracks:

1. **Deep Focus** - warm ambient electronics with restrained melodic movement.
2. **Lo-Fi Hip Hop** - mellow boom-bap rhythm, warm keys, and restrained bass.
3. **Quiet Piano** - felt-piano phrases over a soft harmonic bed.
4. **Organic Drift** - handpan, mallet, or acoustic textures with gentle
   development.
5. **Still Air** - slow cinematic pads with subtle harmonic changes.
6. **Rain Room** - diffuse forest rain on foliage and soft ground, heard from
   shelter through an open window, with gentle wind and occasional soft
   droplets. A recessed piano carries restrained, dark cave reverb. Weather is
   the lead texture; the piano remains supportive and distant. Reject streams,
   gutters, runoff, continuous flowing water, close-miked splashing, sharp rain
   impacts, obvious short repetition, muddy reverb, and exaggerated cavern
   effects.
7. **Slow Pulse** - a warm electronic bed whose native movement supports a
   clear, unhurried half-time kick, backbeat, and muted tick.

Each track is a mastered 60-150 second seamless loop with low dynamic range, no
vocals, and no abrupt transitions. Greenred Productions remains a mood reference
only. Do not copy compositions, recordings, names, artwork, branding, or
distinctive melodic material, and do not make therapeutic or health claims.

## Non-Goals

- Runtime music composition or procedural synthesis.
- Streaming, account connections, or network playback.
- YouTube ripping or importing tracks with unclear redistribution rights.
- User-imported music, downloadable sound packs, or a playlist manager.
- Per-track equalizers, visualization, or adaptive biometric behavior.
- More than seven built-in tracks in this phase.

## Listening Experience

Playback begins at the selected track's intentional starting point on the first
Play of a focus session. The track loops continuously at authored boundaries.

- Switching tracks crossfades into the beginning of the new track.
- Timer Pause does not pause music.
- An in-session Break, Touch Grass, or completion alarm fades music out,
  preserves its exact loop offset, and resumes from that offset when the same
  focus session becomes eligible again, including quiet overtime after the
  completion alarm.
- Entering post-focus Break or Review, deleting the active session, or choosing
  End session stops and releases playback.
- Starting a new focus session clears prior play intent and begins from the new
  track's start after an explicit Play action.
- Relaunch never resumes music automatically.

The existing music-note popover remains the only soundscape control surface. It
continues to provide Play/Pause, track selection, volume, local/offline status,
and concise retryable errors.

## Track Sourcing And Licensing

Every candidate must have a verified license that explicitly permits:

- redistribution inside a desktop application;
- commercial use;
- local storage and offline playback;
- modification for trimming, fades, loudness matching, and seamless looping.

Lo-Fi Hip Hop must use original or explicitly sample-cleared material. Reject
tracks with unclear sample provenance, unresolved Content ID disputes, or stock
loop licensing that does not plainly permit redistribution in the application.

Attribution is allowed. Candidate tracks remain outside the repository until the
user approves them by ear.

For every approved file, record:

- track title and creator;
- original source URL;
- license name and version;
- download date;
- required attribution text;
- a local copy of the license when required;
- the modifications made to prepare the bundled asset.

Repository third-party notices must make every audio file traceable. A vague
"royalty-free" label is insufficient evidence. Do not use audio obtained by
ripping a streaming service or video platform.

Settings > Audio includes one compact **Music credits** disclosure listing each
bundled track's title, creator, and required attribution. It does not duplicate
selection, playback, or volume controls from the music popover.

## Audio Preparation

Approved source material may be trimmed to its strongest 60-150 second section
when the license permits derivatives. Prepare every track to a shared quiet
loudness target and conservative peak ceiling so switching tracks does not cause
surprising volume changes.

Each catalog entry stores authored `loopStartSeconds` and `loopEndSeconds` values.
Loop points exclude encoder padding and use musically compatible boundaries.
Track preparation is complete only after ten consecutive loops play without an
audible gap, click, or rhythmic stumble.

Use 16-bit PCM WAV at 44.1 kHz for gapless authored loops and broad Tauri
webview compatibility. Confirm the format through a native smoke test before
the first asset is committed. Do not duplicate the library in multiple formats
unless platform testing proves it necessary.

## Catalog And Persistence

Retain the existing IDs for the five current selections and add `lofi-hip-hop`
and `slow-pulse`. Existing saved selections therefore remain valid without
migration.

Each catalog entry contains:

```text
id
name
description
assetPath
durationSeconds
loopStartSeconds
loopEndSeconds
creator
sourceUrl
licenseId
attribution
```

The selected track and volume continue through the existing settings controller.
Unknown IDs use Deep Focus. Play intent and playback offset remain session-scoped
runtime state and are never persisted.

## Engine Architecture

Keep the current `SoundscapeController`, UI contract, persistence path, and
application lifecycle integration. Replace only the implementation that creates
soundscape handles.

The bundled-track engine:

- creates or resumes one `AudioContext` only after explicit Play;
- fetches and decodes the selected local asset lazily;
- creates a looping `AudioBufferSourceNode` using authored loop points;
- tracks the active source's start time and loop offset;
- recreates the one-shot source at the recorded offset after suppression;
- crossfades through separate gain buses when switching tracks;
- holds no more than two decoded track buffers during a crossfade;
- releases the previous buffer and graph after the fade;
- invalidates stale asynchronous loads after a switch, session change, or dispose.

The engine must not preload the whole library. The controller remains independent
of timer rendering and receives only application-owned lifecycle state.

The seed argument retained by the current engine interface may be removed if no
remaining caller needs it. Prefer a clear recorded-track contract over preserving
procedural concepts that no longer serve the implementation.

## Loading And State Flow

On Play:

1. Resume or create the audio context from the user gesture.
2. Load and decode the selected local asset when it is not cached.
3. Reject the result if the session, selection, or generation changed while it
   loaded.
4. Start at offset zero or the same-session saved offset.
5. Fade to the persisted master volume.

On track switch while playing:

1. Keep the current track audible.
2. Load and validate the replacement.
3. Start the replacement at offset zero on its own bus.
4. Crossfade only after the replacement starts successfully.
5. Dispose the old source and release its buffer after the fade.

On temporary lifecycle suppression, fade out, save the exact loop-relative
offset, and stop the source. On eligible same-session resume, create a new source
at that offset and fade in.

## Error Handling

- An initial load or decode failure leaves playback stopped and exposes Retry.
- A failed track switch keeps the previous track and selection working.
- Missing assets, invalid durations, and invalid loop ranges fail catalog
  validation during development.
- Audio errors never block timer, navigation, Break, Touch Grass, alarm, or
  session transitions.
- A stale load cannot start playback or replace a newer selection.
- Cleanup remains idempotent after natural end, manual stop, failed switch,
  session termination, and application disposal.

## Automated Verification

Inject an asset loader and audio-engine seam so most behavior does not require
real browser audio.

Tests cover:

- manifest completeness and unique stable IDs;
- valid asset paths, durations, and loop ranges;
- explicit Play before loading or context creation;
- lazy loading and the two-buffer limit;
- seamless-source configuration with authored loop points;
- exact loop-relative offset capture and resume;
- crossfade ordering and old-buffer release;
- failed initial loads and failed switches;
- stale-load rejection;
- timer Pause independence;
- Break, Touch Grass, alarm, quiet-overtime, and terminal cleanup behavior;
- accessibility and persistence behavior already covered by the current UI.

## Manual Acceptance

No track ships solely because its code and license pass review. The user must
approve every candidate by ear before it enters the repository.

For each approved track, verify:

- ten consecutive loops without an audible seam;
- comfortable loudness relative to every other track;
- no distracting repetition, harsh transients, or abrupt arrangement changes;
- Play/Pause, switching, volume, Break, Touch Grass, and alarm transitions;
- background playback and return;
- native Tauri playback on supported desktop platforms;
- desktop and 360 by 640 popover layouts;
- one continuous 60-minute endurance session before release.

Subjective listening quality is a release requirement, not a deferred polish
task.

## Delivery Sequence

1. Verify the target audio format in the native Tauri application.
2. Build and test the bundled-track engine with a temporary test fixture.
3. Shortlist licensed candidates for one catalog slot at a time.
4. Let the user audition candidates before adding them to the repository.
5. Prepare and document each approved asset.
6. Run automated, native, loop-seam, transition, and endurance validation.
7. Remove the superseded procedural preset implementation after replacement
   coverage is green.
