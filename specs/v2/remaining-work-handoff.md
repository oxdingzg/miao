# Remaining Work — miao-dev Handoff

Everything still open in the V2 rebuild, written so a `miao-dev` session can execute it
end-to-end without re-deriving context. Each workstream states its goal, exact entry points,
steps, acceptance checks, and a suggested commit.

Read this with: `specs/v2/v1-retirement.md`, `specs/v2/tui-read-cutover.md`,
`specs/v2/session-messaging.md`, `specs/v2/todo.md`, `specs/v2/session.md`,
`specs/storage/session-storage-hardening.md`.

## 0. Guardrails (do not skip)

- Run in `miao-dev` (source). The release `miao` is the daily driver and must never break.
- **One writer per session.** Flip engine + routes + client surface together, per surface. A
  half-flip double-writes two storage shapes (`message`/`part` vs `session_message`).
- Shared worktree: `git add` only the paths you edited; never `git add -A`.
- Every change: `bun typecheck` green + the changed package's tests, then a conventional commit
  (`feat(scope): …` / `fix(scope): …`) pushed to `miao main` immediately.
- Un-backfilled legacy sessions raise `Session.LegacyNotMigratedError`; run `miao-dev db backfill`
  before continuing them on V2.
- Do not fabricate fixes for unverified behavior. If a step cannot be verified, stop and write the
  blocker into this file.

## 1. Status ledger (verified 2026-09-30)

**Done, pushed, tested**

| Area | Commits |
|---|---|
| Stage 1 protocol seam; Stage 2 parity endpoints; Stage 3 backfill + read fallback | see `v1-retirement.md` |
| G1 repeated-identical-tool-call bound | `1637cb872` |
| G2 tool definition stable ordering | `38f4b5b19` |
| G3 compaction refusal/empty fallback; bounded overflow re-compaction | `ccb8f7f3a`, `3ce997cc0` |
| G8 fuzzy edit; LSP runtime + diagnostics; formatter runtime | `eb7c0c609`, `2a0e88792`, `a3c9c8d4f` |
| G9 V2 MCP runtime (stdio/remote bridge) | `5c66e8c00` |
| G10 subagent cost aggregation into ancestors | `0f54fa79b` |
| G11 migration flock | `1d2db2f69` |
| G13 cost accounting verified; G15 permission fail-closed verified | — |
| G14 clean stream-close detection | `9be726d25` |
| Storage: `db stats`/`db vacuum`/`export --jsonl`/`db backfill` | `fc28cc9c9`, `3e5f0c360`, `c10b71bf8` |
| TUI V2 read path behind `MIAO_TUI_V2` | `d1a2aa72f` |
| Docs: guide.zh/en; session-scoped tools; session messaging; storage hardening | — |

**Open (this document)**

- Workstream A: Stage 4 write flip (TUI → app/desktop/web).
- Workstream B: Stage 5 delete V1.
- Workstream C: SendMessage (session-to-session messaging).
- Workstream D: Storage hardening §5 (delta-only events, blob externalization, reclaim).
- Workstream E: gap items — G2 remainder, G3 remainder, G4, G5, G6, G7, G8 remainder, G9
  remainder, G11 remainder, G12, G13 remainder.
  - G7 progress: ripgrep now enforces a default 30s timeout (overridable via `timeout`) that kills
    the invocation and fails the tool call; covered by `packages/core/test/ripgrep.test.ts`.
    Remaining G7 work: shell output streaming to managed storage, non-streamed body caps.
  - G3 progress: `runSubagent` now returns a `ToolFailure` when the child's last assistant message
    carries an error or `finish: "error"`, so a failed subagent surfaces as a tool error rather than
    empty output; covered by `session-runner.test.ts`. Remaining: interrupt/kill path liveness.
  - G11 progress: `EventV2.durable` now merges the in-process wake with a 1s database poll
    (`pollInterval` overridable), so a second process appending to the same database is tailed
    without gaps; covered by `event.test.ts`.
  - G4 progress: attachment normalization at request build. `toLLMMessages` accepts the target
    model's declared input modalities and replaces image files with a text placeholder when the
    model omits `image`; the runner passes `resolved.info.capabilities.input`. Covered by
    `session-runner-message.test.ts`. Remaining G4 work: cancellation settlement, tool progress.
  - G2 remainder complete: `materialize` accepts `disabledTools` (filtered before ordering) and the
    runner sources it from the new global `disabled_tools` config; re-enabling appends without
    reordering the prefix. Covered by `tool-registry-order.test.ts`.
  - G9 progress: MCP canonical tool names are deduped in deterministic codepoint order (first wins),
    so a reconnect or duplicate listing cannot change the advertised set; covered by `mcp.test.ts`.
    Remaining G9: progressive discovery, OAuth/CIMD, and `ttlMs`/`cacheScope` (not exposed by the
    installed `@modelcontextprotocol/sdk`).
  - G13 progress: `session.turn` telemetry now logs `cacheMissCause`
    (`none`/`cold`/`rebuild`/`prefix-change`) and `SessionRunnerMetrics.cacheMissCause` documents the
    prefix-invalidating actions; covered by `session-runner-metrics.test.ts`.

