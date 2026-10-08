# Why choose miao?

[简体中文](why-miao.zh.md)

**If you want to add requirements while a task is running, understand context
and cost changes, and manage parallel work in your terminal, miao is worth
trying.** miao concentrates on execution, context and interaction around the
model. Model choice, MCP, LSP
and subagents are shared capabilities; the differences are how they are
combined, which states are visible, and what record remains after a failure.

This is a product-use and direction overview. **Reviewed: 2026-10-07**, against
current `main` and `v0.1.20` source. A merged change is not necessarily released.
For broader analysis, see [eight open-source agents compared](agent-comparison.en.md).

## Four situations worth trying

### The task is running, but you have a new requirement

While the agent edits code, add “keep the old configuration” or “fix the tests
before changing the implementation.” Input is recorded durably, then processed
at the next safe turn boundary by default; explicit queue waits until the
Session would otherwise become idle. You can keep participating without
interrupting and restating the task each time.

This does not preempt a running command or guarantee that the model interprets
every requirement correctly. See [input and Sessions](guide.en.md).

### A long conversation slows down, and you want to see why

miao shows per-turn usage, estimated cost and cache state. Large outputs use
bounded previews with full-output files; old-result pruning, summaries and
compaction are configurable. Use those measurements to investigate expensive
or slow turns before switching models or reshaping the task.

Estimates are not provider bills. Pruning and summaries can lose details, and
there is no fixed savings percentage. See [providers and costs](providers.en.md).

### The main task must advance without losing investigations

Delegate caller discovery, migration review or error research to a child
Session. Explicit background tasks return inspectable IDs and notify their
parent on completion. The main conversation can continue, then read the report
or send follow-up work. Project peers can also exchange permission-scoped messages.

Sessions have separate execution contexts; shared-file writes can still
conflict. Background work belongs to its window, not a persistent daemon.
See [background subagents](background-subagents.md) and [Runtime lifecycle](runtime.md).

### You run agents in several terminal panes

miao works independently. Inside mtty, it reports working, awaiting-input,
completed and error states for badges, notifications and prompt queues. The
terminal organizes panes and reminders; miao executes model tasks. Using miao
does not require changing terminals.

See [mtty's agent workspace](https://mtty.dev/mtty/) and
[Remote Control](remote-control.en.md). Remote access is optional, through your
Hub and approved devices—not an unattended cloud-task service.

## Functional differences and their boundaries

The table describes usage rather than claiming shared features as exclusive.
For differences from other implementations, see [the comparison](agent-comparison.en.md).

| Need | miao's approach and current state | Boundary to know |
|---|---|---|
| Mid-task requirements | Durable input; steer / queue promote at safe-turn / idle boundaries; released | Does not preempt the active tool; admission is not completion |
| Background collaboration | Explicit background child Sessions, reports and cancellation are released; automatic read-only background is source work after `v0.1.20` | Not a cross-machine cluster; shared-file writes still need coordination |
| Context and cost | Per-turn estimates, cache state, output governance and summaries are released; old-output pruning/automatic compaction default on and are configurable | Provider-dependent cache behavior; estimates and budgets are not billing hard caps |
| Long-task continuation | Optional todo-driven loop, iteration/stall guards and cost budget; released | Enable explicitly; no automatic post-crash continuation |
| Less editing rework | Fuzzy matching and diagnostics exist; snapshot rebasing and read-side LSP warmup are source changes after `v0.1.20` | Rebasing accepts only unique bounded anchors, not guessed replacements |
| Tool concurrency | Read-only categories can overlap; undeclared tools default to exclusive; main paths released | Not file-conflict-aware scheduling; no common bounded pool for concurrent calls yet |
| Tool scripts | Code Mode / progressive disclosure are experimental | Restricted language and tool surface, not arbitrary script execution |
| Command isolation | Implemented bash OS sandbox on macOS/Linux; off by default | No Windows backend; unavailable backend warns and runs unsandboxed unless set to fail |
| Terminal and remote integration | mtty state integration and Hub/device Remote Control paths are implemented | No Hub needed for local work; remote access requires configuration and explicit enablement; closing the window ends its connection |

Defaults, platforms and commands follow [the guide](guide.en.md),
[the configuration schema](https://mtty.dev/miao/config.json) and your installed
build. [Native benchmarks](native-benchmarks.en.md) measure internal components,
not product rankings.

## When to try alternatives as well

- For backend-specific incremental transport, prewarming or a fixed model workflow, also try Codex CLI or Gemini CLI.
- For file-conflict-aware batches and complex subagent missions, examine Kimi Code.
- For hash-anchored edits, detailed model roles and a broader toolchain, try oh-my-pi.
- To compose your own harness from profiles, examine DeepSeek Harness and its developer-preview boundaries.
- For other multi-provider workflows and ecosystems, compare opencode and Qwen Code too.

These are need-based trial directions, not rankings. **miao currently has no
main-task automatic backup-model chain, credential rotation, automatically
distilled cross-session memory, or automatic post-crash execution recovery.**
If one is essential, verify candidates' actual behavior before choosing.

## Direction of development

This is a direction-level roadmap and a place to update the product's evolution.
**It promises no dates and does not describe current features.** Candidate
changes need design, tests and real-task evidence before becoming defaults.

| Direction | Existing foundation | What to improve or evaluate next |
|---|---|---|
| **More reliable completion and recovery** | Durable input, event records, conditional writes, tool/provider retries and interruption state | Cancellation and streaming consistency; explicit unknown-result recovery; solve side-effect/idempotency boundaries before automatic continuation |
| **More stable context and caching** | Context baselines, spilled outputs, pruning/summaries and visible provider usage | Fork/helper cache affinity, recoverable pruned content, gradual tool discovery and better token decisions |
| **More controlled parallelism and model choice** | Tool-category concurrency, background jobs, subagents and helper models | Bounded/resource-aware scheduling, explicit capacity-error backup-model policy, structured reports and clearer collaboration permissions |
| **More consistent clients and integrations** | Shared protocol/clients, TUI/App/ACP, mtty and window-scoped remote access | Converge compatibility services and UI state; improve long-history interaction, Remote Control pairing/grant visibility and plugin interfaces |
| **Verifiable performance and defaults** | Mechanism regressions, component benchmarks and per-turn data | Add budgets for startup, first turn, resume and long tasks; measure elapsed time/cost/success on one task set before changing optimization or defaults |

When a direction lands, move it into current state with its release version or
source scope instead of leaving it in “future.” Concrete work is tracked by
repository issues, PRs and implementation, not an old roadmap alone.

## Start and contribute

Try one real, small task and compare quality, human corrections, elapsed time
and actual usage.

- [Install and use](guide.en.md)
- [Providers and models](providers.en.md)
- [Open-source agent comparison](agent-comparison.en.md)
- [Report an issue or suggestion](https://github.com/oxdingzg/miao/issues): include build version, configuration, task logs and expected/observed behavior

Implementation references: [execution](../packages/core/src/session/runner/llm.ts),
[input admission](../packages/core/src/session/input.ts),
[output governance](../packages/core/src/tool-output-store.ts),
[compaction](../packages/core/src/session/compaction.ts), [edit recovery](edit-recovery.md),
[read/LSP](../packages/core/src/tool/read.ts), and [permissions/isolation](../SECURITY.md).

For source attribution and licensing, see [project origins and licensing](attribution.en.md).
