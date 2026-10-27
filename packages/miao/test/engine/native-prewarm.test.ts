import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { ClientEvents } from "@miao/server/client-events"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { Effect, Schema } from "effect"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN

if (!binary) test.skip("a warmed Location connects the owner its first Session uses", () => {})
if (binary)
  it.live(
    "a warmed Location connects the owner its first Session uses",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        // The owner is the expensive half of the first session.create: the
        // engine child plus the product context behind it. Warming must leave
        // that owner in the registry, so the create that follows finds it
        // instead of paying for it again while the user waits.
        let prepared = 0
        const owners = yield* makeEngineOwners(
          {
            binary,
            model: "fixture",
            provider: "openai-chat",
            endpoint: "http://127.0.0.1:1",
            env: { OPENAI_API_KEY: "fixture-only" },
          },
          () =>
            Effect.sync(() => {
              prepared++
            }).pipe(Effect.as({ options: {}, refresh: Effect.void })),
        )
        const root = path.join(tmp.path, "engines")
        const native = fromOwners(owners, {}, root)
        const location = Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path })

        yield* native.warm!({ location })
        expect(prepared).toBe(1)

        const input = {
          sessionID: Schema.decodeUnknownSync(SessionID)("ses_prewarmed"),
          storage: SessionEnginePlacement.storageFor(root, location),
          location,
        }
        yield* native.initialize({ ...input, title: "New session" })
        expect(prepared).toBe(1)
        expect(yield* native.snapshot(input)).toMatchObject({ session_id: input.sessionID })
      }),
  )
