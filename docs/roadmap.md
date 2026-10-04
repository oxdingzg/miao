# miao Roadmap — Remaining Work

Status snapshot: **2026-10-04**, latest published release **v0.1.4**.

This is the single authoritative inventory of every open item in the V1→V2 rebuild. It replaces
the earlier distributed trackers (the remaining-work checklist and handoff, the V2 todo list, the
P7 route inventory, the app API migration checklist, and the publication/performance/storage
handoff), which are archived under `docs/archive/`. Each item states its status, the exact code
entry points where known, and an observable acceptance check.

## How to read this

- **Status**: `open`, `partial` (some slices landed), or `blocked`.
- **Acceptance** is the observable proof the slice is done, not just "code merged".
- Ordered roughly by dependency and value, not strictly.
- Ground rules that apply to every slice are collected at the end.

## Already done (context, not remaining)

- V1 session runtime, tools, and the `/session/*`, `/permission/*`, `/question/*`, `/sync/*`
  route groups are deleted. The server mounts `/api/*`, OpenAPI docs, and the embedded UI only.
- V1 retirement Stages 1–5 have landed. Creation is V2-native (`session.next.created.1`); the V1
  projector and `packages/core/v1` schemas remain only for legacy DB reads, backfill, compact, and
  restore.
- Every shipped client — TUI, `--mini`, ACP, `miao run`, web/desktop app, `miao remote` — reads and
  writes through `/api/*`. The TUI has **zero** legacy SDK calls left.
- The app moved off the vendored upstream client to `@miao/client`; the `detectServerProtocol` and
  `protocol === "v1"` branches were removed. The TUI console/org switching feature was deleted.
- SendMessage first slice, the content-addressed Blob store, the durable event tail, and most
  G2/G3/G9/G11/G13 slices are done.
- Storage recovery acceptance for the 2026-10-04 snapshot is complete.

---

## 1. V1 residue — P5 (legacy SDK) and P7 (non-session routes)

**Status:** partial. Goal: the released server runs the V2-only assembly with only the CLI shell
left, and no client depends on `@miao/sdk` or unprefixed legacy routes.

### 1.1 Legacy JS SDK (P5)
The V1 root exports are being torn down; the plugin `Hooks` / `PluginInput.client` move to V2 is
still outstanding.
- [ ] Remove the remaining V1 root exports and regenerate the SDK against V2 only.
- [ ] Move plugin `Hooks` / `PluginInput.client` from V1 to V2.
- [ ] Drop the `@miao/sdk` runtime dependency once all consumers and types are gone.
- **Acceptance:** no package imports a V1 SDK surface; the plugin API uses V2 shapes.

### 1.2 App legacy types and adapters
The app's network calls are migrated, but its internal state still passes through V1-shaped
adapters and types, and V1 event compatibility layers remain.
- [ ] Replace `src/utils/session.ts` current→legacy session adapter.
- [ ] Replace `src/utils/session-message.ts` message/part adapter.
- [ ] Replace `src/context/global-sync/utils.ts` agent/provider/model adapters.
- [ ] Replace legacy `Session`, `Message`, `Part`, `PermissionRequest`, `QuestionRequest`,
      `Project`, `FileNode`, `FileDiffInfo`, `Event` types across app state and rendering.
- [ ] Retire transitional session events (`session.created/updated/diff/status/idle/error`) in
      `src/context/global-sync/event-reducer.ts`, `src/context/server-session.ts`,
      `src/context/notification.tsx`, `src/pages/session/usage-exceeded-dialogs.tsx`.
- [ ] Retire legacy message event compatibility (`message.updated/removed`, `message.part.*`) in
      `src/context/global-sync/event-reducer.ts` and `src/context/server-session.ts`.
- [ ] Migrate LSP and reference events in `src/context/global-sync/event-reducer.ts`.
- [ ] Remove the three compatibility fallbacks in `src/context/server-session.ts`
      (`GET /session/:id`, `/message`, `/message/:mid`).
