# Seamless Soundscape Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every bundled soundscape a verified pure-loop boundary, including an original restrained half-time drum-and-bass treatment for Slow Pulse and track-specific repairs for Deep Focus, Lo-Fi Hip Hop, Quiet Piano, and Still Air.

**Architecture:** Audit all seven tracks and prepare auditions outside the repository before changing canonical assets. Commit one reproducible Python/FFmpeg preparation script for the five tracks requiring repair, retain the already-clean Organic Drift and Rain Room files, update exact catalog durations and checksums, and extend asset tests to enforce the pure-loop format contract while preserving the existing 1.2-second selection crossfade.

**Tech Stack:** Python 3 with NumPy, FFmpeg/ffprobe, 16-bit PCM WAV at 44.1 kHz, TypeScript 6, Vitest, Svelte 5, Web Audio.

## Global Constraints

- Do not replace a canonical asset until the user approves its audition by ear.
- Keep exactly seven bundled soundscapes. Repair Slow Pulse, Deep Focus, Lo-Fi Hip Hop, Quiet Piano, and Still Air; retain Organic Drift and Rain Room byte-for-byte after their boundaries pass the full-library audit.
- Canonical files are pure loops from sample zero through their complete decoded duration, with no recurring global fade-in or fade-out.
- Preserve the existing 1.2-second GUI crossfade between different soundscape selections.
- Slow Pulse uses an original 74 BPM perceived pulse on a 148 BPM subdivision grid and exactly 88 four-beat bars, yielding 142.702703 seconds before sample rounding.
- Slow Pulse uses a low G1 foundation, restrained D2/E2 movement, a rounded kick, soft half-time backbeat, quiet shuffled hats, and sparse ghost percussion. It must not copy the Greenred reference recording, composition, or arrangement.
- Deep Focus keeps its approved mix, pitch, and arrangement; only its repeating boundary changes.
- Lo-Fi Hip Hop uses its approved 72-second, 24-bar region at 80 BPM with a three-second matching-phase overlap.
- Quiet Piano uses an eight-second wrapped overlap to remove the source outro fade without changing its approved mix.
- Still Air uses a one-second wrapped overlap to remove its compressed source discontinuity while preserving the authored ambient loop.
- Canonical output remains 16-bit PCM WAV at 44.1 kHz, between 60 and 150 seconds, near -23 LUFS, and no higher than -2 dBFS true peak.
- Source attribution and licensing remain unchanged when only preparation changes.

---

### Task 1: Render And Approve External Auditions

**Files:**
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/render-loop-auditions.py`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/slow-pulse-74bpm-dnb-audition.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/slow-pulse-74bpm-dnb-seam.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/deep-focus-clean-loop-audition.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/deep-focus-clean-loop-seam.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/library-loop-repairs/lofi-hip-hop-clean-loop-audition.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/library-loop-repairs/lofi-hip-hop-clean-loop-seam.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/library-loop-repairs/quiet-piano-clean-loop-audition.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/library-loop-repairs/quiet-piano-clean-loop-seam.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/library-loop-repairs/still-air-clean-loop-audition.wav`
- Create outside Git: `/private/tmp/pomodoro-soundscape-candidates/library-loop-repairs/still-air-clean-loop-seam.wav`

**Interfaces:**
- Consumes: `slow-pulse-safe-space-loop.wav` and `deep-focus-source.wav` from the approved candidate workspace.
- Produces: five full-length pure-loop candidates and five end-to-start seam excerpts for listening approval, plus audit evidence that Organic Drift and Rain Room require no replacement.

- [ ] **Step 1: Implement deterministic PCM helpers in the external audition script**

Define `read_pcm16(path: Path) -> tuple[np.ndarray, int]`,
`write_pcm16(path: Path, audio: np.ndarray, sample_rate: int) -> None`,
`equal_power_wrapped_loop(audio: np.ndarray, overlap_frames: int) -> np.ndarray`,
`synthesize_slow_pulse(frames: int, sample_rate: int) -> np.ndarray`, and
`seam_excerpt(audio: np.ndarray, sample_rate: int, before: float = 8.0,
after: float = 12.0) -> np.ndarray`.

For a source with `L` frames and overlap `d`, `equal_power_wrapped_loop`
returns `L - d` frames. Set `output[:d]` to
`audio[L-d:L] * cos(theta) + audio[:d] * sin(theta)`, where `theta` advances
from zero toward `pi/2`. Set `output[d:]` to `audio[d:L-d]`. This makes the
last output frame immediately precede the source frame represented at the
first output frame, while the overlap transitions smoothly into source frame
`d` inside the file.

- [ ] **Step 2: Render the Slow Pulse candidate**

