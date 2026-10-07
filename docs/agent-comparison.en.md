# Open-source coding agents: workflow and implementation differences

[简体中文](agent-comparison.zh.md)

Codex CLI, Gemini CLI, Qwen Code, opencode, Kimi Code, DeepSeek Harness,
oh-my-pi and miao can all read code, edit files and run commands around a model.
The differences that affect daily work are often **how tools are scheduled,
how long-running work is handled, how context is managed, and what happens
when something fails**—not just the number of models or tools supported.

This page is maintained by the miao project and includes miao's limitations.
**Reviewed: 2026-10-07.** It compares the source snapshots cited below, not eight
released binaries tested side by side. Some snapshots are development or nightly
code. Support does not mean enabled by default; “not observed” is limited to the
paths inspected. We have not run all projects on one task set, so there is no
aggregate score, ranking, or claim that one is universally faster or cheaper.

## Start with the workflow you care about

These are trial starting points, not a recommendation ranking. More than one
project may fit a particular need.

| Project | Workflow worth examining | What to check when trying it |
|---|---|---|
| Codex CLI[^codex] | Interactive commands, multi-file patches, multi-agent collaboration, and cache/transport integration with Responses backends | Incremental requests and prewarming depend on the backend; Code Mode has an experimental feature gate |
| Gemini CLI[^gemini] | Gemini model workflows, background commands, context management and model availability routing | The new context pipeline and some classifier routing are experimental; helper model calls also cost tokens |
| Qwen Code[^qwen] | Multiple provider protocols, cache-sharing compaction, deferred tools and capacity-error model fallback | Hot compaction has model/window requirements; backups need configuration; speculation is off by default |
| opencode[^opencode] | Multiple providers, terminal/graphical clients, MCP/LSP and an extensible coding workflow | This snapshot contains V1 product paths and a V2 core; do not combine their features into one assumed default configuration |
| Kimi Code[^kimi] | File-access-aware scheduling, subagent batches, adaptive concurrency under rate limits, and worktree missions | Swarm, Tower and dynamic tool loading have their own configuration; this review covers `MoonshotAI/kimi-code` |
| DeepSeek Harness[^dsh] | Profile-composed runtimes, scripted tool calls, continuable subagents and user-path performance budgets | The project explicitly identifies as experimental developer-preview software; the selected profile determines its tools and isolation |
| oh-my-pi (omp)[^omp] | Hash-anchored editing, native search/text tools, model roles and structured subagent reports | Edit formats vary by model; speculation, checkpoints and memory features have settings gates |
| miao[^miao] | Mid-task input, durable pending work, background collaboration, per-turn cost/cache visibility and mtty integration | Pre-1.0; check build provenance; no automatic post-crash continuation, and OS sandboxing is opt-in |

## Do multiple tools run together or wait?

A model proposing several calls does not guarantee parallel execution. The
scheduler still has to account for conflicts, permissions and cancellation.

| Project | Within-turn tool scheduling | Meaning and limits for the user |
|---|---|---|
| Codex CLI | Parallel-safe tools share a read lock; other tools take an exclusive write lock | The classification determines overlap; not every shell or mutation runs concurrently |
| Gemini CLI | Consecutive parallelizable calls form a wave; selected tools and `wait_for_previous` create sequential boundaries | Independent calls can overlap; dependencies still need explicit waiting |
| Qwen Code | Code Mode supports capped tool concurrency; native tool scheduling is a separate path | Script-level concurrency and ordinary calls are not interchangeable capabilities |
| opencode | V1 settles through the AI SDK; V2 eagerly starts recorded calls in fibers and joins before continuation | Behavior depends on the path; MCP Code Mode has a separate concurrency limit |
| Kimi Code | Tools declare read/write paths; a conflict-aware scheduler runs or queues them | Work on non-conflicting files can overlap; correctness depends on access declarations |
| DeepSeek Harness | A bounded rolling pool, exclusive barriers and model-order result commits | Completion replenishes the pool; cancellation also settles started and unstarted calls |
| oh-my-pi | `shared` / `exclusive` classification, plus optional streaming speculation | Ordinary parallelism differs from execution before arguments are complete; speculation needs authorization and discard handling |
| miao | `concurrent` / `exclusive` classification; read-only tools can overlap, undeclared tools default to exclusive | Scheduling is by tool category, not file path; this snapshot has no common bounded pool for all concurrent calls |

