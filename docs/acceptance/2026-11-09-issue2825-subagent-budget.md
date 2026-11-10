# Acceptance record — issue #2825 delegated subagent budget

Date: 2026-11-09. Tree: `1f0830f222` (PR #2831, branch `fix/issue2825-subagent-steps`).

## Problem (issue #2825)

Implementation-shaped delegated children — read the existing code, implement,
test, iterate on CI — routinely consumed more than the host-default bound of
`TURN_LIMIT = 32` provider turns / `TIME_LIMIT_SECS = 1800` (30 minutes). The
child then stopped silently on the bound and the parent had to recover it by
hand: 15+ manual recoveries in one day of orchestrating six roadmap children,
each handoff costing a full transcript, with uncommitted work exposed between
rounds (one child's 89-line uncommitted refactor was saved only by the parent
taking over).

## Change

`crates/miao-engine/src/subagent.rs`: the host-default allowance for a
delegated child grows to `TURN_LIMIT = 96` provider turns and
`TIME_LIMIT_SECS = 3600` (60 minutes). Explicit parent `budget` grants, the
`TURN_CEILING` (10 000 turns) and `WALLCLOCK_CEILING_MS` (24 h) caps, and the
`MIAO_SUBAGENT_MAX_TURNS` / `MIAO_SUBAGENT_MAX_SECONDS` overrides are
unchanged, so a runaway child remains boundable by every existing mechanism.

## Verification

Local Rust compilation is barred on this workstation (rustc guard), so
behaviour is verified by CI only.

- `ci` run [`42847471956`](https://github.com/oxdingzg/miao/actions/runs/42847471956):
  conclusion `success` at tree `1f0830f222`; `release-guard`
  (`42847471381`), `pr-management` (`42847470505`) and `pr-standards`
  (`42847471048`) all `success` on the same tree.
- The bound behaviour stays pinned: `tests/subagent.rs`
  `a_child_the_host_left_unbounded_closes_itself_and_still_reports` asserts
  the child's working-turn count against `subagent::TURN_LIMIT` itself
  (now 95 working turns plus the reserved text-only wrap-up) and that the
  transcript explains the stop with the delegated-allowance note; it passed in
  the run above.
- The explicit-budget paths in `tests/delegation_boundaries.rs` (stated
  `max_turns`, stated `wallclock_ms`, parent-capped and goal-inherited grants)
  never consult the default and passed unchanged in the same run.