## 2. Environment

```sh
# run from source (channel local, DB miao-local.db)
bun run --cwd packages/miao dev -- <args>

# read-path flag
MIAO_TUI_V2=1 bun run --cwd packages/miao dev

# preflight / gates
bun typecheck
bun --cwd packages/core test
bun --cwd packages/tui test
bun --cwd packages/miao test
bun run --cwd packages/client generate        # after any Protocol/Server HttpApi change

# storage
miao-dev db stats
miao-dev db backfill
miao-dev db vacuum
miao-dev export --format jsonl <session>

# preview build (never touches ~/.miao/bin/miao)
./script/install-local.sh
ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao-preview   # rollback
```

Key locations:
- V1 engine: `packages/miao/src/session/prompt.ts` (writes `message`/`part`).
- V2 engine: `packages/core/src/session/runner/llm.ts` (writes `session_message`).
- Server assembly (mounts both trees): `packages/miao/src/server/routes/instance/httpapi/server.ts`.
- Protocol: `packages/protocol/src/groups/session.ts`; handlers `packages/server/src/handlers/session.ts`.
- TUI V1 read store: `packages/tui/src/context/sync.tsx`.
- TUI V2 read store: `packages/tui/src/context/data.tsx` (wired via `DataProvider`, `app.tsx:301`).

## 3. Workstream A — Stage 4 write flip (per surface)

### A.0 Read preflight (flag-gated, already landed)

1. `MIAO_TUI_V2=1`: transcript byte-identical to V1 for a projected session.
2. Legacy session: renders from V1 fallback; sending shows the `LegacyNotMigratedError` hint.
3. Flag off: unchanged V1 behavior.

### A.0b Read live updates (resolved 2026-09-30)

`MIAO_TUI_V2` hydrated the transcript only when `sync` ran and did not update live.

- The session route renders from the V1 `sync` store: `packages/tui/src/routes/session/index.tsx`
  reads `sync.data.message` / `sync.data.part`.
- The global event stream carries both V1 legacy events (`message.updated`, `message.part.*`) and
  V2 durable events (`session.next.*`), but `packages/tui/src/context/sync.tsx` handled the legacy
  cases plus only `session.next.moved`; it had no `session.next.text/reasoning/tool/step` handling.
- `packages/tui/src/context/data.tsx` has a V2 reducer, but the session route does not consume that
  store (`useData` is used only by `component/prompt/autocomplete.tsx`).
- The V2 engine publishes only `session.next.*` (`packages/core/src/session/runner/llm.ts`); nothing
  projects those into the legacy `message.*` stream for the TUI.

Resolved by re-hydrating the affected session from `v2.session.context` on each live V2
`session.next.*` event (debounced ~200ms) in `packages/tui/src/context/sync.tsx`, gated on
`MIAO_TUI_V2` and classified by `isLiveSessionV2Event` (`context/session-v2.ts`). The route keeps
rendering the V1-shaped `sync.data` store, so reads and writes now both come from the V2 API under
the flag.

Tradeoff: this is a refetch-based unblock (full `context` per burst), not an incremental reducer;
an incremental V2 event reducer can replace it later. Live behavior still needs a manual `miao-dev`
soak (`MIAO_TUI_V2=1`, send a prompt, confirm streamed output).

### A.1 TUI write sites (V1 → V2)

