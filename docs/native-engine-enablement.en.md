# Enabling the native engine: scope, gaps, and efficiency evidence

[简体中文](native-engine-enablement.zh.md)

This document answers three questions: once a Session is placed on the native (Rust) engine, **which capabilities become available**, **what is missing relative to the TypeScript runtime**, and **whether there is evidence that performance, token consumption, and task quality are "not below" the TS implementation**.

Every code entry point and document cited points at the current `main`. Progress status is owned by the [roadmap](roadmap.md) and its §9 enablement gates; the engine-side evidence lives under `crates/miao-engine/docs/` (`inventory.md`, `live-eval.md`, `switch-plan.md`, `product-acceptance-matrix.md`).

## 1. What has to be enabled

Two switches decide a native Session, and both are required:

| Switch                            | Effect                                                                                                                                                                                                                                                                                                                                          | Entry point                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Engine discoverable               | Composes the native transport so `/api` can route a Session to the engine. An explicit `MIAO_ENGINE_BIN` wins; otherwise an installed `miao-engine` is discovered. `--capabilities` must report `protocol >= 2`: an explicitly named older engine fails startup, a discovered older engine is ignored and the product keeps running TS Sessions | `packages/miao/src/engine/discovery.ts`, `packages/miao/src/server/server.ts` |
| `MIAO_ENGINE_STORAGE`             | Only then does a new Session become `engine: "rust"` with engine storage. Without it, new Sessions are still created by TS even when the transport is composed                                                                                                                                                                                  | `packages/server/src/handlers/session.ts`                                     |
| Optional global `engine.*` config | Model/endpoint, roles, prompt cache, Responses contracts, MCP/LSP/hooks config paths, `context_limits`, and so on; the environment overrides it key by key                                                                                                                                                                                      | `packages/schema/src/config.ts`, `packages/miao/src/engine/native-engine.ts`  |

Placement is **per-Session and immutable**: the placement catalog is the routing authority, cross-engine/storage/Location takeover is rejected, and legacy TS Sessions keep their TS owner (`packages/core/src/session/engine-placement.ts`, `projector.ts`, `routing.ts`). Moving an existing Session to the other engine requires an **offline migration** (freeze, transfer bundle, takeover after import); there is no live flip (`packages/core/src/session/migration.ts`, `transfer-bundle.ts`).

## 2. What a native Session gains

- **Session core is entirely native**: durable admission, exact retry, steer/queue, resume, fork, revert/unrevert, compaction, recovery, cancellation cascade with process-group cleanup, and `tool.started`/`tool.progress` increment reporting.
- **Tool surface**: the engine catalog (`read_file`/`read_image`/`list_files`/`glob`/`grep`/`write_file`/`edit_file`/`apply_patch`/`bash`, `start_job`/`job_status`/`cancel_job`, `task`, `todowrite`, `goal`, `question`, `recall`, `session_state`, `schedule_wakeup`/cron, `lsp_*`, `monitor`, webfetch/websearch, knowledge, skill, session terminals). The mapping from engine tool names to product renderer ids is in `crates/miao-engine/docs/facade-mapping.md`.
- **Extension surface**: MCP (stdio/HTTP, resources/prompts, OAuth, `list_changed` refresh, `tool_search` discovery), lifecycle hooks, the ADR-12 worker (custom tool files under `.miao/tool`, `.opencode/tool`, and `MIAO_CONFIG_DIR`), Session-owned terminals (Unix), and LSP (its manifest is generated from product config).
- **Model and routing**: routes generated from a host manifest (Anthropic, OpenAI Chat/Responses, subscription Responses, Gemini, Bedrock SigV4 or bearer, Copilot-style auth, declarative Azure/Vertex routes), per-Session model binding with variants, purpose roles, prompt cache, and Responses cache/WebSocket contracts.
- **Context**: ambient context (instructions/skills/references mapped into host manifests), automatic compaction and tool-output pruning (**requires `engine.context_limits`**, see §3), recall, and the Context Epoch.
- **Observability**: per-run usage aggregation, per-turn billed cache lineage (read/write/nonCached/hitRatio), and TTFT written into the `engine_timing` side table rather than into replayed payloads.
- **Protocol surface**: stdio, loopback HTTP (with SSE), and an ACP stdio adapter.

