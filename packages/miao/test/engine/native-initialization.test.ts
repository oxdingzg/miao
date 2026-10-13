import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { Effect, Schema } from "effect"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native initialization is immediately readable without a prompt", () => {})
if (binary)
  it.live("native initialization is immediately readable without a prompt", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      // No reachable provider: identity initialization must never ask a model.
      const owners = yield* makeEngineOwners({
        binary,
        model: "fixture",
        provider: "openai-chat",
        endpoint: "http://127.0.0.1:1",
        env: { OPENAI_API_KEY: "fixture-only" },
      })
      const native = fromOwners(owners)
      const input = {
        sessionID: Schema.decodeUnknownSync(SessionID)("ses_native_initialized"),
        storage: Schema.decodeUnknownSync(AbsolutePath)(path.join(tmp.path, "engine.db")),
        location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
        title: "New session",
      }
      yield* native.initialize(input)
      const first = yield* native.snapshot(input)
      expect(first).toMatchObject({
        session_id: input.sessionID,
        title: input.title,
        location: tmp.path,
        pending: [],
        messages: [],
        active_run: null,
      })
      expect(yield* native.sessions(input)).toEqual([input.sessionID])
      expect(typeof first["created_at_ms"]).toBe("number")
      yield* native.initialize(input)
      expect(yield* native.snapshot(input)).toEqual(first)
      const second = { ...input, sessionID: Schema.decodeUnknownSync(SessionID)("ses_native_other") }
      yield* native.initialize(second)
      expect(yield* native.sessions(input)).toEqual([input.sessionID, second.sessionID])
    }),
  )