**Tool scripts are not exclusive to one project:** Codex has experimental V8
Code Mode, Qwen a sandboxed script bridge, opencode and miao restricted
interpreters, DeepSeek Harness PTC / `run_code`, and omp eval kernels that can
call tools. Tool coverage, permission entry points and languages differ;
a yes/no checkbox loses those distinctions.

## Long commands and delegated work

A persistent shell retains working directories, variables or functions.
Background work lets the main conversation continue. They are separate features.

| Project | Long-running commands | Delegation and result retrieval |
|---|---|---|
| Codex CLI | `unified_exec` manages interactive processes with bounded output | Multi-agent tools support spawning, messaging and wait aggregation |
| Gemini CLI | Explicit background shell execution with logs and configurable inject/notify/silent completion | Subagents and structured `complete-task` results; available tools depend on the agent |
| Qwen Code | Terminal execution infrastructure exists; a PTY dependency alone does not prove every bash call shares persistent shell state | Forked agents, agent tools and worktree collaboration; read-only follow-up speculation is not a generic background agent |
| opencode | Inspected bash/shell paths spawn per call rather than sharing a persistent shell | Product-path task supports background job IDs and completion notices |
| Kimi Code | Background bash plus list/output/stop/wait tools; the inspected path spawns per call | Swarm batches and resumed subagents, with adaptive concurrency under rate limits |
| DeepSeek Harness | Persistent bash and PTY, plus owner-scoped background jobs | One-shot and continuable delegation, settlement notices and follow-up messages; profile-dependent |
| oh-my-pi | Built-in persistent shell; settings can move long commands into background jobs, collected with `wait` | Worker pools, `agent://` artifacts and schema validation; early batch launching is a separate mechanism |
| miao | Ordinary bash spawns per call; `run_in_background`, `job_*` and monitor provide background handling; terminal tools offer separate PTYs | Background child Sessions, completion notices, report retrieval and cancellation; current source can default read-only agents to background |

miao's automatic read-only background default was added **after v0.1.20**.
Background work belongs to the owning window; closing that window does not leave
a persistent execution service. Check stored history and process survival separately.

## Context, caching and model selection

Caching reduces repeated-prefix processing; pruning sends less content;
summarization creates a shorter representation and can add a model call of its
own. Lower compaction thresholds, smaller models or more concurrency do not
necessarily improve task success.

| Project | Context and cache mechanisms | Helper models and failure fallback |
|---|---|---|
| Codex CLI | Session cache keys, supported Responses/WebSocket incremental requests and prewarming, multiple compaction paths and deferred tools | Configurable review model and compaction fallback; not equivalent to generic provider rotation |
| Gemini CLI | Compression, old-output masking and distillation; experimental profiles for the new graph-based pipeline | Lightweight compression/summary models, availability circuit breaking and fallback; some complexity classification is experimental |
| Qwen Code | Provider cache adapters, deferred tools, conditional cache-sharing compaction and CJK-aware token estimates | Fast helper model; configured capacity-error fallback is forbidden after output starts and depends on retry mode |
| opencode | Anthropic cache breakpoints, pruning, summaries and full-output spill; V2 system-context baselines | Small-model title/summary paths and generation-specific retries; not evidence of one unified model fallback chain |
| Kimi Code | Session cache keys, stable tool declarations, summaries and spilled output; capability/gate-dependent dynamic tools | Explicit per-swarm model selection; no general task-complexity role router observed in the inspected paths |
| DeepSeek Harness | In-history system/tool updates to preserve prefixes, compaction, opt-in spill and selected PTC outputs | Separately configurable summary model; no general capacity-error backup-model chain observed |
| oh-my-pi | Code summaries, discoverable tools and compaction; checkpoints/rewind and image-based compaction are gated | Model roles, fallback chains and credential rotation; helper calls affect actual cost |
| miao | Stable context baselines, provider cache policy, common output previews/full-output spill, old-result pruning and summaries | Lightweight title models and optional small-model summaries with fallback; no configured main-task backup-model chain observed |

