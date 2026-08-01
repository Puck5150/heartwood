# Private Desktop Alpha Release Design

**Status:** Approved design
**Date:** 2026-08-01

## Purpose

Prepare Pomodoro Parking Lot for a small, private desktop alpha without adding
new product features. The alpha will be used primarily by the owner, with
possible participation from the owner's wife and a developer friend. Its goal
is to find data-safety, recovery, packaging, and usability problems under real
daily use before beta work begins.

The alpha is desktop-only. A private iOS and Android beta remains a separate
future workstream after the desktop alpha is stable.

## Release Boundary

The first alpha is `v0.1.0-alpha.1`. The version must agree across the
JavaScript package, Tauri configuration, and Rust package metadata.

The supported artifact matrix is:

| Platform | Architecture | Alpha artifacts |
| --- | --- | --- |
| macOS | Universal Apple Silicon and Intel | `.dmg` |
| Windows | x86-64 | NSIS `.exe` |
| Linux | x86-64 | AppImage and `.deb` |

Artifacts are intentionally unsigned during the private alpha. The project
must not add placeholder signing values, dummy certificates, or configuration
that implies the packages are trusted. Signing, macOS notarization, and public
distribution are deferred release-infrastructure work.

## Delivery Approaches Considered

### 1. Automated GitHub prereleases (selected)

GitHub-hosted macOS, Windows, and Linux runners validate and build their native
packages. One workflow publishes the complete matrix to an immutable GitHub
prerelease. This is repeatable and does not require maintaining three local
build machines.

### 2. Manual native builds

Each installer is built on a physical or virtual machine for its operating
system. This avoids release automation but creates inconsistent environments
and makes every alpha revision expensive to reproduce.

### 3. Hybrid validation and packaging

GitHub Actions validates source while native packages are built manually. This
is a useful fallback for diagnosing a platform-specific packaging failure, but
it is not the normal release path because it leaves more room for release
mistakes.

## GitHub Actions Architecture

The repository will have separate validation and alpha-release concerns.

### Validation

Pull requests and ordinary pushes run visible checks but never publish a
release. Validation covers:

