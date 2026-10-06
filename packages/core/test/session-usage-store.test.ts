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
import { SessionTable, SessionToolUsageTable, SessionTurnUsageTable } from "@miao/core/session/sql"
import { SessionUsageStore } from "@miao/core/session/usage-store"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_usage_test")

const seed = Effect.fn("seed")(function* (db: Database.Interface["db"]) {
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
      model: { id: "fallback-model", providerID: "fallback-provider" },
    })
    .run()
})

const stepEnded = {
  sessionID,
  timestamp: DateTime.makeUnsafe(1_000),
  assistantMessageID: SessionMessage.ID.make("msg_assistant"),
  model: { id: ModelV2.ID.make("glm-5.3"), providerID: ProviderV2.ID.make("zhipu"), variant: undefined },
  finish: "stop",
  cost: 0.25,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
  ttft: 412.6,
} as const

describe("SessionUsageStore", () => {
  it.effect("projects a settled step into one turn usage row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)
      yield* events.publish(SessionEvent.Step.Ended, stepEnded)
      const rows = yield* db.select().from(SessionTurnUsageTable).where(eq(SessionTurnUsageTable.session_id, sessionID)).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        model_provider: "zhipu",
        model_id: "glm-5.3",
        finish: "stop",
        cost: 0.25,
        tokens_input: 100,
        tokens_output: 20,
        tokens_reasoning: 5,
        tokens_cache_read: 30,
        tokens_cache_write: 10,
        ttft_ms: 413,
        time_created: 1_000,
      })
    }),
  )

  it.effect("inserts each turn usage row at most once across replays", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)
      const event = {
        id: EventV2.ID.make("evt_turn_1"),
        type: SessionEvent.Step.Ended.type,
        data: stepEnded,
      }
      yield* SessionUsageStore.projectStepEnded(db, event)
      yield* SessionUsageStore.projectStepEnded(db, event)
      const rows = yield* db.select().from(SessionTurnUsageTable).all()
      expect(rows).toHaveLength(1)
    }),
  )

  it.effect("falls back to the session's selected model when the event carries none", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)
      yield* SessionUsageStore.projectStepEnded(db, {
        id: EventV2.ID.make("evt_turn_2"),
        type: SessionEvent.Step.Ended.type,
        data: { ...stepEnded, model: undefined },
      })
      const rows = yield* db.select().from(SessionTurnUsageTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ model_provider: "fallback-provider", model_id: "fallback-model" })
    }),
  )

  it.effect("tracks a tool call from running to settled", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2_000),
        assistantMessageID: SessionMessage.ID.make("msg_assistant"),
        callID: "call_1",
        tool: "bash",
        input: {},
        provider: { executed: false },
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2_500),
        assistantMessageID: SessionMessage.ID.make("msg_assistant"),
        callID: "call_1",
        structured: {},
        content: [],
        provider: { executed: false },
      })
      const rows = yield* db.select().from(SessionToolUsageTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tool: "bash", status: "success", time_called: 2_000, time_settled: 2_500 })
    }),
  )

  it.effect("keeps the first settlement of a tool call", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)
      const called = {
        id: EventV2.ID.make("evt_called_2"),
        type: SessionEvent.Tool.Called.type,
        data: {
          sessionID,
          timestamp: DateTime.makeUnsafe(3_000),
          assistantMessageID: SessionMessage.ID.make("msg_assistant"),
          callID: "call_2",
          tool: "read",
          input: {},
          provider: { executed: false },
        },
      }
      const success = {
        id: EventV2.ID.make("evt_success_2"),
        type: SessionEvent.Tool.Success.type,
        data: {
          sessionID,
          timestamp: DateTime.makeUnsafe(3_100),
          assistantMessageID: SessionMessage.ID.make("msg_assistant"),
          callID: "call_2",
          structured: {},
          content: [],
          provider: { executed: false },
        },
      }
      yield* SessionUsageStore.projectToolCalled(db, called)
      yield* SessionUsageStore.projectToolSettled(db, success, "success")
      yield* SessionUsageStore.projectToolSettled(db, success, "failed")
      const rows = yield* db.select().from(SessionToolUsageTable).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: "success", time_settled: 3_100 })
    }),
  )

  it.effect("removes usage rows with their session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed(db)
      yield* db
        .insert(SessionTurnUsageTable)
        .values({
          event_id: "evt_turn_3",
          session_id: sessionID,
          assistant_message_id: SessionMessage.ID.make("msg_assistant"),
          model_provider: "p",
          model_id: "m",
          finish: "stop",
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          time_created: 0,
        })
        .run()
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
      expect(yield* db.select().from(SessionTurnUsageTable).all()).toHaveLength(0)
    }),
  )
})
