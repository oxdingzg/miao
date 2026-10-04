# Electron desktop icons

Each `dev`, `beta`, and `prod` channel keeps the icons used by the current Electron packaging:

- `icon.icns` for macOS bundles and DMGs;
- `icon.ico` for Windows NSIS installers;
- `dock.png` for unpackaged Electron's macOS Dock icon;
- `icon.png` and the size-specific PNGs for Linux desktop packaging.

From `packages/desktop`, `bun scripts/copy-icons.ts <channel>` copies the selected channel to
`resources/icons`. The prebuild/predev scripts run this step; `resources/icons` is generated and
ignored by Git.

For a macOS icon refresh, use a padded Big Sur-style source when producing `icon.icns`. Keep
`dock.png` synchronized with its `icon_128x128@2x.png` representation so development and packaged
Dock icons have the same inset.

The old Tauri icon-generation command and unused Android, iOS, and Windows Store/UWP outputs were
removed. This package builds Electron desktop targets, not those mobile or appx targets.
