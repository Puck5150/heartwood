# Global Soundscape Playback Design

## Purpose

Flow-state music must be available before a timer starts so a user can choose a soundscape, set its volume, and establish the mood before beginning focus. Playback is a user-controlled app capability, not a child of a timer session.

## Approved Behavior

- The music-note control is visible in every workspace and session state, including the idle start screen and Session Review.
- A user can select, play, pause, and adjust a soundscape without an active timer.
- Music that is playing before focus starts continues without restarting when the timer begins.
- Starting, pausing, resuming, finishing, or reviewing a timer session does not independently start or stop music.
- Break and Touch Grass intermissions temporarily suppress music, preserving its loop position, and resume it afterward if the user had been playing it.
- Completion and overtime alarms temporarily suppress music before the first tone and resume it after the alarm sequence finishes.
- Manual Pause remains authoritative: automatic lifecycle changes never restart music the user paused.
- Selection and volume persistence keep their existing behavior. Playback state remains runtime-only and starts idle after a full app restart.

## Architecture

`SoundscapePopover` remains the single music UI. `App.svelte` renders it unconditionally once settings and the soundscape controller are ready, passing only temporary suppression context rather than using timer status to decide whether the player exists.

`soundscapeController` owns playback intent independently from `SessionState`. It tracks whether the user requested playback and the active track, while `syncLifecycle` supplies only suppression signals such as an alarm or intermission. Timer session identifiers must not create, clear, or rebind playback intent.

The existing audio engine remains unchanged. It continues to own loop offsets, source suspension, resumption, crossfades, and cleanup.

## State Transitions

1. On idle Play, the controller lazily creates the audio engine and selected track, then plays at the saved volume.
2. When focus starts or ends, the controller receives a new lifecycle snapshot but keeps the same track and playback position.
3. When an alarm or intermission starts, the controller fades the master gain to zero and suspends the track.
4. When suppression ends, the controller resumes only when user playback intent is still active.
5. Manual Pause clears playback intent and suspends the track. Later timer transitions cannot resume it.
6. App teardown disposes the controller and audio engine as it does today.

## Failure Handling

Existing best-effort behavior remains: load and playback failures surface in the popover without affecting the timer. A failed preset switch keeps the prior track when possible. Suppression and disposal continue to invalidate stale asynchronous work.

## Testing

Focused tests must demonstrate that:

- the music control renders on the idle start screen;
- idle Play loads and plays the selected track;
- playback survives idle-to-focus and focus-to-review transitions without recreating the track;
- intermission and alarm suppression still suspend and resume the same offset;
- manual Pause is not reversed by timer lifecycle changes;
- existing selection, volume, error, cancellation, and accessibility behavior remains intact.

Fresh completion checks are `npm run check`, `npm test`, `npm run build`, and proportionate native Tauri verification of idle playback carrying into a timer.

## Out of Scope

- Persisting active playback across app restarts.
- Starting music automatically when a timer starts.
- Separate music preferences per session or workspace.
- Changing the bundled soundscape catalog or audio files.