miao already has output bounding and old-result pruning; the early research
matrix's “no output governance” entry is obsolete. DeepSeek Harness likewise has
spill and persistent shell, and Codex has experimental Code Mode. Provider
pricing, cache writes and routing differ, so this table implies no fixed savings
percentage.

## Reducing rework: edits, repeated calls and recovery

| Project | Representative reliability mechanisms | Boundary to keep in mind |
|---|---|---|
| Codex CLI | Multi-file `apply_patch`, grammar-constrained tool inputs, thread/process recovery and forks | Expressing a batch does not guarantee atomic success of every operation |
| Gemini CLI | Path correction, repeated-call/content-loop detection, optional checkpoints and workspace restore | LLM edit correction is off by default; explicit restore does not automatically repair every failure |
| Qwen Code | XML tool-call recovery, thinking-tag parsing and compaction-failure circuit breaking | Recovering a tool-call format does not prove correct edit placement; speculation is not universally safe write-ahead execution |
| opencode | Fuzzy edit matching, multi-file patches, read-side LSP warmup and post-edit diagnostics | These shared features are not miao-exclusive; inspect generation-specific paths separately |
| Kimi Code | Escalating repeated-call reminders/termination and interrupted-tool results on resume | Restoring history does not make rerunning the original command side-effect-free |
| DeepSeek Harness | Repeated-call reminders, declared timeouts, persistence checkpoints and recovery budgets | Reminders do not necessarily stop execution; the project does not claim a security audit |
| oh-my-pi | Snapshot/hashline edits, stale-anchor recovery, optional model-assisted syntax repair and LSP write-through | Formats depend on the model; edit benchmark results are specific to their models and tasks |
| miao | Snapshot rebasing after fuzzy matching fails, conditional writes, LSP warmup/diagnostics and repeated-signature refusal | Rebasing needs unique bounded anchors and refuses ambiguity; no automatic post-crash execution continuation |

**Approval and OS isolation are also separate.** Codex has dedicated sandbox
policies; Gemini supports configured isolation environments; DeepSeek Harness
explicitly documents preview status and isolation limitations. miao's OS sandbox
covers bash only, is off by default, has macOS/Linux backends but no Windows
backend, and warns then runs unsandboxed when a requested backend is unavailable
unless configured to fail. Plugins, MCP and remote environments need separate
review; one “secure” checkbox cannot describe them all.

## Where miao fits, and its remaining gaps

**Direct uses:** add constraints during long tasks with a durable pending-input
record; delegate investigations to background child Sessions; inspect turn usage,
estimated costs and cache state; receive state and queue prompts in mtty. These
make work more observable, not the model inherently more capable.

**Limits to weigh as well:**

- No main-task automatic backup-model chain or credential rotation; transport retry is not model fallback.
- Tool-category scheduling is not Kimi's file-conflict scheduling and has no common bounded concurrent pool.
- Forks use new session cache identities rather than a shared-parent-key path. Providers can still match content, so this does not prove a total cache miss.
- No automatic post-crash continuation; resume explicitly. Built-in `recall` searches the current Session, not automatically distilled cross-session memory.
- Non-session service migration and interface evolution remain; the system is not complete or maintenance-free.

For the product's use cases and direction, see [Why choose miao?](why-miao.en.md).

## How to decide which works better for you

Repeat a small fix, a multi-file change and a task with a long command on the
same repository, primary model, provider quota and permission conditions where
possible. Evaluate backend-specific features separately rather than hiding them.
Record configurations, commits and task logs, then compare:

1. **Quality:** tests, requirements met and human corrections.
2. **Elapsed time:** model wait, tool work, retries and human wait—not only startup or one native function.
3. **Usage:** helper models, cache reads/writes and failed attempts; UI cost estimates alone are insufficient.
4. **Recovery:** state after disconnect, interruption or process exit, and repeated side effects on continuation.

We have not completed this shared experiment. miao's historical Rust/TypeScript
microbenchmarks, omp's editing evaluations and DeepSeek Harness's CI budgets use
different loads and endpoints; **they are not one speed leaderboard**. miao's
records remain in [Native component benchmarks](native-benchmarks.en.md).
For operation, see [the guide](guide.en.md).