| Action | Current (V1) | Target (V2) |
|---|---|---|
| Send prompt | `sdk.client.session.prompt` — `component/prompt/index.tsx:1115` | `sdk.client.v2.session.prompt` — payload `{ sessionID, prompt: PromptInput.Prompt, delivery?, resume? }` |
| Abort/interrupt | `sdk.client.session.abort` — `prompt/index.tsx:436`, `routes/session/index.tsx:619` | `sdk.client.v2.session.interrupt` |
| Shell | `sdk.client.session.shell` — `prompt/index.tsx:1082` | `sdk.client.v2.session.shell` |
| Slash command | `sdk.client.session.command` — `prompt/index.tsx:1104` | `sdk.client.v2.session.command` |
| Create | `sdk.client.session.create` — `prompt/index.tsx:1021` | `sdk.client.v2.session.create` |
| Fork | `app.tsx:506,526`, `routes/session/dialog-*.tsx`, `dialog-message.tsx:81` | `sdk.client.v2.session.fork` |
| Permission reply | `sdk.client.permission.reply` — `routes/session/permission.tsx:168,180,418,426`, `context/sync.tsx:201` | `sdk.client.v2.session.permission.*reply` (session-scoped) |
| Question reply/reject | `sdk.client.question.reply/reject` — `routes/session/question.tsx:50,58,74` | `sdk.client.v2.session.question.*` |

Payload translation is the real work: V1 `prompt` takes `{ parts, agent, model, variant }`; V2 takes
`prompt: PromptInput.Prompt` = `{ text, files, agents }` plus optional `delivery` (`steer`|`queue`)
and `resume`. Map editor text + non-text parts into `Prompt.fields`; choose `delivery` from the
TUI's existing steer-vs-queue decision.

Make reads and writes agree: the session route currently reads `sync` (V1). Either read `data` (V2)
under `MIAO_TUI_V2`, or keep reads on `MIAO_TUI_V2` and gate writes on the same flag.

**A.1 status (2026-09-30).** Landed, gated on `MIAO_TUI_V2`: create, prompt, shell, command,
interrupt, fork, compact/revert (`summarize`→`v2.session.compact`, `revert`→
`v2.session.revert.stage`, `unrevert`→`v2.session.revert.clear`), and permission/question replies.
Payload mapping is `promptInputFromParts` in `context/session-v2-write.ts`; the legacy JS SDK was
regenerated so `v2.session.shell/command/fork` exist (they were missing). Reads already come from
V2 under the flag (A.0b).

V2 permission/question requests now render: `context/sync.tsx` handles `permission.v2.asked` /
`permission.v2.replied` / `question.v2.asked` / `question.v2.replied` / `question.v2.rejected`,
mapping the V2 permission request (`action`/`resources`/`save`/`source`) into the V1 UI shape and
storing the V2 question request (structurally identical) as a `QuestionRequest`. Replies go to
`v2.session.permission.reply` / `v2.session.question.reply|reject` under the flag.

Still required: live end-to-end soak in `miao-dev` with a real provider (A.2 acceptance), and the
browser app/desktop/web surfaces (A.3).

### A.2 Acceptance (from `v1-retirement.md`)

- A session driven entirely through `/api/session/*` writes **`session_message` rows and no
  `message`/`part` rows** — verify with `miao-dev db stats`.
- TUI and app show identical transcripts for the same session before/after the flip.
- Exercise: prompt, steer, queue, tool loop, compaction, permissions, revert, interrupt.
- Suites pass: `packages/core`, `packages/miao`, `packages/tui`, `packages/client`; `bun typecheck`.

### A.3 Then repeat A.0–A.2 for app / desktop / web

They already render V2 events (`packages/app/src/context/data.tsx`) and have a protocol detector
(`packages/app/src/utils/server-protocol.ts`).

**A.3 status (2026-09-30).** The client side is already wired: `utils/server-compat.ts` routes every
write to the V2 `ServerApi` when `detectServerProtocol` returns `v2`, and the app renders V2 events.
Detection prefers the legacy `/global/health` endpoint when both API generations respond, so the app
selects V2 once the server stops serving V1 health (the server cutover, not a client change). Added
a `?protocol=v1|v2` query override in `server-protocol.ts` so a build can be soaked on V2 before
that cutover; absent/unknown values fall back to detection. Live browser preflight/soak remains.

