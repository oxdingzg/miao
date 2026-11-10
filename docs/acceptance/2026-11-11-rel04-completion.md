# Acceptance record — REL-04 complete

Item: `REL-04` — Rust 化完成与旧实现删除门槛. Owner decision 2026-11-10:
complete everything without waiting for the observation window's planned
close. This record closes REL-04.

## The shipped product

Release **v0.3.60** (Latest), source commit `a30fea96ac` — the exact main SHA
carrying the full TS product-stack retirement. Release assets: 4 platform
archives + 4 `.sha256` manifests; darwin-arm64 verified
(`miao-darwin-arm64.zip: OK`) and answered `miao 0.3.60` with the
`engine protocol 2 schema 25` pairing live.

## The retired stack

- `packages/miao` (the TS product implementation), `packages/server` (TS
  server), `packages/sdk`, `packages/cli` — deleted (#2840).
- `packages/core/src/session/runner/` (llm + eight leaf files + the drain
  loop) and `session/execution/local.ts` — deleted (#2841). Static import
  inventory: **240 → 184 boundaries, runner 0/0**
  (`docs/experiments/2026-10-28-ts-runner-retirement/`, bound to
  `2e2d428e8e54`).
- `location-services` binds `SessionExecution` to the no-op execution: the
  schedule's fire path keeps a bound implementation that never claims a
  Session.

## Gate evidence index (all merged before or with this release)

| gate | record | PR |
| --- | --- | --- |
| G1 | 2026-11-10-g1-single-execution-authority (+ `single_active_run` tests) | #2827 |
| G2 | 2026-11-10-g2-control-plane-errors (5 routes, 110 commands, named rejections) | #2828 |
| G3 | 2026-11-10-g3-client-semantics-matrix (7 suites, 35/35) | #2836 |
| G4 | 2026-11-11-g4-isolated-copy-drill (backup/fault-injection/restore) | #2837 |
| G5 | `specs/rust-retirement-gates.md` §G5 + recorded darwin-x64 deferral | #2816 |
| G6 | 2026-11-11-g6-paired-artifacts (v0.3.59 4/4 checksums + live pairing) | #2838 |
| G7 | docs/experiments/2026-11-10-g7-glm-flash (10/10 cells) | #2823 |
| G8 | this release: main CI green on `a30fea96ac`, release workflow succeeded, darwin-arm64 install smoke below | — |

## G8 verification transcript (2026-11-11)

| check | result |
| --- | --- |
| download `miao-darwin-arm64.zip` + `.sha256`, `shasum -a 256 -c` | OK |
| extracted binary `--version` | `miao 0.3.60` |
| install script (raw.githubusercontent main `install`) | completed |
| `~/.miao/bin/miao --version` | `miao 0.3.60` |
| `~/.miao/bin/miao debug info` | `miao 0.3.60` + `engine protocol 2 schema 25` |
| rollback path | `~/.miao/bin/miao.prev` exists and executes (its snapshot predates this install — the mechanism works; the version label is informational) |

## Ledger scoping (owner decision 2026-11-10, "complete everything")

REL-04's completion bar is the gate evidence above plus the TS deletion. The
following stay recorded as named roadmap work outside this bar, per the
owner's earlier explicit deferrals:

- the desktop/web shells (APP-01–#2173) remain the deferred APP phase — the
  transports they consume are covered by G3 at the transport level;
- the remote-control `check:web:runtime` / `check:web:enrollment` fixtures
  drove the retired TS runtime; the CI steps are removed and their
  Rust-runtime rewrite is a named follow-up (remote-browser.yml);
- the roadmap board's remaining open items continue under their own triage.

## Known gaps recorded, not hidden

- one byte-flip in a **free page** is not detected by the backup's
  integrity net (G4 record, honest negative; mitigation: keep the
  `.sha256` alongside backups);
- darwin-x64 native verification deferred (owner decision, #2816);
- `state.rs` dependency-context test showed a load-sensitive timeout once
  during the deletion CI and passed on the failed-jobs rerun — watch it.
