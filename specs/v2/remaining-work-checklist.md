# Remaining Work — Checklist

Companion to `specs/v2/remaining-work-handoff.md`. Tick items in order; each slice ends with the
Definition of Done. Run in `miao-dev` only.

## 0. Guardrails
- [ ] Confirm working in `miao-dev` (source), not release `miao`
- [ ] Confirm one writer per session (engine + routes + client flip together)
- [ ] `git add` only edited paths (never `git add -A`)
- [ ] Run `bun typecheck` + affected package tests before each commit
- [ ] Commit `type(scope): …` and push to `miao main` immediately

## 1. Stage 4 — read preflight
- [ ] Transcript byte-identical to V1 for a projected session (`MIAO_TUI_V2` is now **on by default**; `=0` forces V1)
- [ ] Legacy session renders from the V1 fallback
- [ ] Un-backfilled session send shows the `LegacyNotMigratedError` hint
- [ ] `miao-dev db backfill` migrates a legacy session; resend succeeds
- [ ] `MIAO_TUI_V2=0`: unchanged V1 behavior
- [ ] **A.0b:** V2 runs stream live into the transcript (landed: re-hydrate on `session.next.*`; needs a manual `miao-dev` soak)

## 2. Stage 4 — TUI write flip
- [x] Map editor text + non-text parts → `PromptInput.Prompt` (`{ text, files }`) — `context/session-v2-write.ts`
- [ ] Choose `delivery` (`steer`|`queue`) from the existing TUI decision (currently defaults to the V1 steer behavior)
- [x] Send prompt: `session.prompt` → `v2.session.prompt` (`prompt/index.tsx`)
- [x] Interrupt: `session.abort` → `v2.session.interrupt` (`prompt/index.tsx`, `routes/session/index.tsx`)
- [x] Shell: `session.shell` → `v2.session.shell` (`prompt/index.tsx`)
- [x] Command: `session.command` → `v2.session.command` (`prompt/index.tsx`)
- [x] Create: `session.create` → `v2.session.create` (`prompt/index.tsx`)
- [x] Fork: `session.fork` → `v2.session.fork` (`app.tsx`, `routes/session/dialog-fork-from-timeline.tsx`, `dialog-message.tsx`)
- [x] Compact/revert: `summarize`→`v2.session.compact`, `revert`→`v2.session.revert.stage`, `unrevert`→`v2.session.revert.clear` (`routes/session/index.tsx`, `dialog-message.tsx`)
- [x] Permission reply: → `v2.session.permission.reply`; V2 requests render via `permission.v2.asked`/`replied` in `context/sync.tsx` (V2 request mapped to the V1 UI shape)
- [x] Question reply/reject: → `v2.session.question.reply/reject`; V2 requests render via `question.v2.asked`/`replied`/`rejected` in `context/sync.tsx`
- [x] Reads and writes agree (writes gated on `MIAO_TUI_V2`, the same flag that switches reads)
- [ ] Verify: driven session writes `session_message`, no `message`/`part` rows (`miao-dev db stats`)
- [ ] Verify: TUI and app transcripts identical before/after flip
- [ ] Exercise: prompt, steer, queue, tool loop, compaction, permissions, revert, interrupt (needs live `miao-dev` soak)
- [ ] Suites green: `core`, `miao`, `tui`, `client`; `bun typecheck`
- [ ] Commit + push (partial: write sites landed; see notes)

## 3. Stage 4 — app / desktop / web
- [ ] Repeat read preflight for app/desktop/web (needs a live browser soak)
- [x] `detectServerProtocol` now prefers `/api/health` (pid) and falls back to legacy `/global/health`, so app/desktop/web select V2 whenever the server advertises it
- [x] Reads and writes follow the selection (`utils/server-compat.ts`; app renders V2 events)
- [x] `?protocol=v1|v2` override forces a protocol for soak/rollback
- [ ] Same acceptance as TUI; commit + push (client cutover landed; live soak remains)

