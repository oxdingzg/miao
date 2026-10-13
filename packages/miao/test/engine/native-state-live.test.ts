import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { nativeExecution, nativeTodos } from "@miao/server/native-state"
import { Effect, Schema } from "effect"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native state reads the engine ledger's actual todos", () => {})
if (binary)
  it.live("native state reads the engine ledger's actual todos", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const owners = yield* makeEngineOwners({
        binary,
        model: "fixture",
        provider: "openai-chat",
        env: { OPENAI_API_KEY: "fixture-only" },
      })
      const input = {
        sessionID: Schema.decodeUnknownSync(SessionID)("ses_native_state"),
        storage: Schema.decodeUnknownSync(AbsolutePath)(path.join(tmp.path, "engine.db")),
        location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
      }
      const native = fromOwners(owners)
      yield* native.admit({ ...input, prompt: { text: "durable input" }, resume: false })
      const connection = yield* owners.get({ ...input, engineID: input.storage })
      const todos = [
        { id: "build", content: "build", status: "waiting", priority: "high" },
        { id: "verify", content: "verify", status: "pending", priority: "high", depends_on: ["build"] },
      ]
      yield* Effect.promise(() =>
        connection.client.request("update_state", {
          session_id: input.sessionID,
          operation_id: "todo-1",
          tool: "todowrite",
          input: { todos },
        }),
      )
      const snapshot = yield* native.snapshot(input)
      expect(nativeTodos(snapshot)).toEqual(todos)
      expect(nativeExecution(snapshot)).toEqual({ type: "idle" })
      expect(snapshot["pending"]).toHaveLength(1)
    }),
  )
