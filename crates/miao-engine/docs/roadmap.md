# Unified Rust engine roadmap

Status snapshot: **2026-10-12**; reviewed baseline: `c3baaa6d1` (including #589).

## 1. Objective and document responsibilities

**Improve real-task completion quality while reducing token consumption, end-to-end latency, and human correction.**

Rust is the implementation vehicle. Success is measured by the efficiency of correctly completed tasks: more accurate information gathering, more reliable editing, fewer wasted turns, better context management, and executable verification that closes the task loop.

Evaluate mechanisms from open-source agents and mature coding agents independently against miao's tasks and models. The existing TS implementation is a behavioral reference and evaluation baseline. Capability parity supports migration acceptance but does not replace task-quality and efficiency acceptance. Preserve necessary capabilities while allowing redesigned internals, tool interactions, and client experiences; record the rationale for explicitly accepted alternatives.

This document is the unified entry point for the Rust engine's **objective, current progress, remaining work, execution priorities, and stage gates**. Detailed protocols, architectural contracts, and test evidence remain in dedicated documents:

| Document                                                                               | Responsibility                                                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [inventory.md](inventory.md)                                                           | Capability families and implementation/test evidence; not proof of efficiency gains      |
| [scenarios.md](scenarios.md), [accuracy.md](accuracy.md)                               | Deterministic scenarios, outcome contracts, fault testing, and differential verification |
| [measurements.md](measurements.md), [live-eval.md](live-eval.md)                       | Resource measurements with stated conditions and real-task results                       |
| [handler-migration.md](handler-migration.md), [client-contract.md](client-contract.md) | Product-interface integration scope                                                      |
| [event-bridge.md](event-bridge.md), [facade-mapping.md](facade-mapping.md)             | Event/tool mapping designs; code determines actual coverage                              |
| [rollback-verification.md](rollback-verification.md)                                   | Actual local-preview rollback evidence                                                   |
| [session-blackbox.md](../../../docs/session-blackbox.md)                               | Recording, replay, and cross-engine comparison capabilities and boundaries               |
| [ADR index](README.md)                                                                 | Ownership, durability, authority, provider, extension, and migration decisions           |

Progress updates here do not automatically revise ADR decisions. Architectural changes must also update the corresponding ADR. Early README sections, feasibility studies, and ADR background may retain older snapshots; this document and traceable code evidence define current work status.

## 2. What completion means

- **Complete within the contract scope**: code is merged and has corresponding executable verification; real-task benefits are not inferred.
- **Partially complete**: foundations exist, but the listed functional or acceptance gaps remain.
- **Pending**: the objective is defined, but complete implementation and acceptance evidence have not been established.
- **Candidate experiment**: adoption requires an independent A/B evaluation; it is not a default-implementation commitment.

Record implementation commit/PR, behavioral verification, real-task benefits, and publication status separately for each optimization. Successful CI does not establish improved quality, an Actions artifact is not a formal release, and headless verification does not establish product-experience acceptance.

## 3. Implemented engine foundations

These are reusable foundations, not work to repeatedly rebuild from scratch. See the inventory and corresponding tests for their capability boundaries.

| Foundation                                                                    | Status and evidence                                                                           | Contribution and boundary                                                                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Durable admission, exact retry, steer/queue, execution supervision            | Complete; `src/store.rs`, `src/runtime.rs`, retry/supervision/lost-wake scenarios             | Reduce duplicate execution and unexplained stalls; do not automatically repeat unknown side effects after a crash                     |
| Read/list/glob/grep, conditional write/edit, transactional patch              | Complete; `src/tools.rs`, `src/file_mutation.rs`, `src/patch.rs`, accuracy/differential tests | Reliable editing foundation; anchored edits and automatic stale recovery are not thereby complete                                     |
| Bash/PTY, background jobs, three-platform sandbox                             | Complete within the corresponding scope; process/bash/jobs and Windows scenarios              | Bounded external execution, cancellation, and output; the full interactive-terminal product API still needs integration               |
| Subagents, global limits, independent cancellation                            | Foundations complete; `src/subagent.rs`, `tests/subagent.rs`                                  | Isolate task context; this does not prove delegation reduces total tokens                                                             |
| LSP diagnostics/definition/references, image input                            | Core complete; lsp/media scenarios                                                            | Precise information-gathering foundation; read-triggered warmup, post-edit diagnostic loops, and other media still require evaluation |
| Context Epoch, skills/references, state/todo/goal                             | Complete within the corresponding scope; context/state scenarios                              | Stable-context and on-demand retrieval foundations; full cache optimization is not thereby implemented                                |
| Explicit compaction, recall, fork, revert/unrevert                            | Complete; `src/history.rs`, checkpoint/rewind/recovery scenarios                              | The caller supplies summaries; automatic summary policy and quality evaluation remain incomplete                                      |
| Multiple providers, read-only credentials, safe fallback, shared retry budget | Foundations complete; provider/routing/credential scenarios                                   | Reduce failure cost; purpose-role routing and its benefits still require verification                                                 |
| MCP, hooks, extension-worker protocol host                                    | Foundations complete; mcp/hooks/worker scenarios                                              | Extensible tool entry points; actual existing TS plugin/workflow compatibility still needs wiring                                     |
| Cursor/replay, snapshot/export, stdio/HTTP/ACP                                | Core protocol scope complete; http/acp/two-engines scenarios                                  | Slow-client isolation and reconnect foundations; some ACP methods still return empty results                                          |
| Usage aggregation, doctor, artifact manifests, local installation             | Complete within the corresponding scope; run-usage/install scenarios and engine workflow      | Measurement/delivery foundations; cost accounting and the formal update channel are not fully closed                                  |

### Existing measurements and their limits

- Two small-task live-evaluation rounds exist: six task classes × eight repetitions, Rust 48/48 and TS 47/48; another three classes × three repetitions, both 9/9, with Rust p50 22 s and TS p50 26 s. These observations apply only to that model and small-task scope.
- A single-platform release binary measured 18.4 MiB; warm readiness p50 8.3 ms, first startup 642 ms, and ready engine RSS 10 MiB. Do not extrapolate to long Sessions, the full process tree, or other platforms.
- Preview rollback has been exercised; formal product publication still requires acceptance.
- #589 blackbox supports strict TS semantic-boundary replay and Rust provider replay; partial-response interruption now preserves the recorded payload bytes exactly. Native Rust tool-result substitution and common product-history normalization are still missing at this snapshot.
- **Evidence is not yet sufficient to establish higher quality, fewer tokens, and shorter latency simultaneously across a representative task set.**

## 4. Track A: task quality and efficiency

Establish reproducible outcome measurements first. Then prioritize fewer errors and wasted turns, less redundant context, and less serial waiting. Choose candidate mechanisms by measured benefit.

| ID  | Work item                                                            | Current status                                                                                                     | Next deliverable and acceptance                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Real-task evaluation and efficiency baseline                         | Complete 2026-10-14: frozen suite v2 with long-session, N=8 live baselines on both engines, all-attempt usage, profiles, receipts, phase latency, and a recorded long-session pass (live-eval.md) | Numeric budgets per task from the recorded baseline |
| A2  | First-attempt edit success and low-token editing                     | Complete 2026-10-14: snapshots + anchored rebase (#804), drift control (#805), the v3 multi-line carrier measure (-21% turns, -22% input tokens, -18% p50 at 8/8 both arms), and the short-anchor syntax/wording ablation (#829: the wording measured worse, 33-38% more turns, 35-44% more billed input, new ambiguous-edit rejections; guidance reverted while the concise form stays accepted) | — |
| A3  | Precise retrieval and minimum necessary reading                      | Partial+: line-window reads landed (#811) with the mutation and patch bounds raised to match (#818); measured on the v4 carrier (with shell: neutral 4/4 both arms; without shell: 0/4 pre-A3 vs 4/4 fixed) and reported across the wider task set | — (the large-file edit gap it exposed is fixed in the mutation read take bound, with its test restored) |
| A4  | Context selection, recoverable output archives, automatic compaction | Partial+: Epoch, explicit compact, recall, and output limits exist; pruned tool output is recoverable on demand by the handle its elision marker names (#824) | Budget-aware selection and automatic summaries; retain objectives, open tasks, verification results, and opaque state; measure long-task quality and total compaction/rereading cost                                |
| A5  | Cache stability and provider-cache policy                            | Partial+: stable Epoch foundations and an explicit --prompt-cache on|off policy (#827); prefix stability is asserted in tests and cache reads measured at 11-32% of billed input on suite-v3 | Cache lineage reporting plus per-provider billed cache read/write and TTFT measurement; prefill/incremental transmission are candidates |
| A6  | Bounded parallelism and conflict-aware scheduling                    | Partial: tool RwLock, cross-Session concurrency, and limits exist; same-turn tools still wait serially             | First parallelize independent reads within bounds, then evaluate path-level resource declarations; keep approval/execution/cancellation/settlement explainable and handle unknown external tools conservatively; measure actual overlap, critical paths, and conflicts |
| A7  | Shorter execution→diagnosis→repair→verification loops                | Complete 2026-10-14: read warm-up + post-edit diagnostics + ablation (#808, #810) with the v3 typed carrier measurement (-4% turns, -5% input tokens at 8/8 both arms; zero measurable wait cost on type-clean edits), and the --verify-command completion check (#822) | — |
| A8  | Prevent wasted loops and bound failures                              | Complete 2026-10-14: empty-completion continuation and classified closure (#813), goal-loop stall closure, and per-run loop counts in the evidence (#814) | — |
| A9  | Purpose-role model selection                                         | Partial: primary/fallback routing exists; complete role routing pending                                            | Evaluate small fast models for auxiliary summarization/retrieval/verification first; define capability compatibility and escalation; aggregate every model and failed attempt's costs and verify quality does not decline                                              |
| A10 | Net-beneficial delegation and batch workflows                        | Partial: subagent and worker foundations exist                                                                     | Minimal task packages, structured results, reference rereading, independent verification, and batch-tool boundaries; measure parent+child total tokens, wall time, and merge rework; choose delegation by task                                                         |

**Implementing a mechanism does not complete its efficiency acceptance.** Tool RwLock is not same-turn parallelism; explicit compaction is not automatic context management; model fallback is not role routing; worker transport does not establish existing-plugin compatibility.

## 5. Track B: usable product and delivery

This track makes optimizations usable in the real product while preserving reliability. Minimal integration can proceed alongside track A, but mechanically recreating old interfaces does not replace task-benefit work.

| ID  | Work item                                        | Current status                                                                                                                            | Completion conditions                                                                                                                                                                                           |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Product execution facade and lifecycle           | Partial: `packages/miao/src/engine/{client,session,event,bridge}.ts` and `ClientEvents` exist; product Session handlers still use TS core | Wire Location/engine ownership, startup/shutdown, and configuration mapping; route actual session/message/permission/question/fs/lsp and runtime/mcp execution surfaces through the engine                      |
| B2  | Product events, history, and live interaction    | Partial: prompt/full text/tool/approval bridges exist; progress is not wired through the full product chain                               | Consistent text/reasoning/tool-input deltas, usage/error/retry, question responses, status/compaction/rollback, snapshot/history/replay; preserve exact input IDs, queue delivery, and attachments              |
| B3  | Extensions, credentials, and protocol completion | Partial: worker/MCP/read-only credentials/ACP foundations exist                                                                           | Actual plugin/workflow compatibility; one product-owned refresh writer; actual ACP authenticate/resume/close semantics and config/usage coverage; prioritize added provider/MCP/LSP surfaces by task demand     |
| B4  | Product acceptance and cross-engine comparison   | Partial: two-Rust-sidecar tests and blackbox exist                                                                                        | Actual client attachment to both engines; approvals/cancellation/reconnection/long Sessions pass; add tool-result substitution and common-history normalization and identify intentional behavioral differences |
| B5  | Installation, formal updates, and rollback       | Partial: Actions artifacts/checksum manifests, local installer, and preview rollback exist                                                | Formal engine distribution, version/channel/upgrade handling, release-channel rollback; verify platform confinement and product support scope individually                                                      |
| B6  | Default switch and legacy-core retirement        | Pending                                                                                                                                   | Every switch gate passes; explicitly migrate existing Sessions or retain a readable path; one authority per Session, no double writes, and eventual removal of the second execution core                        |

Decide an independent credential broker, additional providers, full media/LSP/MCP surfaces, terminal-multiplexing APIs, host-service migration, and a fully Rust shell from actual task and maintenance benefits.

Recently landed product-integration evidence (2026-10-12), recorded without changing any status above:

- A durable `session_engine_placement` catalog binds each Session's engine, native storage, and Location atomically; exact retries adopt the binding and cross-engine/storage/Location takeover is rejected. Location resolution now treats that catalog as the routing authority and never reads or heals TS metadata for a Rust-owned Session.
- Client-only assistant-identity and per-attempt provider request/result receipts are delivered on the product stream, bound to their durable cursor, without writing the TS journal. They are evidence for clients; no product UI consumes them yet.
- Strict offline replay preserves recorded partial-response bytes exactly, and WAL enablement retries when another window holds the database. A single all-Rust binary is the end-state direction of the existing migration design. Revise the ADR and use experience/startup/maintenance data to decide whether and when to migrate the shell.

## 6. Stage gates and execution order

### R0 — Comparable, explainable task baseline (partial; next priority)

Complete A1: fixed tasks, initial workspace/commit, model/configuration, oracle, repetitions, and reporting definitions. Cover small fixes, multi-file changes, unfamiliar-repository navigation, test-driven repair, long Sessions, tool failures, and interruption recovery. Include failed tasks instead of selecting only successful runs.

### R1 — Fewer errors and wasted turns (partial)

Prioritize A2/A3/A7/A8: editing, navigation, verification, and failure limits. Ablate mechanisms individually to identify where benefits come from; independently evaluate new editing syntax and reminder wording. Acceptance includes correctness, unintended changes, rework, wasted turns, and human correction.

### R2 — Less context and shorter critical paths (partial)

Advance A4/A5/A6, then choose A9/A10 from data. Count all additional summarization, caching, parallelism, and delegation costs. Compaction or smaller models must not degrade long-task completion quality.

### R3 — Usable product and reproducible outcomes (partial)

Complete B1–B4: connect one actual client task path first, then expand coverage. Use product events/history for acceptance and replay to locate regressions. Fixed recordings verify behavior; live evaluation verifies real quality. Both are necessary complements.

### R4 — Publish and switch the default (acceptance pending)

Complete B5/B6 and satisfy all of the following:

1. Representative-task quality is at least as good as the fixed baseline, with explainable quality/efficiency improvement evidence.
2. Token/cost and end-to-end latency reports are complete, with differences reported by task class rather than claiming every task is cheaper and faster.
3. User-required capabilities pass acceptance and replacement experiences are explicitly accepted; cancellation/recovery/approval/slow-client behavior does not regress.
4. Session and credential ownership are singular, and actual product installation/upgrade/rollback passes.
5. Actual execution and confinement are verified on supported platforms; public versions/artifacts/acceptance commits are traceable.

The earlier M0–M4 labels remain historical infrastructure milestones: M0/M1 core gates passed; M2 engine-side work passed but clients remain incomplete; M3 foundations exist but role/extension product benefits are not fully verified; M4 delivery is partial. **These labels do not replace R0–R4 task-efficiency gates.**

Current priority queue: **A1 → A2/A3/A7/A8 → A4/A5/A6 → data-driven A9/A10 selection**. Advance the minimum viable B1/B2 path in parallel, and close B3–B6 according to actual dependencies. Do not assume optimization benefits or completion dates.

## 7. Shared measurement and adoption rules

| Dimension   | Required reporting                                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quality     | Oracle success rate, first-attempt edit success, unrelated-content preservation, rework, and human correction; state manual standards for tasks that cannot be automatically judged                        |
| Tokens/cost | Input/output/reasoning/cache read/write for every primary/child/auxiliary model, retries, summarization, and failed attempts; missing usage is unknown, not character-count estimates presented as billing |
| Time        | Admission→first semantic output, total time through completed verification, and provider/tool/approval/queue/summarization phases; repeated runs report p50/p95 and sample counts                          |
| Resources   | Engine and full-process-tree RSS, cold/warm startup, FDs, and long-Session curves under consistent platform/concurrency/configuration conditions                                                           |
| Reliability | No rerun of unknown side effects, exact retry, cancellation settlement, replay handoff, slow clients, and cross-engine isolation                                                                           |

TS is the migration baseline. Compare mechanism benefits first against a Rust control using the same model, task, and environment. Report model/price changes separately in routing experiments rather than attributing stronger-model effects to the runtime. Report billed tokens, actual context volume, cost, and cache hits separately.

Fix the task set, initial files, and validators, and use isolated workspaces and fresh databases. Do not change validators or omit necessary verification to shorten latency. Long tasks include mid-run steer, post-compaction recovery, and objective-completion checks. Publish repetition counts, variance, and failure distributions; insufficient samples do not justify hard benefit promises.

For each adoption, record **problem → reference mechanism → local implementation evidence → A/B/ablation results → default-enable decision**. Keep mechanisms without net benefits experimental or remove them. Keep detailed external research and machine-specific environment information private; public documents contain verifiable mechanisms and necessary code-license/source notices.

## 8. Maintenance rules

- Each related PR updates the corresponding A/B item's status, implementation links, and remaining acceptance. Define the objective and oracle before adding a mechanism.
- Mark foundations complete only after functional contracts pass; mark benefits verified only with sufficient live-task evidence. Record publication separately.
- Synchronize progress with the inventory and documentation entry points so READMEs do not continue listing implemented capabilities as missing.
- Preserve ADR invariants: one durable authority, supervised tasks, bound approvals, explicit unknown recovery, and safe fallback.
- Update this status snapshot with evidence; retain historical tests/measurements with their dates, conditions, and commits rather than overwriting them as current conclusions.