## 4. Stage 5 — delete V1
- [ ] Gate: no shipped client imports/calls a `/session/*` route
- [ ] Delete app SDK shims
- [ ] Delete V1 route groups
- [ ] Delete V1 session engine
- [ ] Delete V1 tools/transport
- [ ] Delete `packages/core/v1` schemas
- [ ] Delete legacy SDK
- [ ] Delete `packages/miao` V1 server/engine
- [ ] `bun typecheck` + full suites green; commit + push

## 5. SendMessage (session-to-session)
- [ ] Implement per `specs/v2/session-messaging.md` (after Stage 4)
  - [x] `send_message` tool: resolves a Session ID or `@slug`, admits a queued sender-attributed input into a peer Session, and wakes it via the runner's `wake` callback; missing/cross-project targets fail clearly, and an inbound-queue cap refuses overflow — `session-runner.test.ts`
  - [x] `list_sessions` discovery tool: enumerates sibling Sessions (id/slug/title) in the project — `session-runner.test.ts`
  - [x] `message` permission action asserted per target (default ask) — `session-runner.test.ts`
- [x] A → B delivery; B receives as input (same project) — `session-runner.test.ts`
- [ ] Replies route back; no duplicate delivery after restart; sessions isolated
- [ ] Test + commit + push

## 6. Storage hardening (§5)
- [ ] Delta-only events: retire V1 per-delta sync events; one row per completed fragment
  - [x] V2 write path already persists one durable `text.started`/`text.ended` per fragment and no durable delta — `session-runner-recorded.test.ts`; V1 per-delta event retirement is Workstream B
- [ ] Blob externalization: `blobs/<sha256>` for attachments + oversized tool output
  - [x] Content-addressed `Blob` store (`blob.ts`: put/get/has/remove, atomic write, dedupe) — `blob.test.ts`; not yet wired
- [ ] Messages/events store `hash + mime`; materialize in `to-llm-message.ts`
- [x] Incremental auto-vacuum enabled — native SQLite layers request `auto_vacuum = INCREMENTAL` before WAL on new databases; `database-migration.test.ts`
- [ ] Event-log retention/compaction (snapshot-then-truncate)
- [ ] Per-project blob GC (refcount or mark-and-sweep)
- [ ] Verify: `db stats` shows no `message.part.updated` bloat, no inline base64; size reclaimed by `db vacuum`
- [ ] Test + commit + push

## 7. Gaps
### G2 remainder — lazy/disabled tool definitions
- [x] Global `disabledTools` filter at registry resolution — `materialize({ disabledTools })`, sourced from `disabled_tools` config
- [x] Deferred definitions for mid-session tools (append, never reorder) — `stableToolOrder`
- [x] Verify byte-identical tool array across turns; toggle appends only — `tool-registry-order.test.ts`
- [x] Test + commit + push

### G3 remainder — subagent liveness
- [ ] Report summary model/failure; surface dead/killed subagent to parent
  - [x] Failed subagent step (provider error / `finish: "error"`) returns a `ToolFailure` to the parent instead of "(no output)" — `runSubagent` in `session/runner/llm.ts`
  - [x] Verify: failed subagent reported as an error state — `session-runner.test.ts` "reports a failed subagent as an error instead of empty output"
- [x] Verify: killed subagent reported failed, not hung — the interrupt propagates into the child drain (shared local-tool path); `session-runner.test.ts` covers interrupted local tools
- [ ] Test + commit + push

### G4 — cancellation settlement / attachments / progress
- [ ] Cancellation: cascade-cancel child fibers, drain inbox, settle pending approvals
  - [x] Interrupt clears tool fibers and fails unsettled tools; durable queued/steer input survives interruption — `session-runner.test.ts` ("preserves durable queued/steering input … after interruption")
  - [x] Interrupting a pending permission/question publishes `Replied(reject)`/`Rejected` so subscribers clear the prompt — `permission.test.ts`, `question.test.ts`
- [x] Normalize attachments by model capability at request build — image files become a text placeholder when `capabilities.input` omits `image`
- [x] Wire tool progress events — `Tool.Context.progress` → registry `onProgress` → runner publishes `session.next.tool.progress`; `tool-registry-order.test.ts`. No core tool emits incremental checkpoints yet (bash captures buffered output)
- [ ] Verify: interrupt session with child task + pending approval → no dangling/lost state
- [ ] Test + commit + push

