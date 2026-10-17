import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
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

const binary = process.env.MIAO_ENGINE_BIN
const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const Event = Schema.Struct({
  kind: Schema.String,
  data: Schema.Struct({ reason: Schema.optional(Schema.String) }),
})

async function interruptQuestion(input: {
  binary: string
  workspace: string
  db: string
  endpoint: string
  sessionID: string
}) {
  const child = Bun.spawn(
    [
      input.binary,
      "serve",
      "--db",
      input.db,
      "--workspace",
      input.workspace,
      "--model",
      "fixture",
      "--provider",
      "openai-chat",
      "--endpoint",
      input.endpoint,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENAI_API_KEY: "fixture-only" } },
  )
  const stderr = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill(9), 10_000)
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const frames = [
    { id: 1, method: "subscribe", params: { session_id: input.sessionID, after: 0 } },
    {
      id: 2,
      method: "admit",
      params: {
        input: { session_id: input.sessionID, input_id: "initial", prompt: "Ask a question", delivery: "steer" },
        resume: true,
      },
    },
  ]
  child.stdin.write(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n")
  let output = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) throw new Error(`native fixture exited before its question: ${await stderr}`)
      output += decoder.decode(next.value, { stream: true })
      if (output.includes('"question.requested"')) {
        // An actual process crash after durable dispatch, while the interaction
        // is awaiting its controller. No SQL fixture fabricates unknown state.
        child.kill(9)
        await child.exited
        return
      }
    }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill(9)
    await child.exited
    reader.releaseLock()
  }
}

if (!binary) test.skip("native recovery survives a real process crash and reconciles controller retries", () => {})
if (binary)
  it.live(
    "native recovery survives a real process crash and reconciles controller retries",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const workspace = path.join(tmp.path, "workspace")
        yield* Effect.promise(() => mkdir(workspace))
        let requests = 0
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            requests++
            const body = await request.text()
            if (requests > 1) expect(body).toContain("Operator recovery decision")
            const first = requests === 1
            const delta = first
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "question-call",
                      type: "function",
                      function: {
                        name: "question",
                        arguments: JSON.stringify({
                          questions: [{ question: "Choose a value", options: [{ label: "One" }, { label: "Two" }] }],
                        }),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "recovered" }
            return new Response(
              `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
        const input = {
          sessionID: SessionID.make("ses_native_recovery"),
          storage: AbsolutePath.make(path.join(tmp.path, "engine.db")),
          location: Location.Ref.make({ directory: AbsolutePath.make(workspace) }),
        }
        const endpoint = new URL("chat/completions", server.url).toString()
        yield* Effect.promise(() =>
          interruptQuestion({ binary, workspace, db: input.storage, endpoint, sessionID: input.sessionID }),
        )
        expect(requests).toBe(1)
        const owners = yield* makeEngineOwners({
          binary,
          model: "fixture",
          provider: "openai-chat",
          endpoint,
          env: { OPENAI_API_KEY: "fixture-only" },
        })
        const native = fromOwners(owners)
        const page = yield* native.recoveries(input)
        expect(page.hasMore).toBe(false)
        expect(page.calls).toHaveLength(1)
        const call = page.calls.at(0)
        if (!call) throw new Error("expected a recovered unknown call")
        expect(call.tool).toBe("question")
        expect(call.outcome).toBe("unknown")
        expect(call.resolution).toBeNull()
        const connection = yield* owners.get({ ...input, engineID: input.storage })
        const completed = Promise.withResolvers<void>()
        connection.client.onEvent((value) => {
          if (value.kind !== "run.finished") return
          if (Schema.decodeUnknownSync(Event)(value).data.reason === "completed") completed.resolve()
        })
        const decision = { ...input, callID: call.callID, operationID: "recovery-decision", decision: "retry" as const }
        const receipt = yield* native.resolveRecovery(decision)
        expect(requests).toBe(1)
        expect((yield* native.snapshot(input))["pending"]).toHaveLength(1)
        expect(yield* native.resolveRecovery(decision)).toEqual(receipt)
        expect(yield* native.resolveRecovery({ ...decision, resume: true })).toEqual(receipt)
        yield* Effect.promise(() => completed.promise).pipe(Effect.timeout("10 seconds"))
        expect(requests).toBe(2)
        expect(yield* native.resolveRecovery({ ...decision, resume: true })).toEqual(receipt)
        expect(requests).toBe(2)
        const replay = yield* Effect.promise(() =>
          connection.client.request("events", { session_id: input.sessionID, after: 0 }),
        )
        const events = Schema.decodeUnknownSync(Schema.Array(Event))(replay)
        expect(events.filter((event) => event.kind === "tool.dispatched")).toHaveLength(1)
        expect(events.filter((event) => event.kind === "question.requested")).toHaveLength(1)
        expect(events.filter((event) => event.kind === "tool.recovery.resolved")).toHaveLength(1)
        expect((yield* native.snapshot(input))["pending"]).toHaveLength(0)
        const conflict = yield* native.resolveRecovery({ ...decision, decision: "abandon" }).pipe(Effect.flip)
        expect(conflict._tag).toBe("ConflictError")
      }),
    30_000,
  )
