# Private Desktop Alpha Testing

Use this guide for every alpha candidate before it is shared and while testing
it in normal daily work. Record the exact alpha tag, operating system version,
and downloaded artifact with every result. The build is private, desktop-only,
unsigned, and stores its working data locally.

## Tester Roles

- **Owner:** emphasize daily workflow, reliability, and soundscape quality over
  several days of normal use.
- **Usability tester:** emphasize first-run clarity and ordinary use without
  prior project knowledge.
- **Developer tester:** emphasize recovery, edge cases, packaging, and useful
  technical diagnostics.

Each tester can run the entire checklist. The role descriptions identify where
their attention is most valuable, not separate permission levels.

## Prepare And Back Up

Before an upgrade, deletion test, or external note edit, quit Pomodoro Parking
Lot completely and copy the listed storage roots to a separate location. The
app identifier is `com.pomodoroparkinglot.app`:

```text
macOS (SQLite/config and notes/revisions): ~/Library/Application Support/com.pomodoroparkinglot.app
Windows (SQLite/config and notes/revisions): %APPDATA%\com.pomodoroparkinglot.app
Linux SQLite/config: $XDG_CONFIG_HOME/com.pomodoroparkinglot.app or ~/.config/com.pomodoroparkinglot.app
Linux notes/revisions: $XDG_DATA_HOME/com.pomodoroparkinglot.app or ~/.local/share/com.pomodoroparkinglot.app
```

Linux uses the corresponding `XDG_CONFIG_HOME` or `XDG_DATA_HOME` path when
that variable is set. Its SQLite/config state and notes/revisions live in two
separate roots, so a complete Linux backup requires both. In the app, **Open
Notes Folder** is the authoritative way to locate the current Markdown notes
directory. Copying only that notes directory is not a complete backup.

Before installing:

- [ ] Record the alpha tag, operating system and version, tester role, and
  artifact filename.
- [ ] Compare the artifact's SHA-256 value with its entry in
  `SHA256SUMS.txt`.
- [ ] Quit the app before copying storage. On Linux, back up both the config
  and data roots; on macOS or Windows, back up the single listed root. Confirm
  the copy can be opened at its separate destination.
- [ ] Remove or redact private note and parked-thought content from every log,
  screenshot, export, and issue attachment.

## Installing Unsigned Builds

These instructions use normal operating-system approval paths. Do not disable
Gatekeeper, SmartScreen, or another system-wide security control.

- **macOS:** Open the universal `.dmg`, move the app to Applications, and
  attempt the first launch. If Gatekeeper blocks it, open **System Settings >
  Privacy & Security**, find the message about Pomodoro Parking Lot, and choose
  **Open Anyway**. As a fallback on older macOS versions, use Finder's
  Control-click **Open** path for this app.
- **Windows:** Run the x64 NSIS `.exe`. If SmartScreen appears, verify the
  source and checksum, choose **More info**, then **Run anyway**.
- **Linux:** For the x64 AppImage, run
  `chmod +x <downloaded-file>.AppImage` before launching it. The x64 `.deb` is
  the alternative and can be installed with the system software manager or
  `sudo apt install ./<downloaded-file>.deb`.

## Smoke Checklist

Mark each check as pass, fail, or not applicable in your notes. When a check
fails, stop before destructive follow-up steps if local data may be at risk.

### Installation And Lifecycle

- [ ] Complete a fresh install and first launch on the target operating
  system through the documented unsigned path.
- [ ] Quit normally, relaunch, and confirm expected local state returns.
- [ ] Launch the app a second time and confirm the existing window is shown
  rather than creating a second independent data owner.
- [ ] Upgrade from the previous alpha without losing local data; mark this not
  applicable when no earlier alpha is installed.
- [ ] Observe uninstall behavior and record whether local data remains; do not
  assume or promise that uninstall removes it.

### Timer And Recovery

- [ ] Start focus from a new task and from an unresolved parked thought.
- [ ] Pause and resume focus without changing the task, planned duration, or
  saved work.
- [ ] Choose **Continue focusing** and confirm the same planned duration
  restarts in the same session.
- [ ] Allow focus to enter quiet overtime, dismiss a marker with **Stay with
  it**, and confirm later markers repeat at the planned cadence.
- [ ] Exercise the focus warning at 15 seconds, 30 seconds, and Off; confirm
  Off suppresses the advance warning but not expiry or overtime markers.
- [ ] Let an unacknowledged marker play the alarm sequence, then take a break
  and end a session from the available prompts.
