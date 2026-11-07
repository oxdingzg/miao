# Acceptance record — REL-01 three-platform build, packaging, and checksums

Item: `REL-01`. Tree: `main` including #2696, release `v0.3.46` (latest). The
download-and-verify ran on a macOS arm64 workstation; the musl/static and
Windows legs are read from `.github/workflows/release.yml` and the release's
own build jobs (the `engine-windows` leg has passed on every release attempt
since the v0.3.30 notes, per this item's progress notes).

## The criteria this record accepts

**The supported macOS architectures, Linux static compatibility and Windows
are covered; the release package contains what is actually needed and its
checksums verify; recompilation runs on a build host and host details never
enter public documentation.**

- *Platforms*: `release.yml` builds darwin-arm64 (an Intel Mac maps to the
  arm64 build under Rosetta, by design), linux-x64 and linux-arm64 as
  `x86_64-unknown-linux-musl` / aarch64 musl (`musl-tools` in the workflow —
  static, no glibc coupling), and windows-x64. `v0.3.46` carries all four
  assets, each with a `.sha256` sidecar.
- *Package contents and verification*: the darwin-arm64 archive is the single
  `miao` binary plus `LICENSE` — the binary *is* the engine (`miao serve`,
  `attach`, `acp` are the same file), so nothing the product needs is missing.
  A fresh download of `miao-darwin-arm64.zip` from the release verified
  `shasum -a 256 -c miao-darwin-arm64.zip.sha256` → **OK**, and the extracted
  binary answers as a real client: `miao --version` → `0.3.46`, `miao doctor`
  → `miao 0.3.46 / engine protocol 2 schema 25 / database …`.
- *Build host and public hygiene*: release legs compile on GitHub-hosted
  runners; workstation-side recompilation is offloaded to build hosts over
  SSH by standing instruction, with a local-compile guard. Three host-name
  leaks found in the public tree while writing this record are removed in the
  same pull request (a test-fixture sentence, a measurements note, and one
  acceptance record's `ssh` hint now say "build host"); a repo-wide scan for
  the aliases and addresses now comes back empty.
- *Links*: release [v0.3.46](https://github.com/oxdingzg/miao/releases/tag/v0.3.46);
  `.github/workflows/release.yml`, `script/install-engine.sh`,
  `script/install-local.sh`; the earlier v0.3.30 publication notes in this
  issue.

## What this record does not claim

- Signing and notarization belong to REL-02, not here.
- The Linux archives were not booted end to end in this round; their static
  target is read from the workflow and the platform legs' CI success.
