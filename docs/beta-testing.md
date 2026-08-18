# Beta Testing

Use this guide for every beta candidate before it is shared and while testing
it in normal daily work. Record the exact beta tag, operating system version,
and downloaded artifact with every result. The build covers desktop and
Android, is unsigned (Android carries a beta-only signing key, not a Play
Store identity), and stores its working data locally.

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

Before an upgrade, deletion test, or external note edit on desktop, quit
Heartwood completely and copy the listed storage roots to a separate location.
The app identifier is `com.heartwood.app`:

```text
macOS (SQLite/config and notes/revisions): ~/Library/Application Support/com.heartwood.app
Windows (SQLite/config and notes/revisions): %APPDATA%\com.heartwood.app
Linux SQLite/config: $XDG_CONFIG_HOME/com.heartwood.app or ~/.config/com.heartwood.app
Linux notes/revisions: $XDG_DATA_HOME/com.heartwood.app or ~/.local/share/com.heartwood.app
```

Linux uses the corresponding `XDG_CONFIG_HOME` or `XDG_DATA_HOME` path when
that variable is set. Its SQLite/config state and notes/revisions live in two
separate roots, so a complete Linux backup requires both. In the app, **Open
Notes Folder** is the authoritative way to locate the current Markdown notes
directory on desktop. Copying only that notes directory is not a complete
backup. Android's app-private storage has no equivalent manual backup path on
an unrooted device — treat Android test data as disposable for this beta.

Before installing:

- [ ] Record the beta tag, operating system and version, tester role, and
  artifact filename.
- [ ] Compare the artifact's SHA-256 value with its entry in
  `SHA256SUMS.txt`.
- [ ] Quit the app before copying desktop storage. On Linux, back up both the
  config and data roots; on macOS or Windows, back up the single listed root.
  Confirm the copy can be opened at its separate destination.
- [ ] Remove or redact private note and parked-thought content from every log,
  screenshot, export, and issue attachment.

## Installing Unsigned Builds

These instructions use normal operating-system approval paths. Do not disable
Gatekeeper, SmartScreen, or another system-wide security control.

- **macOS:** Open the universal `.dmg`, move the app to Applications, and
  attempt the first launch. If Gatekeeper blocks it, open **System Settings >
  Privacy & Security**, find the message about Heartwood, and choose
  **Open Anyway**. As a fallback on older macOS versions, use Finder's
  Control-click **Open** path for this app.
- **Windows:** Run the x64 NSIS `.exe`. If SmartScreen appears, verify the
  source and checksum, choose **More info**, then **Run anyway**.
- **Linux:** For the x64 AppImage, run
  `chmod +x <downloaded-file>.AppImage` before launching it. The x64 `.deb` is
  the alternative and can be installed with the system software manager or
  `sudo apt install ./<downloaded-file>.deb`.
- **Android:** Download the `.apk` to the device, tap it, allow "install
  unknown apps" for the app that opened it (browser or file manager) when
  prompted, then Install.

## What's New in This Beta

- Heartwood now runs on Android (arm64-v8a) alongside the existing desktop
  platforms, installed by sideloading a signed APK.
- Desktop continues to check for updates automatically a few seconds after
  launch; Android has no update channel yet — redownload for each new beta.

## Smoke Checklist

Mark each check as pass, fail, or not applicable in your notes. When a check
fails, stop before destructive follow-up steps if local data may be at risk.

### Installation And Lifecycle

- [ ] Complete a fresh install and first launch on the target operating
  system through the documented unsigned/sideload path.
- [ ] Quit normally, relaunch, and confirm expected local state returns.
- [ ] Launch the app a second time and confirm the existing window is shown
  rather than creating a second independent data owner (desktop only).
- [ ] Upgrade from the previous beta without losing local data; mark this not
  applicable when no earlier beta is installed. On Android, confirm installing
  the new APK over the old one is accepted as an upgrade, not a signature
  conflict (this proves the signing key stayed consistent between betas).
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
- [ ] On desktop, put the computer to sleep and wake it during active, paused,
  quiet overtime, and intermission states; confirm the timer recovers from
  elapsed wall-clock time without duplicate alarms.
