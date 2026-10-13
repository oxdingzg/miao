import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { SessionExecution } from "@miao/schema/session-execution"
import { Effect, Schema } from "effect"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native guarded interruption cannot stop a newer execution", () => {})
if (binary)
  it.live(
    "native guarded interruption cannot stop a newer execution",
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
          sessionID: Schema.decodeUnknownSync(SessionID)("ses_guarded_interrupt"),
          storage: Schema.decodeUnknownSync(AbsolutePath)(path.join(tmp.path, "engine.db")),
          location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
        }
        const execution = Effect.fn(function* (running: boolean) {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const snapshot = yield* native.snapshot(input)
            if (running && typeof snapshot["active_run"] === "string")
              return Schema.decodeUnknownSync(SessionExecution.ID)(snapshot["active_run"])
            if (!running && snapshot["active_run"] === null) return undefined
            yield* Effect.sleep("5 millis")
          }
          return yield* Effect.fail(new Error("native execution did not transition"))
        })
        yield* native.admit({ ...input, prompt: { text: "first" } })
        const first = yield* execution(true)
        if (!first) return yield* Effect.fail(new Error("missing first execution"))
        expect(yield* native.interruptIf({ ...input, executionID: "00000000-0000-4000-8000-000000000000" })).toBe(false)
        expect(yield* native.interruptIf({ ...input, executionID: first })).toBe(true)
        yield* execution(false)
        yield* native.admit({ ...input, prompt: { text: "second" } })
        const second = yield* execution(true)
        if (!second) return yield* Effect.fail(new Error("missing second execution"))
        expect(second).not.toBe(first)
        expect(yield* native.interruptIf({ ...input, executionID: first })).toBe(false)
        expect((yield* native.snapshot(input))["active_run"]).toBe(second)
        expect(yield* native.interruptIf({ ...input, executionID: second })).toBe(true)
        yield* execution(false)
      }),
    30_000,
  )
