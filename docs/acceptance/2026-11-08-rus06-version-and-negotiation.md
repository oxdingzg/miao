# Acceptance record — RUS-06 unified versioning and protocol negotiation

Item: `RUS-06`. Tree: `main` including #2695. Commands ran on the Linux build
host (`x86_64-unknown-linux-gnu`) and, for the wire fixtures, a macOS arm64
engine binary.

## The criteria this record accepts

**The root `package.json` stays the single source of the version; one user
entry point and a separate engine child process are packaged without a single
binary forcing a single process; and a protocol incompatibility between an old
client and a new engine is refused clearly instead of corrupting data.**

- *Version source*: root `package.json` carries the version (`bun
  script/set-version.ts` synchronizes workspace manifests from it; no manifest
  carries its own number), builds and runtime read it, and the doctor echoes
  the same figure a fresh sandbox sees — `miao 0.3.46` against root
  `package.json` `0.3.46`, recorded in the COST-05 doctor acceptance.
- *Packaging*: the TUI spawns the engine as a child process
  (`test/engine/native-engine` fixtures and the PERF-04 process-tree sample
  show two processes — `miao-tui` and the engine); a single binary ships both
  sides (`miao-engine serve` is invocable from the same install), so the one
  entry point never forced one process.
- *Negotiation* (#2695): `Initialize` carries the client's wire protocol; the
  engine refuses a mismatch with `Invalid` naming both sides —
  `protocol mismatch: client 1, engine 2; refusing to serve this session
  rather than risk corrupting it` — and provably never creates the session
  (`Snapshot` still errors "Session does not exist"). A frame without the
  field counts as too old to negotiate; the serde default keeps the wire
  format itself parseable. Real clients announce: the TUI transport and the
  TypeScript host (native engine, product tools, baseline run) send
  `REQUIRED_PROTOCOL`/`miao_engine::PROTOCOL`.

## Suites

| what | command | observed |
| --- | --- | --- |
| the negotiation contract | `cargo test --test protocol_negotiation` (from `crates/miao-engine/`) | `4 passed; 0 failed` |
| the crate around it | `cargo test --lib` | `408 passed; 0 failed` |
| the full engine suite (CI sharded legs) | CI run 42408230653-era, `ci.yml` engine matrix | green after the fixtures learned the handshake |
| the wire fixtures end to end | `bun test test/engine/{native-catalog,native-oauth-refresh,native-context-config,product-mcp,context-settlement,http-client}.test.ts` against a real engine binary | 15 passed; 0 failed |

## What this record does not claim

- The version figure is not restated here beyond what the doctor acceptance
  recorded; CHANGELOG and releases own publication history.
- Windows unexercised, as before.
