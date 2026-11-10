# Acceptance record — REL-04 gate evidence map

Date: 2026-11-10. Tree: `121e143a47`. This is a map, not a closure: it records, gate
by gate, which existing acceptance records already carry evidence for REL-04's G1–G8
(`specs/rust-retirement-gates.md`) and what is still missing. The closure record for
the v0.3.25 observation window (opened 2026-11-02, planned close 2026-11-16) is
written on top of this map and must re-verify every row it cites on its own tree.

Bound trees and versions are quoted from each cited record; a record bound to an
older tree covers the gate only as far as its own scope statement claims.

## G1 — single execution authority

| evidence | bound to | covers |
| --- | --- | --- |
| `specs/rus02-ts-runner-retirement.md` + `docs/experiments/2026-10-28-ts-runner-retirement/imports.json` | `bfb0c944e5` (2026-11-10 re-run, #2814) | static import boundaries: 312 edges, runner at 11/15 with exactly two production edges (`core/src/location-services.ts:36`, `core/src/session/execution/local.ts:7`) |
| `docs/acceptance/2026-11-07-val02-task-accounting.md` | `97b4dea0ce` | task accounting through the engine execution path |
| `crates/miao-engine/docs/restart-recovery-drill-2026-10-23.md`, `crates/miao-engine/docs/session-resilience-parity.md` | 2026-10 trees | restart and resilience behaviour |

Missing: a composition-root record for the current tree proving admission, execution,
permission and persistence route through one durable owner (no second writer); the
two historical placements' migration/rejection test record; the native same-Session
serial / cross-Session concurrent execution record as a bound document.

## G2 — product control plane

| evidence | bound to | covers |
| --- | --- | --- |
| `docs/acceptance/2026-11-04-cli-entry-point.md` + `docs/acceptance/2026-11-08-rus04-cli-entrypoints.md` | `04dc191a01`, later `main` | every CLI command implemented by the Rust entry, run from a scratch HOME |
| `docs/acceptance/2026-11-04-config-ext-retry.md`, `2026-11-05-cfg02-*.md`, `2026-11-08-cfg03-reload-boundary.md` | 2026-11 trees | configuration sources, scopes, reload, extension/retry surfaces |
| `crates/miao-engine/docs/mcp-lsp-acceptance-2026-10-24.md` | 2026-10 tree | MCP/LSP control surfaces |

Missing: the frozen HTTP/route group inventory mapped to Rust owners; a
release-artifact launch record showing unsupported features error explicitly instead
of silently degrading.

## G3 — real clients

| evidence | bound to | covers |
| --- | --- | --- |
| `crates/miao-engine/docs/client-acceptance-2026-10-24.json`, `http-client-acceptance-2026-10-24.md`, `zed-acp-acceptance-2026-10-22.md`, `zed-acp-ui-acceptance-2026-10-23.md`, `codecompanion-acp-ui-acceptance-2026-10-25.*` | 2026-10 trees | run, HTTP/SDK, Zed ACP, ACP UI clients: delivery, approval, answers, errors |
| `docs/acceptance/2026-11-01-tui-batch*.md`, `2026-11-07-tui03/04`, `2026-11-09-run01-input-receipts.md`, `2026-11-07-run01.md` | 2026-11 trees | TUI and headless run paths |

Missing: a refreshed per-client matrix (delivery, approval, question, error recovery)
bound to the current release; the 2026-10 client records predate the pure-Rust
product entry.

## G4 — legacy data and history

| evidence | bound to | covers |
| --- | --- | --- |
| `docs/acceptance/2026-11-04-data-migration-transfer.md` | `04dc191a01` | migration, reopen, `miao db backup`, cross-process start, transfer |
| `docs/acceptance/2026-11-08-data01-migration.md` | `main` incl. #2696 era | DATA-01 migration criteria |
| `crates/miao-engine/docs/rollback-verification.md`, `drill-0.2.25-windows.json` | 0.2.x era | rollback drill pattern |

Missing: fault-injection and duplicate-execution drills on an isolated copy at the
current version, plus reverse-recovery records; the spec forbids destructive runs on
real user databases, so these drills are separate isolated-copy runs.

## G5 — extensions and boundaries

Evidence in `specs/rust-retirement-gates.md`: packaged launch smoke on
darwin-arm64 / linux-x64 / windows-x64 / darwin-x64 (Rosetta) against release
`v0.3.25` artifacts; healthy/broken extension mix records (worker-load-diagnostics,
4 pass); linux-arm64 covered by the release workflow building on-target (#2331/#2332).

Missing: darwin-x64 **native** Intel run. The configured build hosts are arm64
(probed 2026-11-10: `macmini` reports `arm64`), so this needs either an Intel Mac or
an explicit product decision to move darwin-x64 out of the supported matrix; the
spec does not allow leaving it implicit.

## G6 — version and protocol

| evidence | bound to | covers |
| --- | --- | --- |
| `docs/acceptance/2026-11-08-rus06-version-and-negotiation.md` | `main` incl. #2695 | single version source, wire negotiation, incompatible-version rejection |
| `specs/rust-retirement-gates.md` §G6 | `58118fc1dc` era | local artifact inventory, malformed-frame rejection paths |

Missing: the paired checklist of published artifacts vs CLI/TUI/engine versions and
SHA-256 per supported platform, produced from one release. Next release can carry it.

## G7 — quality and resources

| evidence | bound to | covers |
| --- | --- | --- |
| `docs/acceptance/2026-11-07-val02-task-accounting.md` | `97b4dea0ce` | per-completed-task time, cost, wall clock |
| `docs/acceptance/2026-11-01-perf04.md`, `2026-11-09-perf05-backpressure.md` | 2026-11 trees | resource profiles, backpressure |

Missing: the fixed-task benchmark with declared models, verifiers, repeat counts and
per-run raw results (`script/engine-benchmark.ts`) — needs an authorised real-model
budget before it can run.

## G8 — release and recovery

Not started, by definition: the deletion PRs themselves (RUS-02 steps 2 and 3) are
blocked by the observation window. Evidence required at that point: approved and
merged deletion PR, green main CI at the exact squash SHA, installable/launchable
final artifacts per supported platform, and a verified rollback path.

## What blocks closure, in order

1. Observation window: closes 2026-11-16; closure record lists in-window failures
   (none observed so far) and re-verifies G1–G4 evidence on its own tree.
2. G1–G4: the missing records listed above — each is one bounded drill or inventory.
3. G5 darwin-x64: hardware or an explicit scope decision.
4. G6: paired checklist at the next release.
5. G7: benchmark budget.
6. Then RUS-02 steps 2–3, then G8.