## 4. Workstream B — Stage 5 delete V1

Only after Stage 4 soaks with no shipped client on `/session/*`. Deletion order (from the migration
map): app SDK shims → V1 route groups → V1 session engine → V1 tools/transport →
`packages/core/v1` schemas → legacy SDK → the `packages/miao` server/engine. Gate each deletion on
"no client imports a `/session/*` route" and the full suite.

## 5. Workstream C — SendMessage (session-to-session messaging)

Spec: `specs/v2/session-messaging.md`. Depends on Stage 4 (both sessions must be V2-driven).

- Verify: A sends to B; B receives as an input; replies route back; no duplicate delivery after
  restart; isolated from unrelated sessions.

## 6. Workstream D — Storage hardening §5

Spec: `specs/storage/session-storage-hardening.md`. The 1.26 GB lives in the legacy V1 write path
(`message.updated.1` / `message.part.updated.1`); the V2 publisher already coalesces
(`packages/core/src/session/runner/publish-llm-event.ts`). Blocked on V2 being the active write
path (Workstream A).

1. **Delta-only events.** Retire the V1 per-delta sync events; keep one durable row per completed
   fragment/message. Do not carry V1's snapshot-per-delta forward.
2. **Blob externalization.** Attachments and oversized tool output under content-addressed
   `blobs/<sha256>` (reuse `packages/core/src/util/hash.ts` and the native blake3 helper); messages
   and events store `hash + mime`. Materialize references in
   `packages/core/src/session/runner/to-llm-message.ts` (currently TODO "Materialize remote and
   managed URIs"). The model still receives materialized bytes; storage dedup is not token dedup.
3. **Reclaim.** Incremental auto-vacuum; retention/compaction of the durable event log
   (snapshot-then-truncate); per-project blob GC (refcount or mark-and-sweep).
4. Acceptance: after migrating a large session, `miao-dev db stats` shows no
   `message.part.updated` snapshot bloat, no inline base64, `event` row count bounded by
   fragment/message count, and file size reclaimed by `miao-dev db vacuum`.

## 7. Workstream E — Gap items

Each is an independent slice. Add a focused test whenever the check is mechanical.

### G2 remainder — lazy/disabled tool definitions
- Where: `packages/core/src/tool/registry.ts` (`materialize`), `packages/core/src/session/runner/llm.ts`.
- Do: global `disabledTools` policy filtered at registry resolution (byte-stable prefix preserved);
  deferred definitions for tools added mid-session (append after the cache breakpoint, never
  reorder); name length bounded (already ≤64 via `validateName`).
- Acceptance: same-session tool array serializes byte-identically across turns; toggling a tool
  keeps the prefix and only appends.

### G3 remainder — subagent liveness reporting
- Where: compaction + `task` tool (`packages/core/src/tool/task.ts`), runner.
- Do: surface the summary request's model/failure; report subagent liveness/terminal state to the
  parent so a dead child is visible.
- Acceptance: refused summary falls back (done); a killed subagent reports as failed, not hangs.

### G4 — cancellation settlement / attachment normalization / progress
- Where: `packages/core/src/session/runner/llm.ts` (cancellation), `to-llm-message.ts`
  (materialize remote/managed URIs), `packages/core/src/tool/bash.ts` (progress), inbox
  (`packages/core/src/session/input.ts`).
- Do: cancellation is first-class — cascade-cancel child fibers, drain the inbox, settle pending
  approvals; normalize attachments by model capability (replace unreadable images with text
  placeholders) at request build; wire tool progress events.
- Acceptance: interrupt a session with a child task + pending approval → no dangling state, no lost
  queue messages, attachments replaced before the request is built.

### G5 — Tool.Called → settlement crash recovery
- Where: `packages/core/src/session/runner/llm.ts`; deferred by `specs/v2/todo.md`.
- Do: idempotency key (`callID` + attempt) + one-shot consume token; on restart mark unsettled
  calls outcome-unknown and require explicit retry/abandon.
- Acceptance: kill mid-tool, resume → no repeated side effect; the model sees "result unknown".

### G6 — background / async jobs
- Where: `packages/core/src/background-job.ts` (exists, unwired to V2); `packages/core/src/tool/bash.ts:72-74`.
- Do: adopt the ACP terminal contract (`terminal/create` → `output` [output/truncated/exitStatus] /
  `wait_for_exit` / `kill` / `release`, `outputByteLimit` truncated from the head on a char
  boundary). Durable status + bounded preview + cooperative cancel + incremental delivery.
- Acceptance: launch a background job, restart the dev server, query status and fetch exit code +
  truncated output.

### G7 — output bounds / timeouts / caps
- Where: `packages/core/src/tool/bash.ts`, `packages/core/src/ripgrep.ts` (grep/glob),
  `packages/core/src/tool/websearch.ts`, `packages/core/src/tool/http-body.ts`,
  `packages/core/src/tool-output-store.ts`.
- Do: stream shell output to disk with a bounded preview (never hold full output in memory);
  ripgrep timeout (kill on expiry, model-visible error); non-streamed JSON/image body caps.
- Acceptance: `yes`/huge-line output does not blow memory or hang; a long grep times out cleanly.

### G8 remainder — AST edit / snapshot-undo
- Where: `packages/core/src/tool/edit.ts`, `packages/core/src/tool/edit-fuzzy.ts`,
  `packages/core/src/snapshot.ts`.
- Do: AST-aware edit ladder; snapshot-based undo/redo of file mutations.
- Acceptance: an edit that a token match would corrupt is either applied structurally or refused;
  undo restores the pre-edit bytes.

### G9 remainder — MCP progressive discovery / OAuth / CIMD
- Where: core `packages/core/src/mcp.ts`; OAuth precedent in `packages/miao/src/mcp/{auth,oauth-provider}.ts`.
- Do: progressive discovery (`search_tools` → `get_tool_details`, switch at 1–5% context, append new
  definitions after the cache breakpoint, never reorder `tools`); OAuth via CIMD ordering
  (pre-registered → CIMD → DCR → prompt), creds keyed by AS `issuer`, validate `iss` (RFC 9207);
  deterministic `tools/list` with `ttlMs`/`cacheScope`; dedupe.
- Acceptance: a large MCP catalog loads lazily without disturbing the prompt-cache prefix; OAuth
  completes and credentials persist per issuer.

### G11 remainder — cross-process durable tail
- Where: `packages/core/src/util/flock.ts` (exists), event log `packages/core/src/event/*`.
- Do: durable event tail polling fallback so a second process never misses rows.
- Acceptance: process A appends, process B tails all rows with no gaps.

### G12 — syscall-level mutation confinement
- Where: core has none; `packages/miao/src/tool/sandbox-runner.ts` (macOS seatbelt / Linux Landlock,
  `miao __sandbox-run`) is a V1-side primitive.
- Do: wire a core-owned OS sandbox into V2 tool execution (workdir + allowed paths + network),
  fail-closed, model-visible denials.
- Acceptance: a mutating tool inside the sandbox cannot write outside allowed paths; network denied
  when configured; denials surface as tool errors.

### G13 remainder — prompt-cache invalidation + buckets
- Where: `packages/core/src/session/runner/llm.ts` (`turns`, cache telemetry), `metrics`.
- Do: a documented invalidation-action list (what invalidates the prefix and why); split
  cache-creation vs reasoning token buckets in telemetry.
- Acceptance: telemetry distinguishes cache misses by cause; a prefix-affecting action is logged.

## 8. Ordering & dependencies

1. Stage 4 TUI (Workstream A) — unblocks SendMessage (C), storage (D), and Stage 5 (B).
2. Stage 4 app/desktop/web (A.3).
3. SendMessage (C) and Storage §5 (D) once V2 is the active writer.
4. Stage 5 delete V1 (B) after soak.
5. G-items (E) are independent; pick by value (G6/G9/G12 highest, G4/G5 next).

## 9. Definition of done (every slice)

- Behavior verified in `miao-dev` with the command and output recorded.
- Focused test added where the check is mechanical.
- `bun typecheck` + affected package suites green.
- One conventional commit on `main`, pushed to `miao`.
- `specs/v2/v1-retirement.md` stage progress and research doc §8 status updated.
- No other session's WIP committed.

## 10. Rollback

- TUI read: unset `MIAO_TUI_V2`.
- Stage 4 write flip: revert the flipped client call sites (V1 routes stay mounted and unused during
  the soak, so a client revert is sufficient).
- Preview binary: `ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao-preview`.
