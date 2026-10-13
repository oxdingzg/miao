import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { Effect } from "effect"
import { EngineClient } from "@/engine/client"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN

if (!binary) test.skip("native reads serve an engine-owned session snapshot", () => {})
if (binary)
  it.live(
    "native reads serve an engine-owned session snapshot",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const client = EngineClient.start({
          binary,
          db: path.join(tmp.path, "engine.db"),
          workspace: tmp.path,
          model: "fixture",
          provider: "openai-chat",
          env: { OPENAI_API_KEY: "fixture-only" },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => client.close()))
        yield* Effect.promise(() =>
          client.request("admit", {
            input: { session_id: "ses_native_reads", input_id: "in_1", prompt: "hello", delivery: "steer" },
            resume: false,
          }),
        )
        const snapshot = (yield* Effect.promise(() =>
          client.request("snapshot", { session_id: "ses_native_reads" }),
        )) as Record<string, unknown>
        expect(snapshot["session_id"]).toBe("ses_native_reads")
        expect(Array.isArray(snapshot["pending"])).toBe(true)
        const sessions = yield* Effect.promise(() => client.request("sessions"))
        expect(Array.isArray(sessions)).toBe(true)
        const missing = yield* Effect.promise(() =>
          client.request("snapshot", { session_id: "ses_absent" }).then(
            () => "resolved",
            () => "rejected",
          ),
        )
        expect(missing).toBe("rejected")
      }),
    15_000,
  )
