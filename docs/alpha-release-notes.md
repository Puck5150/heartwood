# Pomodoro Parking Lot Private Desktop Alpha

This is a private, unsigned desktop alpha for hands-on testing. It may contain
defects, including defects that affect local data. Back up the app-data folder
before testing deletion, note recovery, or upgrades, and do not use this build
as the only copy of important information.

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

- **macOS:** Open the `.dmg`, move Pomodoro Parking Lot to Applications, then
  use Finder's Control-click **Open** path if Gatekeeper blocks the first
  launch. You can also approve the blocked app in **System Settings > Privacy &
  Security > Open Anyway**. Do not turn Gatekeeper off.
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
and privacy-conscious feedback steps. Quit the app and copy its whole app-data
folder before any delete-all or other destructive test.

## Current Limits

- Desktop-only private testing; there is no mobile build.
- No automatic updates.
- No signed distribution or macOS notarization.
- No therapeutic claims; this is a focus tool, not medical treatment.
- Local data is not synced to another device or service.

