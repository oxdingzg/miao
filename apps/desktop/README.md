# miao desktop (Tauri)

The desktop app: a Tauri 2 shell around the shared `@miao/app` renderer. The shell
starts `miao` as a loopback sidecar and hands the webview its URL and credentials;
the renderer then speaks the same protocol as every other client.

Architecture and phasing: [`specs/desktop-app.md`](../../specs/desktop-app.md).

## Prerequisites

Rust toolchain plus the platform webview development packages. See the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Development

```bash
bun install
bun run --cwd apps/desktop tauri dev
```

`tauri dev` runs `vite` on port 1420 and reuses the running devtools server.

## Build

```bash
bun run --cwd apps/desktop build   # renderer bundle into dist/
bun run --cwd apps/desktop tauri build
```

## Layout

- `src/` — the renderer entry. It boots `@miao/app` with the sidecar connection the
  shell reports; desktop-only integrations live here as they land.
- `src-tauri/` — the shell: sidecar lifecycle, windows, menus, deep links, updater,
  platform specifics. `src-tauri/src/cli.rs` spawns the sidecar, `server.rs`
  health-checks it.
- `src-tauri/tauri.conf.json`, `tauri.beta.conf.json`, `tauri.prod.conf.json` —
  dev/beta/prod channels (`ai.miao.desktop.dev|beta|prod`).

## Sidecar

The shell expects the `miao` binary next to it, named `miao-cli` (Tauri
`externalBin`), and runs it as a resident loopback server. A missing binary fails
the health check and surfaces in the shell's error path rather than a blank window.