The engine also carries mechanisms that were measured with ablations: same-turn declared-read parallelism (A6), line-window reads with anchored edits and drift control (A2/A3), the `--verify-command` completion check, output pruning that stays recoverable by the handle its elision marker names, and post-edit diagnostics with read warm-up (A7). These are engine implementations; TS has partial counterparts (read `offset`/`limit`, edit snapshots, post-edit LSP diagnostics, `packages/core/src/session/prune.ts`), so do not count them as pure native additions.

## 3. Gaps relative to TypeScript

| Gap                                    | Current state                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Product-level tools                    | `send_message`, `list_sessions`, `read_session_context`, delegation `report`, `workflow`, worktree, and `push_notification` are registered by the TS runner (`packages/core/src/session/runner/llm.ts`). The engine-side reverse bridge exists (`crates/miao-engine/src/product.rs`, `tools.rs`, `--product-tools`), but the TS host neither writes that manifest nor answers `product_tool` requests, so native Sessions cannot call this set today | `54357739c0` (#1027, labeled draft)                                                                          |
| Narrower plugin surface                | A native Session covers custom tool files, the hooks manifest, and MCP only; plugin `tool.definition`/`before`/`after` hooks do not run, and a plugin-provided non-standard AI SDK provider is not mapped into a route                                                                                                                                                                                                                               | `crates/miao-engine/docs/product-acceptance-matrix.md` (G6), `packages/miao/src/engine/product-routes.ts`    |
| Different automatic-compaction default | TS ships `auto: true` with a 0.9 threshold; the native trigger is `engine.context_limits`, so **leaving it unset means off**, and long Sessions reach the window sooner                                                                                                                                                                                                                                                                              | `packages/core/src/session/compaction.ts`, `packages/schema/src/config.ts`, `crates/miao-engine/src/main.rs` |
| Cost display                           | Native pricing is still read as zero until price resolution lands; the full cache/TTFT presentation matrix and per-model usage summaries are not closed                                                                                                                                                                                                                                                                                              | `crates/miao-engine/docs/product-acceptance-matrix.md`                                                       |
| Windows                                | Native terminal tools are not advertised; ConPTY falls back to an unconfined console when the OS cannot combine it with a container; confinement and upgrade/rollback acceptance is incomplete on all platforms                                                                                                                                                                                                                                      | same, `crates/miao-engine/docs/inventory.md`                                                                 |
| Credential ownership                   | The engine reads the credential store read-only; the TS broker (or the standalone credential daemon) stays the only refresh writer, and an expired credential fails with an explicit error rather than refreshing itself                                                                                                                                                                                                                             | `crates/miao-engine/docs/facade-mapping.md` (ADR-09)                                                         |
| Client coverage                        | A real attached TUI is verified (approvals, cancellation, streamed rendering, replay); the app (web/desktop) transcript retype is still in progress; a third-party ACP editor UI, slow-client backlog bounds, and real-client reconnection are unverified                                                                                                                                                                                            | roadmap §1.2, `crates/miao-engine/docs/product-acceptance-matrix.md`                                         |
| Live account acceptance                | Daily sessions on real Gemini/Anthropic accounts are blocked on credentials and still open                                                                                                                                                                                                                                                                                                                                                           | roadmap §6, §9.4                                                                                             |
| Storage and downgrade                  | A native Session lives in the engine's own store; cross-version data downgrade compatibility is unverified and rollback is "reinstall the previous release"                                                                                                                                                                                                                                                                                          | `switch-plan.md` (G4), the roadmap's rollback section                                                        |

## 4. Efficiency evidence today

| Dimension       | What exists                                                                                                                                                                                                                    | Can "not below TS" be claimed?                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task quality    | Two small-task sweeps with a real model: 6 classes × 8 → Rust 48/48, TypeScript 47/48; 3 classes × 3 → 9/9 for both                                                                                                            | **No.** Small samples of short, programmatically gradable fixes; R4.1 (representative-task quality at least as good as the baseline) is still pending acceptance |
| Latency         | Same sweeps: Rust p50 22 s / p95 27 s, TypeScript p50 26 s / p95 29 s; engine-only warm readiness p50 8.3 ms, cold start 642 ms, ready RSS 10 MiB                                                                              | Only slightly lower on those small tasks; the engine-only numbers are not end-to-end                                                                             |
| Tokens and cost | See §5: 15 classes × 3 runs × both engines, with per-class billed input, cache, output, and cost. The measurements document itself records no cost/context figures, and switch-plan's G5 is still blocked on a budget decision | Partial: §5 gives a direction and a break-even point, but one model at n=3 is not enough to serve as R4.2 acceptance evidence                                    |

Two structural risks move tokens and quality in an unpredictable direction:

- **Prompt and tool-schema bytes differ.** The facade maps tool names only; the input schema and descriptions are the engine's own, so the system prompt and tool catalog are not byte-identical to TS. A recorded wording change cost **+35–44% billed input** (#829, reverted). That changes billing and model behavior alike, so "equivalent wording" cannot be assumed.
- **Compaction and pruning defaults differ.** TS enables automatic compaction by default; the native trigger needs an explicit `engine.context_limits`, so a long native Session can be both more expensive (context growth) and more likely to fail early.
- The engine's own positive ablations (A2: −21% turns / −22% input tokens on the multi-line carrier; A7: −4% turns / −5% input tokens on the typed carrier) hold on their individual carriers; they were not verified on a representative task set and do not extrapolate into "cheaper on every task".

**Conclusion.** Functionally, a native Session can cover the main path without gaps in the core loop; quality is not below on the existing small samples, and §5 adds a per-task-class billed token and cost comparison. That is still not a product-level evaluation: small samples, one model, only programmatically gradable tasks, and one class (`stream-interruption`) that cannot be measured on the current route. A stronger claim still needs the roadmap's §7 dimensions — primary, child, and auxiliary models, retries, summarization, and failed attempts — across more task classes.

## 5. Measured comparison (2026-10-19)

The raw data, manifest, reproduction commands, and comparison tool live in [experiments/2026-10-19-native-engine-suite-v6](experiments/2026-10-19-native-engine-suite-v6/README.en.md): the frozen suite v6 (15 classes) run **3 times on both engines — 90 live model runs** — with both arms on the same `main` commit `83f7c4f9`, sequentially so provider capacity is never shared, on one model `deepseek-v4-flash` (TypeScript through the `deepseek/` provider, the native engine over the `openai-chat` protocol).

Billing convention: `inputTokens` is the inclusive total, so billed input is `inputTokens − cacheReadTokens`. Rates are catalog list prices (input $0.15/M, output $0.60/M, cache read $0.003/M, cache write $0), and the amounts come from the product's own `SessionRunnerCost.ofTurn`, checked against a per-category manual sum.

| Engine | Passed      | Turns         | Billed input | Cached input | Hit rate | Output | Cost         | p50   | p95    |
| ------ | ----------- | ------------- | ------------ | ------------ | -------- | ------ | ------------ | ----- | ------ |
| TS     | 39/45 86.7% | 233 (5.18/r)  | 605,554      | 2,892,288    | 82.7%    | 22,890 | $0.11324     | 7.6 s | 34.9 s |
| RS     | 42/45 93.3% | 500 (11.11/r) | 154,295      | 3,345,021    | 95.6%    | 92,838 | **$0.08888** | 9.0 s | 28.3 s |

**Which is cheaper.** The native engine costs **21.5% less** (ratio 0.785), passes more runs, and trades a slightly slower p50 for a better p95. The money moves in opposite directions:

| Billed category        | TS      | RS      | Difference   |
| ---------------------- | ------- | ------- | ------------ |
| Billed input × $0.15/M | $0.0908 | $0.0231 | **−$0.0677** |
| Cache read × $0.003/M  | $0.0087 | $0.0100 | +$0.0014     |
| Output × $0.60/M       | $0.0137 | $0.0557 | +$0.0420     |

The native input is cheaper (roughly 4.9k first-turn prompt against TS's 14k, hit rate 95.6% against 82.7%) and its output is more expensive (11.1 turns per run against 5.2, 93k output tokens against 23k). **Break-even: the verdict flips once output is priced at least 6.32× input**; this model is at 4.0×.

Per-class ratios (RS/TS):

| Class               | Ratio | Class             | Ratio | Class         | Ratio    |
| ------------------- | ----- | ----------------- | ----- | ------------- | -------- |
| stream-interruption | 0.06  | permission-denial | 0.35  | create-module | 0.61     |
| multi-read          | 0.12  | multi-line-edit   | 0.34  | typed-repair  | 0.61     |
| tool-error          | 0.13  | small-edit        | 0.43  | multi-file    | 0.67     |
| read-only           | 0.19  | test-repair       | 0.46  | docs-sync     | 0.85     |
| rename-symbol       | 0.50  | large-file        | 0.47  | long-session  | **3.43** |

14 of 15 classes are cheaper on the native engine (0.055–0.847); the exception is `long-session` (82 turns per run against TS's 17, at 3.43×). **Excluding that class: TS $0.10003 against RS $0.04356 — the native engine is 56.5% cheaper.**

**Repeat runs and a second model.** A second round of the same suite and model (n=3) gave ratio **0.881**, break-even **4.98×**, and **0.408** excluding `long-session`; a third round on the gateway model `opencode-go/deepseek-v4.1-flash` ([record](experiments/2026-10-19-opencode-go-suite-v6/README.en.md)) gave **0.690**, **8.56×**, and **0.459**. All three agree on direction: the native engine is cheaper overall (11.9%–31.0%) and 54%–59% cheaper once the long-session class is excluded, while the exact magnitude follows the model and task mix; the turns/output spread in `long-session` (2.2×–4.3×) is the main source. One round therefore establishes a direction, not a magnitude; a cost claim should run the same configuration at least twice and report every round.

Two behavioral differences:

- `permission-denial`: TS 0/3 (completes with only a `tool.error`, missing the `permission.denied` receipt the task requires), RS 3/3 (both receipts present).
- `stream-interruption`: 0/3 for both arms, for a protocol reason rather than an engine one (the interruption proxy targets Responses/SSE, so on the `openai-chat` route TS is SIGINTed without a `provider.interrupted` receipt while RS receives provider HTTP 418). The class is not comparable on this route.

Evidence boundary: one model (output/input = 4), n=3 per class, short programmatically gradable tasks, sequential runs on one machine, ~$0.20 for both arms combined; not a product-level or cross-model claim. These numbers hold because two harness defects were fixed first — the TypeScript leg dying in the receipt fingerprint on `undefined` observations, and multi-input runs keeping only the last input's provider interactions — and both fixes are merged.

## 6. Minimum configuration to enable it today

1. Set `engine.context_limits` to match the TS automatic-compaction behavior; without it a long Session has no automatic compaction.
2. Decide `engine.prompt_cache` and the Responses cache/WebSocket contracts, declaring only deployments that were actually verified.
3. Keep `engine.tool_disclosure: full`; `compact` is opt-in and its documentation explicitly does not promise a lower total cost.
4. Confirm credentials are still refreshed by the product broker; the engine only reads them.
5. Accept the missing product-level tools for now, or wire the host side of the product-tool reverse bridge first.
6. Pin the binary with `miao-engine --capabilities` and `miao-engine doctor`; native storage is separate from TS storage, and rollback means reinstalling the previous release.
