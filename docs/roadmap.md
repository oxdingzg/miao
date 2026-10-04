# miao Roadmap — Remaining Work

Status snapshot: **2026-10-04**, latest published release **v0.1.4**.

This document consolidates every still-open item discovered while reconciling the V1→V2
rebuild trackers with the actual repository state. It exists so that no remaining work is
lost between sessions. Each item names the exact code entry points where known, and an
acceptance check.

## How to read this

- **Status**: `open`, `partial` (some slices landed), or `blocked`.
- **Acceptance** is the observable proof the slice is done, not just "code merged".
- Ordered roughly by dependency and value, not strictly.

## Already done (context, not remaining)

- V1 session runtime, tools, and the `/session/*`, `/permission/*`, `/question/*`, `/sync/*`
  route groups are deleted. Every shipped client reads and writes through `/api/*`.
- Stage 1–5 of the V1 retirement have landed; V2 is the only session runtime.
- TUI has **zero** legacy SDK calls left.
- SendMessage first slice, content-addressed Blob store, durable event tail, and most
  G2/G3/G9/G11/G13 slices are done.
- Storage recovery acceptance for the 2026-10-04 snapshot is complete.

---

## 1. V1 residue — P5 (legacy SDK) and P7 (non-session routes)

**Status:** partial.

The goal is that the released server can run the V2-only assembly with only the CLI shell
left, and that no client depends on `@miao/sdk` or unprefixed legacy routes.

### 1.1 Legacy JS SDK (P5)
- [ ] Remove the V1 root exports and regenerate the SDK against V2 only.
- [ ] Move plugin `Hooks` / `PluginInput.client` from V1 to V2.
- [ ] Drop the `@miao/sdk` runtime dependency once all consumers and types are gone.
- **Acceptance:** no package imports V1 SDK surface; plugin API uses V2 shapes.

### 1.2 App legacy types and adapters
**Status:** partial.
- [ ] Replace `src/utils/session.ts` current→legacy session adapter.
- [ ] Replace `src/utils/session-message.ts` message/part adapter.
- [ ] Replace `src/context/global-sync/utils.ts` agent/provider/model adapters.
- [ ] Replace legacy `Session`, `Message`, `Part`, `PermissionRequest`, `QuestionRequest`,
      `Project`, `FileNode`, `FileDiffInfo`, `Event` types across app state and rendering.
- [ ] Retire transitional session events (`session.created/updated/diff/status/idle/error`).
- [ ] Retire legacy message event compatibility (`message.updated/removed`,
      `message.part.*`).
- [ ] Migrate LSP and reference events.
- [ ] Remove the three compatibility fallbacks in `src/context/server-session.ts`
      (`GET /session/:id`, `/message`, `/message/:mid`).
- [ ] Replace V1 endpoint mocks and legacy fixtures in e2e and timeline performance tests.
- **Acceptance:** app renders and mutates with `@miao/client` types only; no legacy types in
  app state.

### 1.3 Non-session legacy routes
**Status:** partial (most endpoints added).
- [ ] Remove the `packages/miao` `app-runtime` V1 layer and any remaining non-session legacy
      routes; switch the release server to the V2-only assembly.
- [ ] Confirm V2 endpoints cover app behaviors that were silently disabled on V2
      (global config read, project rename, directory picker).
- **Acceptance:** `packages/miao` is only the CLI shell; server mounts `/api/*` only.

---

## 2. V2 architecture gaps

**Status:** open / partial per item.

### 2.1 Native runner slices
- [ ] Preserve eager structured local-tool settlement: durably record each complete call,
      start child execution immediately, await every settlement after the provider turn
      closes, then reload projected history once.
- [ ] Revisit per-turn tool-call limits, output truncation, and operational backpressure
      before broadening exposure.
- [ ] Remove the public in-memory `@miao/llm` tool loop after replacing its remaining
      one-turn native-adapter use with a narrow typed dispatcher.
- [ ] Batch streamed deltas and add covering context indexes.
- [ ] Expose replayable Session event cursors over HTTP and the generated SDK where remote
      consumers need them.

### 2.2 Background / async jobs (G6)
**Entry:** `packages/core/src/background-job.ts` (exists, **unwired to V2**),
`packages/core/src/tool/bash.ts`.
- [ ] Adopt the ACP terminal contract (`terminal/create` → `output`
      [output/truncated/exitStatus] / `wait_for_exit` / `kill` / `release`, `outputByteLimit`).
- [ ] Integrate `BackgroundJob` with V2 tool execution: durable status, bounded preview,
      cooperative cancel, incremental delivery, completion delivery.
