import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@miao/core/database/database"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { EventV2 } from "@miao/core/event"
import { ModelV2 } from "@miao/core/model"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { ProviderV2 } from "@miao/core/provider"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionEvent } from "@miao/core/session/event"
import { SessionMessage } from "@miao/core/session/message"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStats } from "@miao/core/session/stats"
import { SessionTable } from "@miao/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const model = { id: ModelV2.ID.make("gpt"), providerID: ProviderV2.ID.make("openai") }
const rootID = SessionV2.ID.make("ses_stats_root")
const childID = SessionV2.ID.make("ses_stats_child")
const grandchildID = SessionV2.ID.make("ses_stats_grandchild")
const otherID = SessionV2.ID.make("ses_stats_other")

const session = (id: SessionV2.ID, parent?: SessionV2.ID, updated = 10) => ({
  id,
  parent_id: parent,
  project_id: Project.ID.global,
  slug: id,
  directory: "/project",
  title: id,
  version: "test",
  time_created: 1,
  time_updated: updated,
})

const step = Effect.fnUntraced(function* (sessionID: SessionV2.ID, messageID: string, cost: number, tool?: string) {
  const events = yield* EventV2.Service
  const assistantMessageID = SessionMessage.ID.make(messageID)
  yield* events.publish(SessionEvent.Prompted, {
    sessionID,
    messageID: SessionMessage.ID.make(`${messageID}_user`),
    timestamp: DateTime.makeUnsafe(1),
    prompt: { text: "go" },
    delivery: "steer",
  })
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(2),
    agent: "build",
    model,
  })
  if (tool) {
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(3),
      callID: `call_${messageID}`,
      name: tool,
    })
  }
  yield* events.publish(SessionEvent.Step.Ended, {
    sessionID,
    timestamp: DateTime.makeUnsafe(4),
    assistantMessageID,
    finish: "stop",
    cost,
    tokens: { input: 100, output: 10, reasoning: 1, cache: { read: 0, write: 0 } },
  })
})

describe("SessionStats", () => {
  it.effect("counts subagent usage once, under its root session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          session(rootID),
          session(childID, rootID),
          session(grandchildID, childID),
          session(otherID, undefined, 5),
        ])
        .run()
        .pipe(Effect.orDie)

      yield* step(rootID, "msg_root", 1, "bash")
      yield* step(childID, "msg_child", 0.5, "read")
      yield* step(grandchildID, "msg_grandchild", 0.25)
      yield* step(otherID, "msg_other", 2)

      // The projector rolls a subagent's usage into every ancestor, which is why
      // summing the session rows double counts it.
      const costOf = (id: SessionV2.ID) =>
        db
          .select({ cost: SessionTable.cost })
          .from(SessionTable)
          .where(eq(SessionTable.id, id))
          .get()
          .pipe(Effect.orDie)
      expect((yield* costOf(rootID))?.cost).toBe(1.75)
      expect((yield* costOf(childID))?.cost).toBe(0.75)

      const all = yield* SessionStats.aggregate(db)
      expect(all.sessions).toBe(2)
      expect(all.cost).toBe(3.75)
      expect(all.messages).toBe(8)
      expect(all.tokens).toEqual({ input: 400, output: 40, reasoning: 4, cache: { read: 0, write: 0 } })
      expect(all.models).toEqual({
        "openai/gpt": { messages: 4, cost: 3.75, tokens: { input: 400, output: 44, cache: { read: 0, write: 0 } } },
      })
      expect(all.tools).toEqual({ bash: 1, read: 1 })
      expect(all.perSession.toSorted()).toEqual([111, 333])

      const recent = yield* SessionStats.aggregate(db, { since: 6 })
      expect(recent.sessions).toBe(1)
      expect(recent.cost).toBe(1.75)
      expect(yield* SessionStats.aggregate(db, { projectID: "other" })).toMatchObject({ sessions: 0, cost: 0 })
    }),
  )
})
