# Desktop app notes (Tauri)

Architecture decisions and phasing: `specs/desktop-app.md`.

## Wiring

- The renderer reaches the engine only through `@miao/app`'s `ServerConnection`. Do not add a
  desktop-specific business protocol, and do not fork shared UI into this package.
- Keep `invoke`/plugin calls inside this package's platform adapter (`src/index.tsx` today).
  Shared packages (`packages/app`, `packages/ui`) must stay runnable in a plain browser.
- The shell owns the sidecar lifecycle: spawn in `src-tauri/src/cli.rs`, health-check in
  `src-tauri/src/server.rs`, kill on `RunEvent::Exit`. A sidecar failure must reach the UI as an
  error, never as a blank window.

## Packaging status

No CI workflow builds, packages, or publishes this app yet, and releases carry no desktop
artifact. `src-tauri/tauri.conf.json` bundles `sidecars/miao-cli-<triple>`; run
`bun ./scripts/prepare-sidecar.ts` (also wired as `predev`/`prebuild`) after building
`crates/miao-cli` to populate it. The previous Electron shell has been retired; this app is the
only desktop shell.

## Copy and i18n

- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key for native menus, picker titles, dialogs, buttons, accessible labels, and displayed errors.
- When migrating existing copy to i18n, preserve the English text byte-for-byte unless the task explicitly requests a copy change.
- NEVER change existing English text or English keys to facilitate translation. English is intentional, designer-written source copy; adapt locale-specific translations and i18n mechanics around it.
- Keep locale and grammar logic in the shared typed i18n layer. Renderer code should resolve copy through the app language API, and the shell should consume typed native-translation bundles instead of assembling translated sentence fragments.
- Do not translate from model knowledge alone. Verify terminology and grammar with Unicode CLDR locale/plural data, Microsoft Localization Style Guides and terminology, Apple localization/style guidance, Mozilla localization style guides, Mozilla Pontoon, and the Firefox localization corpus at `github.com/mozilla-l10n/firefox-l10n`, plus the relevant language authority for the locale.
- Record the corpora used and flag uncertain or regional terminology in review notes.
