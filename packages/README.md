# What lives under `packages`

miao's product is the Rust binary (`crates/miao-cli`, with the engine and the TUI
linked in-process). The TypeScript workspace is still built, but it no longer
contains a product entry point: it builds the desktop client, the vocabulary that
client shares with the engine, the TypeScript implementation that the engine is
tested against, and the build tooling.

Keeping the four roles apart matters because a change belongs in exactly one of
them. Adding a product feature to the TypeScript engine, or a test fixture to the
desktop client, is a sign the change is in the wrong place.

## 1. Desktop client (shipped)

| Path | Package | Role |
| --- | --- | --- |
| `apps/desktop` | — | Tauri shell; launches the Rust engine as its sidecar |
| `packages/app` | `@miao/app` | The SolidJS application the shell mounts |
| `packages/ui` | `@miao/ui` | Shared components, styled for the app |
| `packages/session-ui` | `@miao/session-ui` | Session-specific screen components |

## 2. Client/engine vocabulary (shipped, mostly types)

| Path | Package | Role |
| --- | --- | --- |
| `packages/client` | `@miao/client` | Typed HTTP client. `src/generated` and `src/generated-effect` are produced from `src/contract.ts` by `bun run generate`; never edit them by hand, and regenerate after changing Protocol or Server HttpApi |
| `packages/protocol` | `@miao/protocol` | Wire vocabulary (events, groups, errors) |
| `packages/schema` | `@miao/schema` | Payload schemas shared by client and engine-facing tests |

The desktop client imports only `core/util/*` from the next section — a handful of
helpers (`encode`, `path`, `retry`, `binary`), not the engine implementation.

## 3. TypeScript engine implementation (test reference)

The engine itself is Rust. This directory holds the earlier TypeScript
implementation, which is kept because the Rust engine is validated against it:

| Path | Package |
| --- | --- |
| `packages/core` | `@miao/core` (session runner, tools, providers, database) |
| `packages/llm` | `@miao/llm` |
| `packages/server` | `@miao/server` |
| `packages/sdk` | `@miao/sdk` |
| `packages/codemode` | `@miao/codemode` |
| `packages/plugin` | `@miao/plugin` |
| `packages/native` | `@miao/native` |
| `packages/effect-drizzle-sqlite` | `@miao/effect-drizzle-sqlite` |
| `packages/remote-control` | `@miao/remote-control` |

Its consumers are the differential and black-box suites (`packages/miao/test`,
`packages/core/test`, and the recorded fixtures in `packages/llm/test`). Nothing
in the shipped product runs it. Retiring a piece of it means moving the
corresponding regression to a Rust-side fixture first; deleting it outright would
remove the oracle, not just dead code.

## 4. Tooling, harness and legacy

| Path | Package | Role |
| --- | --- | --- |
| `packages/miao` | `miao` | Engine integration harness and the release build driver (`script/build.ts`); `bin/miao` is a launcher shim, not a TypeScript entry point |
| `packages/script` | `@miao/script` | Shared build helpers |
| `packages/http-recorder` | `@miao/http-recorder` | Records and replays provider traffic for tests |
| `packages/httpapi-codegen` | `@miao/httpapi-codegen` | Generates the client from the HttpApi contract |
| `packages/storybook` | `@miao/storybook` | Component workshop (`bun run dev:storybook`) |
| `packages/desktop` | `@miao/desktop-electron` | The previous Electron desktop shell. Kept for feature parity reference and still packaged by `nix/desktop.nix`; no package imports it |

## Rules of thumb

- Product behaviour is implemented in `crates/`, not here.
- A UI change touches section 1 and, if the wire shape changes, section 2 — with
  `bun run generate` in `packages/client` and the regenerated files committed.
- A change to section 3 is only justified by the tests that consume it.