Use FFmpeg `atempo=1.024956606` to fit the complete 148.313991-second
approved source to approximately 144.702703 seconds without changing pitch.
Apply `equal_power_wrapped_loop` with the exact difference between that result
and `6_293_189` frames, producing a seamless musical bed of exactly
142.702703 seconds. This retains approximately two seconds of wrapped overlap
instead of trimming into the end of the composition. Generate an original
two-bar rhythmic pattern that repeats for 44 cycles:

```text
148 BPM grid, 4/4
bar 1: kick 1; ghost kick 2-and-a; backbeat 3; quiet hats on shuffled eighths
bar 2: kick 1; soft kick 3-and; backbeat 3; quiet hats on shuffled eighths
sub: G1 on bar 1, G1/D2 movement on bar 2, E2 used only as a quiet four-bar turnaround
```

Synthesize the kick as a short sine sweep from 82 Hz to 46 Hz, the backbeat from filtered deterministic noise plus a quiet 185 Hz body, and hats from high-passed deterministic noise with alternating velocity. Keep the rhythm approximately 8 dB below the musical bed before final normalization. Render the full candidate and a seam excerpt containing its final 8 seconds followed by its first 12 seconds.

- [ ] **Step 3: Render the Deep Focus candidate**

Apply `equal_power_wrapped_loop` with a `352_800`-frame (8-second) overlap to
the 5,294,592-frame lossless PCM conversion of the approved source, producing
exactly 4,941,792 frames. Do not alter pitch, equalization, arrangement, or
relative stereo level. Normalize only after boundary preparation, then render
the full candidate and its final-8/first-12-second seam excerpt.

- [ ] **Step 4: Render and measure the remaining library repairs**

Render Lo-Fi Hip Hop from a 72-second region beginning 6.8 seconds into the
source plus a three-second wrapped overlap. Render Quiet Piano with an
eight-second wrapped overlap and Still Air with a one-second wrapped overlap.
Create final-8/first-12-second seam excerpts for all three before measurement.

Run:

```bash
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration -of json /private/tmp/pomodoro-soundscape-candidates/slow-pulse-74bpm-dnb-audition.wav
ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_sample,channels -show_entries format=duration -of json /private/tmp/pomodoro-soundscape-candidates/deep-focus-clean-loop-audition.wav
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/slow-pulse-74bpm-dnb-audition.wav -af loudnorm=I=-23:LRA=7:TP=-2:print_format=json -f null -
ffmpeg -i /private/tmp/pomodoro-soundscape-candidates/deep-focus-clean-loop-audition.wav -af loudnorm=I=-23:LRA=7:TP=-2:print_format=json -f null -
```

Expected: PCM signed 16-bit, 44.1 kHz; Slow Pulse is 142.702698 seconds; Deep Focus is 112.058776 seconds; Lo-Fi Hip Hop is 72 seconds; Quiet Piano is 123.72 seconds; Still Air is 135.974331 seconds; measured loudness is near -23 LUFS and true peak does not exceed -2 dBFS.

- [ ] **Step 5: Obtain listening approval**

Present the full Slow Pulse candidate and seam excerpts for all seven tracks. Do not continue to Task 2 until the user approves the Slow Pulse groove, the five repaired end-to-start transitions, and the two unchanged authored loops.

---

### Task 2: Add Reproducible Loop Preparation

**Files:**
- Create: `scripts/prepare_soundscape_loops.py`
- Create: `scripts/test_prepare_soundscape_loops.py`
- Create: `scripts/requirements-soundscapes.txt`

**Interfaces:**
- Consumes: source paths supplied through `--slow-pulse-source`, `--deep-focus-source`, `--lofi-hip-hop-source`, `--quiet-piano-source`, and `--still-air-source` plus `--output-directory`.
- Produces: five deterministic canonical candidates using the exact approved Task 1 treatments.

- [ ] **Step 1: Write failing tests for sample counts and wrapped boundaries**

Create small synthetic PCM fixtures and assert:

```python
assert slow_pulse_frame_count(44100) == round(88 * 4 * 60 / 148 * 44100)
assert len(equal_power_wrapped_loop(source, 8000)) == len(source) - 8000
assert np.max(np.abs(looped[:8000])) > 0
assert pcm_format(output) == {
    "sample_rate": 44100,
    "bits_per_sample": 16,
    "channels": 2,
    "frames": 2,
}
```

Also call `synthesize_slow_pulse` twice for the same short frame count and
assert byte-identical arrays, proving that the fixed seed controls every noise
layer without requiring the licensed source files in the unit test.

- [ ] **Step 2: Run tests and verify the intended failure**

Run:

```bash
python3 -m unittest discover -s scripts -p 'test_prepare_soundscape_loops.py'
```

Expected: FAIL because `scripts/prepare_soundscape_loops.py` does not exist.

- [ ] **Step 3: Implement the approved preparation script**