- [ ] On Android, background the app (switch to another app or the home
  screen) during active, paused, quiet overtime, and intermission states,
  then return; confirm the same deadline-based recovery holds even though
  Android can suspend backgrounded apps more aggressively than a desktop OS.
- [ ] Complete a session, inspect its review, use **Back to start**, relaunch,
  and confirm the dismissed review does not reopen.
- [ ] Background or minimize the app near a warning and record whether the
  best-effort silent notification appears; do not treat notification-click
  window behavior as supported on any platform, including Android.
- [ ] On Android specifically, treat every notification observation as
  first-time territory, not a regression check — `ARCHITECTURE.md` already
  documents that the notification adapter was verified only against the
  desktop Tauri backend before this beta.

### Notes, Revisions, History, And Deletion

- [ ] Plant thoughts during focus and confirm unresolved thoughts carry forward
  and remain available on the front page.
- [ ] Type Markdown notes, wait for autosave, quit, and reopen the session to
  confirm the exact content returns.
- [ ] Preview Markdown and confirm raw HTML, images, or unsafe links are not
  rendered as trusted content.
- [ ] Create and inspect a checkpoint revision, rename it, restore it, and
  delete revision history while confirming the current note remains.
- [ ] Edit a note externally, return to the app, and exercise both external
  edit conflict choices without silently losing either version. (Desktop
  only — Android's sandboxed storage has no external-edit path to test.)
- [ ] Use **Open Notes Folder** and confirm the expected portable `.md` files
  are present on desktop. Treat this in-app action as authoritative for their
  location.
- [ ] Open History while a timer is running and confirm navigation does not
  stop or reset the timer. On the task board (Projects), confirm the
  Backlog/To Do/In Progress/Done columns stack full-width on a phone screen
  rather than squeezing four abreast, and that a task's Status can be changed
  from its edit dialog without needing drag-and-drop.
- [ ] Export History as Markdown and JSON and inspect the task, timings, parked
  thoughts, and intermission totals.
- [ ] After making a fresh backup (desktop) or accepting Android data is
  disposable, delete one session and confirm its note and revisions are
  removed while unrelated data remains.
- [ ] After making another fresh backup (desktop) or accepting Android data is
  disposable, use **Delete all data** and confirm sessions, planted thoughts,
  notes, and revisions are removed while preferences remain.

### Soundscapes And Tones

- [ ] Play soundscapes before, during, and after focus; starting or ending a
  timer must not unexpectedly stop user-requested playback.
- [ ] Switch every bundled track, adjust volume, and manually pause and resume
  from the music-note control. On the phone-width nav bar, confirm the Music
  control's active/playing state uses the same visual treatment as every
  other tab rather than a different color.
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
  overlapping, clipped, or lost controls. On Android, confirm the same on a
  real phone screen — specifically that the History screen's **Delete**
  action and **+ Project** pill never overlap.
- [ ] Navigate the start, focus, History, Revisions, music, Settings, prompts,
  and confirmations using the keyboard (desktop) or touch (Android — every
  control reachable this way, nothing requiring a mouse-only interaction like
  drag-and-drop).
- [ ] Confirm keyboard focus remains visible and returns to the invoking
  control after closing Settings or a confirmation (desktop).
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
- [ ] Submit the **Beta defect** issue form, or send the same fields privately
  to the owner when repository access is unavailable.
- [ ] Attach only sanitized logs or screenshots and confirm private note and
  parked-thought content has been removed or redacted. On Android, pull
  relevant lines from `adb logcat` rather than a desktop log path.

## Severity And Release Gates

A **blocker** is data loss or corruption, broken timer/session recovery, a
crash in a core workflow, an installer that cannot launch through the
documented unsigned/sideload path, an inaccessible core control, or a missing
supported artifact — including a missing or broken Android build. Stop
distribution and report it immediately.

Cosmetic defects, low-impact friction, and feature requests belong in the
beta backlog unless they prevent practical use. A replacement build receives
a new beta number; published beta assets are not silently replaced.

## Reporting A Defect

Use the repository's **Beta defect** issue form. Include the exact beta tag,
operating system and version, artifact, numbered reproduction steps, expected
and actual behavior, and local-data impact. Logs and screenshots are optional
and must be sanitized. If the tester does not have a GitHub account,
send those same fields to the owner so the owner can file the report without
including private content.
