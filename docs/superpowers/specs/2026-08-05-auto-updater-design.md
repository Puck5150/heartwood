# Auto-Updater Design

**Status:** Approved design
**Date:** 2026-08-05

## Purpose

Give Heartwood an in-app update mechanism so alpha testers stop manually
redownloading installers from GitHub releases, and so future changes to the
release identity or schema go through a tested, reviewed update path instead
of ad hoc manual installs.

This directly follows a real incident: the Pomodoro Parking Lot -> Heartwood
rename changed the Tauri bundle identifier
(`com.pomodoroparkinglot.app` -> `com.heartwood.app`), which silently moved
the app-data directory Tauri scopes by identifier. A tester upgrading from
alpha.1 to alpha.2 by manually installing over their existing copy saw their
notes "disappear" — nothing was deleted, the new identifier's directory was
simply empty. That specific case was fixed separately with a one-time
migration (`src-tauri/src/legacy_data_migration.rs`) that copies data from
the old identifier's directory into the new one on first launch. This spec
is the follow-up: replacing manual installs with a maintained update path
narrows the surface for this class of surprise going forward, and removes
the friction of manual redownloads for testers regardless.

The 2026-08-01 private-alpha design explicitly deferred "Automatic updates."
This spec supersedes that deferral for the reason above — the alpha track is
exactly where an in-app updater earns its keep, since alpha testers are the
ones manually reinstalling today.

## Approaches Considered

### 1. `tauri-plugin-updater` (selected)

Official Tauri 2 plugin, matching the `tauri@2.11.3` already in
`src-tauri/Cargo.toml`. It checks a JSON manifest (`latest.json`), verifies a
minisign signature, downloads the matching platform installer, and installs
it. `tauri-action` — already building every platform's installer in
`release-alpha.yml` — has native support for generating and signing that
manifest as a normal release asset, given a signing key. No custom server or
hand-rolled version-comparison logic is needed.

One real limitation: the updater plugin supports self-update on macOS
(`.dmg`), Windows (NSIS `.exe`), and Linux **AppImage**, but not `.deb`.
`release-alpha.yml`'s Linux job builds both (`appimage,deb`); AppImage
testers get auto-update, `.deb` testers do not and continue installing
manually. Acceptable at alpha scale — noted here so it isn't mistaken for a
bug later.

### 2. Hand-rolled "check GitHub releases API, show a banner with a download
link" (rejected)

Simpler — no signing key, no plugin, just a `fetch` against GitHub's REST
API and a semver comparison. Rejected because it doesn't solve the actual
problem: it replaces "tester manually checks GitHub" with "tester gets
nagged, then manually checks GitHub." No auto-install means the friction and
the update-related risk (silently landing on a build with unreviewed data
implications) are unchanged.

## Release Pipeline & Signing

- **Signing key custody:** the maintainer generates the minisign keypair
  themselves (`npm run tauri signer generate`) and keeps the private key.
  Only the public key is shared, to embed in `tauri.conf.json`. The private
  key and its password are added directly to GitHub Actions repo secrets
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) by the
  maintainer — the key never appears in this repository, in CI logs, or in
  any assistant-authored file.
- **`src-tauri/tauri.conf.json`:** gains a `plugins.updater` block —
  `pubkey` (the generated public key) and `endpoints: ["https://github.com/Puck5150/heartwood/releases/latest/download/latest.json"]`.
  The updater fetches that URL directly; GitHub releases is the manifest
  host, no separate infrastructure.
- **`.github/workflows/release-alpha.yml`:** the `build` job's existing
  `tauri-apps/tauri-action@v1` step gains the two signing env vars (sourced
  from the secrets above). With the updater plugin configured and those
  vars present, `tauri-action` signs each installer and emits a per-platform
  `latest.json` fragment automatically — no new build logic to write.
- **`scripts/prepareAlphaAssets.mjs`:** its `REQUIRED` map currently allows
  only `.dmg`/`.exe`/`.AppImage`/`.deb` and throws on anything else
  (`Unsupported artifact: ...`). It's extended to also accept exactly one
  `latest.json` and its `.sig` sidecar files, passed through unmodified
  (the manifest `tauri-action` produces is already the correct merged
  manifest across the three platform build jobs) and included in
  `SHA256SUMS.txt` like every other asset.