- [ ] Define restart recovery and authorization before exposing remote observation.
- **Acceptance:** launch a background job, restart the dev server, query status and fetch
  exit code plus truncated output.

### 2.3 Cancellation settlement & tool progress (G4)
**Entry:** `packages/core/src/session/runner/llm.ts`, `to-llm-message.ts`,
`packages/core/src/tool/bash.ts`, `packages/core/src/session/input.ts`.
- [ ] Cascade-cancel child fibers, drain the inbox, settle pending approvals on interrupt.
- [ ] Emit incremental tool-progress checkpoints from core tools (bash currently buffers).
- [ ] Materialize remote and managed URIs before provider-history lowering
      (`to-llm-message.ts:80` TODO).
- **Acceptance:** interrupt a session with a child task and a pending approval → no dangling
  or lost state.

### 2.4 Crash-recovery idempotency (G5)
**Entry:** `packages/core/src/session/runner/llm.ts`.
- [ ] Idempotency key (`callID` + attempt) plus a one-shot consume token.
- [ ] On restart, mark unsettled calls outcome-unknown and require explicit retry/abandon.
- **Acceptance:** kill mid-tool, resume → no repeated side effect; model sees "result
  unknown".

### 2.5 Output bounds / timeouts / caps (G7)
**Entry:** `packages/core/src/tool/bash.ts`, `ripgrep.ts`, `tool-output-store.ts`.
- [ ] Stream full shell output to managed storage while keeping a bounded in-memory preview.
- [ ] Non-streamed JSON/image body caps where not yet bounded.
- **Acceptance:** `yes` / huge-line output does not blow memory or hang.

### 2.6 AST edit ladder (G8 remainder)
**Entry:** `packages/core/src/tool/edit.ts`, `edit-fuzzy.ts`.
- [ ] AST-aware edit ladder after exact-edit behavior is established.
- **Acceptance:** an edit a token match would corrupt is applied structurally or refused.

### 2.7 MCP progressive discovery / OAuth / CIMD (G9 remainder)
**Entry:** `packages/core/src/mcp.ts`.
- [ ] Progressive discovery (`search_tools` → `get_tool_details`, append after the cache
      breakpoint, never reorder).
- [ ] OAuth via CIMD ordering (pre-registered → CIMD → DCR → prompt), credentials keyed by
      AS `issuer`, validate `iss` (RFC 9207).
- [ ] Deterministic `tools/list` with `ttlMs`/`cacheScope` (not exposed by the installed MCP
      SDK).
- **Acceptance:** a large MCP catalog loads lazily without disturbing the cache prefix;
  OAuth persists per issuer.

### 2.8 Sandbox coverage beyond bash (G12 remainder)
**Entry:** `packages/core/src/sandbox.ts`, `sandbox/{runner,policy}.ts`.
- [ ] Extend the core OS sandbox to other mutating tools (workdir, allowed paths, network),
      fail-closed, model-visible denials.
- **Acceptance:** a mutating tool inside the sandbox cannot write outside allowed paths;
  network denied when configured.

### 2.9 Durable continuation recovery
**Status:** blocked on explicit design.
- [ ] Design post-crash continuation recovery as one explicit slice: promoted input and
      projected-history state, queued-input promotion and steering assignment,
      provider-attempt preparation vs dispatch ambiguity, required post-turn continuation
      across process loss, explicit `retry`/`abandon`, bounded automatic retry only where
      idempotent, retry budget/backoff/visible status, startup discovery, future clustered
      ownership fencing.
- **Acceptance:** a documented policy with a concrete consumer; no inferred retry from an
  advisory wake.

### 2.10 Deferred hardening cleanup
Keep visible, do not block functionality slices unless a concrete failure appears.
- [ ] Serialize database migration claiming across processes (currently in-process semaphore
      only; two processes can race).
- [ ] Simplify process-local durable-tail wake lifecycle with Effect `RcMap` and one shared
      `PubSub.sliding<void>(1)` per active aggregate.
- [ ] Page large durable aggregate replay reads instead of loading all rows after a stale
      cursor into one array.
- [ ] Decide whether connected tails need a periodic polling fallback for cross-process
      writers.
- [ ] Stream-cap websearch body collection before parsing.
- [ ] Materialize or consistently reject unresolved URL and file attachment sources.
- [ ] Decide stateless OpenAI Responses hosted-tool continuation behavior.
- [ ] Decide whether to preserve deprecated `@miao/llm` orchestration exports.
- [ ] Preserve or alias renamed filesystem SDK generated type names if compatibility
      consumers require them.
