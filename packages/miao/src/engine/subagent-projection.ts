import { AgentV2 } from "@miao/core/agent"
import { Database } from "@miao/core/database/database"
import { SessionCreate } from "@miao/core/session-create"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionID } from "@miao/schema/session-id"
import { Effect, Option, Schema } from "effect"
import type { EngineEvent } from "./client"

export interface SubagentProjectionDeps {
  readonly db: Database.Interface["db"]
  /** Present when the host composes product Session creation. */
  readonly create?: SessionCreate.Interface["create"]
}

const Started = Schema.Struct({
  subagent_id: Schema.String,
  agent: Schema.optional(Schema.String),
})

/**
 * The engine creates a delegated child Session inside its own store, so the
 * product never sees it the way it sees a Session it created itself: without a
 * binding the child exists only in the engine, never appears in a listing, and
 * no client can navigate to it — the `task` tool's child is then unreachable
 * even though its parent reports one.
 *
 * `subagent_start` names the child and the parent it was forked from, and both
 * share one storage and Location, so the event is enough to record the binding
 * the product's own creators would have recorded. A replayed event, or a child
 * some other path already bound, is left alone.
 */
export const projectSubagentStarted = Effect.fn("Engine.projectSubagentStarted")(function* (
  deps: SubagentProjectionDeps,
  event: EngineEvent,
) {
  if (event.kind !== "subagent_start") return false
  const create = deps.create
  if (create === undefined) return false
  const parentID = Schema.decodeUnknownOption(SessionID)(event.session_id)
  const started = Schema.decodeUnknownOption(Started)(event.data)
  if (Option.isNone(parentID) || Option.isNone(started)) return false
  const childID = Schema.decodeUnknownOption(SessionID)(started.value.subagent_id)
  if (Option.isNone(childID)) return false
  // A TypeScript-owned parent delegates through the product `task` tool, which
  // records its child itself: this projection only owes the native path.
  const parent = yield* SessionEnginePlacement.find(deps.db, parentID.value)
  if (parent?.engine !== "rust") return false
  if (yield* SessionEnginePlacement.find(deps.db, childID.value)) return false
  const agent = Schema.decodeUnknownOption(AgentV2.ID)(started.value.agent ?? "")
  yield* create({
    id: childID.value,
    parentID: parentID.value,
    ...(Option.isSome(agent) ? { agent: agent.value } : {}),
    location: parent.location,
    nativeStorage: parent.storage,
  })
  return true
})
