import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { Permission } from "@miao/schema/permission"
import { Question } from "@miao/schema/question"
import { Effect, Schema } from "effect"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN
for (const kind of ["permission", "permission-reject", "question"] as const) {
  if (!binary) test.skip(`native ${kind} replies resolve the engine-owned request`, () => {})
  if (binary)
    it.live(
      `native ${kind} replies resolve the engine-owned request`,
      () =>
        Effect.gen(function* () {
          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "file"), "approved file"))
          const policyFile = path.join(tmp.path, "policy.json")
          yield* Effect.promise(() =>
            Bun.write(policyFile, JSON.stringify({ rules: [{ tool: "read_file", path: "file", decision: "ask" }] })),
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
                          name: kind !== "question" ? "read_file" : "question",
                          arguments: JSON.stringify(
                            kind !== "question"
                              ? { path: "file" }
                              : {
                                  questions: [
                                    {
                                      question: "Choose",
                                      header: "Choice",
                                      options: [
                                        { label: "A", description: "First" },
                                        { label: "B", description: "Second" },
                                      ],
                                    },
                                  ],
                                },
                          ),
                        },
                      },
                    ],
                  }
                : { content: "done" }
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
            policyFile,
            endpoint: new URL("chat/completions", server.url).toString(),
            env: { OPENAI_API_KEY: "fixture-only" },
          })
          const native = fromOwners(owners)
          const input = {
            sessionID: Schema.decodeUnknownSync(SessionID)(`ses_native_${kind}`),
            storage: Schema.decodeUnknownSync(AbsolutePath)(path.join(tmp.path, "engine.db")),
            location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
          }
          yield* native.admit({ ...input, prompt: { text: "request" } })
          const pending = yield* Effect.gen(function* () {
            const deadline = Date.now() + 10_000
            while (Date.now() < deadline) {
              const requests = kind !== "question" ? yield* native.permissions(input) : yield* native.questions(input)
              if (requests.length) return requests[0]
              yield* Effect.sleep("5 millis")
            }
            return yield* Effect.fail(new Error(`native ${kind} request never arrived`))
          })
          if (kind !== "question") {
            expect(pending.id).toStartWith("per_")
            const requestID = Permission.ID.make(pending.id)
            const persistent = yield* native.replyPermission({ ...input, requestID, reply: "always" }).pipe(Effect.flip)
            expect(persistent._tag).toBe("ConflictError")
            expect(yield* native.permissions(input)).toHaveLength(1)
            const wrong = yield* native
              .replyPermission({ ...input, requestID: Permission.ID.make("per_absent"), reply: "once" })
              .pipe(Effect.flip)
            expect(wrong._tag).toBe("ConflictError")
            const other = { ...input, sessionID: Schema.decodeUnknownSync(SessionID)("ses_other") }
            yield* native.admit({ ...other, prompt: { text: "other Session" }, resume: false })
            const crossSession = yield* native.replyPermission({ ...other, requestID, reply: "once" }).pipe(Effect.flip)
            expect(crossSession._tag).toBe("ConflictError")
            expect(yield* native.permissions(input)).toHaveLength(1)
            yield* native.replyPermission({
              ...input,
              requestID,
              reply: kind === "permission-reject" ? "reject" : "once",
            })
          }
          if (kind === "question") {
            expect(pending.id).toStartWith("que_")
            const wrong = yield* native
              .replyQuestion({ ...input, requestID: Question.ID.make("que_absent"), answers: [["A"]] })
              .pipe(Effect.flip)
            expect(wrong._tag).toBe("ConflictError")
            expect(yield* native.questions(input)).toHaveLength(1)
            const requestID = Question.ID.make(pending.id)
            const other = { ...input, sessionID: Schema.decodeUnknownSync(SessionID)("ses_other") }
            yield* native.admit({ ...other, prompt: { text: "other Session" }, resume: false })
            const crossSession = yield* native
              .replyQuestion({ ...other, requestID, answers: [["A"]] })
              .pipe(Effect.flip)
            expect(crossSession._tag).toBe("ConflictError")
            yield* native.replyQuestion({ ...input, requestID, answers: [["A"]] })
          }
          const connection = yield* owners.get({ ...input, engineID: input.storage })
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 10_000
            while (Date.now() < deadline) {
              const events = await connection.client.request("events", { session_id: input.sessionID, after: 0 })
              if (
                Array.isArray(events) &&
                events.some((event) => event.kind === "run.finished" && event.data.reason === "completed")
              )
                return
              await Bun.sleep(5)
            }
            throw new Error(`native ${kind} reply did not complete the run`)
          })
          expect(kind !== "question" ? yield* native.permissions(input) : yield* native.questions(input)).toEqual([])
        }),
      20_000,
    )
}
