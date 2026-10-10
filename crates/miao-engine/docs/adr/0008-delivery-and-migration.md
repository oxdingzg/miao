# ADR-08: Delivery and migration

Status: Proposed (M4; not started. Depends on
[ADR-05](0005-extension-compatibility.md) for extensions and
[ADR-07](0007-http-acp-adapters.md) for the wire; records the M4 milestone that
`inventory.md` lists as `Delivery: single binary, install/update/preview`.)

## Context

The engine and the product currently exist side by side as two implementations
of the same session core, with no integration between them:

- The product (bun/TypeScript) owns the CLI, TUI and desktop shell, the V2
  session core in `packages/core` (durable `session_input` rows, the serialized
  runner, `SessionRunCoordinator`), the plugin/hook/skill ecosystem, config and
  the install/update pipeline (`install`, `script/install-local.sh`, channels
  and the channel-scoped database).
- The Rust engine (`crates/miao-engine`) owns the same concerns in Rust: a
  headless, protocol-first runtime over its own database (`engine_session`,
  `engine_event`), reachable only through `serve` (stdio / `engine-http-0`),
  `acp`, `export` and `doctor`. Nothing in `packages/**` references it.

M1 is capability-complete (see `inventory.md`); the gap to a product is delivery
and the migration between the two cores. This ADR records how to close it.

## Decision

- **Adopt a strangler migration: sidecar first, replacement as the end state.**
  The engine ships and runs as a separate local process while the product drives
  whichever capability has been delegated to it; the TS shell stays until the
  last delegated capability and the last extension are moved. Replacement (the
  product as one Rust binary) is the target, not the first step.
- **One session core is authoritative per Session.** A Session is owned by
  exactly one store at a time: the engine's own database for Sessions created
  through the engine, the TS V2 core for Sessions the product still owns. There
  is no dual write. Moving an existing Session across is an explicit, recorded
  operation (admit the projected history into the engine), never a silent copy.
  This avoids two durable cores disagreeing about one Session.
- **The wire is the client contract.** The product talks to the engine only
  through `engine-stdio-0` / `engine-http-0` / ACP (ADR-07); it never links the
  Rust runtime. Editor clients already reach the engine with no TypeScript
  runtime at all over ACP, and that path is unaffected by this decision.
- **The shell stays until the wire can carry it.** The existing TUI/desktop keep
  being the product while the bridge is built; the end state is a thin client
  over the engine's wire. Which shell (existing, rewritten, or both) converges
  is deferred to the migration design that M4c requires.
- **Extensions keep running where they run today.** During the bridge, TS
  plugins, hooks and skills stay in the TS process. The replacement end state
  requires the ADR-05 compatibility worker (M3); a delegated capability must not
  depend on an extension the worker cannot host.
- **Behaviour parity is a contract, not a port.** Shared scenarios (ADR-05)
  define what "the same" means across the two cores; the engine is never a
  line-by-line translation of the TS core.
- **Delivery (M4) is staged:**
  - **M4a — engine artifacts.** Per-platform release artifacts of the engine
    binary (Linux static/musl, macOS arm64 + x64, Windows) with checksums,
    produced by the `engine` workflow.
  - **M4b — install/update/preview for the engine.** Reuse the existing
    installer semantics: a release channel, a preview build with one-step
    rollback, and `--version`; never touch the release-managed product install.
  - **M4c — product entry.** The product starts through the engine once the
    bridge, the extension story and the shell decision allow it; this is the
    step that turns "single binary" from an engine property into a product one.
- **M4c is gated, not scheduled.** The product switches only when the capability
  matrix is cleared or a substitution is explicitly accepted, when a single
  credential owner is in place (ADR-09), and when platform claims match reality —
  a platform whose confinement is not effective is stated as such, never
  advertised as isolated. Whether the shell stays TypeScript or becomes a Rust
  one is an experience/maintenance decision that does not block the core.

## Consequences

- The engine can be delivered and exercised before the shell is touched, and the
  product keeps working while capability moves.
- The long-term cost the strangler must pay down is the second core: the bridge
  is only complete when the TS V2 core is gone, not merely idle.
- Authority, budget and output governance stay identical across the boundary
  because both entry points sit behind the engine's permission model (ADR-04).
- Deferred: which shell converges, whether the worker is TS-only or a generic
  subprocess protocol, and the Windows process-enforcement follow-ups.
