# Heartwood

A polished, local-first focus workspace: start a focused work session, plant
distracting thoughts without context-switching, continue in flow when the
timer ends, and turn worthwhile planted thoughts into intentional future
focus sessions.

Everything is stored locally — a SQLite database plus a folder of plain
Markdown notes on your own machine. Nothing is uploaded anywhere.

It's built for single-task focus blocks: one task, one timer, one native
window you leave open. It is not a task manager — there's no general
calendar or backlog. Project-scoped task boards (Backlog/To Do/In Progress/Done,
with priority and optional due dates) are available if you want them.
Sessions can optionally be tagged with a Project (grouped under Personal,
Work, or Study) purely for time tracking: see them and their totals from
the Projects view, or a category/project breakdown graph in History. Both
project tagging and task boards are entirely optional and never required
to start or run a session. Use History and Export if you want a record of
what you actually worked on.

For the full build history and what each development phase added, see
[CHANGELOG.md](CHANGELOG.md).

## Get the app

Download a prebuilt installer from the
[latest release](https://github.com/Puck5150/heartwood/releases/latest) —
no Node.js or Rust toolchain required.

| Platform | Architecture | Download |
| --- | --- | --- |
| macOS | Universal (Apple Silicon and Intel) | `.dmg` |
| Windows | x64 | NSIS `.exe` |
| Linux | x64 | AppImage or `.deb` |
| Android | arm64-v8a | `.apk` |

These are beta builds: **unsigned** on macOS and Windows, so your OS will
warn you on first launch (Gatekeeper / SmartScreen) — that's expected, not a
sign of tampering. The Android build is signed with a beta-only key, not a
Play Store identity. Verify the file's SHA-256 against the release's
`SHA256SUMS.txt` before opening it if you want to double-check the download.
Full install steps per platform, backup locations, and current limitations
are in the [beta release notes](docs/beta-release-notes.md); testers
following a structured checklist should use the
[beta testing guide](docs/beta-testing.md) instead.

## Build from source

Only needed if you want to develop the app itself, not just run it. You need
[Node.js](https://nodejs.org/) (20.19.x, 22.12.x, or 24+) and a Rust
toolchain (`rustc`/`cargo`) on your `PATH` — see
[tauri.app](https://v2.tauri.app/start/prerequisites/) for platform-specific
setup if you don't have Rust installed yet.

```bash
git clone https://github.com/Puck5150/heartwood.git
cd heartwood
npm install
```

## Running the app

```bash
npm run tauri:dev
```

This starts the real desktop app with SQLite persistence. On first launch
it creates its own local database and a `notes/` folder under the OS's
standard app-data directory — nothing is created anywhere else on disk.

For a production build (a native installer/binary):

```bash
npm run tauri:build
```

The built app is placed under `src-tauri/target/release/`.

If you just want to poke at the UI without building the Rust shell,
`npm run dev` starts a plain Vite dev server in the browser — it falls back
to an in-memory store, so nothing you do there is saved across a reload.

## Using the app

### Start a focus session

Enter a new task and a duration (1–180 whole minutes), then start — or use
the same duration to start directly from any unresolved thought shown on
the front page. A planted thought is removed from the greenhouse only after
its focus session starts successfully. The timer counts down; pause and
resume at any time.

### Plant distracting thoughts

While focusing, anything that pulls at your attention goes into the
**greenhouse** instead of derailing the session — jot it down and keep
working. Planted thoughts stay tied to the session that captured them, and
carry forward (clearly labeled as "still planted from earlier") into your
next session so nothing gets lost.

### Play flow-state music

Before, during, or after focus, open the music-note menu to choose from seven
bundled instrumental soundscapes, then control Play/Pause and volume without
affecting the timer. You must press Play explicitly; playback remains available
offline, and starting or ending a timer does not interrupt it. Alarms and timed
intermissions temporarily suppress user-requested music, then resume it only
when playback was still user-requested; a manual Pause remains paused through
later timer transitions. Selection and volume persist between launches, but
playback does not survive a full app restart, which begins silent.

### Take notes

Each session has its own Markdown note, autosaved as you type. Switch to
**Preview** to see it rendered; switching back never loses your place.
Notes are stored as plain `.md` files on disk (see [CHANGELOG.md](CHANGELOG.md)
for exactly where and how), so they're readable and portable outside the
app too.

Use **Save checkpoint** any time you want to mark a point in the note you
might want to come back to. The app also automatically snapshots your note
at session boundaries and right before anything destructive (clearing it,
restoring an old version, resolving an external edit conflict) — open
**Revisions** from the note toolbar to browse, compare, rename, or restore
any of these snapshots.

### When the timer ends

Shortly before the planned duration or a later quiet-overtime check-in
(configurable — see Settings below), a small nonblocking prompt appears under
the timer, without interrupting anything you're doing:

- **Continue focusing** — restarts the full planned duration, as many
  times as you like, without losing your place.
- **Take break now** — ends focus early but successfully, and starts a
  break timer. The eventual review shows how much focus time you
  actually accrued.

Ignore the first prompt and it goes away on its own once the timer actually
reaches zero: a short three-tone alarm plays, and the session moves into
**quiet overtime** — the same Flow you'd reach by choosing to keep going, just
reached automatically. The quiet-overtime prompt offers:

- **Stay with it** — dismisses the current check-in, stops any remaining alarm
  repetitions, and keeps the same session in quiet overtime.
- **Take a break** — starts a break timer, preserving the overtime
  already accrued.
- **End session** — ends the session and takes you to the review
  screen, where you can edit your note, wrap up, and either start the
  next session (optionally carrying forward any thoughts still planted)
  or use **Back to start** to return to the idle front page instead.

Quiet overtime keeps counting upward without restarting the session. Each full
planned focus duration creates another check-in until you take a break or end
the session. The selected warning preference can announce the upcoming
check-in; an unacknowledged check-in plays the short alarm sequence and then
returns to quiet overtime.

**Back to start** acknowledges that review as seen — the session, its
note, and any revisions stay exactly as they are and remain fully
reachable from History; only a marker on that one session is recorded, so
relaunching the app afterward opens the idle front page instead of
reopening the same review. If you use Back to start on one session and
never look at another completed session's review, relaunching still
opens idle — only a review you've actually dismissed is skipped.

If the app is in the background or minimized when the timer reaches
zero, it sends a single, silent system notification instead of relying
on you seeing the in-app prompt — notifications are best-effort and
depend on your OS granting permission the first time a session with
warnings enabled starts. **The app does not implement or guarantee
bringing itself to the front when you click a notification.** The
installed notification plugin's desktop backend has no supported way
for the app to observe a notification being clicked — only its mobile
(iOS/Android) backend does. The notification adapter has only ever been
verified against the desktop Tauri backend, so no click-to-focus behavior
is wired up there (verified directly against the plugin's own Rust
source, not just its TypeScript declarations); Android notification
behavior is untested, first-time territory for this beta. Because
the app never receives any signal from a click, whatever your OS does
natively when you click the notification (if anything) is entirely
outside the app's control and may vary by platform; this has not been
independently exercised by clicking a real system notification on
macOS, Windows, or Linux. If a future version of the plugin adds real
desktop support for this, it's worth revisiting.

### History

**View history** is reachable from the workspace rail at any time, and also
as a direct link on the timer itself while a session is running — it never
interrupts or resets the running timer. It shows every completed session —
task, timings, and planted thoughts — and lets you:

- **Export** your data as Markdown or JSON.
- **Open Notes Folder** to browse the raw note files directly.
- **Delete** an individual session, or **Delete all data**, which removes
  every session, planted thought, note, and note revision — your
  preferences (like the selected alarm tone) are kept.

### Settings

Open **Settings** from the workspace rail (available from Focus, History,
and Revisions alike — it never interrupts a running timer) to adjust:

- **Theme** — Sunlit, Cozy, Quiet Natural, Coastal Air, Night Walk, Moon
  Garden, or Graphite.
- **Appearance** — Light, Dark, or System (follows your OS setting live).
- **Timer accent** — Blue, Green, Orange, Red, or Yellow.
- **Focus warning** — how much advance notice the "time's almost up" or next
  check-in prompt gives you: Off, 15 seconds, or 30 seconds (default). Off
  skips only the advance warning and its silent notification; the timer still
  reaches its marker and quiet-overtime check-ins continue.
- **Alarm tone** — pick from the built-in catalog and preview it before
  committing.
- **Music credits** — view the title and creator for each locally bundled
  soundscape. Playback, selection, and volume stay in the music-note menu.

Each choice applies immediately and is remembered between launches
(`themeFamily`, `appearanceMode`, `timerAccent`, `focusWarningLeadMs`, and
`selectedToneId` are the persisted setting keys). If a choice fails to
save, the field shows the last value you picked with an inline **Retry**
rather than silently reverting. "Delete all data" (above) never clears
these preferences.

### Works at any window size

The native app's browser UI is phone-responsive down to a 360×640
viewport; iOS packaging is still a future follow-up. The desktop window
resizes down to 720×560. Greenhouse and Notes are stacked, not
side by side, at every width; on a narrow browser viewport they switch between
tabs instead, to save vertical space — nothing you've typed into either one is
lost when you switch tabs or resize.

## Commands

```bash
npm install         # install dependencies
npm run dev         # start the Vite dev server (frontend only, no Tauri)
npm run check       # type-check (svelte-check + tsc)
npm test            # run the unit test suite (vitest)
npm run build       # production build of the frontend
npm run tauri:dev   # run the desktop app in dev mode (Vite + Tauri)
npm run tauri:build # build the desktop app
```

## Where the logic lives

See [ARCHITECTURE.md](ARCHITECTURE.md) for a file-by-file map of the codebase.