- [ ] Replace V1 endpoint mocks (`e2e/utils/mock-server.ts`), the `SessionV1` / legacy fixtures in
      `e2e/performance/timeline-stability/fixture.ts`, and remaining legacy SDK type fixtures.
- [ ] Remaining directory config read from `GET /config`.
- **Acceptance:** the app renders and mutates with `@miao/client` types only; no legacy types in
  app state; no legacy-route mocks in tests.

### 1.3 Non-session legacy routes and server teardown
Most V2 endpoints exist (`pty.shells`, `project.update`, `vcs.diff`, `fs.content`, `config.update`,
`workspace.reset` via `/api/worktree`, `project.initGit`, `project` persistence). Remaining:
- [x] Move project persistence into core. The ID migration, sandbox maintenance, directory
      registration, and `project.updated` event already lived in core `ProjectRegistry`;
      `ProjectMetadata` now also owns `setInitialized`, `sandboxes`, `addSandbox`, and
      `removeSandbox`. The `packages/miao` `Project` service delegates to core and no longer writes
      `ProjectTable` directly (#35, #36). The server handlers already use core only.
- [ ] Delete the now-thin `packages/miao` `Project` facade. It retains only `fromDirectory`
      (resolve + `ProjectRegistry.register`), the `/init` subscription, and `discover`
      (`ProjectRegistry.discoverIcon`); its tests still exercise `discover`. Repoint
      `instance-store`, `bootstrap`, `worktree`, `control-plane/workspace`, `stats`, and `scrap` at
      core, then move the `/init` subscription to a small miao-owned service.
- [ ] Remove the `packages/miao` `app-runtime` V1 layer and any remaining non-session legacy routes;
      switch the release server to the V2-only assembly.
- [ ] Confirm V2 endpoints cover app behaviors that were silently disabled on V2 (global config
      read, project rename, directory picker, custom providers).
- **Acceptance:** `packages/miao` is only the CLI shell; the server mounts `/api/*` only; no V1
  project code remains.

---

## 2. V2 architecture gaps

**Status:** open / partial per item.

### 2.1 Native runner slices
The first Effect-native local runner is implemented. Next reviewed slices:
- [ ] Preserve eager structured local-tool settlement: durably record each complete call, start its
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
**Entry:** `packages/core/src/background-job.ts` (exists, **unwired to V2**),
`packages/core/src/tool/bash.ts:72-74`.
- [ ] Adopt the ACP terminal contract (`terminal/create` → `output`
      [output/truncated/exitStatus] / `wait_for_exit` / `kill` / `release`, `outputByteLimit`
      truncated from the head on a char boundary).
- [ ] Integrate `BackgroundJob` with V2 tool execution: durable status, bounded preview,
      cooperative cancel, incremental delivery, completion delivery.
- [ ] Define restart recovery and authorization before exposing remote observation.
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
(`failInterruptedTools`).
- [ ] Idempotency key (`callID` + attempt) plus a one-shot consume token.
- [ ] On restart, mark unsettled calls outcome-unknown and require explicit retry/abandon.
- **Acceptance:** kill mid-tool, resume → no repeated side effect; the model sees "result unknown".

### 2.5 Output bounds / timeouts / caps (G7)
**Entry:** `packages/core/src/tool/bash.ts`, `ripgrep.ts`, `tool/websearch.ts`,
`tool/http-body.ts`, `tool-output-store.ts`.
Progress: ripgrep enforces a default 30s timeout (overridable) that kills the invocation and fails
the call; webfetch/websearch bound response bodies; MCP image results are capped at 5 MB base64.
- [ ] Stream full shell output to managed storage while keeping a bounded in-memory preview.
- [ ] Add bounded line framing for ripgrep.
- [ ] Non-streamed JSON/image body caps where not yet bounded.
- **Acceptance:** `yes` / huge-line output does not blow memory or hang; a long grep times out
  cleanly.

### 2.6 AST edit ladder (G8 remainder)
**Entry:** `packages/core/src/tool/edit.ts`, `edit-fuzzy.ts`, `packages/core/src/snapshot.ts`.
Progress: snapshot-based undo/redo exists; mid-line fuzzy matches that would corrupt are refused.
- [ ] AST-aware edit ladder after exact-edit behavior is established (port the V1 fuzzy correction
      strategies deliberately: line-trimmed matching, block-anchor fallback, indentation
      correction, similarity-threshold review).
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
`packages/core/src/sandbox/{runner,policy}.ts`.
Progress: V2 bash runs under the core OS sandbox; a catch-all allow rule cannot lift it.
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
- [ ] Page large durable aggregate replay reads instead of loading every row after a stale cursor
      into one array.
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
permission action per target (default ask). A → B delivery works in the same project.
- [ ] Loop-guard cost accounting for a receiving drain.
- [ ] Replies route back; no duplicate delivery after restart; sessions isolated from unrelated
      ones.
- **Acceptance:** A sends to B; B receives; reply routes back; restart produces no duplicate.

---

## 3. Config, plugins, services

**Status:** open.
- [ ] Rework config for a cleaner shape with auto-conversion of old configs. Old configs should be
      converted automatically.
- [ ] Plugin-defined context registration and hot-reload lifecycle on the scoped System Context
      registry seam.
- [ ] Nested project instruction discovery after successful reads, admitted durably at the next
      Safe Provider-Turn Boundary.
- [ ] Design the server plugin API and hooks (immer drafts so bad mutations can be thrown away, a
      global instance, tool registration such as `opencode.tool.register({...})`).
- [ ] Make every service hot-reloadable via granular events instead of teardown, so services react
      to changes and reconfigure themselves (and the frontend can receive them, e.g. `model.added`);
      this also prevents startup from blocking.
- [ ] Register providers as plugins that autoload from their own logic/config and register models
      into the model database; the auth system should track any kind of auth, not just providers.

---

## 4. Storage operations

**Status:** partial.
- [ ] Compact `miao-main.db` (preview channel; **2.34 GB** on 2026-10-04, uncompacted). Follow the
      V1-table retirement path (`miao db compact`: batched delete of `message.*` events, drop
      `message`/`part`, reset only the emptied `event_sequence` rows, checkpoint + vacuum).
- [ ] Measure `miao.db` against the <200 MB acceptance (**876 MB** on 2026-10-04; previously 666 MB
      on 2026-10-03).
- [x] Delete old `miao*.db.bak-*` / `*.compacted-*` copies and the `retirement-20261003` rehearsal
      stash in `~/.local/share/miao`. Owner-approved deletion on 2026-10-04: 21 GB → 5.8 GB (about
      15 GB reclaimed). Active databases (`miao.db`, `miao-main.db`, `miao-local.db`) and the
      accepted `backups/acceptance-*` snapshots were retained. The macmini build host carries no
      miao database files, so there was nothing to migrate there.
- [ ] Delta-only events: retire the V1 per-delta sync events; keep one durable row per completed
      fragment/message. Do not carry V1's snapshot-per-delta forward. (The V2 write path already
      persists one durable `text.started`/`text.ended` per fragment with no durable delta.)
- [ ] Event-log retention/compaction (snapshot-then-truncate).
- [ ] Per-project blob GC (refcount or mark-and-sweep).
- [ ] Verify `db stats` shows no `message.part.updated` bloat, no inline base64, an `event` row
      count bounded by fragment/message count, and that `db vacuum` reclaims size.
- **Acceptance:** bounded event rows, no inline base64, reclaimed file size.

---

## 5. Performance analysis and reporting

**Status:** partial (measurement done, analysis/report open). A 400-message fixed-workload typing
run on the compiled 0.1.2 preview finished: 1800 s, 119 inputs / 0 timeouts, PTY write-to-echo P50
19.5 ms / P95 23.7 ms / P99 25.4 ms / max 27.3 ms; main-isolate RSS 725.6 MB → 747.9 MB; FD count
steady at 35; hydration count 1. The measurement boundary excludes terminal presentation and this
was idle-plus-typing, not streaming or repeated Session lifecycle switching.
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
- [ ] Validate the released **Windows 0.1.4** artifact upgrade path from 0.1.2 (fresh install only
      so far).
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