- [ ] Start **Break** and **Touch Grass** intermissions, return early, and let
  each expire into quiet intermission overtime before returning.
- [ ] Quit and relaunch during active, paused, quiet overtime, and intermission
  states; confirm recovery is silent and preserves the correct state.
- [ ] Put the computer to sleep and wake it during active, paused, quiet
  overtime, and intermission states; confirm the timer recovers from elapsed
  wall-clock time without duplicate alarms.
- [ ] Complete a session, inspect its review, use **Back to start**, relaunch,
  and confirm the dismissed review does not reopen.
- [ ] Background or minimize the app near a warning and record whether the
  best-effort silent notification appears; do not treat notification-click
  window behavior as supported.

### Notes, Revisions, History, And Deletion

- [ ] Park thoughts during focus and confirm unresolved thoughts carry forward
  and remain available on the front page.
- [ ] Type Markdown notes, wait for autosave, quit, and reopen the session to
  confirm the exact content returns.
- [ ] Preview Markdown and confirm raw HTML, images, or unsafe links are not
  rendered as trusted content.
- [ ] Create and inspect a checkpoint revision, rename it, restore it, and
  delete revision history while confirming the current note remains.
- [ ] Edit a note externally, return to the app, and exercise both external
  edit conflict choices without silently losing either version.
- [ ] Use **Open Notes Folder** and confirm the expected portable `.md` files
  are present. Treat this in-app action as authoritative for their location.
- [ ] Open History while a timer is running and confirm navigation does not
  stop or reset the timer.
- [ ] Export History as Markdown and JSON and inspect the task, timings, parked
  thoughts, and intermission totals.
- [ ] After making a fresh backup, delete one session and confirm its note and
  revisions are removed while unrelated data remains.
- [ ] After making another fresh backup, use **Delete all data** and confirm
  sessions, parked thoughts, notes, and revisions are removed while
  preferences remain.

### Soundscapes And Tones

- [ ] Play soundscapes before, during, and after focus; starting or ending a
  timer must not unexpectedly stop user-requested playback.
- [ ] Switch every bundled track, adjust volume, and manually pause and resume
  from the music-note control.
- [ ] Confirm alarm and timed-intermission audio suppresses soundscapes, then
  restores playback only when it was still user-requested.
- [ ] Manually pause a soundscape, trigger an alarm or intermission tone, and
  confirm it remains paused afterward.
- [ ] Preview each alarm and return tone in Settings, save selections, relaunch,
  and confirm the chosen tones remain selected.

### Appearance And Accessibility

- [ ] Exercise Light, Dark, and System appearance with every theme family and
  timer accent; confirm text and controls remain legible.
- [ ] Resize the desktop window and inspect narrow responsive layouts without
  overlapping, clipped, or lost controls.
- [ ] Navigate the start, focus, History, Revisions, music, Settings, prompts,
  and confirmations using the keyboard.
- [ ] Confirm keyboard focus remains visible and returns to the invoking
  control after closing Settings or a confirmation.
- [ ] Confirm primary labels, timer state, warnings, failures, and status
  changes are understandable without relying only on appearance, color, or
  sound.

### Feedback

- [ ] Record concise reproduction steps, expected behavior, actual behavior,
  and whether any timer, note, parked thought, preference, or other local data
  was lost or changed.
- [ ] Classify the result as blocker, non-blocking defect, usability friction,
  or feature request.
- [ ] Reproduce a defect once when doing so cannot risk more data, and record
  whether it happens consistently.
- [ ] Submit the **Alpha defect** issue form, or send the same fields privately
  to the owner when repository access is unavailable.
- [ ] Attach only sanitized logs or screenshots and confirm private note and
  parked-thought content has been removed or redacted.

## Severity And Release Gates

A **blocker** is data loss or corruption, broken timer/session recovery, a
crash in a core workflow, an installer that cannot launch through the
documented unsigned path, an inaccessible core control, or a missing supported
artifact. Stop distribution and report it immediately.

Cosmetic defects, low-impact friction, and feature requests belong in the
alpha backlog unless they prevent practical use. A replacement build receives
a new alpha number; published alpha assets are not silently replaced.

## Reporting A Defect

Use the repository's **Alpha defect** issue form. Include the exact alpha tag,
operating system and version, artifact, numbered reproduction steps, expected
and actual behavior, and local-data impact. Logs and screenshots are optional
and must be sanitized. If the tester cannot access the private repository,
send those same fields to the owner so the owner can file the report without
including private content.
