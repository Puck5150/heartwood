# Heartwood Beta

This is an unsigned beta for hands-on testing. It may contain defects,
including defects that affect local data. Quit the app and back up all
storage roots listed below before testing deletion, note recovery, or
upgrades. Do not use this build as the only copy of important information.

## Downloads

Choose the artifact for the device you are testing:

| Platform | Architecture | Download |
| --- | --- | --- |
| macOS | Universal Apple Silicon and Intel | `.dmg` |
| Windows | x64 | NSIS `.exe` |
| Linux | x64 | AppImage |
| Linux | x64 | `.deb` |
| Android | arm64-v8a | `.apk` |

The macOS and Windows packages are unsigned; the Android package is signed
with a dedicated beta signing key that implies no trust beyond "built by
this project's release pipeline," not a Play Store identity. Confirm that
the file came from this release and compare its SHA-256 value with
`SHA256SUMS.txt` before opening it. The checksum detects an incomplete or
changed download; it is not a code-signing certificate.

## Installing An Unsigned Build

- **macOS:** Open the `.dmg`, move Heartwood to Applications, and
  attempt the first launch. If Gatekeeper blocks it, open **System Settings >
  Privacy & Security**, find the app's security message, then choose **Open
  Anyway**. As a fallback on older macOS versions, use Finder's Control-click
  **Open** path. Do not turn Gatekeeper off.
- **Windows:** Run the NSIS `.exe`. If SmartScreen appears, confirm the source
  and checksum, choose **More info**, then **Run anyway**. Do not turn
  SmartScreen off.
- **Linux AppImage:** Make the downloaded file executable with
  `chmod +x <downloaded-file>.AppImage`, then run it. If AppImage support is
  unavailable, install the x64 `.deb` instead with your software manager or
  `sudo apt install ./<downloaded-file>.deb`.
- **Android:** Download the `.apk` on the device itself (or transfer it over),
  then tap it to install. Android will prompt to **install unknown apps**
  for whichever app opened the file (browser or file manager) — allow it for
  that app only, then tap Install. Do not enable "install unknown apps"
  globally beyond that one app.

For checksums, run `shasum -a 256 <file>` on macOS,
`Get-FileHash <file> -Algorithm SHA256` in PowerShell, `sha256sum <file>` on
Linux, or a checksum-calculator app on Android, and compare the result with
the matching line in `SHA256SUMS.txt`.

## Before Testing

Read the complete [beta testing guide](https://github.com/Puck5150/heartwood/blob/__RELEASE_COMMIT_SHA__/docs/beta-testing.md).
It contains backup locations, the platform smoke checklist, severity guidance,
and privacy-conscious feedback steps. A complete Linux backup requires both:

```text
SQLite/config: $XDG_CONFIG_HOME/com.heartwood.app or ~/.config/com.heartwood.app
Notes/revisions: $XDG_DATA_HOME/com.heartwood.app or ~/.local/share/com.heartwood.app
```

Quit the app before copying both Linux roots or the single location documented
for macOS and Windows, especially before delete-all or another destructive test.
Android's app-private storage isn't accessible for manual backup without a
rooted device — treat Android test data as disposable for this beta.

## Current Limits

- No automatic updates on Android; desktop still checks for updates
  automatically. Android testers redownload the APK for each new beta.
- No signed distribution or macOS notarization; Android's signing key is
  beta-only, not a Play Store identity.
- No therapeutic claims; this is a focus tool, not medical treatment.
- Local data is not synced to another device or service.