- [ ] Revisit syscall-level mutation confinement for hostile external processes
      (`openat`, `O_NOFOLLOW`, descriptor-relative mutation).

### 2.11 SendMessage remainder
**Status:** partial.
- [ ] Loop-guard cost accounting for a receiving drain.
- [ ] Replies route back; no duplicate delivery after restart; sessions isolated.
- **Acceptance:** A sends to B; B receives; reply routes back; restart produces no duplicate.

---

## 3. Config, plugins, services

**Status:** open.
- [ ] Rework config for a cleaner shape with auto-conversion of old configs.
- [ ] Plugin-defined context registration and hot-reload lifecycle on the scoped registry
      seam.
- [ ] Nested project instruction discovery after successful reads, admitted durably at the
      next Safe Provider-Turn Boundary.
- [ ] Design server plugin API and hooks (immer drafts, global instance, tool registration).
- [ ] Make every service hot-reloadable via granular events instead of teardown.
- [ ] Decide provider/model registration as plugins feeding the model database.

---

## 4. Storage operations

**Status:** partial.
- [ ] Compact `miao-main.db` (preview channel; **2.34 GB** on 2026-10-04, uncompacted).
- [ ] Measure `miao.db` against the <200 MB acceptance (**876 MB** on 2026-10-04).
- [x] Delete old `miao*.db.bak-*` / `*.compacted-*` copies and the `retirement-20261003`
      rehearsal stash in `~/.local/share/miao`. Owner-approved deletion on 2026-10-04:
      21 GB → 5.8 GB (about 15 GB reclaimed). Active databases (`miao.db`, `miao-main.db`,
      `miao-local.db`) and the accepted `backups/acceptance-*` snapshots were retained. The
      macmini build host carries no miao database files, so there was nothing to migrate
      there.
- [ ] Event-log retention/compaction (snapshot-then-truncate).
- [ ] Per-project blob GC (refcount or mark-and-sweep).
- [ ] Verify `db stats` shows no `message.part.updated` bloat, no inline base64, and that
      `db vacuum` reclaims size.
- **Acceptance:** bounded event rows, no inline base64, reclaimed file size.

---

## 5. Performance analysis and reporting

**Status:** partial (measurement done, analysis/report open).
- [ ] Run the downloaded 0.1.0 artifact against the identical fixture for a controlled
      before/after comparison. The artifact path is recorded in the 2026-10-04 handoff; do
      not hard-code a temporary path here.
- [ ] Audit input-timing correlation for batched keys; the current receipt logic can
      overwrite a pre-update receipt, so results must not be called per-key latency.
- [ ] Analyze RSS/native allocations and object owners; add a Session
      switch/create/close lifecycle scenario.
- [ ] Produce the bilingual final performance report with raw evidence links and boundaries.
- [ ] Resolve the `shutdown.forced: true` result (five-second SIGTERM wait) and confirm
      graceful shutdown, distinguishing application behavior from PTY draining.
- **Acceptance:** controlled comparison plus written report; no unproven improvement claims.

## 6. Released-binary acceptance

**Status:** open.
- [ ] Validate the released **Windows 0.1.4** artifact and upgrade from 0.1.2; confirm
      provider errors and inbox recovery in that artifact.
- [ ] Validate outgoing message cards and cross-process sender/recipient behavior in a
      released binary.
- [ ] Exercise real multi-Session behavior for acknowledgment-loop guidance (live soak).
- [ ] Observe recovery from a real transient TLS incident (classification shipped and
      unit-tested).
- [ ] Confirm Go paid-request success (requires **Global** in the OpenCode workspace Privacy
      settings).
- [ ] Reassess older non-blocking Windows browser-E2E failures against current `main`.

---

## 7. Documentation

**Status:** open.
- [ ] Update current guides that still describe the removed SDK or superseded architecture.
- [ ] Preserve historical release/research records and upstream licensing notices.
- [ ] Keep OpenCode vendor provider IDs (`opencode`, `opencode-go`) as real provider
      identities.

---

## Working-tree drafts (not committed)

- `packages/miao/script/measure-input-pty.py`
- `packages/miao/script/seed-input-latency.ts`

Need a final isolated rerun (preserve monotonic aggregate sequences if reseeding) before
deciding whether to commit.

## Cross-cutting rules

- Land every change through a PR on a short-lived branch; `main` is protected.
- Compile on a configured build host, never locally.
- Run `bun typecheck` and the affected package suite from the package directory.
- After any public Protocol/Server `HttpApi` change, run `bun run generate` from
  `packages/client`.
