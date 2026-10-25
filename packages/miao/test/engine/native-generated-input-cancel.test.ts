import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { Effect, Schema } from "effect"
import { translatePrompt } from "@/engine/bridge"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("a generated notice can be read, cancelled and read back on the real engine", () => {})
if (binary)
  it.live(
    "a generated notice can be read, cancelled and read back on the real engine",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const owners = yield* makeEngineOwners({
          binary,
          model: "fixture",
          provider: "openai-chat",
          // A promoted input starts a run. Point the provider at a closed port
          // so that run fails immediately; promotion itself is the durable
          // boundary this test observes, not the provider turn.
          endpoint: "http://127.0.0.1:1/v1/chat/completions",
          env: { OPENAI_API_KEY: "fixture-only" },
        })
        const native = fromOwners(owners)
        const sessionID = SessionID.make("ses_generated_cancel")
        const location = Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path })
        const storage = Schema.decodeUnknownSync(AbsolutePath)(path.join(tmp.path, "engine.db"))
        const input = { sessionID, storage, location }
        const connection = yield* owners.get({ storage, engineID: storage, location })

        // An engine-generated notice has no product prompt id. The product only
        // knows the identity its inbox read hands out; a cancel must address
        // the engine row behind it.
        const generated = (inputID: string, delivery: "steer" | "queue") =>
          Effect.promise(() =>
            connection.client.admit(
              { session_id: sessionID, input_id: inputID, prompt: `notice ${inputID}`, delivery },
              false,
            ),
          )

        yield* generated("monitor:job:first", "queue")
        const read = yield* native.inputs({ ...input, limit: 50 })
        expect(read.inputs).toHaveLength(1)
        const notice = read.inputs[0]!.id
        expect(String(notice)).toStartWith("msg_gen_")
        expect(yield* native.cancelInput({ ...input, inputID: notice })).toBe(true)
        expect((yield* native.inputs({ ...input, limit: 50 })).inputs).toEqual([])

        // Control: a product prompt keeps its submitted identity and cancels
        // without any identity resolution.
        const control = yield* native.admit({ ...input, prompt: { text: "control" }, resume: false })
        expect(String(control.id)).toStartWith("msg_")
        expect(String(control.id)).not.toStartWith("msg_gen_")
        expect(yield* native.cancelInput({ ...input, inputID: control.id })).toBe(true)
        expect((yield* native.inputs({ ...input, limit: 50 })).inputs).toEqual([])

        // A promoted notice has a final answer. Retrying its derived identity
        // must not resolve to some other pending input.
        yield* generated("monitor:job:promoted", "steer")
        const promoted = (yield* native.inputs({ ...input, limit: 50 })).inputs[0]!.id
        yield* Effect.promise(() => connection.client.request("resume", { session_id: sessionID }))
        const promotedGone = yield* waitFor(native, input, (ids) => !ids.includes(String(promoted)))
        expect(promotedGone.inputs).toEqual([])
        // The journal promotion lands at a later seq than admission. The read
        // identity above and the promoted message must still be the same one.
        const journal = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({ session_id: Schema.String, seq: Schema.Number, kind: Schema.String, data: Schema.Unknown }),
          ),
        )(yield* Effect.promise(() => connection.client.request("events", { session_id: sessionID, after: 0 })))
        const promotion = journal.find(
          (event) =>
            event.kind === "input.promoted" &&
            typeof event.data === "object" &&
            event.data !== null &&
            "input_id" in event.data &&
            event.data.input_id === "monitor:job:promoted",
        )
        expect(promotion).toBeDefined()
        expect(String(translatePrompt(promotion!)?.messageID)).toBe(String(promoted))
        yield* generated("monitor:job:kept", "queue")
        expect(yield* native.cancelInput({ ...input, inputID: promoted })).toBe(false)
        const kept = yield* native.inputs({ ...input, limit: 50 })
        expect(kept.inputs.map((entry) => String(entry.id))).toHaveLength(1)
        expect(String(kept.inputs[0]!.id)).toStartWith("msg_gen_")
        expect(yield* native.cancelInput({ ...input, inputID: kept.inputs[0]!.id })).toBe(true)
      }),
    60_000,
  )

function waitFor(
  native: ReturnType<typeof fromOwners>,
  input: { sessionID: SessionID; storage: AbsolutePath; location: Location.Ref },
  done: (ids: readonly string[]) => boolean,
) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const page = yield* native.inputs({ ...input, limit: 50 })
      if (done(page.inputs.map((entry) => String(entry.id)))) return page
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.fail(new Error("generated input never reached the expected inbox state"))
  })
}
