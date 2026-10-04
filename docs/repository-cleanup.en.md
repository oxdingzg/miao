# Unused upstream-material cleanup — 2026-10-04

**Language:** [English](repository-cleanup.en.md) | [简体中文](repository-cleanup.zh.md)

The audit covered tracked root material, app/UI public assets and symlink targets, desktop icon
copying/packaging, repository automation, release helpers, and references from code and docs.
It removes unused material rather than treating every occurrence of `opencode` as obsolete.

## Removed

| Material                                                                       | Why it was unused                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `screenshot-uk.png`                                                       | Unreferenced upstream screenshot; current product screenshots live in `docs/images`                                                                                 |
| App help `placeholder.png`                                                     | No component imports it; the actual help screenshots and video remain                                                                                               |
| Old unversioned `apple-touch-icon.png`, `favicon-96x96.png`, and `favicon.svg` | Current HTML/Favicon components use the v3 assets; remove the unused public symlinks together with their UI targets                                                 |
| `social-share-zen.png` (public link + UI target), UI `social-share-black.png`  | No current consumer; the referenced `social-share.png` remains                                                                                                      |
| `.github/publish-python-sdk.yml`                                               | Entirely commented out, not an executable workflow; the referenced Python SDK no longer exists                                                                      |
| `.github/workflows/notify-discord.yml`                                         | Unused inherited release-notification integration; it is not part of the maintained release publication path                                                        |
| `script/beta.ts`                                                               | Unreferenced upstream beta integration; depends on absent `v2`/`beta` branches and invokes `opencode`                                                               |
| `script/release`                                                               | Direct-main commit/push helper superseded by the protected-main PR workflow; both release guides now describe PR preparation followed by explicit workflow dispatch |
| Desktop Android launcher outputs (51 files)                                    | No Android build target or consumer in the Electron package                                                                                                         |
| Desktop iOS outputs (54 files)                                                 | No iOS build target or consumer in the Electron package                                                                                                             |
| Desktop UWP/Store outputs (30 files)                                           | Windows packaging uses NSIS, not appx/UWP                                                                                                                           |

Total: **150 removed paths**, approximately **4.39 MB** of tracked payload including symlink text.
This removes files from the current checkout; it does not rewrite Git history.

## Corrected active material

- The active web manifest and shared Favicon component now identify the application as `miao`.
- The desktop icon README describes the actual Electron channel/copying path, not a removed Tauri
  command. Required desktop icon files remain in all three channels.
- Release preparation stays on a short-lived branch and lands through a PR before the release
  workflow is dispatched. This cleanup itself does not publish a release.

## Retained after verification

- Root `LICENSE`, both miao/opencode copyright lines, and the UI/HTTP recorder license files.
- Real provider identities (`opencode`, `opencode-go`), provider logos, upstream attribution,
  historical research/changelogs, database/configuration compatibility identifiers, and working
  theme names.
- Current `docs/images` screenshots, used help images/video, fonts, audio, generated icon sprites
  and their source icon libraries.
- Desktop channel icons used by `scripts/copy-icons.ts`, Electron-builder and the macOS Dock:
  `icon.icns`, `icon.ico`, `dock.png`, `icon.png`, and desktop PNG sizes.
- V3 app favicons, manifest icons, the referenced share image, and the conventional `/favicon.ico`
  browser fallback. Public asset symlinks require their UI targets; absence of a TypeScript import
  alone is not evidence that a target is unused.
- Maintained CI/release/install checks, issue/PR tooling and team metadata, which still have
  consumers in the fork.

Active artwork retaining upstream visual identity is a separate redesign concern. Deleting an
asset that a page or packaging pipeline still uses would not be a valid cleanup.
