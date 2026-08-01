# Pomodoro Parking Lot Private Desktop Alpha

This is a private, unsigned desktop alpha for hands-on testing. It may contain
defects, including defects that affect local data. Quit the app and back up all
storage roots listed below before testing deletion, note recovery, or upgrades.
Do not use this build as the only copy of important information.

## Downloads

Choose the artifact for the computer you are testing:

| Platform | Architecture | Download |
| --- | --- | --- |
| macOS | Universal Apple Silicon and Intel | `.dmg` |
| Windows | x64 | NSIS `.exe` |
| Linux | x64 | AppImage |
| Linux | x64 | `.deb` |

The macOS and Windows packages are unsigned. Confirm that the file came from
this private release and compare its SHA-256 value with `SHA256SUMS.txt` before
opening it. The checksum detects an incomplete or changed download; it is not a
code-signing certificate.

## Installing An Unsigned Build

- **macOS:** Open the `.dmg`, move Pomodoro Parking Lot to Applications, and
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

For checksums, run `shasum -a 256 <file>` on macOS,
`Get-FileHash <file> -Algorithm SHA256` in PowerShell, or `sha256sum <file>` on
Linux, and compare the result with the matching line in `SHA256SUMS.txt`.

## Before Testing

Read the complete [private alpha testing guide](https://github.com/Puck5150/pomodoro_parking_lot/blob/main/docs/alpha-testing.md).
It contains backup locations, the platform smoke checklist, severity guidance,
and privacy-conscious feedback steps. A complete Linux backup requires both:

```text
SQLite/config: $XDG_CONFIG_HOME/com.pomodoroparkinglot.app or ~/.config/com.pomodoroparkinglot.app
Notes/revisions: $XDG_DATA_HOME/com.pomodoroparkinglot.app or ~/.local/share/com.pomodoroparkinglot.app
```

Quit the app before copying both Linux roots or the single location documented
for macOS and Windows, especially before delete-all or another destructive test.

## Current Limits

- Desktop-only private testing; there is no mobile build.
- No automatic updates.
- No signed distribution or macOS notarization.
- No therapeutic claims; this is a focus tool, not medical treatment.
- Local data is not synced to another device or service.
