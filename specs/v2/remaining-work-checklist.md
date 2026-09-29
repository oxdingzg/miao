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
- [ ] `MIAO_TUI_V2=1`: transcript byte-identical to V1 for a projected session
- [ ] Legacy session renders from V1 fallback
- [ ] Un-backfilled session send shows `LegacyNotMigratedError` hint
- [ ] `miao-dev db backfill` migrates a legacy session; resend succeeds
- [ ] Flag off: unchanged V1 behavior
- [ ] **A.0b:** V2 runs stream live into the transcript (landed: re-hydrate on `session.next.*` under `MIAO_TUI_V2`; needs a manual `miao-dev` soak)

## 2. Stage 4 — TUI write flip
- [ ] Map editor text + non-text parts → `PromptInput.Prompt` (`{ text, files, agents }`)
- [ ] Choose `delivery` (`steer`|`queue`) from the existing TUI decision
- [ ] Send prompt: `session.prompt` → `v2.session.prompt` (`prompt/index.tsx:1115`)
- [ ] Interrupt: `session.abort` → `v2.session.interrupt` (`prompt/index.tsx:436`, `routes/session/index.tsx:619`)
- [ ] Shell: `session.shell` → `v2.session.shell` (`prompt/index.tsx:1082`)
- [ ] Command: `session.command` → `v2.session.command` (`prompt/index.tsx:1104`)
- [ ] Create: `session.create` → `v2.session.create` (`prompt/index.tsx:1021`)
- [ ] Fork: `session.fork` → `v2.session.fork` (`app.tsx:506,526`, `routes/session/dialog-*.tsx`, `dialog-message.tsx:81`)
- [ ] Permission reply: → `v2.session.permission.*reply` (`routes/session/permission.tsx:168,180,418,426`, `context/sync.tsx:201`)
- [ ] Question reply/reject: → `v2.session.question.*` (`routes/session/question.tsx:50,58,74`)
- [ ] Reads and writes agree (session route reads `data` under `MIAO_TUI_V2`, or gate writes on same flag)
- [ ] Verify: driven session writes `session_message`, no `message`/`part` rows (`miao-dev db stats`)
- [ ] Verify: TUI and app transcripts identical before/after flip
- [ ] Exercise: prompt, steer, queue, tool loop, compaction, permissions, revert, interrupt
- [ ] Suites green: `core`, `miao`, `tui`, `client`; `bun typecheck`
- [ ] Commit + push

## 3. Stage 4 — app / desktop / web
- [ ] Repeat read preflight for app/desktop/web
- [ ] Flip their write paths to `/api/session/*`
- [ ] Same acceptance as TUI; commit + push

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
- [ ] A → B delivery; B receives as input
- [ ] Replies route back; no duplicate delivery after restart; sessions isolated
- [ ] Test + commit + push

## 6. Storage hardening (§5)
- [ ] Delta-only events: retire V1 per-delta sync events; one row per completed fragment
- [ ] Blob externalization: `blobs/<sha256>` for attachments + oversized tool output
- [ ] Messages/events store `hash + mime`; materialize in `to-llm-message.ts`
- [ ] Incremental auto-vacuum enabled
- [ ] Event-log retention/compaction (snapshot-then-truncate)
- [ ] Per-project blob GC (refcount or mark-and-sweep)
- [ ] Verify: `db stats` shows no `message.part.updated` bloat, no inline base64; size reclaimed by `db vacuum`
- [ ] Test + commit + push

## 7. Gaps
### G2 remainder — lazy/disabled tool definitions
- [ ] Global `disabledTools` filter at registry resolution (prefix stays stable)
- [ ] Deferred definitions for mid-session tools (append, never reorder)
- [ ] Verify byte-identical tool array across turns; toggle appends only
- [ ] Test + commit + push

### G3 remainder — subagent liveness
- [ ] Report summary model/failure; surface dead/killed subagent to parent
  - [x] Failed subagent step (provider error / `finish: "error"`) returns a `ToolFailure` to the parent instead of "(no output)" — `runSubagent` in `session/runner/llm.ts`
  - [x] Verify: failed subagent reported as an error state — `session-runner.test.ts` "reports a failed subagent as an error instead of empty output"
- [ ] Verify: killed subagent reported failed, not hung (interrupt path still open)
- [ ] Test + commit + push

### G4 — cancellation settlement / attachments / progress
- [ ] Cancellation: cascade-cancel child fibers, drain inbox, settle pending approvals
- [ ] Normalize attachments by model capability at request build
- [ ] Wire tool progress events
- [ ] Verify: interrupt session with child task + pending approval → no dangling/lost state
- [ ] Test + commit + push

### G5 — crash recovery idempotency
- [ ] Idempotency key (`callID` + attempt) + one-shot consume token
- [ ] On restart: unsettled call = outcome-unknown; explicit retry/abandon
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
- [ ] Verify: `yes`/huge lines don't blow memory; long grep times out
- [ ] Test + commit + push

### G8 remainder — AST edit / snapshot-undo
- [ ] AST-aware edit ladder
- [ ] Snapshot-based undo/redo of mutations
- [ ] Verify: structural edit or refuse; undo restores pre-edit bytes
- [ ] Test + commit + push

### G9 remainder — MCP discovery / OAuth / CIMD
- [ ] Progressive discovery (`search_tools` → `get_tool_details`, append after cache breakpoint)
- [ ] OAuth via CIMD ordering; creds keyed by AS `issuer`; validate `iss`
- [ ] Deterministic `tools/list` with `ttlMs`/`cacheScope`; dedupe
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
- [ ] Document invalidation-action list
- [ ] Split cache-creation vs reasoning token buckets in telemetry
- [ ] Verify: misses distinguished by cause
- [ ] Commit + push

## Definition of Done (each slice)
- [ ] Behavior verified in `miao-dev` (command + output recorded)
- [ ] Focused test added where mechanical
- [ ] `bun typecheck` + affected suites green
- [ ] One conventional commit on `main`, pushed to `miao`
- [ ] `specs/v2/v1-retirement.md` + research §8 updated
- [ ] No other session's WIP committed

## Rollback
- [ ] TUI read: unset `MIAO_TUI_V2`
- [ ] Stage 4 client: revert flipped call sites
- [ ] Preview binary: `ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao-preview`
