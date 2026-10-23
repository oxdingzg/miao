# Native Engine Switch and Retirement Plan

Companion to the roadmap's B6 and R4. R4's five acceptance conditions stay the
authority; this document turns them into ordered gates with an evidence owner
for each, and defines the switch and retirement sequence with rollback at
every step. Status markers are as of 2026-10-22.

The [product acceptance matrix](product-acceptance-matrix.md) separates
implementation tests from real-client and published-artifact evidence for
G3/G4/G6. Use its open rows before declaring any of these gates closed.

## Gate ladder

| # | Gate (maps to R4) | Evidence owner | Status |
| --- | --- | --- | --- |
| G1 | Singular ownership: one placement authority per Session, no double writes (R4.4) | `session_engine_placement` catalog; exact retry adopts the binding; cross-engine/storage/Location takeover rejected | Closed: product-level placement acceptance through `/api` (#1229) |
| G2 | Product event chain carries the native step: text, tools, prompts, approvals, step settlement with usage, retries (R4.3) | bridge mappings + `session.next.*` events (#850, #848) | Closed: TUI consumes the native step chain, including `session.next.step.ended` settling the streamed message (`packages/tui/src/context/sync.tsx`, `packages/tui/test/session-v2.test.ts`) |
| G3 | Real-client acceptance on the native engine: cancellation, recovery, approvals, slow clients, reconnection (R4.3) | ACP tests over the real binary (#852), native restore/journal tests, blackbox replay | Partial: TUI is verified, and a Zed click-through recorded 2026-10-23 covers allow-once, reject, Stop, and quit/reopen replay ([record](zed-acp-ui-acceptance-2026-10-23.md)); remaining: multi-editor coverage (no second native ACP client exists to test against) |
| G4 | Platform confinement and formal distribution: upgrade/rollback passes on every supported platform (R4.4/5) | Release channel ships the engine (#854) with sha256 manifests; `install-engine.sh --release` rollback; published 0.2.11 engine archives verified on all platforms ([0.2.11 report](artifact-acceptance-0.2.11.md)) | Partial: macOS and Windows published binaries pass the full drill ([0.2.23 report](artifact-acceptance-0.2.23.md)); the 0.2.25 Linux asset is a static-pie (musl) build that passes the drill on Ubuntu 24.04, so the #1235 glibc blocker is closed in the published artifact ([0.2.25 report](artifact-acceptance-0.2.25.md)); the 0.2.25 macOS arm64 cross-version drill also passes. Linux upgrade/downgrade still needs a runnable prior Linux asset (0.2.25 is the first musl build), the Windows 0.2.25 drill is not recorded, and native Intel macOS remains open |
| G5 | Efficiency evidence on a representative task set (R4.1/2): quality ≥ baseline, token/cost/latency reported by task class | Evaluation carrier + harness; per-delegation evidence (#847), per-step usage (#842), read-batch windows (#846) | Partial+: seven task families × two priced model families × both engines ran ([cost benchmark](../../docs/experiments/engine-cost-benchmark.md)); both batch gaps are closed in code (GLM pricing in #1251, the deepseek rust blocker in #1264), so a rerun fills their cells |
| G6 | User-required capabilities on native: plugins/workflows, MCP, LSP at product parity (R4.3) | Engine MCP/LSP foundations; B3 remainder | Partial: plugin tools/hooks, worktree, workflow, delegation report, and per-model rows in both the TUI sidebar and the app context panel are covered; a real inventory of used plugins/workflows remains |

## Switch sequence

Every step is independently reversible; the placement catalog keeps TS-owned
Sessions intact throughout.

1. **Opt-in (today).** An installed, protocol-compatible engine is discovered
   automatically (or named with `MIAO_ENGINE_BIN`), but new Sessions stay
   TypeScript-owned until the operator sets `engine.storage` or
   `MIAO_ENGINE_STORAGE`.
2. **Distributed.** The release channel ships the engine binary per platform
   with checksum manifests, and `install-engine.sh --release` installs it with
   one-step rollback (#854). The product still defaults to the TS core.
3. **Opt-in by flag or configuration.** `--engine native` on `run`/`serve`
   opts new Sessions into native placement for that invocation, using a
   default store under the data directory; `--engine ts` clears the
   environment override (#1234). A global `engine.storage` key (or
   `MIAO_ENGINE_STORAGE`) also opts new Sessions in. Existing Sessions keep
   their recorded placement, and legacy TS remains the fallback without any
   opt-in.
4. **Default for new Sessions.** New Sessions place natively; an escape
   hatch (`--engine ts`, which clears the storage override) keeps the TS path
   reachable. Native-owned Sessions never double-write; TS-owned Sessions
   never route to the engine.
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
