# Contributing to miao

We want to make it easy for you to contribute to Miao. Here are the most common type of changes that get merged:

- Bug fixes
- Additional LSPs / Formatters
- Improvements to LLM performance
- Support for new providers
- Fixes for environment-specific quirks
- Missing standard behavior
- Documentation improvements

However, any UI or core product feature must go through a design review with the core team before implementation.

If you are unsure if a PR would be accepted, feel free to ask a maintainer or look for issues with any of the following labels:

- [`help wanted`](https://github.com/oxdingzg/miao/issues?q=is%3Aissue%20state%3Aopen%20label%3Ahelp-wanted)
- [`good first issue`](https://github.com/oxdingzg/miao/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)
- [`bug`](https://github.com/oxdingzg/miao/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug)
- [`perf`](https://github.com/oxdingzg/miao/issues?q=is%3Aopen%20is%3Aissue%20label%3A%22perf%22)

> [!NOTE]
> PRs that ignore these guardrails will likely be closed.

Want to take on an issue? Leave a comment and a maintainer may assign it to you unless it is something we are already working on.

## Adding New Providers

New providers shouldn't require many if ANY code changes, but if you want to add support for a new provider first make a PR to:
https://github.com/anomalyco/models.dev

## Developing miao

- Requirements: Bun 1.4.x (the version `packageManager` pins), a Rust stable
  toolchain, and `cargo` on `PATH`.
- Install dependencies once from the repo root:

  ```bash
  bun install
  ```

- Run the binary from source:

  ```bash
  bun dev            # cargo run --manifest-path crates/miao-cli/Cargo.toml
  bun dev --help
  bun dev serve      # headless API server
  bun dev .          # TUI in the current directory
  ```

  The product is the Rust binary: `crates/miao-cli` links the engine and the TUI
  in-process, so there is no separate engine process to start. Everything after
  `bun dev` is passed to the binary unchanged.

### Tests

Tests do not run from the repository root (a guard rejects it); run them in the
package that owns them:

```bash
cd packages/engine-ts/core && bun test
cd packages/app && bun test
```

Rust tests run with cargo. Do not compile on the workstation you are editing on:
send `cargo build`/`cargo test` to a build host and copy the result back.

```bash
cargo test --manifest-path crates/miao-engine/Cargo.toml
```

### Running against a different directory

`bun dev` starts in the current working directory. Pass a path to start somewhere
else, or `.` for the repository root:

```bash
bun dev <directory>
bun dev .
```

### Building a binary

Build the release binary on a build host, then install that artifact:

```bash
cargo build --release --manifest-path crates/miao-cli/Cargo.toml
./script/install-local.sh --binary target/release/miao
```

`install-local.sh` smoke-tests `--version`, installs the binary under
`~/.local/share/miao/bin`, and repoints `~/.local/bin/miao-preview`. The
release-managed `~/.miao/bin/miao` is left untouched, so a work-in-progress build
cannot break the command you rely on.

### Where things live

`packages/README.md` describes the TypeScript layers; the Rust side is the three
`crates/miao-*` packages the binary is built from. In short:

- `crates/miao-cli`, `crates/miao-engine`, `crates/miao-tui` — the shipped binary
- `packages/app`, `packages/ui`, `packages/session-ui` — the SolidJS client the desktop shell mounts
- `apps/desktop` — the Tauri shell around `packages/app`
- `packages/client`, `packages/protocol`, `packages/schema` — wire vocabulary shared by the client and the engine tests
- `packages/engine-ts/*` — the earlier TypeScript implementation the Rust engine is validated against; nothing shipped runs it
- `packages/script`, `packages/http-recorder`, `packages/httpapi-codegen`, `packages/storybook` — tooling

### `bun dev` vs `miao`

Both are the same program. `bun dev` is `cargo run --manifest-path
crates/miao-cli/Cargo.toml`, so it compiles your working tree and is the only
entry point that reflects uncommitted edits. `miao` is a release binary; run
`bun script/set-version.ts` and cut a release to see a change there.

### Running the API Server

To start the miao headless API server:

```bash
bun dev serve
```

This starts the headless server on port 4096 by default. You can specify a different port:

```bash
bun dev serve --port 8080
```

### Running the Web App

To test UI changes during development:

1. **First, start the miao server** (see [Running the API Server](#running-the-api-server) section above)
2. **Then run the web app:**

```bash
bun run --cwd packages/app dev
```

This starts a local dev server at http://localhost:5173 (or similar port shown in output). Most UI changes can be tested here, but the server must be running for full functionality.

### Running the Desktop App

The desktop app is a Tauri shell (`apps/desktop`) around the shared web UI: it starts
`miao` as a loopback sidecar and renders `packages/app` in the system webview.

To run it in development, first build the sidecar binary the shell bundles, then start
Tauri (which serves the renderer on port 1420):

```bash
cargo build --manifest-path crates/miao-cli/Cargo.toml
bun run --cwd apps/desktop tauri dev
```

`apps/desktop/scripts/prepare-sidecar.ts` (run by `bun run tauri`) copies that binary into
`apps/desktop/src-tauri/sidecars/`. To package the app:

```bash
bun run --cwd apps/desktop tauri build
```

The previous Electron shell was retired once the Tauri port reached parity; see
`specs/desktop-app.md`.

> [!NOTE]
> After changing the public Protocol or Server `HttpApi`, run `bun run generate`
> from `packages/client` and commit the regenerated files. Never edit
> `src/generated` or `src/generated-effect` by hand.

Please try to follow the [style guide](./AGENTS.md)

### Setting up a debugger

The binary is Rust, so attach a native debugger:

```bash
cargo build --manifest-path crates/miao-cli/Cargo.toml
rust-lldb target/debug/miao        # or rust-gdb on Linux
```

The TUI and the engine are linked into that one process, so a breakpoint anywhere
in `crates/miao-engine` or `crates/miao-tui` stops the same program; there is no
separate server process to attach to. `bun dev` builds and runs the same binary
when you do not need a debugger.

Without a debugger, the engine writes structured diagnostics to
`<data root>/log/miao.log`; set `MIAO_LOG_FILE` to write them somewhere else.

#### VSCode setup

[.vscode/launch.example.json](.vscode/launch.example.json) attaches `lldb` to the
locally built binary, and
[.vscode/settings.example.json](.vscode/settings.example.json) carries the
workspace settings.

## Pull Request Expectations

### Branches and merging

Development is trunk-based: `main` is always releasable, and every change
reaches it through a pull request. Branches are short-lived.

| | |
|---|---|
| **Naming** | `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, or `test/` plus a short subject, e.g. `fix/session-recovery` |
| **Lifetime** | Merge within a day or two |
| **Merging** | Squash, so one pull request becomes one commit on `main` |
| **After merge** | The branch is deleted |

`main` is protected: it cannot be pushed to directly, and every change needs an
approving review from a code owner and passing CI before it can merge. Keep one
pull request to one concern; a review that has to hold several unrelated changes
in mind finds fewer problems in all of them.

### Issue First Policy

**All PRs must reference an existing issue.** Before opening a PR, open an issue describing the bug or feature. This helps maintainers triage and prevents duplicate work. PRs without a linked issue may be closed without review.

- Use `Fixes #123` or `Closes #123` in your PR description to link the issue
- For small fixes, a brief issue is fine - just enough context for maintainers to understand the problem

### General Requirements

- Keep pull requests small and focused
- Explain the issue and why your change fixes it
- Before adding new functionality, ensure it doesn't already exist elsewhere in the codebase

### UI Changes

If your PR includes UI changes, please include screenshots or videos showing the before and after. This helps maintainers review faster and gives you quicker feedback.

### Logic Changes

For non-UI changes (bug fixes, new features, refactors), explain **how you verified it works**:

- What did you test?
- How can a reviewer reproduce/confirm the fix?

### No AI-Generated Walls of Text

Long, AI-generated PR descriptions and issues are not acceptable and may be ignored. Respect the maintainers' time:

- Write short, focused descriptions
- Explain what changed and why in your own words
- If you can't explain it briefly, your PR might be too large

### PR Titles

PR titles should follow conventional commit standards:

- `feat:` new feature or functionality
- `fix:` bug fix
- `docs:` documentation or README changes
- `chore:` maintenance tasks, dependency updates, etc.
- `refactor:` code refactoring without changing behavior
- `test:` adding or updating tests

You can optionally include a scope to indicate which package is affected:

- `feat(app):` feature in the app package
- `fix(desktop):` bug fix in the desktop package
- `chore(miao):` maintenance in the miao package

Examples:

- `docs: update contributing guidelines`
- `fix: resolve crash on startup`
- `feat: add dark mode support`
- `feat(app): add dark mode support`
- `fix(desktop): resolve crash on startup`
- `chore: bump dependency versions`

### Style Preferences

These are not strictly enforced, they are just general guidelines:

- **Functions:** Keep logic within a single function unless breaking it out adds clear reuse or composition benefits.
- **Destructuring:** Do not do unnecessary destructuring of variables.
- **Control flow:** Avoid `else` statements.
- **Error handling:** Prefer `.catch(...)` instead of `try`/`catch` when possible.
- **Types:** Reach for precise types and avoid `any`.
- **Variables:** Stick to immutable patterns and avoid `let`.
- **Naming:** Choose concise single-word identifiers when they remain descriptive.
- **Runtime APIs:** Use Bun helpers such as `Bun.file()` when they fit the use case.

## Feature Requests

For net-new functionality, start with a design conversation. Open an issue describing the problem, your proposed approach (optional), and why it belongs in Miao. The core team will help decide whether it should move forward; please wait for that approval instead of opening a feature PR directly.

## Issue Requirements

All issues **must** use one of our issue templates:

- **Bug report** — for reporting bugs (requires a description)
- **Feature request** — for suggesting enhancements (requires verification checkbox and description)
- **Question** — for asking questions (requires the question)

Blank issues are not allowed. When a new issue is opened, an automated check verifies that it follows a template and meets our contributing guidelines. If an issue doesn't meet the requirements, you'll receive a comment explaining what needs to be fixed and have **2 hours** to edit the issue. After that, it will be automatically closed.

Issues may be flagged for:

- Not using a template
- Required fields left empty or filled with placeholder text
- AI-generated walls of text
- Missing meaningful content

If you believe your issue was incorrectly flagged, let a maintainer know.
