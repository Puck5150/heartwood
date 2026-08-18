# Beta Release Design

**Status:** Approved design
**Date:** 2026-08-18

## Purpose

Move Heartwood from the private desktop alpha
(`docs/superpowers/specs/2026-08-01-private-desktop-alpha-release-design.md`)
into a beta that also ships Android for the first time. The alpha spec
explicitly deferred mobile packaging to "a separate feasibility audit" before
implementation — that audit happened informally this session: `tauri android
init` was run, the toolchain (JDK 17, Android SDK/NDK, Rust Android targets)
was installed, the app was built and exercised live on a physical device, and
four real mobile-layout/interaction bugs were found and fixed (History
overlap, a nav color inconsistency, an unusable 4-column task board on phone
width, and no touch-friendly way to change a task's status). Android is no
longer unproven — this spec is about shipping it through the same release
discipline the desktop alpha already has.

Beta **replaces** alpha as the active release tier. No further alpha tags are
cut after this; `v0.1.0-beta.1` is the next release.

## Release Boundary

The first beta is `v0.1.0-beta.1` — same base version as the current alpha
(`0.1.0`), only the prerelease label changes from `-alpha.N` to `-beta.N`.
Version agreement (`scripts/releaseVersion.mjs`) still enforces one version
across `package.json`, the lockfile, `tauri.conf.json`, and the Rust
manifest/lockfile; its tag regex moves from `-alpha\.(\d+)` to `-beta\.(\d+)`.

The supported artifact matrix:

| Platform | Architecture | Beta artifacts |
| --- | --- | --- |
| macOS | Universal Apple Silicon and Intel | `.dmg` |
| Windows | x86-64 | NSIS `.exe` |
| Linux | x86-64 | AppImage and `.deb` |
| Android | arm64-v8a | `.apk` |

Android ships `arm64-v8a` only — it covers the large majority of real
devices in active use, and it's the ABI actually validated on a physical
phone this session. Broader ABI coverage (`armeabi-v7a`, `x86_64`) is a small
later addition to the same CI job if a tester's device needs it, not a
blocker for the first beta.

All artifacts stay **unsigned**, matching the alpha's posture and this
session's explicit decision to defer real signing:

- macOS: ad-hoc codesign only (`APPLE_SIGNING_IDENTITY: '-'`), no
  notarization.
- Windows: unsigned, expected SmartScreen warning.
- Android: signed with a dedicated beta signing key (self-generated,
  CI-secret-only — Android requires *some* signature to install at all, but
  this is not a Play Store key and implies no trust beyond "built by this
  pipeline"). Generated once as part of this work, stored only as GitHub
  Actions secrets, never committed. This key becomes the app's lasting
  Android identity — every future beta must be signed with the same key or
  installs won't be recognized as upgrades.

The project must not add placeholder signing values, dummy certificates, or
anything implying the packages are more trusted than they are.

## CI Architecture

`release-alpha.yml` is adapted in place rather than duplicated — the
release-alpha spec's validation/release split, immutability preflight,
provenance checks, and checksum generation all carry over unchanged. Changes:

1. **Rename** `release-alpha.yml` → `release-beta.yml`.
2. **Tag trigger** moves from `v*-alpha.*` to `v*-beta.*`.
3. **New Android build job**, parallel to the existing macOS/Windows/Linux
   matrix job:
   - `ubuntu-22.04` runner.
   - JDK 17 (Temurin), Android command-line tools, platform 36 and matching
     build-tools (`compileSdk`/`targetSdk` in `gen/android/app/build.gradle.kts`
     are both 36), NDK r27 — same versions installed locally this session.
   - `rustup target add aarch64-linux-android`.
   - `npx tauri android build --target aarch64` (release mode; no `--debug`).
   - Signing happens through Gradle, not a manual post-build
     zipalign/apksigner pass: `gen/android/app/build.gradle.kts` gets a
     `signingConfigs { release { ... } }` block reading the keystore and
     passwords from environment variables, and `buildTypes.release` points at
     it. The CI step decodes `ANDROID_KEYSTORE_BASE64` back into a keystore
     file, exports it and the three secrets as env vars, then runs the build
     — output is already a signed, installable APK.
   - Uploads the signed APK as a workflow artifact, same naming convention as
     the desktop platforms (`[platform]-[arch]-[bundle]`).
4. **Release job** downloads the Android artifact alongside the desktop ones
   and includes it in the same GitHub prerelease, checksummed the same way as
   every other file (`SHA256SUMS.txt`).

New GitHub Actions secrets required: `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

No auto-update wiring for Android in this phase (see Deferred Work) — the
existing desktop Tauri updater (`docs/superpowers/specs/2026-08-05-auto-updater-design.md`)
is unaffected and continues to work exactly as it does today.

## Tester Distribution

Unchanged from the alpha model: the GitHub prerelease is the source of truth,
downloaded directly by testers with repository access or transferred
privately by the owner otherwise. Each release still includes a plain
description, a platform-to-download mapping, SHA-256 checksums,
unsigned-install instructions, data-location/backup guidance, known
limitations, and feedback instructions — commit-pinned the same way the alpha
release notes are.

`docs/alpha-testing.md` → `docs/beta-testing.md` and
`docs/alpha-release-notes.md` → `docs/beta-release-notes.md`, both gaining an
Android row/section:

- Enable "Install unknown apps" for the browser/file manager used to open the
  APK (Android's equivalent of the Gatekeeper/SmartScreen unsigned-install
  path already documented for desktop).
- Download the APK, verify its SHA-256 against `SHA256SUMS.txt`.
- Tap to install.
- Android data-location note (SQLite/config and notes/revisions paths for the
  app's own storage, matching the existing per-platform backup section).

## Feedback Model

Unchanged structure from the alpha defect form
(`docs/superpowers/specs/2026-08-01-private-desktop-alpha-release-design.md`'s
Feedback Model section) — version, OS, artifact used, repro steps,
expected/actual, whether local data was affected, optional logs/screenshots —
with "Android" added as a selectable OS/platform and a reminder that Android
logs come from `adb logcat`, not a desktop log path.

## Beta Test Checklist

Everything in the alpha checklist (installation/lifecycle, timer/recovery,
local data, audio/appearance, accessibility) still applies per-platform,
including Android now. Additional Android-specific passes:

- Fresh install and first launch via sideloaded APK.
- Backgrounding/foregrounding the app mid-focus-session (Android can suspend
  or kill backgrounded apps more aggressively than desktop OSes) — confirm
  the timer's deadline-based recovery still lands correctly on resume.
- Rotation/multi-window behavior if the device supports it.
- Touch-only pass through every screen this session's fixes targeted:
  History (Delete/+ Project no longer overlap), the task board (columns
  stack full-width, not four abreast), and changing a task's status via the
  new edit-dialog radio group instead of drag-and-drop.
- Native notification behavior on Android specifically — `ARCHITECTURE.md`
  already flags that the desktop notification adapter was verified only
  against the desktop Tauri backend, so this is genuinely first-time
  territory, not a regression check.

## Severity And Release Gates

Unchanged from the alpha spec's gates (data loss/corruption, broken
timer/session recovery, a core-workflow crash, an installer that can't be
installed/launched through the documented unsigned path, inaccessible core
controls, a missing supported-platform artifact) — Android is now simply one
more platform those gates apply to.

Beta exit criteria add to the alpha's:

- No known data-loss defects on any of the four platforms, including Android.
- Successful sideload install and upgrade-in-place across at least two
  Android beta releases (proves the signing key stayed consistent).
- The four mobile-specific bugs fixed this session stay fixed under the
  documented touch-only pass.

## Scope Freeze And Deferred Work

This phase changes release infrastructure and documentation only — no new
product features, matching the alpha spec's own scope discipline.

Deferred until after beta evidence supports them:

- Code signing and macOS notarization, Windows Authenticode/Trusted Signing.
- Public (non-GitHub-Release) distribution.
- iOS packaging (Android-only for this beta).
- **Android automatic updates** — explicitly the next phase after this one.
  The desktop updater (`@tauri-apps/plugin-updater`) has no mobile
  equivalent in Tauri today; getting Android onto an update channel means
  either an in-app "check for new APK" flow against the same
  `docs/updates/latest.json` manifest the desktop updater already publishes
  (detect a newer version, prompt, hand the user to a browser download of
  the new APK — Android can't silently self-replace an installed APK the
  way desktop can) or a distribution channel that supports it natively
  (e.g. F-Droid, or a private Play Store track, both bigger asks than this
  beta). Until then, Android testers redownload manually for each beta.
- Broader Android ABI coverage (`armeabi-v7a`, `x86_64`) beyond arm64-v8a.

## Acceptance Criteria

The beta-release implementation is complete when:

1. Pull requests and ordinary pushes still run validation without publishing
   (unchanged from alpha).
2. A matching `v*-beta.*` tag produces the complete unsigned artifact matrix
   — three desktop installers plus a signed Android APK — only after the
   immutable-release preflight succeeds.
3. Version mismatch, failed policy/provenance checks, or any failed platform
   build (including the new Android job) prevents a complete release.
4. The Android APK is signed through the Gradle signing config using
   CI-secret-only key material; the keystore is never committed.
5. The release contains checksums (including the APK) and commit-pinned
   installation, backup, limitations, and feedback instructions covering all
   four platforms.
6. The documented beta checklist, including the Android-specific and
   touch-only passes, can be executed against an exact beta version.
7. `docs/beta-testing.md` and `docs/beta-release-notes.md` exist and replace
   their alpha equivalents' role; no further alpha tags are cut.