Move the approved deterministic PCM, synthesis, time-fit, equal-power wrapping, normalization, and encoding behavior from the external audition script into `scripts/prepare_soundscape_loops.py`. Accept only explicit source and output paths, refuse to overwrite without `--force`, use a fixed random seed of `5150` for percussion noise, and print duration, sample rate, channel count, integrated loudness, true peak, and SHA-256 for each output.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
python3 -m unittest discover -s scripts -p 'test_prepare_soundscape_loops.py'
```

Expected: PASS with deterministic frame counts, format, wrapping, and hashes.

- [ ] **Step 5: Commit the reproducible preparation tooling**

```bash
git add scripts/prepare_soundscape_loops.py scripts/test_prepare_soundscape_loops.py scripts/requirements-soundscapes.txt
git commit -m "build: make soundscape loop preparation reproducible"
```

---

### Task 3: Replace Approved Assets And Lock Their Metadata

**Files:**
- Replace: `public/audio/soundscapes/slow-pulse.wav`
- Replace: `public/audio/soundscapes/deep-focus.wav`
- Replace: `public/audio/soundscapes/lofi-hip-hop.wav`
- Replace: `public/audio/soundscapes/quiet-piano.wav`
- Replace: `public/audio/soundscapes/still-air.wav`
- Modify: `src/lib/soundscapeCatalog.ts`
- Modify: `src/lib/soundscapeAssets.test.ts`
- Modify: `docs/licenses/soundscapes.md`

**Interfaces:**
- Consumes: user-approved outputs from Task 2.
- Produces: canonical pure-loop assets with catalog and license-ledger metadata that match the files exactly.

- [ ] **Step 1: Write failing WAV contract tests**

Extend `src/lib/soundscapeAssets.test.ts` with a local RIFF parser that reads
`fmt ` and `data` chunks. For every catalog asset, assert `audioFormat === 1`,
`bitsPerSample === 16`, `sampleRate === 44100`, decoded duration differs from
`loopEndSeconds` by no more than one sample, and the RMS of both the first and
last 100 ms exceeds `1e-5`. Add approved frame-count assertions for all seven
files: Deep Focus 4,941,792; Lo-Fi Hip Hop 3,175,200; Quiet Piano 5,456,052;
Organic Drift 2,822,400; Still Air 5,996,468; Rain Room 3,969,000; and Slow
Pulse 6,293,189. This makes the test fail against every old boundary before
replacement.

- [ ] **Step 2: Run the asset test and verify failure**

Run:

```bash
npm test -- --run src/lib/soundscapeAssets.test.ts
```

Expected: FAIL because the five repaired assets still use their old metadata and boundaries.

- [ ] **Step 3: Install the approved files and metadata**

Run the preparation script with the five approved sources and `--force` into
`public/audio/soundscapes`. Keep every catalog `loopStartSeconds` value at `0`,
set the five repaired durations and loop ends from their exact sample counts,
and update only those five preparation descriptions and canonical SHA-256
values in `docs/licenses/soundscapes.md`.

- [ ] **Step 4: Run focused asset and playback tests**

Run:

```bash
npm test -- --run src/lib/soundscapeAssets.test.ts src/lib/soundscapeCatalog.test.ts src/lib/soundscapeTrackLoader.test.ts src/lib/soundscapeEngine.test.ts src/lib/soundscapeController.test.ts
```

Expected: PASS with the existing selection crossfade, buffer cache, and offset-resume behavior unchanged.

- [ ] **Step 5: Commit the approved assets and metadata**

```bash
git add public/audio/soundscapes/slow-pulse.wav public/audio/soundscapes/deep-focus.wav public/audio/soundscapes/lofi-hip-hop.wav public/audio/soundscapes/quiet-piano.wav public/audio/soundscapes/still-air.wav src/lib/soundscapeCatalog.ts src/lib/soundscapeAssets.test.ts docs/licenses/soundscapes.md
git commit -m "assets: refine bundled soundscape loops"
```

---

### Task 4: Verify The Integrated Application

**Files:**
- Verify only: all files changed in Tasks 2 and 3.

**Interfaces:**
- Consumes: the integrated branch.
- Produces: fresh automated and listening evidence for PR review.

- [ ] **Step 1: Run the complete project checks**

```bash
npm run check
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check origin/main...HEAD
```

Expected: every command exits 0 without new warnings.

- [ ] **Step 2: Verify runtime behavior**

Launch the Tauri application. Cycle through all seven tracks and confirm the existing GUI transition remains smooth. Pause the timer while music continues, enter and return from an intermission while exact offset resumes, and confirm completion alarms suppress then restore eligible focus playback.

- [ ] **Step 3: Complete the loop listening gate**

Listen through ten consecutive loops of all seven tracks. Confirm no recurring fade, silence, click, doubled attack, tempo stumble, density jump, or bass phase jump appears at the boundary and that the first cycle matches later cycles in apparent level.

- [ ] **Step 4: Inspect and push the reviewed branch**

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
git push origin codex/phase-5d-local-soundscapes
```

Expected: only intentional Phase 5D files are changed and PR #16 updates successfully.
