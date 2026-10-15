# Native Engine Switch and Retirement Plan

Companion to the roadmap's B6 and R4. R4's five acceptance conditions stay the
authority; this document turns them into ordered gates with an evidence owner
for each, and defines the switch and retirement sequence with rollback at
every step. Status markers are as of 2026-10-15.

## Gate ladder

| # | Gate (maps to R4) | Evidence owner | Status |
| --- | --- | --- | --- |
| G1 | Singular ownership: one placement authority per Session, no double writes (R4.4) | `session_engine_placement` catalog; exact retry adopts the binding; cross-engine/storage/Location takeover rejected | Mechanism landed; needs one product-level acceptance run |
| G2 | Product event chain carries the native step: text, tools, prompts, approvals, step settlement with usage, retries (R4.3) | bridge mappings + `session.next.*` events (#850, #848) | Landed for the event vocabulary; TUI consumption of `step.ended` still to verify |
| G3 | Real-client acceptance on the native engine: cancellation, recovery, approvals, slow clients, reconnection (R4.3) | ACP tests over the real binary (#852), native restore/journal tests, blackbox replay | Partial: extend the ACP client matrix (TUI worker + external ACP client) and run the full matrix |
| G4 | Platform confinement and formal distribution: upgrade/rollback passes on every supported platform (R4.4/5) | Release channel ships the engine (#854) with sha256 manifests; `install-engine.sh --release` rollback | Partial: actual upgrade/rollback pass per platform, plus confinement checks per platform |
| G5 | Efficiency evidence on a representative task set (R4.1/2): quality ≥ baseline, token/cost/latency reported by task class | Evaluation carrier + harness; per-delegation evidence (#847), per-step usage (#842), read-batch windows (#846) | Mechanism landed; **blocked on the live-run budget decision** — the wider task set and multi-read carrier still need selecting |
| G6 | User-required capabilities on native: plugins/workflows, MCP, LSP at product parity (R4.3) | Engine MCP/LSP foundations; B3 remainder | Partial: task-demand prioritization per the roadmap |

## Switch sequence

Every step is independently reversible; the placement catalog keeps TS-owned
Sessions intact throughout.

1. **Opt-in (today).** The engine composes only when `MIAO_ENGINE_BIN` is
   configured; native-owned Sessions keep the explicit refusal otherwise.
2. **Distributed.** The release channel ships the engine binary per platform
   with checksum manifests, and `install-engine.sh --release` installs it with
   one-step rollback (#854). The product still defaults to the TS core.
3. **Opt-in by flag.** `miao --engine native` (or the global config's engine
   section present) opts NEW Sessions into native placement; existing Sessions
   keep their recorded placement. Legacy TS remains the fallback for
   unflagged Sessions.
4. **Default for new Sessions.** New Sessions place natively; an escape
   hatch (`--engine legacy`) keeps the TS path reachable. Native-owned
   Sessions never double-write; TS-owned Sessions never route to the engine.
5. **Retirement.** After two consecutive releases pass G1–G6 with no
   regression reopen: the TS runner stops accepting new Sessions (read-only
   for history), and the removal PR deletes the second execution core.
   Rollback is `git revert` plus a release re-pin; recorded journals stay
   readable by design (ADR-15's parity keeps them valid).

## Evidence discipline

- Fixed recordings verify behavior; live evaluation verifies quality — both
  required (roadmap §6). No gate closes on mechanism alone.
- G5's live runs follow §7's reporting table: per task class, billed tokens
  separated from estimates, p50/p95 with sample counts, and model/price
  changes reported separately from runtime effects.
- A gate regression reopens only that gate, not the ladder; the placement
  catalog makes a reopened engine gate invisible to TS-owned Sessions.