### G5 — crash recovery idempotency
- [ ] Idempotency key (`callID` + attempt) + one-shot consume token
- [ ] On restart: unsettled call = outcome-unknown; explicit retry/abandon
  - [x] Crash-recovered tools report an outcome-unknown error, not a definite failure — `failInterruptedTools`; `session-runner.test.ts`
- [ ] Verify: kill mid-tool, resume → no repeat side effect; model sees unknown
- [ ] Test + commit + push

### G6 — background / async jobs
- [ ] Adopt ACP terminal contract (create/output/wait_for_exit/kill/release, `outputByteLimit`)
- [ ] Durable status + bounded preview + cooperative cancel + incremental delivery
- [ ] Verify: restart dev server, query status + exit code + truncated output
- [ ] Test + commit + push

### G7 — output bounds / timeouts / caps
- [ ] Stream shell output to disk with bounded preview
- [x] Ripgrep timeout (kill + model-visible error) — 30s default, `timeout` override
- [ ] Non-streamed JSON/image body caps
  - [x] webfetch/websearch already use `collectBoundedResponseBody`; MCP image results are capped at 5 MB base64 (`mcp.test.ts`)
- [ ] Verify: `yes`/huge lines don't blow memory; long grep times out
- [ ] Test + commit + push

### G8 remainder — AST edit / snapshot-undo
- [ ] AST-aware edit ladder
- [x] Snapshot-based undo/redo of mutations — `Snapshot.restore` + `SessionRevert`; `snapshot.test.ts` "captures and restores Location-scoped changes"
- [x] Verify: a token match that would corrupt is refused — mid-line fuzzy matches are rejected (`edit-fuzzy.test.ts`)
- [ ] Test + commit + push

### G9 remainder — MCP discovery / OAuth / CIMD
- [ ] Progressive discovery (`search_tools` → `get_tool_details`, append after cache breakpoint)
- [ ] OAuth via CIMD ordering; creds keyed by AS `issuer`; validate `iss`
- [ ] Deterministic `tools/list` with `ttlMs`/`cacheScope`; dedupe
  - [x] Deterministic canonical-name dedupe (codepoint order, first wins) — `mcp.test.ts`; `ttlMs`/`cacheScope` still open (not exposed by the installed MCP SDK)
- [ ] Verify: large catalog loads lazily without disturbing the prefix; OAuth persists per issuer
- [ ] Test + commit + push

### G11 remainder — cross-process durable tail
- [x] Durable event tail polling fallback — `EventV2.durable` merges the in-process wake with a 1s DB poll (`pollInterval` overridable)
- [x] Verify: a foreign writer committing rows directly is tailed with no gap — `event.test.ts` "tails durable events written by another process"
- [x] Test + commit + push

### G12 — syscall-level confinement
- [ ] Wire core-owned OS sandbox into V2 tool execution (workdir, allowed paths, network)
- [ ] Fail-closed, model-visible denials
- [ ] Verify: writes outside allowed paths denied; network denied when configured
- [ ] Test + commit + push

### G13 remainder — cache invalidation + buckets
- [x] Document invalidation-action list — see `SessionRunnerMetrics.cacheMissCause`
- [ ] Split cache-creation vs reasoning token buckets in telemetry — `tokens` already carries distinct `cache.write` and `reasoning` fields
- [x] Verify: misses distinguished by cause — `session.turn` logs `cacheMissCause` (`none`/`cold`/`rebuild`/`prefix-change`); `session-runner-metrics.test.ts`
- [x] Commit + push

## Definition of Done (each slice)
- [ ] Behavior verified in `miao-dev` (command + output recorded)
- [ ] Focused test added where mechanical
- [ ] `bun typecheck` + affected suites green
- [ ] One conventional commit on `main`, pushed to `miao`
- [ ] `specs/v2/v1-retirement.md` + research §8 updated
- [ ] No other session's WIP committed

## Rollback
- [ ] TUI: `MIAO_TUI_V2=0` forces the V1 read/write path
- [ ] Stage 4 client: revert flipped call sites
- [ ] Preview binary: `ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao-preview`