- `npm run check`
- `npm test`
- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`

The current private repository cannot enforce protected-branch checks on its
GitHub plan. A green validation run is therefore a documented human release
gate rather than a server-enforced merge rule.

### Alpha release

Only an explicit tag matching the alpha tag convention, such as
`v0.1.0-alpha.1`, starts packaging. The release pipeline:

1. Verifies that the tag and every application version source agree.
2. Runs the complete validation job.
3. Builds each native artifact only after validation succeeds.
4. Uploads platform outputs as workflow artifacts with unambiguous names.
5. Collects the agreed complete platform set in one release job.
6. Generates SHA-256 checksums for the distributed files.
7. Publishes a GitHub prerelease with install guidance and known limitations.

An ordinary push, pull request, workflow rerun without an alpha tag, or partial
platform build must never publish a complete alpha release.

The macOS job installs both Rust targets needed for a universal build. Windows
and Linux use their native GitHub-hosted runners. Dependencies are installed
from the committed lockfiles, and action versions are pinned to stable major
releases or immutable revisions according to repository convention.

## Release Integrity And Failure Handling

Alpha releases are immutable. A defective `alpha.1` is followed by `alpha.2`;
its files are not silently replaced. This keeps feedback, checksums, commits,
and binaries tied to one identity.

A failed build on any supported platform prevents the release from being
presented to testers as complete. Successful intermediate workflow artifacts
may remain available to the developer for diagnosis, but the tester-facing
release must contain the full agreed matrix.

The workflow uses least-privilege GitHub permissions. Validation jobs require
read access only. The release job alone receives the permission needed to
create release assets, and only in the tag-triggered release path. No secrets
are required for the unsigned alpha.

## Tester Distribution

The GitHub prerelease is the source of truth. A tester with repository access
can download the artifact directly. Because the repository is private, the
owner may instead download an artifact and transfer it privately to a tester
who does not have GitHub repository access.

Each prerelease includes:

- A plain description of the private alpha and its version.
- A platform-to-download mapping.
- SHA-256 checksums.
- Unsigned-install instructions.
- Application-data and Markdown-note locations.
- Backup guidance before destructive testing.
- Known limitations and deferred work.
- Feedback and defect-reporting instructions.

Unsigned guidance should use normal operating-system UI where possible:

- macOS explains the expected Gatekeeper warning and the supported
  right-click/Open or Privacy & Security approval path.
- Windows explains the expected SmartScreen warning and the More info/Run
  anyway path.
- Linux explains AppImage executable permission and the `.deb` alternative.

The guide must not tell testers to broadly disable platform security controls.

## Feedback Model

The repository will provide a structured alpha-defect issue form requesting:

- Alpha version
- Operating system and version
- Installation artifact used
- Reproduction steps
- Expected and actual behavior
- Whether a timer, note, parked thought, preference, or other local data was
  lost or changed
- Optional logs and screenshots

The form reminds testers to remove private note and parked-thought content from
attachments. A tester without repository access can send the same fields to
the owner, who can file the issue without exposing private content.

Tester emphasis is intentionally different:

- The owner exercises daily workflow, reliability, and soundscape quality.
- The owner's wife emphasizes first-run clarity and usability without project
  knowledge.
- The developer friend emphasizes recovery, edge cases, packaging, and
  technical diagnostics.

## Alpha Test Checklist

Every candidate receives a release smoke pass before distribution:

### Installation and lifecycle

- Fresh install and first launch on each supported operating system.
- Normal quit and relaunch.
- Upgrade from the previous alpha without losing local data.
- Uninstall behavior is observed and documented without promising that local
  user data is automatically removed.

### Timer and recovery

- Start from a new task and from an unresolved parked thought.
- Pause, resume, restart the focus duration, and enter quiet overtime.
- Take Break and Touch Grass intermissions and return early or after expiry.
- Quit, relaunch, sleep, and wake during active, paused, overtime, and
  intermission states.
- Exercise warnings enabled and disabled, alarms, repeated overtime markers,
  and session review.

### Local data

- Park and carry forward thoughts.
- Autosave and reopen Markdown notes.
- Create, inspect, rename, restore, and delete note revisions.
- Exercise external note edits and conflict handling.
- Open the notes folder, export history, delete one session, and delete all
  data after making a backup.

### Audio and appearance

- Play soundscapes before, during, and after focus.
- Switch tracks, adjust volume, manually pause, and verify alarm/intermission
  suppression and restoration.
- Preview and use alarm and return tones.
- Exercise light, dark, and system appearance; themes; timer accents; window
  resizing; and narrow responsive layouts.

### Accessibility and controls

- Navigate primary workflows with the keyboard.
- Confirm focus remains visible and modal focus returns correctly.
- Confirm core labels and status changes remain understandable without
  relying only on color or sound.

## Severity And Release Gates

The following block an alpha release:

- Data loss or corruption
- Broken timer/session recovery
- A crash in a core workflow
- An installer that cannot be installed or launched through the documented
  unsigned path
- Core controls that are inaccessible or prevent task completion
- A missing or incomplete supported-platform artifact

Cosmetic defects, low-impact friction, and feature requests enter the alpha
backlog unless they materially prevent use. The owner may publish a follow-up
alpha after blockers are fixed and the complete release matrix passes again.

Desktop alpha exit criteria are:

- No known data-loss defects.
- Reliable timer recovery across quit, relaunch, sleep, and wake.
- Successful installation and upgrade on the supported platform matrix.
- Core workflows are understandable to a tester without developer context.
- Several days of normal daily use without a blocking defect.

## Scope Freeze And Deferred Work

The alpha-readiness phase changes release infrastructure, documentation, and
defect-reporting support. It does not add product features.

Deferred until after desktop-alpha evidence supports them:

- Hydration and standing prompts
- Planner and calendar integration
- Additional or downloadable soundscapes
- Network music providers and account connections
- Automatic updates
- Code signing and macOS notarization
- Public distribution
- iOS and Android packaging

Mobile beta begins with a separate feasibility audit. It must evaluate Tauri
mobile support, storage paths, SQLite and Markdown portability, background
timer behavior, notification behavior, audio lifecycle, touch navigation, and
private TestFlight/Google Play distribution before mobile implementation is
planned.

## Acceptance Criteria

The alpha-release implementation is complete when:

1. Pull requests and ordinary pushes run validation without publishing.
2. A matching alpha tag can produce the complete unsigned artifact matrix.
3. Version mismatch or any failed platform build prevents a complete release.
4. The release contains checksums, installation guidance, backup guidance,
   limitations, and feedback instructions.
5. A structured defect form exists and protects tester privacy by instruction.
6. The documented smoke checklist can be executed against an exact alpha
   version.
7. Product scope remains frozen to release readiness and defect repair.
