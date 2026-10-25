# Session takeover ledger for 25 October 2026

Status checkpoint: 2026-10-25T19:20:35+08:00. This ledger preserves the interrupted workstreams; `docs/roadmap.md` remains the project-wide roadmap. PR status is a checkpoint, so query the recorded head and current checks before any merge.

## Completed work

- v0.3.6 is published with 24 release assets. Its release predates the open fixes below.
- Sidebar context pressure and trend charts landed in #1395.
- Home installation version landed in #1396 (`67688731dbece3471fae0def53e2937de4bf2d7c`).

## Pending pull requests

| PR | Branch | Work | Checks at checkpoint |
| --- | --- | --- | --- |
| [#1394](https://github.com/oxdingzg/miao/pull/1394) | `feat/embedded-engine-artifact` | feat(build): embed the engine binary into the single-file build | All reported checks successful or skipped |
| [#1398](https://github.com/oxdingzg/miao/pull/1398) | `fix/native-session-stalls` | fix(engine): prevent catalog reads and transport loss from stalling sessions | All reported checks successful or skipped |
| [#1399](https://github.com/oxdingzg/miao/pull/1399) | `fix/tui-session-blank` | fix(tui): keep open sessions visible when catalog entries fail | Running: unit / unit tests (linux), unit / window runtime (windows), engine / engine (macos-14), engine / engine (ubuntu-latest), engine / engine (windows), blackbox / session blackbox replay, e2e / e2e (linux), e2e / e2e (windows, non-blocking until Windows suite is fixed) |
| [#1400](https://github.com/oxdingzg/miao/pull/1400) | `fix/engine-idle-ownership` | fix(engine): reclaim idle runtimes using process-owned live work | All reported checks successful or skipped |
| [#1401](https://github.com/oxdingzg/miao/pull/1401) | `fix/native-stream-watchdog` | fix(engine): keep event idle deadlines active throughout provider streams | All reported checks successful or skipped |
| [#1402](https://github.com/oxdingzg/miao/pull/1402) | `test/conformance-workspace` | test(conformance): verify isolated engine placement and durable outcomes | All reported checks successful or skipped |
| [#1403](https://github.com/oxdingzg/miao/pull/1403) | `fix/native-run-admission-gap` | fix(engine): publish initial input promotion and run start atomically | All reported checks successful or skipped |
| [#1404](https://github.com/oxdingzg/miao/pull/1404) | `feat/context-prune-events` | feat(engine): persist measured tool output pruning facts | All reported checks successful or skipped |
| [#1405](https://github.com/oxdingzg/miao/pull/1405) | `fix/native-long-history` | fix(engine): preserve long session snapshots and forks | All reported checks successful or skipped |
| [#1406](https://github.com/oxdingzg/miao/pull/1406) | `docs/native-acceptance-status` | docs: refresh native engine acceptance status | Running: engine / engine (windows) |
| [#1407](https://github.com/oxdingzg/miao/pull/1407) | `feat/tui-compact-footer` | feat(tui): consolidate the composer into a compact status layout | Running: unit / unit tests (linux) |
| [#1408](https://github.com/oxdingzg/miao/pull/1408) | `feat/session-usage-history` | feat(session): expose paginated provider usage history | Running: unit / unit tests (linux), unit / window runtime (windows), typecheck / typecheck tasks, engine / engine (macos-14), engine / engine (ubuntu-latest), engine / engine (windows), e2e / e2e (linux), e2e / e2e (windows, non-blocking until Windows suite is fixed), remote / browser |

No approving review was recorded on these PRs at this checkpoint. Follow the project rule requiring an approving review, successful CI, squash merge, and branch deletion. Never report a tested preview as merged or published.

## Context display work still to finish

- [ ] App context/cache timeline: provider-step input and cache read/write stacks, independent axes when the context window changes, explicit unknown values, and compaction markers. The data API is #1408; the UI branch is `feat/app-context-history`.
- [ ] App input-category history: show system/user/assistant/tool estimates over time and label their coverage and estimate basis. Do not present loaded-transcript estimates as historical provider measurements.
- [ ] Bridge native `context.pruned` facts from #1404 into the product EventV2 stream. Preserve durable source identity and replay behavior.
- [ ] TUI compaction/pruning settlement cards: actual before/after bytes, savings, affected-message count, and trigger reason. Do not relabel bytes as tokens.
- [ ] Reconcile and preserve the original context-management reference and mockup drafts after checking their claims and licence boundaries. They are backed up privately and are not yet repository commits.

## Rust consolidation work still to finish

The original request authorized sequential implementation and validation of four phases. #1394 embeds an engine executable in the host artifact, then extracts and launches it. It remains a two-process program; neither an engine library integration nor a native terminal UI is complete.

1. Phase 1: complete embedded-artifact conformance, reviewing the isolated-workspace harness in #1402, then obtain review and land #1394.
2. Phase 2: move the remaining host orchestration, durable admission/delivery integration, permissions, config, and storage boundaries into Rust. Preserve existing Session and Location ownership rules, explicit provider turns, and durable replay.
3. Phase 3: implement the terminal UI with ratatui using current product behavior as the parity specification. Validate one complete phase before advancing.
4. Phase 4: settle plugin compatibility and implement the corresponding single-artifact publishing, updater, and signing path. Packaging alone does not complete this phase.

## Verification and release work

- [ ] Land the stalled-session, transport, ownership, watchdog, blank-view, admission-race, and long-history fixes after review and successful checks.
- [ ] Verify the combined tree: retained-session title recovery, large-history snapshot/fork, long tool sequences, parent/child completion, process crashes, service restarts, two-window ownership, and active-window continuity after another window closes.
- [ ] Verify the compact footer in actual terminal sizes, including active, idle, retrying, queued input, compaction, error, and approval states.
- [ ] Validate the compiled preview after the final combination of fixes; keep the release-managed daily command separate.
- [ ] Audit the original uncommitted conformance runs before archiving. Prior embedded/release control runs were 3/12 and 4/12; #1402 fixes harness engine/database/workspace ambiguity. Those earlier runs are not passing acceptance evidence.
- [ ] Audit older detached acceptance-worktree edits against merged PRs. Do not discard them or commit their mixed concerns as one change.
- [ ] Prepare any subsequent version through `script/set-version.ts`, review release notes, verify release artifacts, and confirm actual publication. v0.3.6 publication does not deliver the open PRs above.

## External acceptance conditions

Track the evidence in [#1267](https://github.com/oxdingzg/miao/issues/1267) and #1406:

- [ ] Resume the confirmed Anthropic-protocol account route after the gateway weekly quota resets and complete a real multi-turn Session. One successful native provider turn is already recorded; it does not satisfy the multi-turn acceptance.
- [ ] Observe a real credential naturally expire with the account owner present and verify broker refresh without giving the engine credential write ownership. Controlled refresh-path tests are already recorded.
- [ ] Validate approval, denial, and cancellation in a second actual ACP editor client when one is available. Do not claim server or SDK tests as a second editor.

## Recovery and source records

The source conversation IDs are retained because they are necessary to recover instructions and task state:

- Release and acceptance work: `6c05188a-d31a-4e2f-99dd-819010640856`.
- Reliability and compact-footer continuation: `01a17289-2be3-7d42-81a3-43171216c11b`. Its backend continued after its window closed, so coordinate before touching its worktrees.
- Rust phases: `ses_gfe5e8de7afd9ffewdy2rsSiMd`.
- Context display: `ses_gfe5e8db8dcc1ffeWmHuyL3KE3`.
- Previously inherited recovery work also referenced `ses_gfe5e8f2d2f3effeCmXgYMEbk4`; verify the released fixes against that source rather than dropping the inherited request.

A private machine-readable ledger preserves PR heads, current worktree paths, source locations, and a recovery snapshot of tracked changes and untracked files. Machine-specific build details and raw local records stay outside this public repository.

## New validation evidence

#1408 is committed as `a99fa5a176` and pushed. Its core usage-store suite passes 10 tests, including replay deduplication, timestamp-tie pagination, concurrent new rows, and cross-Session cursor rejection. Core, schema, protocol, server, and client package typechecks passed; both Client variants were generated by `bun run generate`.

Before App changes, the production first-navigation benchmark passed on a build host: first destination observed at 33.2 ms, stable destination at 47.2 ms, zero blank or unknown samples. Raw metrics are retained on the App UI branch. The existing streaming benchmark fails before UI changes because its live fixture still emits retired `message.part.*` events; repair that benchmark separately or use a current V2 scenario before claiming streaming performance parity.
