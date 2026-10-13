import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { Question } from "@miao/schema/question"
import { Effect, Schema } from "effect"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { translateQuestionResolved } from "@/engine/bridge"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN
const Requests = Schema.Array(Schema.Struct({ question_id: Schema.String, input_hash: Schema.String }))
const Events = Schema.Array(
  Schema.Struct({ session_id: Schema.String, seq: Schema.Number, kind: Schema.String, data: Schema.Unknown }),
)
if (!binary) test.skip("native question rejection continues without interrupting the run", () => {})
if (binary)
  it.live(
    "native question rejection continues without interrupting the run",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const body = await request.json()
            const first = !body.messages.some((message: { role: string }) => message.role === "tool")
            const delta = first
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call",
                      type: "function",
                      function: {
                        name: "question",
                        arguments: JSON.stringify({
                          questions: [
                            { question: "Choose", header: "Choice", options: [{ label: "A" }, { label: "B" }] },
                          ],
                        }),
                      },
                    },
                  ],
                }
              : { content: "continued after rejection" }
            return new Response(
              `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
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
          sessionID: Schema.decodeUnknownSync(SessionID)("ses_native_rejection"),
          storage: Schema.decodeUnknownSync(AbsolutePath)(path.join(tmp.path, "engine.db")),
          location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
        }
        yield* native.admit({ ...input, prompt: { text: "ask" } })
        const connection = yield* owners.get({ ...input, engineID: input.storage })
        const pending = yield* Effect.gen(function* () {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const value = yield* Effect.promise(() =>
              connection.client.request("questions", { session_id: input.sessionID }),
            )
            const requests = Schema.decodeUnknownSync(Requests)(value)
            if (requests.length) return requests[0]
            yield* Effect.sleep("5 millis")
          }
          return yield* Effect.fail(new Error("question not requested"))
        })
        const requestID = Question.ID.make(`que_${pending.question_id}`)
        const wrong = yield* native
          .rejectQuestion({ ...input, requestID: Question.ID.make("que_absent") })
          .pipe(Effect.flip)
        expect(wrong._tag).toBe("ConflictError")
        yield* native.rejectQuestion({ ...input, requestID })
        const events = yield* Effect.gen(function* () {
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            const value = yield* Effect.promise(() =>
              connection.client.request("events", { session_id: input.sessionID, after: 0 }),
            )
            const events = Schema.decodeUnknownSync(Events)(value)
            if (events.some((event) => event.kind === "run.finished")) return events
            yield* Effect.sleep("5 millis")
          }
          return yield* Effect.fail(new Error("model did not continue after rejection"))
        })
        const resolved = events.find((event) => event.kind === "question.resolved")
        if (!resolved) return yield* Effect.fail(new Error("missing rejection event"))
        expect(translateQuestionResolved(resolved)).toEqual({
          type: "question.v2.rejected",
          data: { sessionID: input.sessionID, requestID },
        })
        expect(events.find((event) => event.kind === "run.finished")?.data).toMatchObject({ reason: "completed" })
        expect((yield* native.snapshot(input))["questions"]).toEqual([])
      }),
    30_000,
  )
