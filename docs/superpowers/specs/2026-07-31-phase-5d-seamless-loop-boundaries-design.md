# Phase 5D: Seamless Loop Boundaries

**Status:** Approved design
**Date:** 2026-07-31
**Depends on:** [Phase 5D bundled soundscape redesign](2026-07-31-phase-5d-bundled-soundscape-redesign-design.md)

## Objective

Make every bundled soundscape repeat continuously without replaying a fade,
dropping into silence, clicking, or producing an obvious musical restart. Keep
the existing smooth crossfade when the user selects a different soundscape.

## Playback Contract

Each canonical WAV is a pure loop. Its first sample is the authored loop start,
and its end reconnects directly to that start. The file contains no global
fade-in or fade-out that would be heard on every cycle.

The Web Audio source continues to loop the canonical file from offset zero to
its measured duration. Initial Play begins at offset zero. Break, Touch Grass,
and alarm suppression continue to capture and restore the exact loop-relative
offset. No runtime fade or overlapping source is added at ordinary loop
boundaries.

The existing 1.2-second crossfade applies only when changing from one selected
soundscape to another. It remains independent from continuous playback of one
track.

## Asset Authoring

Use the least invasive boundary treatment appropriate for each track:

- For rhythmic or clearly metered music, select matching bar boundaries and
  cut on compatible downbeats. Do not overlap kicks, backbeats, or melodic
  attacks merely to conceal a poor cut.
- For ambient, sustained, rain, or noise-based material, select compatible
  texture boundaries. When an exact cut still clicks or changes density, bake
  a short equal-power wrapped overlap into the canonical file.
- Preserve the approved mix, pitch, arrangement, and overall listening level.
  Boundary work must not become a remix.
- Keep each canonical file between 60 and 150 seconds, as 16-bit PCM WAV at
  44.1 kHz, normalized near -23 LUFS with true peak no higher than -2 dBFS.

The catalog continues to store explicit loop points. For these pure-loop files,
`loopStartSeconds` remains zero and `loopEndSeconds` matches the exact prepared
duration. Any changed duration and checksum must be updated together with the
asset and license ledger.

## Slow Pulse Groove

The passage supplied as a Greenred Productions mood reference measures at
approximately 73.8 BPM. Slow Pulse uses an original 74 BPM perceived pulse on
a 148 BPM subdivision grid, producing a restrained half-time drum-and-bass
feel without copying the reference recording, composition, or arrangement.

The original rhythm uses a deep rounded kick, a soft half-time backbeat, quiet
shuffled hats and ghost percussion, and restrained warm sub-bass movement. The
drums must be clearly audible beneath the musical bed without becoming frantic,
harsh, ominous, or attention-seeking. Avoid rapid breakbeat fills, bright
cymbals, aggressive bass modulation, and recognizable sampled breaks.

Author the track as exactly 88 four-beat bars at 148 BPM, approximately 142.7
seconds. The final beat, bass phase, and musical bed must all reconnect on the
same downbeat. This groove direction remains provisional until the user accepts
the rendered audition by ear.

## Preparation Workflow

Work from the approved source or latest approved pre-loop master, not from a
lossy preview. Prepare candidate boundaries outside the repository. For each
track, create a short seam audition containing the end followed immediately by
the beginning so the transition can be judged without waiting through the full
track.

Replace a canonical asset only after its seam audition is accepted. Re-run
format, duration, loudness, peak, and checksum measurements after replacement.
Do not alter source/license attribution when only the preparation changes.
Slow Pulse additionally requires approval of the complete drum-and-bass groove,
not merely its isolated boundary.

## Verification

Automated checks must confirm:

- exactly seven canonical soundscape files remain packaged;
- catalog loop points stay within the decoded duration;
- no silence is introduced at a boundary;
- preparation metadata and SHA-256 values match the committed files;
- existing lazy loading, two-buffer caching, offset resume, lifecycle cleanup,
  and selection-crossfade tests remain green.

Listening acceptance is required for each track:

- audition the isolated end-to-start transition;
- listen through at least ten consecutive loops without a gap, fade, click,
  rhythmic stumble, doubled attack, or sudden texture change;
- confirm the first cycle and later cycles have the same apparent level;
- switch between tracks and confirm the existing GUI crossfade remains smooth;
- pause for an intermission near a boundary, return, and confirm exact-offset
  playback remains coherent.

## Non-Goals

- Runtime crossfading at every loop boundary.
- A one-time intro followed by a separate internal loop region.
- Changing the seven-track catalog, UI, selection crossfade duration, or
  playback controls.
- Re-composing, replacing, or broadly remixing an approved track while fixing
  its boundary.