## Evidence and versions

The following links pin the reviewed source rather than following default
branches. The text summarizes implementation, without rerunning every binary,
model task or security audit. An update should revise the snapshots, claims and
both languages together.

[^codex]: `openai/codex@19c4793` (2026-10-06): [Parallel gate](https://github.com/openai/codex/blob/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src/tools/parallel.rs), [Caching, transport and prewarming](https://github.com/openai/codex/blob/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src/client.rs), [Interactive execution](https://github.com/openai/codex/blob/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src/unified_exec/mod.rs), [Multi-agent tools and Code Mode](https://github.com/openai/codex/tree/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src/tools), [Compaction and configuration](https://github.com/openai/codex/tree/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src).
[^gemini]: `google-gemini/gemini-cli@ef59c53` (2026-10-06, nightly): [Scheduling](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts), [Context modules](https://github.com/google-gemini/gemini-cli/tree/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/context), [Background shell tools](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/tools/shellBackgroundTools.ts), [Routing](https://github.com/google-gemini/gemini-cli/tree/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/routing), [Availability](https://github.com/google-gemini/gemini-cli/tree/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/availability), [Loop detection](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/services/loopDetectionService.ts), [Checkpoint and sandbox documentation](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/README.md).
[^qwen]: `QwenLM/qwen-code@f338578` (2026-10-06): [Code Mode concurrency](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/docs/design/code-mode-concurrency.md), [Cache-sharing compaction](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/services/chatCompressionService.ts), [Model fallback](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/core/llm-chat.ts), [XML recovery](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/core/xml-tool-call-fallback.ts), [Fast models and speculation](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/docs/users/features/followup-suggestions.md), [Caching and tools](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/docs/users/features/context-cost.md).
[^opencode]: `anomalyco/opencode@ecc4916` (2026-10-06): [V2 runner](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/core/src/session/runner/llm.ts), [Product-path task](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/tool/task.ts), [V1 tools, LSP and shell](https://github.com/anomalyco/opencode/tree/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src), [V2 output governance](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/core/src/tool-output-store.ts), [Cache policy](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/llm/src/cache-policy.ts), [Code Mode](https://github.com/anomalyco/opencode/tree/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/codemode).
[^kimi]: `MoonshotAI/kimi-code@21406fb` (2026-09-30): [Conflict scheduling](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/toolExecutor/toolScheduler.ts), [Swarm batches](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts), [Tools and background tasks](https://github.com/MoonshotAI/kimi-code/tree/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/tools), [Output spill](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/toolResultTruncation/toolResultTruncationService.ts), [Repeated calls](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts), [Cache and tool declarations](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/kosong/src/message.ts).
[^dsh]: `deepseek-ai/deepseek-harness@5badb15` (2026-10-03): [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md), [Persistent shell](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/shell/tool-bash-persistent/README.md), [Subagents](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/subagent/tool-subagent/README.md), [Compaction](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/README.md), [Spill](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/spill/spill-policy/README.md), [PTC](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/ptc-runtime/README.md), [Guard](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/guard/README.md), [Benchmark methodology](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/benchmarks/AGENTS.md), [Safety limits](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/SAFETY.md).
[^omp]: `can1357/oh-my-pi@add251b` (2026-10-07): [Tool scheduling](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/packages/agent/src/agent-loop.ts), [Hashline recovery](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/crates/pi-edit/src/modes/hashline/recovery.rs), [Model roles](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/packages/coding-agent/src/config/model-roles.ts), [Report retrieval](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/packages/coding-agent/src/internal-urls/agent-protocol.ts), [Editing and LSP](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/packages/coding-agent/src/edit/index.ts), [Features, defaults and self-reported evaluations](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/README.md).
[^miao]: `oxdingzg/miao@4b01a140e` (2026-10-07): [Scheduling, subagents and repeated calls](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/packages/core/src/session/runner/llm.ts), [Output governance](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/packages/core/src/tool-output-store.ts), [Compaction](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/packages/core/src/session/compaction.ts), [Edit recovery](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/docs/edit-recovery.md), [Background work and lifecycle](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/docs/runtime.md), [Permissions and sandbox](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/SECURITY.zh.md).
