# miao Roadmap — Remaining Work

Status snapshot: **2026-10-05**, latest published tag **v0.1.4** (0.1.5–0.1.7 prepared;
0.1.8 open in PR #151).

This is the single authoritative inventory of every open item in the V1→V2 rebuild. It replaces
the earlier distributed trackers (the remaining-work checklist and handoff, the V2 todo list, the
P7 route inventory, the app API migration checklist, and the publication/performance/storage
handoff), which are archived under `docs/archive/`. Each item states its status, the exact code
entry points where known, and an observable acceptance check.

## How to read this

- **Status**: `open`, `partial` (some slices landed), or `blocked`.
- **Acceptance** is the observable proof the slice is done, not just "code merged".
- Ordered by the **Next up** list below, then by section.
- Ground rules that apply to every slice are collected at the end.

## Already done (context, not remaining)

- V1 session runtime, tools, and the `/session/*`, `/permission/*`, `/question/*`, `/sync/*`
  route groups are deleted. The server mounts `/api/*`, OpenAPI docs, and the embedded UI only.
- V1 retirement Stages 1–5 have landed. Creation is V2-native (`session.next.created.1`); the V1
  projector and `packages/core/v1` schemas remain only for legacy DB reads, backfill, compact, and
  restore.
- Every shipped client — TUI, `--mini`, ACP, `miao run`, web/desktop app — reads and
  writes through `/api/*`. The TUI has **zero** legacy SDK calls left.
- The app moved off the vendored upstream client to `@miao/client`; the `detectServerProtocol` and
  `protocol === "v1"` branches were removed. The TUI console/org switching feature was deleted.
- SendMessage first slice, the content-addressed Blob store, the durable event tail, and most
  G2/G3/G9/G11/G13 slices are done.
- Storage recovery acceptance for the 2026-10-04 snapshot is complete.

## Landed since the 2026-10-04 snapshot

- **V1 residue**: project persistence moved into core and the legacy `packages/miao` `Project`
  facade retired (#35 #36 #46). `PluginInput.client` now exposes the V2 `@miao/client` and the V2
  plugin entry point (`@miao/plugin/v2/promise` / `@miao/plugin/v2/effect`) exists; the V1 `Hooks`
  entry is deprecated (§1.1).
- **V2 architecture**: durable background jobs with lifecycle, restart recovery, and
  observation/control tools (#111 #133 #105 #144) and durable background subagent handoff (#144);
  `failInterruptedTools` distinguishes undispatched from unknown-outcome calls (#101) and dangling
  tool-call openers are recovered on stop turns (#139); full shell output streams to managed
  storage (#132); ripgrep is bounded (default timeout + `Stream.splitLines` + row limit); the AST
  fuzzy edit ladder (line-trimmed, block-anchor, similarity-threshold) is implemented (#76 #80
  #103); peer messages are delivered at safe continuation boundaries with outgoing receipts (#112); provider-repetition detection covers multi-phrase loops (#53 #127).
- **Config/storage/perf**: config V1 auto-migration (`ConfigMigrateV1` in `packages/core/src/config.ts`);
  `miao db {stats,backfill,vacuum,compact,restore,externalize-blobs,gc-blobs,retention}` (#55 #56
  #61 #63 #77); durable-log read paging (#52); concurrent drain cap (#100); isolated PTY
  input-latency harness (#141) and input-timing tracing.
- **New stream (see §8)**: hub auth/directory/relay (#98 #99 #109 #110), remote-control
  channels/grants (#67 #70 #71 #87 #90), iOS app and pairing (#72 #85 #96 #125), Command Code
  provider (#129 #138 #149).
- **Context management (compaction)**: proactive compaction summarizes **once** over the warm
  request prefix instead of re-embedding the history in bounded stages, which on a 1M-token window
  measured **43 minutes** with no progress in the log (#698). The trigger is anchored on the
  provider's own count for the previous request plus the messages appended since it, and bounded by
  `max(window − headroom, window × threshold)` rather than a bare ratio (#700); the staged fallback
  reports a slice plan and per-slice progress and stays interruptible (#701); the auxiliary model is
  chosen by **price within its provider** rather than by name, with a plan-priced zero read as
  cheapest rather than unknown (#699); Anthropic `/messages/count_tokens` and Gemini
  `:countTokens` can count a request before it is sent, and a refused count never fails a turn
  (#704). A running compaction is now visible: the drain status carries the `compacting` phase (#709)
  and its slice progress (`8/22 slices`; #715), which the status route and the remote clients read.
  The pre-push secret scan now covers only the commits a push sends, so one stale local branch no
  longer blocks every push from a machine (#706), and the iOS enrollment fixture's dummy keys are an
  accepted finding (#707).

## Next up (ordered)

1. **§1.3** Remove the `packages/miao` `app-runtime` V1 layer and remaining non-session routes;
   switch the release server to the V2-only assembly. Finishes the V1→V2 reset.
2. **§1.2** Retire the app's legacy types, transitional session/message events, and route mocks.
3. **§2.1** Finish the runner slices: coalesce streamed deltas + covering projected-history
   indexes, drop the `@miao/llm` tool loop, expose replayable Session event cursors.
4. **§2.5** Remaining output bounds: non-streamed JSON/image body caps.
5. **§2.3** Cancellation: cascade cancel as one first-class path, incremental tool progress,
   materialize remote/managed URIs before history lowering.
6. **§2.4** Crash-recovery idempotency: idempotency key + one-shot consume token.
7. **§2.8** Extend the core sandbox to the remaining mutating tools, then default-on.
8. **§2.7** MCP progressive discovery / CIMD OAuth / deterministic `tools/list`.
9. **§2.2** ACP terminal contract (`terminal/create`, `wait_for_exit`, `kill`, `release`).
10. **§3** Finish config/plugin/service rework (nested instructions, per-service hot reload,
    providers-as-plugins).
11. **§4** Storage operational acceptance (compact `miao-main.db`, measure `miao.db`, delta-only
    events).
12. **§2.9** Design durable continuation recovery (currently blocked).
13. **§5** Produce the bilingual performance report.
14. **§7** Refresh stale guides.
15. **§6** Released-binary acceptance (mostly owner/credential-blocked).
16. **§8** Land the remote-control / Hub / iOS / push stream.

---

## 1. V1 residue — P5 (legacy SDK) and P7 (non-session routes)

**Status:** partial. Goal: the released server runs the V2-only assembly with only the CLI shell
left, and no client depends on `@miao/sdk` or unprefixed legacy routes.

### 1.1 Legacy JS SDK (P5)
The legacy V1 SDK is gone: no package depends on a V1 SDK surface, the app and CLI talk through
`@miao/client`, and `packages/sdk` is now the **embedded SDK entry point** (`OpenCode.create()` for
library use), not a legacy surface — keep it.
- [x] `PluginInput.client` exposes the V2 `@miao/client` (`OpenCode.make`) and the V2 plugin entry
      point (`define` from `@miao/plugin/v2/promise` or `@miao/plugin/v2/effect`) exists. The V1
      `Hooks` entry remains only as a deprecated shim that logs a one-time warning under V2.
- **Acceptance:** `PluginInput.client` exposes a V2 client and the V1 `Hooks` interface is either
  adapted or retired. (Met; the deprecated shim may be deleted once no consumer uses it.)

### 1.2 App legacy types and adapters
The app's network calls are migrated and the identity `server-compat` shim is gone (#40). Note that
`src/utils/session.ts` and `src/utils/session-message.ts` are current V2→view-model normalizers, not
legacy adapters, and stay. Remaining are genuine V1-shaped leftovers:
- [x] Replace `src/context/global-sync/utils.ts` agent/provider/model adapters (V2-only; the V1 rename map is gone).
- [ ] Replace legacy `Session`, `Message`, `Part`, `PermissionRequest`, `QuestionRequest`,
      `Project`, `FileNode`, `FileDiffInfo`, `Event` types across app state and rendering.
      Permissions are done (#338). The transcript is the remaining half: app state is a hybrid
      (`SessionMessageInfo` skeleton + V1 `Message` / `Part` content lookups fed by the synthetic
      events in `server-session.ts`); retype it onto V2 `SessionMessage` with parts inline.
      Consumers: `server-session.ts` (synthetic-event pipeline),
      `global-sync/{event-reducer,session-cache,session-trim}.ts`,
      `pages/session/timeline/{model,rows}.tsx`, `message-timeline.tsx`, `components/dialog-fork.tsx`,
      `components/prompt-input.tsx`, `components/session/session-context-tab.tsx`,
      `components/session/session-header.tsx`, `pages/home/home-sessions-controller.tsx`,
      `pages/layout/sidebar-items.tsx`, `pages/session.tsx`.

      Scope note: this is an epic, not a cleanup. `utils/session-message.ts`
      (`normalizeSessionMessages`) carries the rendering contract — agent/model
      context inheritance from meta messages, shell commands projected as a
      user+assistant turn pair, compaction parts, parent backfill — and
      `@miao/session-ui/message-part` renders V1 `Part` shapes, so the retype
      spans the app timeline AND the session-ui part renderers. Stage it as
      its own cutover (V2-native turn construction in `rows.ts` first, then
      session-ui renderers), mirroring how the TUI cut over.
- [x] Retire transitional session events (`session.created/updated/diff/status/idle/error`) in
      `src/context/global-sync/event-reducer.ts`, `src/context/server-session.ts`,
      `src/context/notification.tsx`, `src/pages/session/usage-exceeded-dialogs.tsx`.
- [ ] Retire legacy message event compatibility (`message.updated/removed`, `message.part.*`) in
      `src/context/global-sync/event-reducer.ts` and `src/context/server-session.ts`.
      (`server-session` still synthesizes these internally from the V2 reduction; retiring them
      is part of the transcript retype above.)
      (`server-session` still synthesizes these internally from the V2 reduction; retiring them
      needs the V2-native reduction redesign.)
- [x] Migrate LSP and reference events in `src/context/global-sync/event-reducer.ts`.
- [x] Remove the three compatibility fallbacks in `src/context/server-session.ts`
      (`GET /session/:id`, `/message`, `/message/:mid`).
- [x] Replace V1 endpoint mocks (`e2e/utils/mock-server.ts`), the `SessionV1` / legacy fixtures in
      `e2e/performance/timeline-stability/fixture.ts`, and remaining legacy SDK type fixtures
      (the files are gone).
- [x] Remaining directory config read from `GET /config`.
- **Acceptance:** the app renders and mutates with `@miao/client` types only; no legacy types in
  app state; no legacy-route mocks in tests.

### 1.3 Non-session legacy routes and server teardown
Most V2 endpoints exist (`pty.shells`, `project.update`, `vcs.diff`, `fs.content`, `config.update`,
`workspace.reset` via `/api/worktree`, `project.initGit`, `project` persistence). Remaining:
- [x] Move project persistence into core (#35, #36).
- [x] Delete the legacy `packages/miao` `Project` facade (#46).
- [x] Drop the dead V1 `@/storage` service and the `@/background/job` instance wrapper from the
      app layer; the background-job engine cases moved to `packages/core/test/background-job.test.ts`.
      The release server already assembles V2-only through `packages/server` (`assembly.ts`), and
      `RuntimeHost` builds a core-only execution runtime.
- [x] Decouple the remaining non-harness consumers from `AppRuntime`: the updater reads global
      config directly (same file order as the Config service), the TUI SIGUSR2 reload only emits
      the local disposed event (the window process holds no instances), exit paths dispose only
      when AppRuntime was used, and the unused `bootstrap`/`InstanceRuntime` Promise bridge is
      deleted. `AppRuntime` remains only inside `effect-cmd.ts` plus the control-plane worktree
      adapter.
- [x] Move the first command bodies onto core services via the location-scope pattern
      (`debug v2` was already the template): `models` reads the booted `Catalog` provider/model
      list and `debug skill` lists `SkillV2`, so neither touches the V1 provider or skill
      services. `debug config` prints the redacted core `Config.merge(entries)` and
      `debug info` derives its plugin list from the merged V2 config plus auto-discovered
      files, so neither touches the V1 config service. `debug lsp` drives the core LSP
      service (symbols now take a file to select the server) and `debug snapshot` is
      redefined onto core capture/files/diff tree semantics, replacing the V1
      git-file track/patch/diff. `mcp` now reads the merged V2 config and drives
      the core `MCP`/`McpAuth` services (auth status derives from stored tokens;
      the OAuth flow opens the browser itself, so the URL handoff is gone), so
      its add/list/auth/logout/debug paths leave the V1 graph. `providers list` and
      `logout` read and remove core `Credential` records directly (the V1
      `Auth` store's `auth.json` is legacy; core holds them in the database);
      `providers login` still runs the V1 `Auth`/`Plugin` auth-hook flow and is
      the last V1 command surface. Remaining V1 consumers: `providers login` and
      the control-plane worktree adapter.
- [x] Migrate `providers login` onto core `Integration`: the registry (populated by the
      models-catalog plugin, one integration per provider) exposes the login methods that
      V1 got from plugin auth hooks, plus `connection.key` for API keys, `connection.oauth` +
      `attempt.status`/`attempt.complete` (+ optional `code`) for OAuth, and `adoptLegacy`
      for existing `auth.json` records. Provider filtering (enabled/disabled plus the
      opencode/openai priority order) and the interactive prompts stay in the command.
      Decide the fate of the legacy `login <url>` well-known flow (`fetch
      /.well-known/opencode` + spawn auth command + store token) — it has no V2 counterpart
      and likely belongs in the same retirement as `auth.json`.
      Landed: the command opens a location scope, awaits the plugin boot barrier, offers the
      integration's key/oauth methods (with `--method` and a picker), drives `connection.key`
      or `connection.oauth` + `attempt.status` polling (prompting for the code in `code`
      mode), and awaited-approval. The V1 enabled/disabled provider lists are gone (V2 has no
      such config; the migration folds them into `provider`), so no config read remains. Both
      edge flows were retired as no V2 path can resolve their credentials: the
      `login <url>` well-known flow and the "Other" custom-provider key path (their helpers
      and tests are deleted).
- [ ] Remove the `packages/miao` `app-runtime` V1 layer: migrate `effect-cmd.ts` commands and the
      control-plane worktree adapter to core services, then delete the V1 graph.
      Inventory from the completed survey:
      - Commands reading the V1 instance: none. (`stats`, `session list`, `export`, `pr`,
        `mcp add`, `import`, `plugin`, `agent`, `debug rg`, and `marketplace` all resolve the
        project through `cli/project-context.ts` or `process.cwd()` and set `instance: false`.)
        `agent create` was reimplemented on core: it resolves a model from `Catalog`
        (`model.get`/`model.default`), gets the `LanguageModelV3` from `AISDK.language`, and
        runs `generateObject` with the existing prompt and schema — the V1
        `Agent.Service.generate` (now dead) and its prompt file are the only V1 agent pieces
        left, and they go with the module when the V1 graph is deleted. `agent list` reads
        `AgentV2.all()`.
      - The V1 workspace/adapters subsystem has no production caller (`Workspace.Service` is
        only referenced by tests), so its runtime is deleted: `control-plane/workspace.ts`,
        `workspace-adapter-runtime.ts`, `util.ts`, and `dev/*`. What survives is `types.ts`
        (the `Workspace` view model that `public-schemas.ts` keeps in the generated legacy SDK —
        shape and identifier unchanged, verified by `check:generated`) and `adapters/` (the
        plugin `experimental_workspace.register` target, itself now dead). They are entangled
        with the instance plumbing: `effect/instance-state.ts`, `effect/bridge.ts`,
        `effect/run-service.ts`, and `project/instance-store.ts` all import
        `control-plane/workspace-context.ts`, so that module moves with the instance group when
        the whole group is deleted.
      - After those, `effect/app-runtime.ts`, `effect/app-node-builder-v1.ts`,
        `project/bootstrap.ts`, `project/bootstrap-service.ts`, and the remaining V1 service
        modules (v1 config/provider/plugin/lsp/skill/snapshot/auth/worktree/…) have no
        consumers and can be deleted; `effect-cmd.ts` then assembles a core-only runtime.
      - `server/routes/instance/httpapi/public-schemas.ts` still imports the V1 `Workspace`
        module for the OpenAPI document; that reference must switch to a protocol/schema
        source before the module is deleted.
      This is a multi-PR cutover: land the command migrations first, then the instance/workspace
      deletion, then the app-layer deletion.
- [ ] Confirm V2 endpoints cover app behaviors that were silently disabled on V2 (global config
      read, project rename, directory picker, custom providers).
- **Acceptance:** `packages/miao` is only the CLI shell; the server mounts `/api/*` only; no V1
  project code remains.

---

## 2. V2 architecture gaps

**Status:** open / partial per item.

### 2.1 Native runner slices
The first Effect-native local runner is implemented. Next reviewed slices:
- [x] Preserve eager structured local-tool settlement: durably record each complete call, start its
      child execution immediately, await every settlement after the provider turn closes, then
      reload projected history once.
- [ ] Revisit per-turn tool-call limits, output truncation, and operational backpressure before
      broadening exposure. Eager local execution is deliberately unbounded today while SQLite
      publication stays serialized.
- [ ] Remove the public in-memory `@miao/llm` tool loop after replacing its remaining one-turn
      native-adapter use with a narrow typed dispatcher.
- [ ] Batch streamed deltas and add covering context indexes.
- [ ] Expose replayable Session event cursors over HTTP and the generated SDK where remote
      consumers need them.

### 2.2 Background / async jobs (G6)
**Entry:** `packages/core/src/session/background-jobs.ts`, `packages/core/src/tool/background-job.ts`,
`packages/core/src/background-job.ts`, `packages/core/src/tool/bash.ts`.
- [ ] Adopt the ACP terminal contract (`terminal/create` → `output`
      [output/truncated/exitStatus] / `wait_for_exit` / `kill` / `release`, `outputByteLimit`
      truncated from the head on a char boundary).
- [x] Integrate `BackgroundJob` with V2 tool execution: durable status, bounded preview,
      cooperative cancel, incremental delivery, completion delivery, observation/control tools
      (#105 #111 #133).
- [x] Define restart recovery and authorization before exposing remote observation (#133 #144).
- **Acceptance:** launch a background job, restart the dev server, query status and fetch exit code
  plus truncated output.

### 2.3 Cancellation settlement & tool progress (G4)
**Entry:** `packages/core/src/session/runner/llm.ts`, `to-llm-message.ts`,
`packages/core/src/tool/bash.ts`, `packages/core/src/session/input.ts`.
Progress: a stalled subagent is interrupted and child process groups are cleaned up on a parent
interrupt; interrupt clears tool fibers and fails unsettled tools while durable queued/steer input
survives; interrupting a pending permission/question publishes `Replied(reject)`/`Rejected`;
attachments are normalized by model capability at request build; tool progress events are wired
end to end (`session.next.tool.progress`).
- [ ] Cascade-cancel child fibers, drain the inbox, and settle pending approvals as one first-class
      cancellation path.
- [ ] Emit incremental tool-progress checkpoints from core tools (bash currently buffers output).
- [ ] Materialize remote and managed URIs before provider-history lowering
      (`to-llm-message.ts:80` TODO).
- **Acceptance:** interrupt a session with a child task and a pending approval → no dangling or
  lost state, no lost queue messages.

### 2.4 Crash-recovery idempotency (G5)
**Entry:** `packages/core/src/session/runner/llm.ts`.
Progress: a tool left running by a prior process is settled with an outcome-unknown error
(`failInterruptedTools`), and undispatched calls are distinguished from unknown-outcome calls (#101).
- [ ] Idempotency key (`callID` + attempt) plus a one-shot consume token.
- [ ] On restart, mark unsettled calls outcome-unknown and require explicit retry/abandon.
- **Acceptance:** kill mid-tool, resume → no repeated side effect; the model sees "result unknown".

### 2.5 Output bounds / timeouts / caps (G7)
**Entry:** `packages/core/src/tool/bash.ts`, `packages/core/src/ripgrep.ts`,
`packages/core/src/tool/{websearch,http-body}.ts`, `packages/core/src/tool-output-store.ts`.
Progress: ripgrep enforces a default 30s timeout (overridable) and bounds a scan with
`Stream.splitLines` plus a row limit; webfetch/websearch bound response bodies; MCP image results
are capped at 5 MB base64; full shell output streams to managed storage while an in-memory preview
is bounded (#132).
- [x] Stream full shell output to managed storage while keeping a bounded in-memory preview (#132).
- [x] Add bounded line framing for ripgrep.
- [ ] Non-streamed JSON/image body caps where not yet bounded.
- **Acceptance:** `yes` / huge-line output does not blow memory or hang; a long grep times out
  cleanly.

### 2.6 AST edit ladder (G8 remainder)
**Entry:** `packages/core/src/tool/edit.ts`, `edit-fuzzy.ts`, `edit-match.ts`,
`packages/core/src/snapshot.ts`.
- [x] AST-aware edit ladder ported deliberately from V1 (line-trimmed matching, block-anchor
      fallback, indentation correction, similarity-threshold review) (#76 #80 #103).
- **Acceptance:** an edit a token match would corrupt is applied structurally or refused; undo
  restores pre-edit bytes.

### 2.7 MCP progressive discovery / OAuth / CIMD (G9 remainder)
**Entry:** `packages/core/src/mcp.ts`; OAuth precedent in `packages/miao/src/mcp/{auth,oauth-provider}.ts`.
Progress: canonical MCP tool names are deduped deterministically (codepoint order, first wins).
- [ ] Progressive discovery (`search_tools` → `get_tool_details`, switch at 1–5% context, append
      after the cache breakpoint, never reorder).
- [ ] OAuth via CIMD ordering (pre-registered → CIMD → DCR → prompt), credentials keyed by AS
      `issuer`, validate `iss` (RFC 9207).
- [ ] Deterministic `tools/list` with `ttlMs`/`cacheScope` where the installed
      `@modelcontextprotocol/sdk` exposes them.
- **Acceptance:** a large MCP catalog loads lazily without disturbing the prompt-cache prefix;
  OAuth completes and credentials persist per issuer.

### 2.8 Sandbox coverage beyond bash (G12 remainder)
**Entry:** `packages/core/src/sandbox.ts` (`Sandbox.Service`),
`packages/core/src/sandbox/{runner,policy}.ts`, `packages/core/src/config/sandbox.ts`.
Progress: V2 bash and code-mode run under the core OS sandbox; a catch-all allow rule cannot lift
it.
- [ ] Extend the same core-owned sandbox to the other mutating tools (workdir, allowed paths,
      network), fail-closed, model-visible denials.
- [ ] Make the sandbox default-on for the remaining tools.
- **Acceptance:** a mutating tool inside the sandbox cannot write outside allowed paths; network
  denied when configured; denials surface as tool errors.

### 2.9 Durable continuation recovery
**Status:** blocked on explicit design. Do not infer that ambiguous provider work is safe to retry
from an advisory wake; the first inbox-driven runner intentionally omits outer provider-attempt
markers until there is a concrete consumer and a complete recovery policy.
- [ ] Design post-crash continuation recovery as one explicit slice modeling: promoted input and
      projected-history state; queued-input promotion and steering assignment; provider-attempt
      preparation vs dispatch ambiguity; required post-turn continuation across process loss;
      explicit `retry`/`abandon` for unknown outcomes; bounded automatic retry only where provider
      and tool idempotency make it safe; retry budget, backoff, visible recovery status, startup
      discovery, and future clustered ownership fencing.
- Do not introduce an enclosing durable execution identity solely to group these facts; a
  process-local Session drain has no durable transcript boundary.
- **Acceptance:** a documented policy with a concrete consumer; no inferred retry from an advisory
  wake.

### 2.10 Deferred hardening cleanup
Keep visible; do not block functionality slices unless a concrete failure appears during canary
work.
- [ ] Serialize database migration claiming across processes (currently an in-process semaphore
      only; two processes starting against one SQLite database can still race).
- [ ] Simplify the process-local durable-tail wake lifecycle with Effect `RcMap` and one shared
      `PubSub.sliding<void>(1)` per active aggregate, keeping SQLite cursor replay and
      subscribe-before-history semantics unchanged.
- [x] Page large durable aggregate replay reads instead of loading every row after a stale cursor
      into one array (#52).
- [ ] Decide whether connected tails need a periodic polling fallback for cross-process SQLite
      writers (current advisory wakes are intentionally process-local).
- [ ] Stream-cap websearch body collection before parsing.
- [ ] Materialize or consistently reject unresolved URL and file attachment sources.
- [ ] Decide stateless OpenAI Responses hosted-tool continuation behavior (reconstructed hosted
      output can replay as a stored `item_reference` when `store !== false`; `store: false`
      intentionally omits it).
- [ ] Decide whether to preserve deprecated `@miao/llm` orchestration exports.
- [ ] Preserve or alias renamed filesystem SDK generated type names if compatibility consumers
      require them.
- [ ] Revisit syscall-level mutation confinement for hostile external processes (`openat`,
      `O_NOFOLLOW`, descriptor-relative mutation where supported).

### 2.11 SendMessage remainder
**Entry:** `send_message` / `list_sessions` tools registered by the runner.
Progress: `send_message` resolves a Session ID or `@slug`, rejects missing and cross-project
targets, refuses to overflow the target's inbound queue (`MAX_INBOUND_QUEUE`), admits a queued
`<message from session="…">` input, and wakes the target through a `wake` callback on
`SessionRunner.run`. `list_sessions` enumerates sibling Sessions. Delivery asserts the `message`
permission action per target (default ask); peer messages are delivered at safe continuation
boundaries (#112) and outgoing receipts are shown. A → B delivery works in the same project.
- [ ] Loop-guard cost accounting for a receiving drain.
- [ ] Replies route back; no duplicate delivery after restart; sessions isolated from unrelated
      ones.
- **Acceptance:** A sends to B; B receives; reply routes back; restart produces no duplicate.

### 2.12 Repetitive provider output protection
- [x] Bound per-stream text/reasoning detection state, abort high-confidence short-prose loops
      without automatic retry, and preserve prior tool settlement (#53).
- [x] Neutralize recognized repetitive assistant output in provider-facing history only, retaining
      durable records and completed tool calls/results (#53).
- [x] Extend coverage beyond short newline-delimited prose to multi-phrase loops (#127).
- **Evidence:** [Investigation and limits](provider-output-repetition.en.md), including concurrent
  same-model normal-session controls. This is a client mitigation, not a proven provider root fix.

### 2.13 Engine context management and automatic compaction

**Status:** landed. The runtime runs automatic compaction with tool-output pruning behind an
explicit configuration; every checklist item below is done. The decisions live in
`src/context_trigger.rs` and are wired into the run loop: `ContextLimits` (`--context-limits <json>`,
camelCase `window`/`ratio`/`headroom`/`per_pass`, plus `prune_chars`/`protect_turns`) is the product's
opt-in — absent, the trigger is off and nothing in the loop changes (#735, #742).
`context_trigger::maybe_compact` gates on the breaker, anchors on the newest `usage` event's
normalized per-turn usage plus the message seq it counted (`Store::context_anchor`, gate ① — every
provider adapter normalizes to camelCase `inputTokens`/`outputTokens` in `src/usage.rs`), plans one summary pass over the warm
prefix the next turn would re-send (`plan_summary`, gate ③, with the bounded segmented fallback when
the prefix exceeds `per_pass`; the default 1000 equals the history selection's message cap, so any
selectable prefix is one call), and commits exactly one checkpoint through the run-owned
`history.rs::compact_for_run` contract — active run, settled provider turn, no outstanding tool
dispatch, closed assistant boundary, no backward move, idempotent per id (#734). `history.rs::compact`
stays the idle-only operator path. A refusal never fails the drain or drops history: every rejection
feeds `Breaker` and the next attempt is skipped once three consecutive summaries fail (#730, #735);
an explicit `compact` that commits a checkpoint resets that streak (#740). Gate ④ is applied:
`prune_history` elides oversized tool results from the outgoing request only, keeping the newest
`protect_turns` user messages whole and marking the cut explicitly (#742). Ephemeral
`compaction.started` (segments) / `compaction.progress` (segment i/n) / `compaction.skipped` /
`compaction.failed` (reason) / `compaction.finished` and `context.pruned` notices sit between the
durable `pre_compact` and `post_compact` events (gate ⑥). Gate ② prices exactly the
messages appended after that marker: `CompactRequest` carries a counter the runtime binds to the
session provider's own endpoint, and an unsupported or refused count falls back to the delta's char
estimate.

- [x] Anchor the trigger on the newest `usage` event's normalized per-turn usage plus the messages
      appended since that report, with the headroom spelled out (prune protection + summary output +
      slack) and the later of that and a configured ratio as the limit. Each usage report records
      `context_message_seq`, so the appended term is exact.
- [x] Count a request before sending it through the provider's own endpoint where one exists
      (Anthropic `/messages/count_tokens`; other adapters report `Unsupported`), falling back to the
      estimate and never failing a turn on a refused count (`resolve_pending_tokens`, the injected
      counter in `CompactRequest`, `tests/context_wire.rs`).
- [x] Summarize once over the warm request prefix, keeping the bounded staged recovery only for a
      prefix that no longer fits, and reuse the existing checkpoint contract (idle-only, closed
      boundary, idempotent, pre/post events).
- [x] Prune tool output in the context selection so the protected output of one step bounds the
      prompt. `prune_history` applies `prune_tool_output` to the outgoing request only: the newest
      `protect_turns` (default 2) user messages keep their output, each payload over `prune_chars`
      keeps a bounded head and tail around an explicit elision mark, and stored history is untouched
      (`tests/context_prune.rs`).
- [x] Trip a breaker after N refused summaries, reset by an explicit `compact` request. Three
      consecutive rejections trip it; an explicit `compact` that commits a checkpoint resets it
      (`Runtime::reset_compaction_breaker`, called from the host's `compact` dispatch,
      `tests/compaction_breaker.rs`).
- [x] Publish progress between `pre_compact` and `post_compact` (slice i/n, characters covered) so a
      client can render it. Progress is ephemeral (segment i/n counts, not characters).
- **Acceptance:** a 1M-window engine Session compacts in one provider call; no compaction crosses the
  headroom; a refused summary trips the breaker without dropping history; progress is observable;
  `cargo test -p miao-engine` covers each item above. The decision functions have unit tests
  (`src/context_trigger.rs`), pruning and the breaker reset have integration tests
  (`tests/context_prune.rs`, `tests/compaction_breaker.rs`, `tests/context_wire.rs`), and
  `tests/compaction_acceptance.rs` drives a real drain through the runtime and asserts the acceptance
  facts end to end: one provider call compacts the crossed session, the checkpoint lands through the
  durable lifecycle with the next turn starting from the summary alone, progress is observable, and a
  second crossed turn compacts again. The literal 1M-window live model run is still not recorded, and
  remains the one acceptance item without evidence.
- **Evidence:** `crates/miao-engine/README.md`, `src/context_trigger.rs`, `src/runtime.rs` (the
  settled-boundary call site), `src/history.rs::compact_for_run`, `src/usage.rs` (normalized usage),
  `--context-limits`, `PROTOCOL.md` (`compact`, `pre_compact`/`post_compact`), and the TS
  implementation in `packages/core/src/session/compaction.ts`.

### 2.14 Compaction client surface and restore budget

**Status:** partial. The visible half has landed, the restore budget has not.

- [x] Make a running compaction visible from the **drain status** rather than a new event: the
      status could not say `compacting` at all, so clients that read it (the app's thinking row,
      remote control) could not tell a summary in flight from any other wait (#709). The TUI was
      never in that position — it infers the phase from `compaction.started`/`ended` in its own
      store — so the status path now agrees with it instead of being a second, driftable copy.
- [x] Publish the slice plan and each slice as progress on that status (`stage`/`stages`), with the
      coordinator treating a slice update as worth publishing and **not** restarting the phase clock
      a client is already showing, and render it as `Compacting context · 8/22 slices` (#715).
      Deliberately not a `session.next.compaction.progress` event: progress is what the session is
      doing *now*, which is exactly what the status is for, and it expires with the phase.
- [ ] Give the first turn after a compaction a restore budget for re-reading the files the summary
      says matter, bounded per file and per compaction, so a checkpoint does not cost the model its
      working set.
- [x] Optional polish: render the streaming summary text mid-flight. The app folds `.delta` fragments
      into an unsettled draft the transcript renders as plain assistant text and swaps for the settled
      checkpoint on `ended` (a refused or failed summary publishes no `ended`, so the app drops the
      draft when the drain leaves the `compacting` phase); the TUI keeps its refresh-on-`ended`
      projection, where the phase and slice progress (#709 #715) already carry the wait.
- **Acceptance:** the first turn after a checkpoint can re-read the working set within its budget
  without re-compacting. Visibility acceptance is met (#709 #715): both clients show the phase and
  slice progress while a compaction runs.

---

## 3. Config, plugins, services

**Status:** partial — the plugin API and config migration landed; service hot-reload and
provider-as-plugin remain.
- [x] Config V1 auto-migration (`ConfigMigrateV1`); a document with any V1 key is migrated as a
      whole (`packages/core/src/config.ts`).
- [x] A V2 plugin surface with a scoped context/registration seam exists
      (`packages/plugin/src/v2/{promise,effect}` including `context.ts` and `registration.ts` on top
      of `packages/core/src/system-context/registry.ts`).
- [ ] Nested project instruction discovery after successful reads, admitted durably at the next
      Safe Provider-Turn Boundary (`packages/core/src/instruction-context.ts` is the entry point).
- [ ] Design the server plugin API and hooks (immer drafts so bad mutations can be thrown away, a
      global instance, tool registration).
- [ ] Make every service hot-reloadable via granular events instead of teardown, so services react
      to changes and reconfigure themselves (and the frontend can receive them, e.g. `model.added`);
      this also prevents startup from blocking.
- [ ] Register providers as plugins that autoload from their own logic/config and register models
      into the model database; the auth system should track any kind of auth, not just providers.

---

## 4. Storage operations

**Status:** partial — the tooling landed; the operational acceptance remains.
- [x] `miao db {stats,backfill,vacuum,compact,restore,externalize-blobs,gc-blobs,retention}` exist
      (#55 #56 #61 #63 #77). `db stats` reports the blob store and inline base64; `db compact` runs
      the V1-table retirement (batched delete of `message.*` events, drop `message`/`part`, reset
      only emptied `event_sequence` rows, checkpoint + vacuum); `db gc-blobs` deletes unreferenced
      blobs; `db retention` reports prunable events.
- [ ] Compact `miao-main.db` (preview channel; **2.34 GB** on 2026-10-04, uncompacted) and record
      the result.
- [ ] Measure `miao.db` against the <200 MB acceptance (**876 MB** on 2026-10-04).
- [x] Delete old `miao*.db.bak-*` / `*.compacted-*` copies and the retirement stash in
      `~/.local/share/miao` (owner-approved 2026-10-04: 21 GB → 5.8 GB, about 15 GB reclaimed).
- [ ] Delta-only events: retire the V1 per-delta sync events; keep one durable row per completed
      fragment/message. (The V2 write path already persists one durable `text.started`/`text.ended`
      per fragment with no durable delta.)
- [ ] Event-log retention/compaction (snapshot-then-truncate), building on `db retention`.
- [x] Per-project blob GC (`db gc-blobs`, #61).
- [ ] Verify `db stats` shows no `message.part.updated` bloat, no inline base64, an `event` row
      count bounded by fragment/message count, and that `db vacuum` reclaims size.
- **Acceptance:** bounded event rows, no inline base64, reclaimed file size.

---

## 5. Performance analysis and reporting

**Status:** partial (measurement done, analysis/report open). A 400-message fixed-workload typing
run on the compiled 0.1.2 preview finished: 1800 s, 119 inputs / 0 timeouts, PTY write-to-echo P50
19.5 ms / P95 23.7 ms / P99 25.4 ms / max 27.3 ms; main-isolate RSS 725.6 MB → 747.9 MB; FD count
steady at 35; hydration count 1. The measurement boundary excludes terminal presentation and this
was idle-plus-typing, not streaming or repeated Session lifecycle switching. An isolated PTY
input-latency harness now exists (#141) and input-timing is traced (#146).
- [ ] Run the downloaded 0.1.0 artifact against the identical fixture for a controlled before/after
      comparison, serially with follow-up runs. (The artifact path is recorded in the archived
      2026-10-04 handoff; do not hard-code a temporary path here.)
- [ ] Audit input-timing correlation for batched keys; the current receipt logic can overwrite a
      pre-update receipt, so results must not be called per-key latency.
- [ ] Analyze RSS/native allocations and object owners; add a Session switch/create/close lifecycle
      scenario.
- [ ] Produce the bilingual final performance report with raw evidence links and boundaries.
- [ ] Resolve the `shutdown.forced: true` result (five-second SIGTERM wait) and confirm graceful
      shutdown, distinguishing application behavior from PTY draining.
- **Acceptance:** controlled comparison plus written report; no unproven improvement claims.

---

## 6. Released-binary acceptance

**Status:** partial. The released **0.1.4** binary was installed and exercised on three real
machines on 2026-10-04: macOS ARM64 (macmini), Linux x64 (xx02), and Windows x64 (192.168.3.96).
Each returned `0.1.4` from `--version`, initialized a fresh database, and reported `miao doctor`
findings: none. `db stats`, `db compact --dry-run`, and `db vacuum` ran cleanly on an isolated DB.

Verified on the released binary:
- [x] Cross-platform smoke: the same 0.1.4 artifact runs on macOS ARM64, Linux x64, and Windows x64;
      `doctor` is clean on all three.
- [x] Cross-process inbox recovery: one process admitted a durable `queue` input
      (`admitted_seq=1, promoted_seq=null`), a separate later process with no live in-session event
      read it back via `GET /api/session/:id/inputs`, and a third process promoted it
      (`promoted_seq=17`, projected `session_message` `seq=17`). Exercised on xx02 against an
      isolated database.

Still open or blocked:
- [ ] Validate the released Windows artifact upgrade path from 0.1.2 (fresh install only so far);
      re-check against the current release (0.1.7 prepared / 0.1.8 open).
- [ ] Validate outgoing message cards and cross-process sender/recipient behavior in a released
      binary (blocked: no provider credential on the verification machines).
- [ ] Observe provider-error visibility in a released binary against a real provider (blocked: no
      provider credential; earlier compiled-binary fault injection saw a red `API Error: 429` and
      `Retrying · attempt #1`).
- [ ] Exercise real multi-Session behavior for acknowledgment-loop guidance (live soak).
- [ ] Observe recovery from a real transient TLS incident (classification shipped and unit-tested
      in 0.1.2).
- [ ] Confirm Go paid-request success (requires **Global** in the OpenCode workspace Privacy
      settings).
- [ ] Reassess older non-blocking Windows browser-E2E failures against current `main`.
- [ ] Confirm the complete latest cross-platform CI suite, including the Windows browser-E2E
      failures previously treated as non-blocking.

Note: `MIAO_DATA_DIR` is not honored; the database override is `MIAO_DB` (a file path). Verification
used a throwaway `HOME` plus `MIAO_DB` so no owner database was touched.

---

## 7. Documentation

**Status:** open.
- [ ] Update current guides that still describe the removed SDK or superseded architecture.
- [ ] Preserve historical release/research records and upstream licensing notices.
- [ ] Keep OpenCode vendor provider IDs (`opencode`, `opencode-go`) as real provider identities.

---

## 8. Remote control, Hub, iOS, push (new since the snapshot)

**Status:** in progress. This stream is not yet in the extracted remaining-work list; it lives in
open PRs and recent merges.
- [x] Authenticated encrypted relay hub, channels, and durable grants (#67 #70 #71 #87 #90).
- [x] Hub account authentication, directory binding, and one-use runtime tickets (#98 #99 #109
      #110).
- [x] Android/iOS native remote-control application and pairing (#72 #85 #96 #125), and runtime
      control without restarting sessions (#121 #122 #134).
- [ ] Browser session workspace, account cookies, checkpoints, and relay connections (#124 #126
      #128 #130).
- [ ] Push delivery: APNs transport, registry, registration API, iOS token lifecycle (#146 #147
      #148 #150 #152).
- [ ] Private named-tunnel deployment (#145) and bounded live text snapshots (#142).
- [ ] Design doc for unified session remote control (#64).

---

## Working-tree drafts (not committed)

- `packages/miao/script/measure-input-pty.py`
- `packages/miao/script/seed-input-latency.ts`

Need a final isolated rerun (preserve monotonic aggregate sequences if reseeding) before deciding
whether to commit.

## Ground rules (every slice)

- Run in `miao-dev` (source); the release `miao` is the daily driver and must never break.
- One writer per session: flip engine, routes, and client surface together, per surface.
- `git add` only the paths you edited; never `git add -A`; do not commit another session's WIP.
- Every change: `bun typecheck` green plus the changed package's tests, then a conventional commit
  on a short-lived branch through a pull request. `main` is protected; squash-merge.
- Compile on a configured build host, never locally.
- After any public Protocol/Server `HttpApi` change, run `bun run generate` from `packages/client`.
- Un-backfilled legacy sessions raise `Session.LegacyNotMigratedError`; run `miao-dev db backfill`
  before continuing them on V2.
- Do not fabricate fixes for unverified behavior; record the blocker instead.

## Rollback

- Preview binary: `ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao-preview`.
- V1 is deleted, so roll back a regression by installing a previous release.
