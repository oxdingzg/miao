# Running the workflow tool for engine-owned Sessions

[Roadmap](roadmap.md) §9 gate 2 landed the product-tool reverse bridge, and
`packages/miao/src/engine/product-tools.ts` advertises the peer tools and
`push_notification`. The `workflow` tool
(`packages/core/src/tool/workflow.ts`) is absent. This document records the
design for closing that gap, following the analysis pattern of
[native-worktree-move.en.md](native-worktree-move.en.md).

## 1. Why the engine cannot implement it natively

The TS `workflow` tool is two pieces:

1. **A confined JavaScript interpreter** (`@miao/codemode`) that executes the
   orchestration script with a single capability: `agent(...)`.
2. **A spawn capability** bound to the TS runner closure (`runSubagent`,
   `packages/core/src/session/runner/llm.ts`): agent catalog selection,
   permission assertion, budget inheritance, and a first-class child Session
   whose final assistant text becomes the call's result.

Reimplementing (1) in Rust is a non-starter. Moving (2) engine-side would
duplicate the product's Session creation, agent, and budget semantics inside
the engine. The tool therefore belongs on the host side of the bridge, like
every other product-owned tool.

## 2. Execution model

The manifest advertises `workflow`; the host executor:

1. Runs the script in `CodeMode.make` with the same `LIMITS`
   (30 min deadline, 64 tool calls, 32 KiB output).
2. Implements `agent(input)` as: create a **first-class child Session** with
   the caller's Session as `parentID`, the requested agent from the product
   agent catalog, and the operator's budget; prompt it; await its durable
   completion through the engine event stream (`run.finished` on the child's
   subscription); return the child's final assistant text as the call result.
   Children born under `MIAO_ENGINE_STORAGE` are engine-owned by the normal
   placement rules — no mixed-engine special case.
3. Refuses nesting: a Session that already has a `parentID` fails the call
   ("Subagents cannot spawn further subagents"), mirroring `runSubagent`.

Each `agent` call is a full session with its own cost, exactly as the tool's
description promises; costs are attributable because children are ordinary
Sessions.

## 3. Engine contracts that must change

Two small engine additions, both confined to the product bridge:

1. **Call context in the dispatch.** `Bridge::call(session, name, input)`
   (`crates/miao-engine/src/product.rs`, invoked at
   `crates/miao-engine/src/runtime.rs` in the product-tool arm) carries no
   tool-call identity. The `product_tool` request gains the calling
   `message_id`/`call_id` so the host can assert the subagent-spawn
   permission (`action: "task"`, resources `[agent]`) with a real
   permission source instead of a standing-policy guess.
2. **Cancellation notice.** Today a cancelled run silently drops the pending
   bridge reply (`Bridge::pending` cleanup), so a host executor would keep
   running child Sessions for a parent that is gone. When a run settles with
   pending bridge calls — cancel, failure, or clean end — the engine emits a
   `product_tool.cancel` control message with the `bridge_id`; the executor
   cancels its children (the durable cancellation cascade reaches them
   because they are real Sessions) and stops the script.

## 4. Host pieces

1. `product-tools.ts` gains the `workflow` definition (schema copied from the
   TS tool) and an executor with the behavior above, plus the LIMITS deadline.
2. Child creation reuses the product session-creation services the executor
   context already provides (`Database`, `SessionStore`, ownership) — the
   same path the server's session-create handler uses, so placement, agent
   references, and retry identity behave identically.
3. The executor holds the child's subscription until completion; a failed
   child (run failure) surfaces as the `agent` call's error, and the script
   decides whether to continue.

## 5. Non-goals

- **Background subagents**: the TS `autoBackground`/delegation path is not
  reproduced. Engine-owned Sessions that want background work use the
  engine's native `task`/`monitor` tools; `workflow` spawn is foreground.
- **Timers or crons inside spawn**: children are plain prompt sessions.
- **Interpreting engine-side**: the script never leaves the host.

## 6. Acceptance

- An engine-owned Session runs a two-`agent` workflow; both children appear
  in the product with `parentID` set and their own usage/cost; the tool
  result carries the second child's final text.
- Cancelling the parent mid-run cancels both children and settles the tool
  call without orphans.
- A child Session (nested `workflow`) is refused with a clear error.
- LIMITS hold: a script exceeding the deadline or output cap fails closed.
- TS-placed Sessions are unaffected; the manifest addition is inert for them.
