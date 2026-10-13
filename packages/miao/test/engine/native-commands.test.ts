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

if (!binary) test.skip("native commands mutate and interrupt the engine-owned session", () => {})
if (binary)
  it.live(
    "native commands mutate and interrupt the engine-owned session",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const requested = Promise.withResolvers<void>()
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            requested.resolve()
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n',
                    ),
                  )
                },
              }),
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
          sessionID: Schema.decodeUnknownSync(SessionID)("ses_native_commands"),
          storage: Schema.decodeUnknownSync(AbsolutePath)(path.join(tmp.path, "engine.db")),
          location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
        }
        yield* native.admit({ ...input, prompt: { text: "wait" }, resume: false })
        yield* native.rename({ ...input, title: "Engine title" })
        expect((yield* native.snapshot(input))["title"]).toBe("Engine title")
        // Idle interruption is a no-op, not an execution in the TS runner.
        yield* native.interrupt(input)
        const connection = yield* owners.get({ ...input, engineID: input.storage })
        yield* Effect.promise(() => connection.client.request("resume", { session_id: input.sessionID }))
        yield* Effect.promise(() => requested.promise)
        yield* native.interrupt(input)
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const events = await connection.client.request("events", { session_id: input.sessionID, after: 0 })
            if (
              Array.isArray(events) &&
              events.some((event) => event.kind === "run.finished" && event.data.reason === "interrupted")
            )
              return
            await Bun.sleep(5)
          }
          throw new Error("native interruption did not finish the engine run")
        })
        const missing = yield* native
          .rename({ ...input, sessionID: Schema.decodeUnknownSync(SessionID)("ses_absent"), title: "missing" })
          .pipe(Effect.flip)
        expect(missing._tag).toBe("ConflictError")
      }),
    20_000,
  )