- **`src-tauri/Cargo.toml`** gains `tauri-plugin-updater`; `src-tauri/src/lib.rs`
  registers it alongside the existing plugins (`sql`, `dialog`, `fs`,
  `opener`, `notification`).

## Frontend UX & State

- **New `src/lib/updateController.svelte.ts`**, structured like the existing
  `settingsController.svelte.ts` (a factory function returning reactive
  `$state`), but with no write queue — this is transient session state, not
  a persisted setting. States: `idle -> checking -> (none | available) ->
  downloading -> ready -> restarting`, with a quiet `error` slot at the
  `checking`, `downloading`, and install stages.
- **Trigger:** automatic only, a few seconds after launch. No manual "Check
  for updates" control in Settings — checking is opportunistic and
  unattended, debounced so a given launch never checks more than once.
- **UI:** a new small component visually matching the existing
  `FirstTimeHint.svelte` banner (`role="status"`, muted background, inline
  action link) — not a modal, not a new visual language.
  - Stage 1 (update found): *"Heartwood vX.Y.Z is available — **Update** /
    Later"*. Nothing downloads until the user clicks Update.
  - Stage 2 (after consent, once downloaded): *"Update ready — **Restart
    now** / Later"*.
- **Mid-session behavior:** the Stage 1 banner may appear during an active
  Focus/Flow/Break session — it's passive and dismissible, same as the
  existing hint banners already shown mid-session. The Stage 2 restart
  prompt never fires mid-session even if the download finishes while a
  session is active; it's held and only surfaced once the user is back on
  the idle screen (session finished or abandoned). An active timer is never
  interrupted by an update.

## Error Handling

- **Check fails** (GitHub unreachable, offline): fully silent. No banner, no
  error surfaced. Retries on the next launch. Checking is opportunistic and
  never worth alarming a tester over.
- **Download or signature verification fails:** the banner switches to
  *"Couldn't update — Retry / Later"*. No automatic retry loop, no bypass —
  a manifest or binary that fails signature verification never installs,
  regardless of the specific failure reason. Both failure modes are
  dismissible and never block normal use of the current version.

## Testing

- `updateController.svelte.ts`: unit tests inject a fake plugin API (the
  same pattern `settingsController.svelte.ts`'s tests use for fake Tauri
  commands) and cover the state machine's transitions, both error paths, and
  specifically the "no restart prompt during an active session" gate — the
  one piece of real custom logic here, since the rest is thin wiring around
  the plugin.
- `scripts/prepareAlphaAssets.test.ts`: extended with cases for accepting
  exactly one `latest.json` plus its `.sig` sidecars, and rejecting
  duplicates or unexpected extras, matching its existing allowlist test
  style.
- No new Rust-side unit tests: plugin registration in `lib.rs` isn't logic
  to test, matching how the existing plugins (`dialog`, `fs`, `notification`)
  are registered untested today.

## Rollout Note

This does not retroactively help any install that predates it (alpha.2,
alpha.3, and any tester still on alpha.1). Those installs have no updater
code at all, so they still require one more manual install to *receive* the
feature. Self-updating starts working for them from that install onward.

## Acceptance Criteria

1. `tauri.conf.json` and `release-alpha.yml` are configured so a tagged
   alpha release produces a signed `latest.json` alongside the existing
   installer matrix, without changing what platforms are built.
2. `scripts/prepareAlphaAssets.mjs` accepts the updater manifest and its
   signature files without loosening its existing allowlist for anything
   else.
3. Heartwood checks for updates automatically and silently a few seconds
   after launch, at most once per launch, with no manual trigger.
4. An available update is presented as a dismissible banner; downloading
   and installing each require explicit user consent at their own step.
5. The restart-to-apply prompt never appears while a Focus, Flow, or Break
   session is active.
6. A failed check is silent; a failed download or signature verification is
   surfaced, retryable, dismissible, and never partially installs.
7. The signing private key exists only as a GitHub Actions secret set by
   the maintainer — it is never generated, stored, or transmitted through
   this codebase or an assistant session.
