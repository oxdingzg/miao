import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { SessionMessage } from "@miao/schema/session-message"
import { Effect, Schema } from "effect"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { messageID } from "@/engine/identity"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN
const Events = Schema.Array(
  Schema.Struct({ session_id: Schema.String, seq: Schema.Number, kind: Schema.String, data: Schema.Unknown }),
)
if (!binary) test.skip("native fork resolves public message IDs and retains its owner", () => {})
if (binary)
  it.live(
    "native fork resolves public message IDs and retains its owner",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            return new Response(
              'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
        const owners = yield* makeEngineOwners({
          binary,
          model: "fixture",
          provider: "openai-chat",
          endpoint: new URL("chat/completions", server.url).toString(),
          env: { OPENAI_API_KEY: "fixture-only" },
        })
        const native = fromOwners(owners)
        const input = {
          sessionID: Schema.decodeUnknownSync(SessionID)("ses_native_parent"),
          storage: Schema.decodeUnknownSync(AbsolutePath)(path.join(tmp.path, "engine.db")),
          location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
        }
        const promptID = SessionMessage.ID.make("msg_native_fork_prompt")
        yield* native.admit({ ...input, id: promptID, prompt: { text: "request" } })
        const parent = yield* Effect.gen(function* () {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const snapshot = yield* native.snapshot(input)
            if (
              snapshot["active_run"] === null &&
              Array.isArray(snapshot["messages"]) &&
              snapshot["messages"].length >= 2
            )
              return snapshot
            yield* Effect.sleep("5 millis")
          }
          return yield* Effect.fail(new Error("parent did not settle"))
        })
        const connection = yield* owners.get({ ...input, engineID: input.storage })
        const events = Schema.decodeUnknownSync(Events)(
          yield* Effect.promise(() => connection.client.request("events", { session_id: input.sessionID, after: 0 })),
        )
        const committed = events.find((event) => event.kind === "message.committed")
        if (!committed) return yield* Effect.fail(new Error("missing committed assistant"))
        const data = Schema.decodeUnknownSync(Schema.Struct({ anchor_seq: Schema.Number }))(committed.data)
        const targetSessionID = Schema.decodeUnknownSync(SessionID)("ses_native_forked")
        yield* native.fork({ ...input, targetSessionID, messageID: messageID(input.sessionID, data.anchor_seq) })
        const child = yield* native.snapshot({ ...input, sessionID: targetSessionID })
        expect(child["parent_session_id"]).toBe(input.sessionID)
        expect(child["title"]).toBe(parent["title"])
        expect(child["mode"]).toBe(parent["mode"])
        expect(child["messages"]).toHaveLength(2)
        expect(child["pending"]).toEqual([])
        expect(child["active_run"]).toBeNull()
        const history = yield* native.history({ ...input, sessionID: targetSessionID, after: 0, limit: 100 })
        const user = history.events.find((event) => event.type === "session.next.prompt.admitted")
        expect(user?.data).toMatchObject({ sessionID: targetSessionID, prompt: { text: "request" } })
        const projected = Schema.decodeUnknownSync(Schema.Struct({ messageID: SessionMessage.ID }))(user?.data)
        const beforeRetry = yield* native.snapshot({ ...input, sessionID: targetSessionID })
        const retry = yield* native.admit({
          ...input,
          sessionID: targetSessionID,
          id: projected.messageID,
          prompt: { text: "request" },
          resume: false,
        })
        expect(retry.id).toBe(projected.messageID)
        expect(yield* native.snapshot({ ...input, sessionID: targetSessionID })).toEqual(beforeRetry)

        expect((yield* native.snapshot({ ...input, sessionID: targetSessionID }))["pending"]).toEqual([])

        const userFork = Schema.decodeUnknownSync(SessionID)("ses_native_user_fork")
        yield* native.fork({ ...input, targetSessionID: userFork, messageID: promptID })
        expect((yield* native.snapshot({ ...input, sessionID: userFork }))["messages"]).toHaveLength(1)
        const invalid = yield* native
          .fork({
            ...input,
            targetSessionID: Schema.decodeUnknownSync(SessionID)("ses_invalid_fork"),
            messageID: SessionMessage.ID.make("msg_missing"),
          })
          .pipe(Effect.flip)
        expect(invalid._tag).toBe("ConflictError")
        expect(yield* native.sessions(input)).not.toContain("ses_invalid_fork")
      }),
    30_000,
  )
